"""Wave forecast for the globe's time bar: one model run, now to +7 days, packed small for the browser.

Run it (from anywhere):
    python3 pieces/11-ocean/build_forecast.py                      GFS-Wave, newest complete run
    python3 pieces/11-ocean/build_forecast.py --model ecmwf        ECMWF IFS ecWAM, newest complete 00 or 12 UTC run
    python3 pieces/11-ocean/build_forecast.py --run 2026112500     that run
    python3 pieces/11-ocean/build_forecast.py --hours 24           only up to +24 h (quick test)
    python3 pieces/11-ocean/build_forecast.py --wind-only          only add the 10 m wind files to the existing run folder
Takes a few minutes (GFS: about 4 MB downloaded per step, 49 steps). Needs numpy, scipy and Pillow.

Sources (free, no account):
  gfs    NOAA NCEP GFS-Wave (WAVEWATCH III), 0.25 degree global grid. Read from NOAA's open data bucket on AWS
         (noaa-gfs-bdp-pds, NOAA Open Data Dissemination; no rate limit), NOMADS as fallback. Hourly to +120 h, then
         3-hourly to +384 h. US Government work, public domain.
  ecmwf  ECMWF IFS wave model (ecWAM), 0.25 degree, open data (CC BY 4.0), Google Cloud mirror then data.ecmwf.int.
         3-hourly to +144 h, then 6-hourly to +240 h for the 00 and 12 UTC runs (06 and 18 UTC stop at +90 h).
         No swell / wind-sea split in the open data: the total sea only.

Steps kept: every 3 h from +0 to +120 h, then every 6 h to +168 h (STEPS). Beyond 5 days the forecast is shown at
lower detail, and the page says skill drops.

Writes data/forecast/<model>/:
  manifest.json      model, run, attribution, channel list and scales, the two grids, and the steps (forecast hour,
                     valid time, file names)
  hi_fNNN.bin.gz     0.5 degree (361 x 720), steps up to +120 h only (desktop)
  lo_fNNN.bin.gz     1 degree (181 x 360), every step (phones, and desktop beyond +120 h)
  mask_hi.bin.gz, mask_lo.bin.gz   255 where the model has sea at the first step, 0 for land and sea ice
Each .bin is uint8 [6][nLat][nLon], rows from 90 S, columns from 0 E, gzip-compressed (the browser unpacks it with
DecompressionStream). Channels, in order:
  0 Hs    significant wave height of the whole sea, 0.1 m per step
  1 sH    primary swell height, 0.1 m (ECMWF: same as Hs; no split)
  2 wH    wind-sea height, 0.1 m (ECMWF: 0)
  3 sT    primary swell peak period, 0.1 s (ECMWF: peak period of the whole sea, pp1d)
  4 sD    direction the primary swell is GOING, clockwise from north, 256 steps per turn (1.4 degrees)
          (ECMWF: mean wave direction, mwd, turned to 'going')
  5 wD    direction the wind sea is going, same coding (ECMWF: 0; the height is 0 there anyway)
  (the browser turns directions into east / north components before smooth sampling, so 359 and 1 degree blend right)
Wind (10 m, land and sea, no mask), per step, next to the wave files:
  whi_fNNN.bin.gz    0.5 degree (361 x 720), steps up to +120 h only (desktop)
  wlo_fNNN.bin.gz    1 degree (181 x 360), every step
Each .bin is int8 u[nLat][nLon] then v[nLat][nLon], 0.5 m/s per step (same coding as wind_gfs.bin; u towards east,
v towards north), rows from 90 S, columns from 0 E, gzip-compressed. GFS: UGRD / VGRD 10 m above ground from the
same run's pgrb2 0.25 degree file; ECMWF: 10u / 10v from the oper stream. Listed in the manifest under "wind" and,
per step, as "whi" / "wlo" (plus "wpeak": strongest wind of the step).
Land and ice cells hold the nearest sea cell's values, so the browser's smooth (bilinear) sampling has no dark seam
at the coast; the mask says where the sea really is.
"""
import argparse, datetime, gzip, json, os, sys, time, urllib.request
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from scipy import ndimage

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from grib2 import decode_grib2                  # grib2.py in this folder

AGENT = {"User-Agent": "oceany-build-forecast/1.0"}
STEPS = list(range(0, 121, 3)) + list(range(126, 169, 6))
HI_MAX = 120                                     # last forecast hour also written at 0.5 degree
CHANNELS = ["Hs", "sH", "wH", "sT", "sD", "wD"]

ap = argparse.ArgumentParser()
ap.add_argument("--model", choices=["gfs", "ecmwf"], default="gfs")
ap.add_argument("--run", help="YYYYMMDDHH")
ap.add_argument("--hours", type=int, default=STEPS[-1], help="last forecast hour to build")
ap.add_argument("--wind-only", action="store_true", help="add wind files to the existing run folder; waves untouched")
ap.add_argument("--workers", type=int, default=4)
args = ap.parse_args()
steps = [s for s in STEPS if s <= args.hours]
OUT = os.path.join(HERE, "data", "forecast", args.model)


def get(url, byte_range=None, tries=3):
    headers = dict(AGENT)
    if byte_range:
        headers["Range"] = "bytes=%d-%s" % byte_range
    for k in range(tries):
        try:
            return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90).read()
        except Exception as e:
            if k == tries - 1:
                raise
            time.sleep(2 + 3 * k)


def head(url):
    try:
        urllib.request.urlopen(urllib.request.Request(url, headers=AGENT, method="HEAD"), timeout=30)
        return True
    except Exception:
        return False


# ---------- sources ----------
if args.model == "gfs":
    ROOTS = ["https://noaa-gfs-bdp-pds.s3.amazonaws.com/", "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/"]
    WANT = {"HTSGW:surface": "Hs", "WVHGT:surface": "wH", "SWELL:1 in sequence": "sH", "SWPER:1 in sequence": "sT",
            "WVDIR:surface": "wD", "SWDIR:1 in sequence": "sD"}

    def rel(run, fh):
        d, c = run.strftime("%Y%m%d"), run.strftime("%H")
        return f"gfs.{d}/{c}/wave/gridded/gfswave.t{c}z.global.0p25.f{fh:03d}.grib2"

    def ready(run):
        return any(head(r + rel(run, steps[-1]) + ".idx") for r in ROOTS)

    def wind_rel(run, fh):
        d, c = run.strftime("%Y%m%d"), run.strftime("%H")
        return f"gfs.{d}/{c}/atmos/gfs.t{c}z.pgrb2.0p25.f{fh:03d}"

    def fetch(run, fh, relf=rel, WANT=WANT):
        last = None
        for root in ROOTS:
            url = root + relf(run, fh)
            try:
                lines = get(url + ".idx").decode().strip().split("\n")
                break
            except Exception as e:
                last = e
        else:
            raise SystemExit(f"{relf(run, fh)}: not found ({last})")
        starts = [int(l.split(":")[1]) for l in lines]
        picked = [k for k, l in enumerate(lines) if ":".join(l.split(":")[3:5]) in WANT]
        groups = []
        for k in picked:
            if groups and groups[-1][-1] == k - 1:
                groups[-1].append(k)
            else:
                groups.append([k])
        out = {}
        for g in groups:
            end = starts[g[-1] + 1] - 1 if g[-1] + 1 < len(lines) else ""
            blob = get(url, (starts[g[0]], end))
            for k in g:
                a = starts[k] - starts[g[0]]
                b = starts[k + 1] - starts[g[0]] if k + 1 < len(lines) else len(blob)
                out[WANT[":".join(lines[k].split(":")[3:5])]] = decode_grib2(blob[a:b])
        miss = set(WANT.values()) - set(out)
        if miss:
            raise SystemExit(f"{url}: missing {sorted(miss)}")
        return out, url

    WIND_WANT = {"UGRD:10 m above ground": "u", "VGRD:10 m above ground": "v"}

    def fetch_wind(run, fh):
        return fetch(run, fh, wind_rel, WIND_WANT)

    MODEL = "NOAA NCEP GFS-Wave (WAVEWATCH III), forced by GFS winds"
    ATTRIB = "NOAA NCEP model output (US Government work, public domain), from NOAA Open Data Dissemination on AWS. Redrawn here; not an official NOAA product."
    PARTITIONS = True
    CYCLES = (0, 6, 12, 18)
else:
    ROOTS = ["https://storage.googleapis.com/ecmwf-open-data/", "https://data.ecmwf.int/forecasts/"]
    WANT = {"swh": "Hs", "pp1d": "sT", "mwd": "sD"}
    YEAR = datetime.datetime.now(datetime.timezone.utc).year

    def rel(run, fh):
        d, h = run.strftime("%Y%m%d"), run.strftime("%H")
        return f"{d}/{h}z/ifs/0p25/wave/{d}{h}0000-{fh}h-wave-fc"

    def ready(run):
        return any(head(r + rel(run, steps[-1]) + ".index") for r in ROOTS)

    def fetch(run, fh):
        last = None
        for root in ROOTS:
            try:
                idx = [json.loads(l) for l in get(root + rel(run, fh) + ".index").decode().splitlines() if l.strip()]
                break
            except Exception as e:
                last = e
        else:
            raise SystemExit(f"{rel(run, fh)}: not found ({last})")
        url = root + rel(run, fh) + ".grib2"
        picked = sorted((e for e in idx if e.get("param") in WANT), key=lambda e: e["_offset"])
        out = {}
        for e in picked:                                   # three small fields; one request each
            blob = get(url, (e["_offset"], e["_offset"] + e["_length"] - 1))
            g = decode_grib2(blob)
            out[WANT[e["param"]]] = np.roll(g, -g.shape[1] // 2, axis=1)   # IFS columns start at 180 W; ours at 0 E
        miss = set(WANT.values()) - set(out)
        if miss:
            raise SystemExit(f"{url}: missing {sorted(miss)}")
        return out, url

    def fetch_wind(run, fh):
        d, h = run.strftime("%Y%m%d"), run.strftime("%H")
        base = f"{d}/{h}z/ifs/0p25/oper/{d}{h}0000-{fh}h-oper-fc"
        last = None
        for root in ROOTS:
            try:
                idx = [json.loads(l) for l in get(root + base + ".index").decode().splitlines() if l.strip()]
                break
            except Exception as e:
                last = e
        else:
            raise SystemExit(f"{base}: not found ({last})")
        url = root + base + ".grib2"
        out = {}
        for e in idx:
            if e.get("param") in ("10u", "10v") and e.get("levtype") == "sfc":
                g = decode_grib2(get(url, (e["_offset"], e["_offset"] + e["_length"] - 1)))
                out["u" if e["param"] == "10u" else "v"] = np.roll(g, -g.shape[1] // 2, axis=1)
        if set(out) != {"u", "v"}:
            raise SystemExit(f"{url}: missing wind fields")
        return out, url

    MODEL = "ECMWF IFS wave model (ecWAM)"
    ATTRIB = (f"© {YEAR} European Centre for Medium-Range Weather Forecasts (ECMWF). Source: ECMWF open data, IFS. "
              "Licence: CC BY 4.0. ECMWF does not accept any liability whatsoever for any error or omission in the data, "
              "their availability, or for any loss or damage arising from their use. Regridded and rounded here.")
    PARTITIONS = False
    CYCLES = (0, 12)

# ---------- which run ----------
now = datetime.datetime.now(datetime.timezone.utc)
old_manifest, old_steps = None, {}
if args.wind_only:
    old_manifest = json.load(open(os.path.join(OUT, "manifest.json")))
    old_steps = {e["fh"]: e for e in old_manifest["steps"]}
    args.run = datetime.datetime.strptime(old_manifest["run"], "%Y-%m-%dT%H:%M:%SZ").strftime("%Y%m%d%H")
    steps = [s for s in steps if s in old_steps]
if args.run:
    run = datetime.datetime.strptime(args.run, "%Y%m%d%H").replace(tzinfo=datetime.timezone.utc)
else:
    t = now.replace(minute=0, second=0, microsecond=0)
    for back in range(0, 49):
        run = t - datetime.timedelta(hours=back)
        if run.hour in CYCLES and ready(run):
            break
    else:
        raise SystemExit("no complete run found in the last 48 h")
print(f"{args.model}: run {run:%Y-%m-%d %H} UTC, +{steps[0]} to +{steps[-1]} h, {len(steps)} steps", flush=True)


# ---------- pack ----------
def going(deg_from, ok):
    g = (np.where(ok, np.nan_to_num(deg_from), 0) + 180.0) % 360.0
    return (np.round(g / 360.0 * 256) % 256).astype(np.uint8)


def q(v, scale):
    return np.clip(np.round(np.nan_to_num(v, nan=0.0) / scale), 0, 254).astype(np.uint8)


def pack(f, every):
    s = (slice(None, None, every), slice(None, None, every))
    Hs = f["Hs"][s]
    sea = np.isfinite(Hs) & (Hs >= 0)
    if PARTITIONS:
        sH, wH, sT = f["sH"][s], f["wH"][s], f["sT"][s]
        sOk = sea & np.isfinite(sH) & np.isfinite(f["sD"][s]) & (sH > 0)
        wOk = sea & np.isfinite(wH) & np.isfinite(f["wD"][s]) & (wH > 0)
        ch = [q(Hs, .1), q(np.where(sOk, sH, 0), .1), q(np.where(wOk, wH, 0), .1), q(np.where(sOk, sT, 0), .1),
              going(f["sD"][s], sOk), going(f["wD"][s], wOk)]
    else:
        T, D = f["sT"][s], f["sD"][s]
        ok = sea & np.isfinite(D) & np.isfinite(T)
        z = np.zeros(Hs.shape, np.uint8)
        ch = [q(Hs, .1), q(np.where(ok, Hs, 0), .1), z, q(np.where(ok, T, 0), .1), going(D, ok), z]
    a = np.stack(ch)
    # land / ice: copy the nearest sea cell (no seam under bilinear sampling); the mask says where the sea is
    # (only within 3 cells of the sea; deep inland stays 0, which compresses to almost nothing)
    dist, (ii, jj) = ndimage.distance_transform_edt(~sea, return_indices=True)
    a = a[:, ii, jj]
    far = dist > 3
    a[:, far] = 0
    return a, sea


def pack_wind(w, every):
    """int8 u then v, 0.5 m/s per step, rows from 90 S, columns from 0 E; land and sea alike."""
    s = (slice(None, None, every), slice(None, None, every))
    return np.clip(np.round(np.nan_to_num(np.stack([w["u"][s], w["v"][s]])) * 2), -127, 127).astype("i1")


def build_wind(fh, entry):
    w, url = fetch_wind(run, fh)
    for res, every in (("whi", 2), ("wlo", 4)):
        if res == "whi" and fh > HI_MAX:
            continue
        a = pack_wind(w, every)
        name = f"{res}_f{fh:03d}.bin.gz"
        with open(os.path.join(OUT, name), "wb") as o:
            o.write(gzip.compress(a.tobytes(), 9, mtime=0))
        entry[res] = name
        st = 0.25 * every
        sp = np.hypot(a[0].astype(float), a[1].astype(float)) * 0.5
        k = int(np.argmax(sp))
        entry["wpeak"] = {"s": round(float(sp.flat[k]), 1), "lat": round(-90 + st * (k // a.shape[2]), 1),
                          "lon": round(((st * (k % a.shape[2])) + 180) % 360 - 180, 1)}
    entry["windSource"] = url


def build(fh):
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    if args.wind_only:
        entry = old_steps[fh]
        build_wind(fh, entry)
        print(f"  +{fh:3d} h  wind  {time.time() - t0:4.1f} s", flush=True)
        return entry, None
    f, url = fetch(run, fh)
    entry = {"fh": fh, "valid": (run + datetime.timedelta(hours=fh)).strftime("%Y-%m-%dT%H:%M:%SZ"), "source": url}
    masks = {}
    for res, every in (("hi", 2), ("lo", 4)):
        if res == "hi" and fh > HI_MAX:
            continue
        a, sea = pack(f, every)
        name = f"{res}_f{fh:03d}.bin.gz"
        with open(os.path.join(OUT, name), "wb") as o:
            o.write(gzip.compress(a.tobytes(), 9, mtime=0))
        entry[res] = name
        masks[res] = sea
        if res == "hi":
            hs = a[0].astype(float) * 0.1
            hs[~sea] = np.nan
            k = np.nanargmax(hs)
            entry["peak"] = {"hs": round(float(np.nanmax(hs)), 1), "lat": round(-90 + 0.5 * (k // 720), 1),
                             "lon": round(((0.5 * (k % 720)) + 180) % 360 - 180, 1)}
    build_wind(fh, entry)
    print(f"  +{fh:3d} h  {time.time() - t0:4.1f} s", flush=True)
    return entry, masks


with ThreadPoolExecutor(args.workers if args.model == "gfs" else 2) as ex:
    results = list(ex.map(build, steps))
entries = [r[0] for r in results]
WIND = {"scale": 0.5, "layout": "int8 u plane then int8 v plane, m/s = value * scale",
        "grids": {"hi": {"nLon": 720, "nLat": 361, "lat0": -90, "lon0": 0, "step": 0.5},
                  "lo": {"nLon": 360, "nLat": 181, "lat0": -90, "lon0": 0, "step": 1}}}
if args.wind_only:
    old_manifest["steps"] = entries
    old_manifest["wind"] = WIND
    with open(os.path.join(OUT, "manifest.json"), "w") as o:
        json.dump(old_manifest, o, indent=1)
    size = sum(os.path.getsize(os.path.join(OUT, e[k])) for e in entries for k in ("whi", "wlo") if e.get(k))
    print(f"wind added to {OUT}: {len(entries)} steps, {size / 1e6:.1f} MB")
    sys.exit(0)
for res in ("hi", "lo"):
    m = results[0][1][res]
    with open(os.path.join(OUT, f"mask_{res}.bin.gz"), "wb") as o:
        o.write(gzip.compress(np.where(m, 255, 0).astype(np.uint8).tobytes(), 9, mtime=0))

manifest = {
    "model": MODEL, "modelId": args.model, "run": run.strftime("%Y-%m-%dT%H:%M:%SZ"),
    "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "attribution": ATTRIB, "partitions": PARTITIONS,
    "channels": CHANNELS, "scale": {"Hs": 0.1, "sH": 0.1, "wH": 0.1, "sT": 0.1}, "direction": "value / 256 x 360 = degrees clockwise from north, direction going",
    "grids": {"hi": {"nLat": 361, "nLon": 720, "lat0": -90, "step": 0.5, "mask": "mask_hi.bin.gz"},
              "lo": {"nLat": 181, "nLon": 360, "lat0": -90, "step": 1.0, "mask": "mask_lo.bin.gz"}},
    "layout": "gzip of uint8 [6][nLat][nLon], rows from 90 S, columns from 0 E, channels in the order of 'channels'",
    "wind": WIND,
    "steps": entries,
    "note": "Model output, not measurement. For research and play only. Not a forecast or warning service.",
}
with open(os.path.join(OUT, "manifest.json"), "w") as o:
    json.dump(manifest, o, indent=1)
size = sum(os.path.getsize(os.path.join(dp, fn)) for dp, _, fs in os.walk(OUT) for fn in fs)
print(f"wrote {OUT}: {len(entries)} steps, {size / 1e6:.1f} MB")
