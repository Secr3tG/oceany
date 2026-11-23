"""Snow and sea ice for the globe, from the daily IMS analysis (NOAA / US National Ice Center, via NSIDC G02156).

Run once a day (from anywhere):   python3 pieces/10-sky/build_snow.py
Downloads the newest 24 km Northern Hemisphere file, keeps the snow and sea-ice cells,
and writes data/snow_ims24.bin (the dots) and data/snow_ims24.json (date, counts, source).

The file is a 1024 x 1024 grid of digits, one per 24 km cell:
  0 outside the hemisphere, 1 open water, 2 land without snow, 3 sea or lake ice, 4 snow-covered land.
The grid is a polar stereographic map (looking down on the North Pole), so each cell's
latitude and longitude has to be worked out from its x, y position (the formula below).
"""
import datetime, gzip, json, os, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")
BASE = "https://noaadata.apps.nsidc.org/NOAA/G02156/24km/{y}/ims{y}{d:03d}_00UTC_24km_v1.3.asc.gz"

# 1. Find the newest file: try today's day-of-year, then go back a day at a time (the file is about a day late).
today = datetime.datetime.now(datetime.timezone.utc).date()
for back in range(6):
    day = today - datetime.timedelta(days=back)
    url = BASE.format(y=day.year, d=day.timetuple().tm_yday)
    try:
        raw = urllib.request.urlopen(url, timeout=60).read()
        break
    except Exception as err:          # 404: not published yet, try the day before
        print("not there:", url, err)
else:
    raise SystemExit("No IMS file found in the last 6 days; nothing written.")
print("using", url)

# 2. Read the grid. Header lines are text; data lines are exactly 1024 digits long.
text = gzip.decompress(raw).decode("ascii")
header = [line for line in text.splitlines()[:40] if line.strip()]
rows = [line for line in text.splitlines() if len(line) == 1024 and line.isdigit()]
if len(rows) != 1024:
    raise SystemExit(f"Expected 1024 data rows, found {len(rows)}; nothing written.")
grid = np.array([list(map(int, r)) for r in rows], dtype=np.uint8)
# The first data row is the BOTTOM of the map ("(1,1) starts at lower left"; checked: Greenland comes out as snow).

# 3. Cell centres in metres on the map: 24 km cells, map centred on the North Pole.
n, cell = 1024, 24000.0
c = (np.arange(n) + 0.5) * cell - n * cell / 2
x, y = np.meshgrid(c, c)               # y grows with the row number (row 0 = bottom)

# 4. Map x, y -> latitude, longitude. Polar stereographic on the WGS84 ellipsoid, true scale at 60 N,
#    central meridian 80 W (from NSIDC's grid description). Standard formula (Snyder 1987, eq. 21-38 and 7-9).
a, e = 6378137.0, 0.0818191908426      # Earth's equator radius (m) and how squashed it is
lat_ts, lon0 = np.radians(60.0), -80.0
mc = np.cos(lat_ts) / np.sqrt(1 - (e * np.sin(lat_ts)) ** 2)
tc = np.tan(np.pi / 4 - lat_ts / 2) / ((1 - e * np.sin(lat_ts)) / (1 + e * np.sin(lat_ts))) ** (e / 2)
t = np.hypot(x, y) * tc / (a * mc)
lat = np.pi / 2 - 2 * np.arctan(t)     # first guess (as if the Earth were a sphere) ...
for _ in range(5):                     # ... then a few corrections for the ellipsoid
    lat = np.pi / 2 - 2 * np.arctan(t * ((1 - e * np.sin(lat)) / (1 + e * np.sin(lat))) ** (e / 2))
lat = np.degrees(lat)
lon = (lon0 + np.degrees(np.arctan2(x, -y)) + 180) % 360 - 180

# 5. Keep only snow (4) and sea/lake ice (3), and write them as small integers.
keep = (grid == 3) | (grid == 4)
lat_i = np.round(lat[keep] * 100).astype("<i2")    # hundredths of a degree
lon_i = np.round(lon[keep] * 100).astype("<i2")
code = grid[keep].astype("u1")
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "snow_ims24.bin"), "wb") as f:
    f.write(lat_i.tobytes()); f.write(lon_i.tobytes()); f.write(code.tobytes())

# 6. The date: the file name is the day the analysis is valid for (00 UTC); the header says which day's data went in.
valid = day.isoformat()
data_day = next((h.split(":")[1].strip() for h in header if h.startswith("Julian day")), "")
made = next((h.split(":", 1)[1].strip() for h in header if h.startswith("Processing day")), "")
meta = {"source": url, "valid": valid + " 00 UTC", "dataDayOfYear": data_day, "processed": made,
        "cellKm": 24, "count": int(keep.sum()), "snow": int((code == 4).sum()), "ice": int((code == 3).sum()),
        "built": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="minutes"),
        "layout": "int16 lat*100 [count], int16 lon*100 [count], uint8 code [count]; 3 sea/lake ice, 4 snow on land"}
with open(os.path.join(OUT, "snow_ims24.json"), "w") as f:
    json.dump(meta, f, indent=1)
print(meta["valid"], meta["snow"], "snow cells,", meta["ice"], "ice cells")
