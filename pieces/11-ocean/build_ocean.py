"""Wind, waves and swell for the globe: one snapshot of NOAA's own models, one run, one valid time.

Run it (from anywhere), about every 6 hours:   python3 pieces/11-ocean/build_ocean.py
Takes under a minute. Needs numpy and Pillow (Pillow decodes the JPEG 2000 images inside the wave files).

Both fields come straight from NOAA NCEP's NOMADS server (US Government work, public domain):
  GFS        weather model, 10 m wind (u = towards east, v = towards north), 0.5 degree file
  GFS-Wave   NCEP's WAVEWATCH III, driven by the same GFS run's winds, 0.25 degree file (we keep every 2nd point)
NOMADS sends GRIB2 files (the standard weather-data format). We fetch only the fields we need: each file has an
".idx" text list giving the byte range of every field, and we ask for just those bytes. About 4.5 MB in 13 requests.

Writes into data/:
  wind_gfs.bin     u and v for every grid point, as small whole numbers (int8, half a m/s per step)
  waves_ww3.bin    nine wave fields for every grid point (uint8, scale in the JSON; 255 = no data: land, ice)
  ocean.json       model names, run, valid time, grid, scales, and the swell at each unlocked spot (from the 0.25 degree grid)

(build_ocean_pacioos.py is the older version that read the University of Hawaii WW3 copy on PacIOOS; kept as a fallback.)
"""
import datetime, json, os, time, urllib.request
import numpy as np
from grib2 import decode_grib2                  # grib2.py in this folder (Python finds it beside the script)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")
NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/"
AGENT = {"User-Agent": "oceany-build-ocean/1.0"}

def get(url, byte_range=None):
    """Download a URL (or part of it) and return the bytes. A short pause after each request keeps us polite to NOMADS."""
    headers = dict(AGENT)
    if byte_range:
        headers["Range"] = "bytes=%d-%s" % byte_range
    data = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120).read()
    time.sleep(0.5)
    return data

def exists(url):
    try:
        urllib.request.urlopen(urllib.request.Request(url, headers=AGENT, method="HEAD"), timeout=60)
        time.sleep(0.5)
        return True
    except Exception:
        return False

# 1. Which moment to show: now, rounded down to the last 3-hour step (the 0.5 degree GFS file is 3-hourly).
#    Which run: the newest one (00, 06, 12 or 18 UTC) whose files for that moment are already on the server.
now = datetime.datetime.now(datetime.timezone.utc)
valid = now.replace(minute=0, second=0, microsecond=0, hour=now.hour - now.hour % 3)
newest_run = valid.replace(hour=valid.hour - valid.hour % 6)    # runs start at 00, 06, 12 and 18 UTC
for back in range(0, 30, 6):                                     # a run takes about 4 hours to appear; try older ones
    run = newest_run - datetime.timedelta(hours=back)
    fhr = int((valid - run).total_seconds() // 3600)
    day, cyc = run.strftime("%Y%m%d"), run.strftime("%H")
    wind_url = f"{NOMADS}gfs.{day}/{cyc}/atmos/gfs.t{cyc}z.pgrb2.0p50.f{fhr:03d}"
    wave_url = f"{NOMADS}gfs.{day}/{cyc}/wave/gridded/gfswave.t{cyc}z.global.0p25.f{fhr:03d}.grib2"
    if exists(wind_url + ".idx") and exists(wave_url + ".idx"):
        break
else:
    raise SystemExit("No complete GFS run found on NOMADS for " + valid.isoformat())
print(f"valid {valid:%Y-%m-%d %H} UTC = GFS run {day} {cyc} UTC + {fhr} h")

# 2. Read the .idx list and fetch only the fields we want. Each line is  number:start_byte:date:NAME:LEVEL:forecast:
def fetch_fields(url, wanted):
    lines = get(url + ".idx").decode().strip().split("\n")
    starts = [int(l.split(":")[1]) for l in lines]
    out = {}
    for k, line in enumerate(lines):
        key = ":".join(line.split(":")[3:5])                     # e.g. "SWELL:1 in sequence"
        if key in wanted:
            end = starts[k + 1] - 1 if k + 1 < len(lines) else ""
            out[wanted[key]] = decode_grib2(get(url, (starts[k], end)))
    missing = set(wanted.values()) - set(out)
    if missing:
        raise SystemExit("missing fields in " + url + ": " + ", ".join(sorted(missing)))
    return out

# 3. Decoding: grib2.py beside this script (one GRIB2 reader for the project; it raises an error on anything it does not know).
#    A GRIB2 field is a list of numbered sections: 3 = the grid, 5 = how the numbers are packed, 6 = which points have
#    data (land has none in the wave file), 7 = the packed numbers. Every value is (R + X * 2^E) / 10^D for whole numbers X.

# 4. Fetch. Wind: 0.5 degree, rows from 90 S (361) x columns from 0 E (720).
wind = fetch_fields(wind_url, {"UGRD:10 m above ground": "u", "VGRD:10 m above ground": "v"})
u, v = wind["u"], wind["v"]
# Waves: T = total sea (height, peak period, peak direction), s = primary swell (partition 1), w = wind sea.
WAVE = {"HTSGW:surface": "Thgt", "PERPW:surface": "Tper", "DIRPW:surface": "Tdir",
        "SWELL:1 in sequence": "shgt", "SWPER:1 in sequence": "sper", "SWDIR:1 in sequence": "sdir",
        "WVHGT:surface": "whgt", "WVPER:surface": "wper", "WVDIR:surface": "wdir"}
fine = fetch_fields(wave_url, WAVE)                               # 0.25 degree, 721 x 1440
NAMES = list(WAVE.values())
fields = {name: fine[name][::2, ::2] for name in NAMES}           # every 2nd point: 361 x 720 at 0.5 degree, true values
for name in ("Tdir", "sdir", "wdir"):
    fine[name] = fine[name] % 360

# 5. Pack into small numbers. Wind: int8, 0.5 m/s per step (range +-63 m/s). Waves: uint8, scale below, 255 = no data.
#    Rounding costs at most 0.25 m/s, 5 cm of height, 0.05 s of period or 1 degree of direction: less than the models' own error.
wind_i8 = np.clip(np.round(np.nan_to_num(np.stack([u, v])) * 2), -127, 127).astype("i1")
SCALE = {"hgt": 0.1, "per": 0.1, "dir": 2.0}                     # metres, seconds, degrees per step
packed = []
for name in NAMES:
    step = SCALE[name[1:]]
    a = fields[name]
    q = np.where(np.isnan(a), 255, np.clip(np.round(np.nan_to_num(a) / step), 0, 254))
    if name.endswith("dir"):
        q = np.where(np.isnan(a), 255, np.round(np.nan_to_num(a) / step) % 180)   # directions wrap: 360 degrees is 0
    packed.append(q.astype("u1"))
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "wind_gfs.bin"), "wb") as f:
    f.write(wind_i8.tobytes())
with open(os.path.join(OUT, "waves_ww3.bin"), "wb") as f:
    f.write(np.stack(packed).tobytes())

# 6. The primary swell at each unlocked spot: the nearest 0.25 degree grid point that has wave data, within 1.5 degrees.
#    (The model cannot see inside a bay or behind a headland; this is the swell offshore of the spot.)
regions = json.load(open(os.path.join(HERE, "..", "07-globe", "regions.json")))["regions"]
lats = np.arange(721) * 0.25 - 90
lons = np.arange(1440) * 0.25
spots = []
for r in regions:
    if r.get("status") != "unlocked":
        continue
    dlat = lats[:, None] - r["lat"]
    dlon = (lons[None, :] - r["lon"] + 180) % 360 - 180
    dist = np.hypot(dlat, dlon * np.cos(np.radians(r["lat"])))  # rough distance in degrees
    dist[np.isnan(fine["shgt"])] = 99                             # skip land and no-data points
    i, j = np.unravel_index(np.argmin(dist), dist.shape)
    if dist[i, j] > 1.5:
        continue
    spots.append({"id": r["id"], "name": r["name"], "lat": r["lat"], "lon": r["lon"], "gridLat": float(lats[i]), "gridLon": float(lons[j]),
                  "swellHeight": round(float(fine["shgt"][i, j]), 2), "swellPeriod": round(float(fine["sper"][i, j]), 1),
                  "swellFrom": round(float(fine["sdir"][i, j])), "totalHeight": round(float(fine["Thgt"][i, j]), 2)})

when = valid.strftime("%Y-%m-%dT%H:00:00Z")
run_text = run.strftime("%Y-%m-%d %H UTC")
meta = {
    "valid": when, "validWaves": when, "built": now.isoformat(timespec="minutes"),
    "wind": {"model": "NOAA NCEP GFS (0.5 degree)", "run": run_text, "forecastHour": fhr, "source": wind_url,
             "grid": {"lat0": -90, "nLat": 361, "lon0": 0, "nLon": 720, "step": 0.5},
             "layout": "int8 u[361][720] then v[361][720], m/s x 2 (u east, v north); rows from 90 S, columns from 0 E"},
    "waves": {"model": "NOAA NCEP GFS-Wave (WAVEWATCH III), forced by the same GFS run's winds (0.25 degree, every 2nd point kept)",
              "run": run_text, "forecastHour": fhr, "source": wave_url,
              "grid": {"lat0": -90, "nLat": 361, "lon0": 0, "nLon": 720, "step": 0.5},
              "fields": NAMES, "scale": {n: SCALE[n[1:]] for n in NAMES}, "noData": 255,
              "layout": "uint8 [9][361][720] in the order of fields; value x scale; directions are 'coming from', degrees clockwise from north"},
    "licence": "NOAA NCEP model output, US Government work, public domain. Not an official product here; not for safety decisions.",
    "spots": spots,
}
with open(os.path.join(OUT, "ocean.json"), "w") as f:
    json.dump(meta, f, indent=1)
print("GFS and GFS-Wave run", run_text, "+", fhr, "h | valid", when)
for s in spots:
    print(f"  {s['name']}: swell {s['swellHeight']} m at {s['swellPeriod']} s from {s['swellFrom']} deg")
