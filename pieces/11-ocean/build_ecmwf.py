"""Wind and waves from ECMWF's IFS, the European model, next to NOAA's GFS: the same files and grid the globe already reads.

Run it (from anywhere) once per IFS run (the refresh workflow does it, timed to ECMWF's open-data release):
    python3 pieces/11-ocean/build_ecmwf.py                  the newest run whose files are all out
    python3 pieces/11-ocean/build_ecmwf.py --run 2026112312  that run (the workflow passes the run its check found)
Takes about a minute. Needs numpy and imagecodecs (ECMWF packs its numbers with CCSDS compression; grib2.py decodes it).

Source: ECMWF open data, IFS at 0.25 degree, real time, licence CC BY 4.0 (attribution required; see SOURCES.md).
  oper stream   10u, 10v     10 m wind (u = towards east, v = towards north), m/s
  wave stream   swh          significant wave height of the total sea (wind sea + swell), m
                pp1d         peak period, s (the same quantity as GFS-Wave's PERPW, so the two models compare like for like)
                mwp          mean period, s (shorter than the peak period; GFS-Wave's files have no total mean period)
                mwd          mean direction the waves come from, degrees clockwise from north (GFS-Wave gives the peak's)
The open data has no swell partitions, so the swell-fronts layer stays on GFS-Wave whichever model is chosen.
IFS steps are every 3 hours (GFS: every hour). Runs at 00, 06, 12 and 18 UTC. Each run's open data appears all at once,
about 7 h 34 min after 00/12 UTC and 6 h 27 min after 06/18 UTC (Last-Modified of every step, checked 22-23 Nov 2026,
matching the end of ECMWF's dissemination schedule). One run is kept from +6 h to +18 h, which covers the time until
the next run is out plus a margin; the globe shows the step nearest the viewer's clock, as it does for GFS.

Files come from Google Cloud's copy of ECMWF open data (allows byte ranges, about 2 minutes behind ECMWF's own portal);
data.ecmwf.int is the fallback. Each GRIB2 file has a ".index" list (one JSON line per field, with _offset and _length),
so we fetch only the fields we need, neighbouring fields in one request. About 4 MB per step.

Writes into data/ (the same layouts as build_ocean.py, so the globe's loader reads both):
  wind_ifs_fNNN.bin   int8 u[361][720] then v[361][720], half a m/s per step; rows from 90 S, columns from 0 E
  waves_ifs_fNNN.bin  uint8 [4][361][720]: Thgt, Tper, Tdir, mper (scale in the JSON; 255 = no data: land, sea ice)
  wind_ifs.bin, waves_ifs.bin   copies of the step nearest the build time
  ocean_ecmwf.json   model names, run, grid, scales, licence and attribution, the list of steps
"""
import datetime, json, os, shutil, sys, time, urllib.request
import numpy as np
from grib2 import decode_grib2                  # grib2.py in this folder

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data")
MIRRORS = ["https://storage.googleapis.com/ecmwf-open-data/", "https://data.ecmwf.int/forecasts/"]
AGENT = {"User-Agent": "oceany-build-ecmwf/1.0"}
STEPS = [6, 9, 12, 15, 18]                      # forecast hours kept (scripts/layer_due.py checks the last one)
YEAR = datetime.datetime.now(datetime.timezone.utc).year
ATTRIBUTION = (f"© {YEAR} European Centre for Medium-Range Weather Forecasts (ECMWF). Source: ECMWF open data, "
               "IFS. Licence: CC BY 4.0. ECMWF does not accept any liability whatsoever for any error or omission in "
               "the data, their availability, or for any loss or damage arising from their use. Regridded and rounded here.")

def get(url, byte_range=None):
    """Download a URL (or bytes a..b of it). A short pause after each request keeps us polite."""
    headers = dict(AGENT)
    if byte_range:
        headers["Range"] = "bytes=%d-%d" % byte_range
    data = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120).read()
    time.sleep(0.3)
    return data

def get_any(path, byte_range=None):
    """The same file from the first mirror that answers."""
    err = None
    for root in MIRRORS:
        try:
            return get(root + path, byte_range), root
        except Exception as e:
            err = e
    raise SystemExit(f"{path}: not on any mirror ({err})")

def path(run, step, stream):
    day, hh = run.strftime("%Y%m%d"), run.strftime("%H")
    return f"{day}/{hh}z/ifs/0p25/{stream}/{day}{hh}0000-{step}h-{stream}-fc"

def exists(p):
    for root in MIRRORS:
        try:
            urllib.request.urlopen(urllib.request.Request(root + p, headers=AGENT, method="HEAD"), timeout=60)
            return True
        except Exception:
            pass
        finally:
            time.sleep(0.3)
    return False

# 1. Which run: --run, else the newest whose last kept step is out on a mirror.
now = datetime.datetime.now(datetime.timezone.utc)
if "--run" in sys.argv:
    run = datetime.datetime.strptime(sys.argv[sys.argv.index("--run") + 1], "%Y%m%d%H").replace(tzinfo=datetime.timezone.utc)
else:
    newest = now.replace(minute=0, second=0, microsecond=0, hour=now.hour - now.hour % 6)
    for back in range(0, 30, 6):
        run = newest - datetime.timedelta(hours=back)
        if exists(path(run, STEPS[-1], "wave") + ".index") and exists(path(run, STEPS[-1], "oper") + ".index"):
            break
    else:
        raise SystemExit("No complete IFS run found")
print(f"ECMWF IFS run {run:%Y-%m-%d %H} UTC, steps +{STEPS[0]} to +{STEPS[-1]} h")

def fetch_fields(p, wanted):
    """Fields named in `wanted` ({ecmwf param: our name}) from one file, as 721 x 1440 grids rows from the south, 0 E first."""
    raw, root = get_any(p + ".index")
    index = [json.loads(line) for line in raw.decode().splitlines() if line.strip()]
    picked = sorted((e for e in index if e.get("param") in wanted and e.get("levtype", "sfc") == "sfc"), key=lambda e: e["_offset"])
    groups = []                                   # fields stored next to each other come in one request
    for e in picked:
        if groups and groups[-1][-1]["_offset"] + groups[-1][-1]["_length"] == e["_offset"]:
            groups[-1].append(e)
        else:
            groups.append([e])
    out = {}
    for g in groups:
        a, b = g[0]["_offset"], g[-1]["_offset"] + g[-1]["_length"] - 1
        blob = get(root + p + ".grib2", (a, b))
        for e in g:
            grid = decode_grib2(blob[e["_offset"] - a: e["_offset"] - a + e["_length"]])
            # IFS columns start at 180 E (= 180 W); GFS's start at 0 E. Roll half a turn so both share one layout.
            out[wanted[e["param"]]] = np.roll(grid, -grid.shape[1] // 2, axis=1)
    missing = set(wanted.values()) - set(out)
    if missing:
        raise SystemExit(f"missing fields in {p}: {', '.join(sorted(missing))}")
    return out, root

NAMES = ["Thgt", "Tper", "Tdir", "mper"]
SCALE = {"Thgt": 0.1, "Tper": 0.1, "Tdir": 2.0, "mper": 0.1}      # metres, seconds, degrees, seconds per step
regions = json.load(open(os.path.join(HERE, "..", "07-globe", "regions.json")))["regions"]
lats = np.arange(721) * 0.25 - 90
lons = np.arange(1440) * 0.25

def build_step(step):
    wind, root = fetch_fields(path(run, step, "oper"), {"10u": "u", "10v": "v"})
    fine, _ = fetch_fields(path(run, step, "wave"), {"swh": "Thgt", "pp1d": "Tper", "mwd": "Tdir", "mwp": "mper"})
    fine["Tdir"] = fine["Tdir"] % 360
    u, v = wind["u"][::2, ::2], wind["v"][::2, ::2]               # every 2nd point: 361 x 720 at 0.5 degree, as GFS
    wind_i8 = np.clip(np.round(np.nan_to_num(np.stack([u, v])) * 2), -127, 127).astype("i1")
    packed = []
    for name in NAMES:
        a = fine[name][::2, ::2]
        q = np.clip(np.round(np.nan_to_num(a) / SCALE[name]), 0, 254)
        if name == "Tdir":
            q = np.round(np.nan_to_num(a) / SCALE[name]) % 180                # directions wrap: 360 is 0
        packed.append(np.where(np.isnan(a), 255, q).astype("u1"))
    wf, vf = f"wind_ifs_f{step:03d}.bin", f"waves_ifs_f{step:03d}.bin"
    with open(os.path.join(OUT, wf), "wb") as f:
        f.write(wind_i8.tobytes())
    with open(os.path.join(OUT, vf), "wb") as f:
        f.write(np.stack(packed).tobytes())
    # the total sea at each unlocked spot: nearest 0.25 degree point with wave data, within 1.5 degrees (offshore of the spot)
    spots = []
    for r in regions:
        if r.get("status") != "unlocked":
            continue
        dlon = (lons[None, :] - r["lon"] + 180) % 360 - 180
        dist = np.hypot(lats[:, None] - r["lat"], dlon * np.cos(np.radians(r["lat"])))
        dist[np.isnan(fine["Thgt"])] = 99
        i, j = np.unravel_index(np.argmin(dist), dist.shape)
        if dist[i, j] > 1.5:
            continue
        spots.append({"id": r["id"], "name": r["name"], "lat": r["lat"], "lon": r["lon"], "gridLat": float(lats[i]),
                      "gridLon": float(lons[j]), "totalHeight": round(float(fine["Thgt"][i, j]), 2),
                      "peakPeriod": round(float(fine["Tper"][i, j]), 1), "meanPeriod": round(float(fine["mper"][i, j]), 1),
                      "meanFrom": round(float(fine["Tdir"][i, j])),
                      "windU": round(float(wind["u"][i, j]), 1), "windV": round(float(wind["v"][i, j]), 1)})
    valid = run + datetime.timedelta(hours=step)
    print(f"  +{step} h valid {valid:%Y-%m-%d %H} UTC ({root})")
    return {"valid": valid.strftime("%Y-%m-%dT%H:00:00Z"), "forecastHour": step, "wind": wf, "waves": vf,
            "windSource": root + path(run, step, "oper") + ".grib2", "waveSource": root + path(run, step, "wave") + ".grib2",
            "spots": spots}

os.makedirs(OUT, exist_ok=True)
steps = [build_step(s) for s in STEPS]
listed = {s["wind"] for s in steps} | {s["waves"] for s in steps}
for f in os.listdir(OUT):                        # step files of older runs are no longer listed: remove them
    if (f.startswith("wind_ifs_f") or f.startswith("waves_ifs_f")) and f not in listed:
        os.remove(os.path.join(OUT, f))
near = min(steps, key=lambda s: abs((datetime.datetime.strptime(s["valid"], "%Y-%m-%dT%H:%M:%SZ")
                                     .replace(tzinfo=datetime.timezone.utc) - now).total_seconds()))
shutil.copyfile(os.path.join(OUT, near["wind"]), os.path.join(OUT, "wind_ifs.bin"))
shutil.copyfile(os.path.join(OUT, near["waves"]), os.path.join(OUT, "waves_ifs.bin"))

run_text = run.strftime("%Y-%m-%d %H UTC")
grid = {"lat0": -90, "nLat": 361, "lon0": 0, "nLon": 720, "step": 0.5}
meta = {
    "modelId": "ecmwf", "valid": near["valid"], "validWaves": near["valid"], "built": now.isoformat(timespec="minutes"),
    "stepHours": 3,
    "wind": {"model": "ECMWF IFS (0.25 degree, every 2nd point kept)", "short": "ECMWF IFS", "run": run_text,
             "forecastHour": near["forecastHour"], "source": near["windSource"], "grid": grid,
             "layout": "int8 u[361][720] then v[361][720], m/s x 2 (u east, v north); rows from 90 S, columns from 0 E"},
    "waves": {"model": "ECMWF IFS wave model (ecWAM), coupled to the IFS atmosphere (0.25 degree, every 2nd point kept)",
              "short": "ECMWF ecWAM", "run": run_text, "forecastHour": near["forecastHour"], "source": near["waveSource"],
              "grid": grid, "fields": NAMES, "scale": SCALE, "noData": 255,
              "fieldNotes": {"Thgt": "significant wave height (swh)", "Tper": "peak period (pp1d)",
                             "Tdir": "mean direction, coming from (mwd)", "mper": "mean period (mwp)"},
              "layout": "uint8 [4][361][720] in the order of fields; value x scale; directions are 'coming from', degrees clockwise from north"},
    "licence": "CC BY 4.0",
    "attribution": ATTRIBUTION,
    "spots": near["spots"],
    "steps": steps,
}
with open(os.path.join(OUT, "ocean_ecmwf.json"), "w") as f:
    json.dump(meta, f, indent=1)
print("ECMWF IFS run", run_text, "| nearest step", near["valid"], "|", len(steps), "steps")
for s in near["spots"]:
    print(f"  {s['name']}: {s['totalHeight']} m, peak {s['peakPeriod']} s, mean {s['meanPeriod']} s, from {s['meanFrom']} deg")
