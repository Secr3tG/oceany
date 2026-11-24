#!/usr/bin/env python3
"""Build the "Hurricanes live" layer: tropical cyclones active right now. Writes data/live_storms.json.

For research and play only. Not a forecast or warning service. Not an official product. Do not use for safety decisions.

Sources (all US government, public domain under the NWS disclaimer; see SOURCES.md):
  1. NHC (Atlantic, East and Central Pacific): https://www.nhc.noaa.gov/CurrentStorms.json lists the active storms with
     position, wind, pressure and links. For each storm two zips: the advisory's 5-day forecast shapefile
     (forecastTrack.zipFile: forecast points + cone polygon) and the best track so far (bestTrackGIS.zipFile).
     So: 1 request when nothing is active, 1 + 2 per storm otherwise.
  2. Other basins (West Pacific, Indian Ocean, Southern Hemisphere): NOAA IBTrACS "ACTIVE" CSV (storms active in the
     last 7 days, provisional, updated about three times a week, days behind real time). Shown as "recent track", never
     as live, and without a forecast. JTWC's own warnings are not used (no clear reuse terms; see SOURCES.md).

Run:
    python3 build_hurricanes_live.py                      the real feeds -> data/live_storms.json
    python3 build_hurricanes_live.py --test al142024 012  an archived NHC advisory (Milton, advisory 12, 8 Oct 2024 03 UTC)
                                                          -> data/live_storms_test.json, marked as a test
The globe reads live_storms.json through data-source.js (layer "hurricanes-live"); ?storms_live=test loads the test file.
Standard library only (the shapefiles are read by shapefile_lite.py). Times in the output are UTC, ISO 8601.
"""
import csv, datetime, io, json, math, os, re, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from shapefile_lite import read_zip  # noqa: E402

NHC_JSON = "https://www.nhc.noaa.gov/CurrentStorms.json"
NHC_ARCHIVE_ZIP = "https://www.nhc.noaa.gov/gis/forecast/archive/{id}_5day_{adv}.zip"
NHC_BEST = "https://www.nhc.noaa.gov/gis/best_track/{id}_best_track.zip"
NHC_PUBLIC_ARCHIVE = "https://www.nhc.noaa.gov/archive/{year}/{short}/{id}.public.{adv}.shtml"
ACTIVE_CSV = ("https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-"
              "ibtracs/v04r01/access/csv/ibtracs.ACTIVE.list.v04r01.csv")
AGENT = {"User-Agent": "oceany-layer-build/1.0 (research and play; github.com/Secr3tG/oceany)"}
UTC = datetime.timezone.utc
RECENT_MAX_H = 96          # IBTrACS ACTIVE is left out entirely when its newest record is older than this
RECENT_EDGE_H = 12         # ...and a storm only counts as possibly still active when its last record is within this of
                           # the file's newest record (a storm that stopped earlier has ended; the file keeps 7 days)
CONE_STEP_DEG = 0.12       # cone outline kept every ~13 km (the polygon arrives with ~2,400 points)
DISCLAIMER = ["For research and play only. Not a forecast or warning service.",
              "Not an official product. Do not use for safety decisions."]

# Saffir-Simpson on 1-minute wind in knots (NHC's own scale)
category = lambda kt: 0 if kt is None else 5 if kt >= 137 else 4 if kt >= 113 else 3 if kt >= 96 else 2 if kt >= 83 else 1 if kt >= 64 else 0

# NHC classification codes (CurrentStorms.json `classification`, shapefile STORMTYPE)
KIND = {"TD": "Tropical depression", "TS": "Tropical storm", "HU": "Hurricane", "MH": "Major hurricane",
        "STD": "Subtropical depression", "STS": "Subtropical storm", "SD": "Subtropical depression", "SS": "Subtropical storm",
        "PTC": "Potential tropical cyclone", "PC": "Post-tropical cyclone", "TY": "Typhoon", "STY": "Super typhoon",
        "DB": "Disturbance", "LO": "Low", "EX": "Extratropical", "WV": "Tropical wave"}
TZ = {"UTC": 0, "GMT": 0, "AST": -4, "EDT": -4, "EST": -5, "CDT": -5, "CST": -6, "MDT": -6, "MST": -7,
      "PDT": -7, "PST": -8, "HDT": -9, "HST": -10, "AKDT": -8, "AKST": -9, "CHST": 10}

iso = lambda d: d.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def get(url, timeout=60):
    r = urllib.request.urlopen(urllib.request.Request(url, headers=AGENT), timeout=timeout)
    data = r.read()
    time.sleep(0.5)                       # never more than two requests a second to NOAA
    return data, r.headers


def adv_time(advdate):
    """'1000 PM CDT Mon Oct 07 2024' -> datetime (UTC). None when it does not parse."""
    m = re.match(r"\s*(\d{3,4})\s*(AM|PM)\s+([A-Z]+)\s+\w+\s+(\w+)\s+(\d+)\s+(\d{4})", advdate or "")
    if not m or m.group(3) not in TZ:
        return None
    hhmm, ap, tz, mon, day, year = m.groups()
    h, mi = int(hhmm[:-2]), int(hhmm[-2:])
    h = h % 12 + (12 if ap == "PM" else 0)
    local = datetime.datetime.strptime(f"{year} {mon} {day} {h} {mi}", "%Y %b %d %H %M")
    return (local - datetime.timedelta(hours=TZ[tz])).replace(tzinfo=UTC)


def thin_ring(ring, step):
    """Keep a polygon ring's points at least `step` degrees apart (the first and last always kept)."""
    out = [ring[0]]
    for p in ring[1:]:
        if math.hypot(p[0] - out[-1][0], p[1] - out[-1][1]) >= step:
            out.append(p)
    if out[-1] != ring[-1]:
        out.append(ring[-1])
    return out


def r2(x):
    return round(x, 2)


def forecast_from_zip(zbytes):
    """The 5-day zip -> (forecast points [[lat, lon, kt, tau, validISO]], cone rings [[[lat, lon], ...]], tau-0 attrs)."""
    layers = read_zip(zbytes)
    pts, cone, now_attrs = [], [], None
    for name, rows in layers.items():
        low = name.lower()
        if low.endswith("_pts"):
            adv = None
            for shape, a in sorted(rows, key=lambda r: r[1].get("TAU") or 0):
                lon, lat = shape[1]
                tau = int(a.get("TAU") or 0)
                adv = adv or adv_time(a.get("ADVDATE"))
                v = valid_time(a, adv)
                pts.append([r2(lat), r2(lon), int(a.get("MAXWIND") or 0), tau, iso(v) if v else None])
                if tau == 0:
                    now_attrs = a
        elif low.endswith("_pgn"):
            for shape, a in rows:
                for ring in shape[1]:
                    cone.append([[r2(lat), r2(lon)] for lon, lat in thin_ring(ring, CONE_STEP_DEG)])
    return pts, cone, now_attrs


def valid_time(a, adv):
    """A forecast point's VALIDTIME ('08/0000' = day 8, 00 UTC) as a datetime, in the advisory's month (or the next)."""
    m = re.match(r"(\d+)/(\d\d)(\d\d)", a.get("VALIDTIME") or "")
    if not m or not adv:
        return None
    day, h, mi = map(int, m.groups())
    y, mo = adv.year, adv.month
    if day < adv.day - 15:                                           # crossed into the next month
        y, mo = (y + 1, 1) if mo == 12 else (y, mo + 1)
    return datetime.datetime(y, mo, day, h, mi, tzinfo=UTC)


def past_from_zip(zbytes, until=None):
    """Best-track zip -> [[lat, lon, kt, timeISO]] in time order (only fixes up to `until`, for the test advisory)."""
    rows = []
    for name, recs in read_zip(zbytes).items():
        if not name.lower().endswith("_pts"):
            continue
        for shape, a in recs:
            dtg = a.get("DTG")
            if dtg is None:
                continue
            t = datetime.datetime.strptime(str(int(dtg)), "%Y%m%d%H").replace(tzinfo=UTC)
            if until and t > until:
                continue
            lon, lat = shape[1]
            rows.append((t, [r2(lat), r2(lon), int(a.get("INTENSITY") or 0), iso(t)]))
    return [r for _, r in sorted(rows)]


def num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def nhc_storm(s, zips):
    """One CurrentStorms.json entry (+ its downloaded zips) -> the layer's storm record."""
    kt = num(s.get("intensity"))
    pa = s.get("publicAdvisory") or {}
    fc = s.get("forecastTrack") or s.get("trackCone") or {}
    pts, cone, _ = forecast_from_zip(zips["forecast"]) if zips.get("forecast") else ([], [], None)
    past = past_from_zip(zips["best"]) if zips.get("best") else []
    cls = (s.get("classification") or "").upper()
    return {
        "id": s.get("id"), "source": "NHC", "name": s.get("name"), "classification": cls, "kind": KIND.get(cls, cls),
        "cat": category(kt) if cls in ("HU", "MH") else 0, "windKt": kt, "pressureMb": num(s.get("pressure")),
        "lat": s.get("latitudeNumeric"), "lon": s.get("longitudeNumeric"),
        "moveDir": s.get("movementDir"), "moveKt": s.get("movementSpeed"),
        "advisory": pa.get("advNum") or fc.get("advNum"), "advisoryTime": pa.get("issuance") or s.get("lastUpdate"),
        "positionTime": s.get("lastUpdate"), "link": pa.get("url") or "https://www.nhc.noaa.gov/",
        "forecastAdvisory": fc.get("advNum"), "past": past, "forecast": pts, "cone": cone,
    }


def build_nhc():
    raw, headers = get(NHC_JSON)
    j = json.loads(raw)
    storms = []
    for s in j.get("activeStorms") or []:
        zips = {}
        fz = ((s.get("forecastTrack") or {}).get("zipFile") or (s.get("trackCone") or {}).get("zipFile"))
        bz = (s.get("bestTrackGIS") or s.get("bestTrack") or {}).get("zipFile")
        for key, url in (("forecast", fz), ("best", bz)):
            if url and url.startswith("https://www.nhc.noaa.gov/"):     # only NHC's own host is followed
                try:
                    zips[key] = get(url)[0]
                except Exception as e:                                 # a storm without its zip still gets its dot
                    print(f"{s.get('id')}: {key} zip not read ({e})", file=sys.stderr)
        storms.append(nhc_storm(s, zips))
    return storms, {"etag": headers.get("ETag"), "lastModified": headers.get("Last-Modified")}


def build_test(storm_id, adv):
    """An archived advisory, built exactly as a live one would be (CurrentStorms.json reconstructed from the zip)."""
    fz = get(NHC_ARCHIVE_ZIP.format(id=storm_id, adv=adv))[0]
    pts, cone, a = forecast_from_zip(fz)
    issued = adv_time(a.get("ADVDATE"))
    syn = valid_time(a, issued) or issued                            # hour 0 of the forecast = the storm's position time
    past = past_from_zip(get(NHC_BEST.format(id=storm_id))[0], until=syn)
    cls = (a.get("STORMTYPE") or "").upper()
    kt = a.get("MAXWIND")
    name = re.sub(r"^(Hurricane|Major Hurricane|Tropical Storm|Tropical Depression|Post-Tropical Cyclone|"
                  r"Potential Tropical Cyclone|Subtropical Storm|Subtropical Depression)\s+", "", a.get("STORMNAME") or "")
    lon, lat = pts[0][1], pts[0][0]
    return [{
        "id": storm_id, "source": "NHC", "name": name, "classification": cls, "kind": KIND.get(cls, a.get("TCDVLP") or cls),
        "cat": int(a.get("SSNUM") or category(kt)), "windKt": kt, "pressureMb": a.get("MSLP"), "lat": lat, "lon": lon,
        "moveDir": a.get("TCDIR"), "moveKt": a.get("TCSPD"), "advisory": str(int(adv)), "advisoryTime": iso(issued),
        "positionTime": iso(syn),
        "link": NHC_PUBLIC_ARCHIVE.format(year=storm_id[-4:], short=storm_id[:4], id=storm_id, adv=adv),
        "forecastAdvisory": adv, "past": past, "forecast": pts, "cone": cone,
    }]


def build_recent(skip_ids):
    """IBTrACS ACTIVE: storms outside NHC's basins, last record within RECENT_MAX_H. Provisional, days behind."""
    raw, headers = get(ACTIVE_CSV)
    rd = csv.reader(io.StringIO(raw.decode("utf-8", "replace")))
    head = next(rd); next(rd)                                        # 2nd row = units
    ix = {k: i for i, k in enumerate(head)}
    by = {}
    for r in rd:
        if len(r) < len(head):
            continue
        atcf = (r[ix["USA_ATCF_ID"]] or "").lower()
        if r[ix["BASIN"]] in ("NA", "EP") or atcf[:2] in ("al", "ep", "cp") or atcf in skip_ids:
            continue                                                 # NHC's basins come from NHC itself
        t = datetime.datetime.strptime(r[ix["ISO_TIME"]], "%Y-%m-%d %H:%M:%S").replace(tzinfo=UTC)
        if t.hour % 6 or t.minute:                                   # 6-hourly fixes only (IBTrACS interpolates 3-hourly)
            continue
        w = num(r[ix["USA_WIND"]])
        w = w if w is not None and w >= 0 else num(r[ix["WMO_WIND"]])
        lat, lon = num(r[ix["LAT"]]), num(r[ix["LON"]])
        if lat is None or lon is None:
            continue
        s = by.setdefault(r[ix["SID"]], {"sid": r[ix["SID"]], "name": r[ix["NAME"]].title(), "basin": r[ix["BASIN"]],
                                          "agency": r[ix["USA_AGENCY"]] or r[ix["WMO_AGENCY"]], "pts": []})
        s["pts"].append((t, [r2(lat), r2(((lon + 180) % 360) - 180), int(w) if w is not None else None, iso(t)]))
    now = datetime.datetime.now(UTC)
    for s in by.values():
        s["pts"].sort()
    newest = max((s["pts"][-1][0] for s in by.values()), default=None)
    if not newest or (now - newest).total_seconds() > RECENT_MAX_H * 3600:
        return [], {"lastModified": headers.get("Last-Modified")}
    out = []
    for s in by.values():
        t_last, last = s["pts"][-1]
        if (newest - t_last).total_seconds() > RECENT_EDGE_H * 3600:
            continue
        kt = last[2]
        out.append({"id": s["sid"], "source": "IBTrACS", "name": s["name"] if s["name"] != "Not_Named" else "Unnamed",
                    "basin": s["basin"], "kind": "Tropical cyclone", "cat": category(kt), "windKt": kt, "pressureMb": None,
                    "lat": last[0], "lon": last[1], "positionTime": last[3], "link":
                    "https://www.ncei.noaa.gov/products/international-best-track-archive",
                    "past": [p for _, p in s["pts"]], "forecast": [], "cone": []})
    return out, {"lastModified": headers.get("Last-Modified")}


def main(argv):
    now = datetime.datetime.now(UTC)
    test = "--test" in argv
    if test:
        i = argv.index("--test")
        storms, recent = build_test(argv[i + 1].lower(), argv[i + 2]), []
        src = {"nhc": {"archive": NHC_ARCHIVE_ZIP.format(id=argv[i + 1].lower(), adv=argv[i + 2])}}
    else:
        storms, nhc_meta = build_nhc()
        try:
            recent, act_meta = build_recent({s["id"] for s in storms})
        except Exception as e:                                       # NHC alone is still worth publishing
            print(f"IBTrACS ACTIVE not read ({e})", file=sys.stderr)
            recent, act_meta = [], {"error": str(e)}
        src = {"nhc": nhc_meta, "ibtracsActive": act_meta}
    times = [s["advisoryTime"] for s in storms if s.get("advisoryTime")]
    out = {
        "schema": 1, "built": iso(now), "test": test,
        "dataTime": max(times) if times else iso(now),               # newest advisory, or when we last looked
        "checked": iso(now), "storms": storms, "recent": recent, "sources": src, "disclaimer": DISCLAIMER,
        "credit": ("Active storms: NOAA National Hurricane Center (nhc.noaa.gov), CurrentStorms.json and GIS advisories. "
                   "Other basins: NOAA IBTrACS v04r01 ACTIVE (provisional, days behind). Redrawn by Oceany; "
                   "not official and not endorsed by NOAA/NWS."),
    }
    path = os.path.join(HERE, "data", "live_storms_test.json" if test else "live_storms.json")
    with open(path, "w") as f:
        json.dump(out, f, separators=(",", ":"))
    print(f"{os.path.basename(path)}: {len(storms)} NHC storm(s), {len(recent)} recent other-basin storm(s), "
          f"{os.path.getsize(path)} bytes")


if __name__ == "__main__":
    main(sys.argv[1:])
