"""Wind, waves and swell for the globe: NOAA's own models, one run, one valid time per hour from +3 h to +13 h.

Run it (from anywhere) once per GFS run, about 3 h 50 min after 00, 06, 12 and 18 UTC (the refresh workflow does it):
    python3 pieces/11-ocean/build_ocean.py                  the newest run whose files are all on NOMADS
    python3 pieces/11-ocean/build_ocean.py --run 2026112312  that run (the workflow passes the run its check found)
Takes about a minute. Needs numpy and Pillow (Pillow decodes the JPEG 2000 images inside the wave files).

Both fields come straight from NOAA NCEP's NOMADS server (US Government work, public domain):
  GFS        weather model, 10 m wind (u = towards east, v = towards north), 0.25 degree file, hourly (every 2nd point kept)
  GFS-Wave   NCEP's WAVEWATCH III, driven by the same GFS run's winds, 0.25 degree file, hourly (every 2nd point kept)
One run covers the time until the next run is out (about 6 h later) plus a margin: forecast hours STEPS (+3 h to +13 h,
every hour). The globe shows the hour nearest the viewer's clock, so its "now" field moves every hour with no new download.
NOMADS sends GRIB2 files (the standard weather-data format). We fetch only the fields we need: each file has an
".idx" text list giving the byte range of every field, and we ask for just those bytes, neighbouring fields in one request.
About 4 MB in 4-6 requests per hour of forecast, with a pause after each request.

Writes into data/:
  wind_gfs_fNNN.bin   u and v for every grid point at forecast hour NNN, as small whole numbers (int8, half a m/s per step)
  waves_ww3_fNNN.bin  nine wave fields for every grid point (uint8, scale in the JSON; 255 = no data: land, ice)
  wind_gfs.bin, waves_ww3.bin   copies of the hour nearest the build time (older pages and the bundled fallback read these)
  ocean.json       model names, run, grid, scales, the list of hours (steps) with each hour's swell at the unlocked spots,
                   and, at the top, the valid time and spots of the hour nearest the build time
(build_ocean_pacioos.py is the older version that read the University of Hawaii WW3 copy on PacIOOS; kept as a fallback.)
"""
import datetime, json, os, shutil, sys, time, urllib.request
import numpy as np
from grib2 import decode_grib2                  # grib2.py in this folder (Python finds it beside the script)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")
NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/"
AGENT = {"User-Agent": "oceany-build-ocean/1.0"}
STEPS = list(range(3, 14))                      # forecast hours kept from each run (scripts/layer_due.py checks the last one)

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

def urls(run, fhr):
    day, cyc = run.strftime("%Y%m%d"), run.strftime("%H")
    return (f"{NOMADS}gfs.{day}/{cyc}/atmos/gfs.t{cyc}z.pgrb2.0p25.f{fhr:03d}",
            f"{NOMADS}gfs.{day}/{cyc}/wave/gridded/gfswave.t{cyc}z.global.0p25.f{fhr:03d}.grib2")

# 1. Which run: the one given with --run, else the newest (00, 06, 12 or 18 UTC) whose last hour is already on NOMADS.
now = datetime.datetime.now(datetime.timezone.utc)
if "--run" in sys.argv:
    run = datetime.datetime.strptime(sys.argv[sys.argv.index("--run") + 1], "%Y%m%d%H").replace(tzinfo=datetime.timezone.utc)
else:
    newest = now.replace(minute=0, second=0, microsecond=0, hour=now.hour - now.hour % 6)
    for back in range(0, 30, 6):                                  # a run takes about 3.5 hours to appear; try older ones
        run = newest - datetime.timedelta(hours=back)
        if all(exists(u + ".idx") for u in urls(run, STEPS[-1])):
            break
    else:
        raise SystemExit("No complete GFS run found on NOMADS")
print(f"GFS run {run:%Y-%m-%d %H} UTC, hours +{STEPS[0]} to +{STEPS[-1]}")

# 2. Read the .idx list and fetch only the fields we want. Each line is  number:start_byte:date:NAME:LEVEL:forecast:
#    Fields next to each other in the file come in one request, then are cut apart at their start bytes.
def fetch_fields(url, wanted):
    lines = get(url + ".idx").decode().strip().split("\n")
    starts = [int(l.split(":")[1]) for l in lines]
    picked = [k for k, line in enumerate(lines) if ":".join(line.split(":")[3:5]) in wanted]
    groups = []
    for k in picked:
        if groups and groups[-1][-1] == k - 1:
            groups[-1].append(k)
        else:
            groups.append([k])
    out = {}
    for g in groups:
        first, last = g[0], g[-1]
        end = starts[last + 1] - 1 if last + 1 < len(lines) else ""
        blob = get(url, (starts[first], end))
        for k in g:
            a = starts[k] - starts[first]
            b = starts[k + 1] - starts[first] if k + 1 < len(lines) else len(blob)
            out[wanted[":".join(lines[k].split(":")[3:5])]] = decode_grib2(blob[a:b])
    missing = set(wanted.values()) - set(out)
    if missing:
        raise SystemExit("missing fields in " + url + ": " + ", ".join(sorted(missing)))
    return out

# 3. Decoding: grib2.py beside this script (one GRIB2 reader for the project; it raises an error on anything it does not know).
#    A GRIB2 field is a list of numbered sections: 3 = the grid, 5 = how the numbers are packed, 6 = which points have
#    data (land has none in the wave file), 7 = the packed numbers. Every value is (R + X * 2^E) / 10^D for whole numbers X.

# Waves: T = total sea (height, peak period, peak direction), s = primary swell (partition 1), w = wind sea.
WAVE = {"HTSGW:surface": "Thgt", "PERPW:surface": "Tper", "DIRPW:surface": "Tdir",
        "SWELL:1 in sequence": "shgt", "SWPER:1 in sequence": "sper", "SWDIR:1 in sequence": "sdir",
        "WVHGT:surface": "whgt", "WVPER:surface": "wper", "WVDIR:surface": "wdir"}
NAMES = list(WAVE.values())
SCALE = {"hgt": 0.1, "per": 0.1, "dir": 2.0}                     # metres, seconds, degrees per step
regions = json.load(open(os.path.join(HERE, "..", "07-globe", "regions.json")))["regions"]
lats = np.arange(721) * 0.25 - 90
lons = np.arange(1440) * 0.25

def build_step(fhr):
    """Fetch one forecast hour, write its two .bin files, return its entry for ocean.json."""
    wind_url, wave_url = urls(run, fhr)
    # 4. Wind: 0.25 degree file (721 x 1440, rows from 90 S, columns from 0 E); every 2nd point kept, 361 x 720.
    wind = fetch_fields(wind_url, {"UGRD:10 m above ground": "u", "VGRD:10 m above ground": "v"})
    u, v = wind["u"][::2, ::2], wind["v"][::2, ::2]
    fine = fetch_fields(wave_url, WAVE)                           # 0.25 degree, 721 x 1440
    for name in ("Tdir", "sdir", "wdir"):
        fine[name] = fine[name] % 360
    fields = {name: fine[name][::2, ::2] for name in NAMES}       # every 2nd point: 361 x 720 at 0.5 degree, true values
    # 5. Pack into small numbers. Wind: int8, 0.5 m/s per step (range +-63 m/s). Waves: uint8, scale above, 255 = no data.
    #    Rounding costs at most 0.25 m/s, 5 cm of height, 0.05 s of period or 1 degree of direction: less than the models' own error.
    wind_i8 = np.clip(np.round(np.nan_to_num(np.stack([u, v])) * 2), -127, 127).astype("i1")
    packed = []
    for name in NAMES:
        a = fields[name]
        q = np.where(np.isnan(a), 255, np.clip(np.round(np.nan_to_num(a) / SCALE[name[1:]]), 0, 254))
        if name.endswith("dir"):
            q = np.where(np.isnan(a), 255, np.round(np.nan_to_num(a) / SCALE[name[1:]]) % 180)   # directions wrap: 360 is 0
        packed.append(q.astype("u1"))
    wf, vf = f"wind_gfs_f{fhr:03d}.bin", f"waves_ww3_f{fhr:03d}.bin"
    with open(os.path.join(OUT, wf), "wb") as f:
        f.write(wind_i8.tobytes())
    with open(os.path.join(OUT, vf), "wb") as f:
        f.write(np.stack(packed).tobytes())
    # 6. The primary swell at each unlocked spot: the nearest 0.25 degree grid point that has wave data, within 1.5 degrees.
    #    (The model cannot see inside a bay or behind a headland; this is the swell offshore of the spot.)
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
    valid = run + datetime.timedelta(hours=fhr)
    print(f"  +{fhr} h valid {valid:%Y-%m-%d %H} UTC")
    return {"valid": valid.strftime("%Y-%m-%dT%H:00:00Z"), "forecastHour": fhr, "wind": wf, "waves": vf,
            "windSource": wind_url, "waveSource": wave_url, "spots": spots}

os.makedirs(OUT, exist_ok=True)
steps = [build_step(fhr) for fhr in STEPS]
# old hour files from earlier runs are not listed any more: remove them so data/ holds one run
listed = {s["wind"] for s in steps} | {s["waves"] for s in steps}
for f in os.listdir(OUT):
    if (f.startswith("wind_gfs_f") or f.startswith("waves_ww3_f")) and f not in listed:
        os.remove(os.path.join(OUT, f))
# the hour nearest the build time also goes into the single files and the top-level fields
near = min(steps, key=lambda s: abs((datetime.datetime.strptime(s["valid"], "%Y-%m-%dT%H:%M:%SZ")
                                     .replace(tzinfo=datetime.timezone.utc) - now).total_seconds()))
shutil.copyfile(os.path.join(OUT, near["wind"]), os.path.join(OUT, "wind_gfs.bin"))
shutil.copyfile(os.path.join(OUT, near["waves"]), os.path.join(OUT, "waves_ww3.bin"))

run_text = run.strftime("%Y-%m-%d %H UTC")
grid = {"lat0": -90, "nLat": 361, "lon0": 0, "nLon": 720, "step": 0.5}
meta = {
    "valid": near["valid"], "validWaves": near["valid"], "built": now.isoformat(timespec="minutes"),
    "wind": {"model": "NOAA NCEP GFS (0.25 degree, every 2nd point kept)", "run": run_text, "forecastHour": near["forecastHour"],
             "source": near["windSource"], "grid": grid,
             "layout": "int8 u[361][720] then v[361][720], m/s x 2 (u east, v north); rows from 90 S, columns from 0 E"},
    "waves": {"model": "NOAA NCEP GFS-Wave (WAVEWATCH III), forced by the same GFS run's winds (0.25 degree, every 2nd point kept)",
              "run": run_text, "forecastHour": near["forecastHour"], "source": near["waveSource"], "grid": grid,
              "fields": NAMES, "scale": {n: SCALE[n[1:]] for n in NAMES}, "noData": 255,
              "layout": "uint8 [9][361][720] in the order of fields; value x scale; directions are 'coming from', degrees clockwise from north"},
    "licence": "NOAA NCEP model output, US Government work, public domain. Not an official product here; not for safety decisions.",
    "spots": near["spots"],
    "steps": steps,
}
with open(os.path.join(OUT, "ocean.json"), "w") as f:
    json.dump(meta, f, indent=1)
print("GFS and GFS-Wave run", run_text, "| nearest hour", near["valid"], "|", len(steps), "hours")
for s in near["spots"]:
    print(f"  {s['name']}: swell {s['swellHeight']} m at {s['swellPeriod']} s from {s['swellFrom']} deg")
