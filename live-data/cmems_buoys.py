"""Find CMEMS INSITU wave platforms near spots using index_latest.txt.
Usage: python live-data/cmems_buoys.py [--refresh] [--hours 48] [--km 150] [--fetch PLATFORM_CODE ...]
Index is cached in live-data/cache/index_latest.txt (44 MB, keep out of git) (cm.get also fetches ~270MB of other index parts; we delete them).
Needs prior `copernicusmarine login`. Stdlib + copernicusmarine (+xarray for --fetch printing).
"""
import re, argparse, csv, datetime as dt, math, os, sys, glob
import copernicusmarine as cm

DS = "cmems_obs-ins_glo_phybgcwav_mynrt_na_irr"
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "cache")
SPOTS = {"Klitmoller": (57.04, 8.49), "HvideSande": (56.00, 8.10),
         "Peniche": (39.37, -9.38), "TelAviv": (32.08, 34.76)}
WAVE = {"VHM0", "VAVH", "VTPK", "VGHS", "VTM02", "VMDR"}

def hav(a, b, c, d):
    p = math.pi / 180
    x = math.sin((c - a) * p / 2) ** 2 + math.cos(a * p) * math.cos(c * p) * math.sin((d - b) * p / 2) ** 2
    return 12742 * math.asin(math.sqrt(x))

def refresh():
    os.makedirs(OUT, exist_ok=True)
    cm.get(dataset_id=DS, dataset_part="latest", index_parts=True, no_directories=True,
           output_directory=OUT, overwrite=True, disable_progress_bar=True, filter="*index_latest.txt")
    for f in ("index_history.txt", "index_monthly.txt"):
        try: os.remove(os.path.join(OUT, f))
        except OSError: pass

def scan(hours, km):
    path = os.path.join(OUT, "index_latest.txt")
    cutoff = dt.datetime.utcnow() - dt.timedelta(hours=hours)
    best = {}  # (spot, platform) -> record
    with open(path, encoding="utf-8") as fh:
        for row in csv.reader(l for l in fh if not l.startswith("#")):
            if len(row) < 12: continue
            plat, fn, la0, la1, lo0, lo1, t0, t1, inst, upd, mode, params = row[:12]
            vars_ = WAVE & set(params.split())
            if not vars_ or not ("VHM0" in vars_ or "VAVH" in vars_ or "VTPK" in vars_): continue
            try:
                end = dt.datetime.strptime(t1, "%Y-%m-%dT%H:%M:%SZ")
                lat, lon = (float(la0) + float(la1)) / 2, (float(lo0) + float(lo1)) / 2
            except ValueError: continue
            if end < cutoff: continue
            plat0 = plat
            for s, (a, b) in SPOTS.items():
                d = hav(a, b, lat, lon)
                if d <= km:
                    plat = re.sub(r"_\d{8}$", "", os.path.basename(fn).replace(".nc", ""))  # platform id = file stem minus date
                    k = (s, plat)
                    if k not in best or end > best[k]["end"]:
                        best[k] = dict(spot=s, plat=plat, lat=lat, lon=lon, d=d, end=end, inst=inst, vars=sorted(vars_), file=fn)
    return sorted(best.values(), key=lambda r: (r["spot"], r["d"]))

def fetch(rec):
    d = os.path.join(OUT, "files_" + rec["plat"]); os.makedirs(d, exist_ok=True)
    cm.get(dataset_id=DS, dataset_part="latest", filter="*" + os.path.basename(rec["file"]), no_directories=True,
           output_directory=d, overwrite=True, disable_progress_bar=True)
    import xarray as xr
    f = glob.glob(os.path.join(d, "*.nc"))[0]
    ds = xr.open_dataset(f)
    for v in ("VHM0", "VAVH", "VTPK", "VMDR"):
        if v in ds:
            a = ds[v].squeeze(); a = a.where(a.notnull(), drop=True) if a.ndim else a
            if a.size: print(f"   {rec['plat']} {v} = {float(a.values.ravel()[-1]):.2f} at {str(ds['TIME'].values.ravel()[-1])[:16]}Z")

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true"); ap.add_argument("--hours", type=float, default=48)
    ap.add_argument("--km", type=float, default=150); ap.add_argument("--top", type=int, default=4); ap.add_argument("--fetch", nargs="*", default=[])
    a = ap.parse_args()
    if a.refresh or not os.path.exists(os.path.join(OUT, "index_latest.txt")): refresh()
    recs = scan(a.hours, a.km)
    seen = {}
    for r in recs:
        seen[r["spot"]] = seen.get(r["spot"], 0) + 1
        if seen[r["spot"]] > a.top: continue
        print(f"{r['spot']:11} {r['plat']:14} {r['d']:6.1f}km {r['lat']:.3f},{r['lon']:.3f} {','.join(r['vars'])} end={r['end']:%Y-%m-%d %H:%M}Z {r['inst'][:30]}")
    for r in recs:
        if r["plat"] in a.fetch: fetch(r)
