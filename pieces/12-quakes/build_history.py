#!/usr/bin/env python3
"""Build the earthquake history layer: every M5+ earthquake in the USGS ComCat catalogue since 1970.

Question it answers: where does the Earth break? Plotted together, fifty years of strong earthquakes
draw the plate edges by themselves (Ring of Fire, Mid-Atlantic Ridge, Himalaya), and the deep ones
trace the plates that dive under others (subduction zones).

Data: USGS ComCat via the FDSN event web service (public domain, see SOURCES.md).
  https://earthquake.usgs.gov/fdsnws/event/1/query
The service refuses queries that match more than 20,000 events, so we ask one year at a time
(about 1,000-2,500 M5+ events a year) and keep each year's CSV in raw/ so a rebuild needs no network.

Output (data/), read by quakes_history.js:
  quakes_m5.bin   N events, column by column (all little-endian):
                    int16  lat x 100     [N]   (0.01 degree, about 1 km)
                    int16  lon x 100     [N]
                    uint16 depth x 10    [N]   (0.1 km; depth below sea level, negatives clamped to 0)
                    uint8  mag x 10      [N]   (50 = M5.0)
                    uint8  year - 1970   [N]
                  sorted by time, so one year is one contiguous run (yearOffsets in the .json).
  quakes_m5.json  count, years, yearOffsets, layout, source and build date.

Usage:  python3 -I build_history.py            (downloads missing years, then builds)
        python3 -I build_history.py --offline  (build from raw/ only)
"""
import csv, json, os, struct, sys, time, urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, 'raw')
OUT = os.path.join(HERE, 'data')
FIRST_YEAR = 1970
MIN_MAG = 5.0
URL = ('https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv&eventtype=earthquake'
       '&minmagnitude={m}&starttime={a}-01-01T00:00:00&endtime={b}-01-01T00:00:00&orderby=time-asc')


def fetch_year(year, last_year):
    """Download one year's CSV into raw/ (skipped when the file exists, except the current, unfinished year)."""
    path = os.path.join(RAW, f'comcat_m5_{year}.csv')
    if os.path.exists(path) and year < last_year:
        return path
    url = URL.format(m=MIN_MAG, a=year, b=year + 1)
    req = urllib.request.Request(url, headers={'User-Agent': 'oceany-globe-build (research)'})
    with urllib.request.urlopen(req, timeout=120) as r:
        body = r.read()
    with open(path, 'wb') as f:
        f.write(body)
    time.sleep(1.0)          # be polite to the service
    return path


def main():
    offline = '--offline' in sys.argv
    os.makedirs(RAW, exist_ok=True); os.makedirs(OUT, exist_ok=True)
    last_year = datetime.now(timezone.utc).year
    rows = []
    for year in range(FIRST_YEAR, last_year + 1):
        path = os.path.join(RAW, f'comcat_m5_{year}.csv')
        if not offline:
            path = fetch_year(year, last_year)
        if not os.path.exists(path):
            continue
        with open(path, newline='') as f:
            for r in csv.DictReader(f):
                try:
                    t = r['time']; lat = float(r['latitude']); lon = float(r['longitude'])
                    mag = float(r['mag']); depth = float(r['depth'] or 0)
                except (KeyError, ValueError):
                    continue          # an event with no magnitude or position: skipped, not guessed
                if mag < MIN_MAG:
                    continue
                y = int(t[:4])
                rows.append((t, y, lat, lon, max(0.0, depth), mag))
        print(f'{year}: {sum(1 for r in rows if r[1] == year)} events', flush=True)

    rows.sort(key=lambda r: r[0])
    n = len(rows)
    years = last_year - FIRST_YEAR + 1
    offsets = [0] * (years + 1)
    for r in rows:
        offsets[r[1] - FIRST_YEAR + 1] += 1
    for k in range(years):
        offsets[k + 1] += offsets[k]

    lat = struct.pack(f'<{n}h', *(round(r[2] * 100) for r in rows))
    lon = struct.pack(f'<{n}h', *(round(r[3] * 100) for r in rows))
    dep = struct.pack(f'<{n}H', *(min(65535, round(r[4] * 10)) for r in rows))
    mag = bytes(min(255, round(r[5] * 10)) for r in rows)
    yr = bytes(r[1] - FIRST_YEAR for r in rows)
    with open(os.path.join(OUT, 'quakes_m5.bin'), 'wb') as f:
        f.write(lat + lon + dep + mag + yr)

    deep = sum(1 for r in rows if r[4] >= 300)
    meta = {
        'count': n, 'minMag': MIN_MAG, 'firstYear': FIRST_YEAR, 'lastYear': last_year,
        'lastEvent': rows[-1][0] if rows else None,
        'yearOffsets': offsets,
        'layout': 'int16 lat*100 [N], int16 lon*100 [N], uint16 depth_km*10 [N], uint8 mag*10 [N], uint8 year-1970 [N]; little-endian; sorted by time',
        'stats': {'deep300': deep, 'maxMag': max(r[5] for r in rows) if rows else None},
        'source': 'USGS ComCat, FDSN event web service (earthquake.usgs.gov/fdsnws/event/1), eventtype=earthquake, M5.0+. Public domain.',
        'built': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%MZ'),
    }
    with open(os.path.join(OUT, 'quakes_m5.json'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'))
    print(f'{n} events, {deep} at 300 km or deeper; bin {8 * n / 1e6:.2f} MB')


if __name__ == '__main__':
    main()
