"""Where does the whitewater start at Pipeline? Sentinel-2 vs the Stage A model, no tuning.

Run:  python validate_s2.py [--since 2024-01-01] [--until 2026-11-15] [--max-cloud 30]
Writes validation/s2_whitewater.json (numbers only: no image, no frame is saved anywhere).

Method, in plain steps:
  1. Sentinel-2 L2A scenes over the take-off (Element 84 Earth Search STAC, public, no login). Overpass ~21:19 UTC (11:19 HST).
  2. For each scene, read only a small window of the 10 m near-infrared band (B08) straight from the public cloud-optimised
     GeoTIFF (HTTP range reads into memory). Water is black in B08 (reflectance ~0); whitewater (foam) is bright (> 0.1).
  3. Along 9 profiles parallel to the model's reference line (offsets -200..+200 m every 50 m, 314 deg seaward), sample B08
     every 5 m and walk in from the seaward end: the first point with two consecutive samples above FOAM (0.03) is the
     seaward edge of the whitewater on that profile, as a distance s from the line start (the same s as the model's).
     Foam only on the beach and in the swash (s < SHORE_ZONE, one cell past the 0 m LMSL shoreline at 55.7 m) counts as
     "no whitewater on the reef". Cloud test: shortwave infrared (B11, 20 m) above 0.10 on more than 3% of the sea part of
     the profiles. Clouds are bright in B11, while foam and water are dark there. (The L2A scene classification, SCL, marks
     surf foam as cloud, so a first run with SCL threw away exactly the big-surf days; it is not used.) A scene is also
     skipped if the offshore part of the line (s > 900 m) is not dark in B08 (glint, haze).
  4. Swell at the overpass: NDBC 51201 (Waimea Bay, owned by PacIOOS, data from CDIP/Scripps) standard met record nearest
     to the overpass within 35 min: WVHT (total Hs), DPD (dominant period), MWD (direction at DPD). Tide: NOAA CO-OPS
     Honolulu 1612340 observed water level, MSL datum, 6-min, nearest to the overpass (the North Shore has no CO-OPS gauge;
     Honolulu's tide is close in phase and range, about +-0.1 m).
  5. Model: stage_a.run_stage_a(Hs, DPD, MWD, tide, site=PIPELINE), exactly as the viewer's exact path would (no table).
Nothing here feeds back into the model, the take-off point or the reference line.
"""
import argparse
import gzip
import io
import json
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import transform
from rasterio.windows import from_bounds

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "06-live-wave"))
import sites  # noqa: E402
import stage_a as sa  # noqa: E402

S = sites.PIPELINE
M = 111195.0
STAC = "https://earth-search.aws.element84.com/v1/search"
FOAM = 0.03                 # B08 reflectance; open water here reads 0.00 (clipped), foam 0.1-0.6
CLOUD_B11 = 0.10            # B11 reflectance above which a sea sample counts as cloud
SHORE_ZONE = 66.0           # s below this (shoreline 55.7 m + one 10 m cell) is beach / swash, not a reef break
OFFSETS = list(range(-200, 201, 50))
STEP = 5.0
NDBC_DIR = HERE / "data" / "raw" / "ndbc_51201"
OUT = HERE / "validation" / "s2_whitewater.json"


def get(url, data=None, tries=3):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json", "User-Agent": "oceany-validation"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception:
            if k == tries - 1:
                raise
            time.sleep(2 + 3 * k)


def scenes(since, until, max_cloud):
    body = {"collections": ["sentinel-2-l2a"], "intersects": {"type": "Point", "coordinates": [S["takeoff"]["lon"], S["takeoff"]["lat"]]},
            "datetime": f"{since}T00:00:00Z/{until}T23:59:59Z", "query": {"eo:cloud_cover": {"lt": max_cloud}}, "limit": 100}
    out, url, data = [], STAC, json.dumps(body).encode()
    while url:
        d = json.loads(get(url, data))
        for f in d["features"]:
            out.append(dict(id=f["id"], t=f["properties"]["datetime"], cloud=f["properties"]["eo:cloud_cover"],
                            nir=f["assets"]["nir"]["href"], swir=f["assets"]["swir16"]["href"]))
        nxt = [l for l in d.get("links", []) if l.get("rel") == "next"]
        if nxt and nxt[0].get("body"):
            url, data = nxt[0]["href"], json.dumps(nxt[0]["body"]).encode()
        elif nxt:
            url, data = nxt[0]["href"], None
        else:
            url = None
    return out


def profile_lonlat(off, s):
    c = np.cos(np.radians(S["origin_lat"]))
    L, A = np.radians(S["line_deg"]), np.radians(S["along_deg"])
    E = s * np.sin(L) + off * np.sin(A); N = s * np.cos(L) + off * np.cos(A)
    return S["origin_lon"] + E / (M * c), S["origin_lat"] + N / M


def read_window(url, pad=400):
    lo, la = profile_lonlat(0, np.array([0.0, S["s_max"]]))
    with rasterio.open(url) as src:
        xs, ys = transform("EPSG:4326", src.crs, list(lo) + [profile_lonlat(-250, np.array([0.0]))[0][0], profile_lonlat(250, np.array([1290.0]))[0][0]],
                           list(la) + [profile_lonlat(-250, np.array([0.0]))[1][0], profile_lonlat(250, np.array([1290.0]))[1][0]])
        w = from_bounds(min(xs) - pad, min(ys) - pad, max(xs) + pad, max(ys) + pad, src.transform).round_offsets().round_lengths()
        return src.read(1, window=w, boundless=True, fill_value=0), src.window_transform(w), src.crs


def sample(arr, T, crs, off, s):
    lo, la = profile_lonlat(off, s)
    xs, ys = transform("EPSG:4326", crs, list(lo), list(la))
    col = np.floor((np.array(xs) - T.c) / T.a).astype(int); row = np.floor((np.array(ys) - T.f) / T.e).astype(int)
    ok = (row >= 0) & (row < arr.shape[0]) & (col >= 0) & (col < arr.shape[1])
    v = np.full(len(s), np.nan); v[ok] = arr[row[ok], col[ok]]
    return v


def seaward_foam(v, s):
    """Seaward-most s with two consecutive samples above FOAM, walking shoreward; None if none seaward of SHORE_ZONE."""
    for q in range(len(s) - 1, 0, -1):
        if s[q - 1] < SHORE_ZONE:
            return None
        if v[q] > FOAM and v[q - 1] > FOAM:
            return float(s[q])
    return None


def foam_bands(v, s):
    """Foam runs [start, end] (m) seaward of SHORE_ZONE: where the whitewater is on the profile at the overpass."""
    out, a = [], None
    for q in range(len(s)):
        f = s[q] >= SHORE_ZONE and v[q] > FOAM
        if f and a is None:
            a = s[q]
        if not f and a is not None:
            out.append([float(a), float(s[q - 1])]); a = None
    if a is not None:
        out.append([float(a), float(s[-1])])
    return out


def load_ndbc():
    recs = {}
    for f in sorted(NDBC_DIR.glob("51201*.txt*")):
        txt = gzip.open(f, "rt").read() if f.suffix == ".gz" else f.read_text()
        for line in txt.splitlines():
            if line.startswith("#"):
                continue
            p = line.split()
            if len(p) < 12:
                continue
            t = datetime(int(p[0]), int(p[1]), int(p[2]), int(p[3]), int(p[4]), tzinfo=timezone.utc)
            try:
                hs, dpd, mwd = float(p[8]), float(p[9]), float(p[11])
            except ValueError:          # realtime2 writes MM for missing
                continue
            if hs >= 99 or dpd >= 99 or mwd >= 999:
                continue
            recs[t] = (hs, dpd, mwd)
    return recs


def nearest(recs, t, max_min=35):
    best = min(recs, key=lambda k: abs((k - t).total_seconds()), default=None)
    if best is None or abs((best - t).total_seconds()) > max_min * 60:
        return None, None
    return best, recs[best]


def tide_msl(t):
    b = (t - timedelta(minutes=12)).strftime("%Y%m%d %H:%M"); e = (t + timedelta(minutes=12)).strftime("%Y%m%d %H:%M")
    url = ("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=water_level&station=1612340&datum=MSL&units=metric"
           f"&time_zone=gmt&format=json&application=oceany_validation&begin_date={b.replace(' ', '%20')}&end_date={e.replace(' ', '%20')}")
    d = json.loads(get(url))
    v = [(abs((datetime.strptime(x["t"], "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc) - t).total_seconds()), float(x["v"]))
         for x in d.get("data", []) if x.get("v")]
    return min(v)[1] if v else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2022-01-01"); ap.add_argument("--until", default="2026-11-15")
    ap.add_argument("--max-cloud", type=float, default=30)
    a = ap.parse_args()
    recs = load_ndbc()
    print(f"NDBC 51201 records: {len(recs)} ({min(recs):%Y-%m-%d} .. {max(recs):%Y-%m-%d})", flush=True)
    sc = scenes(a.since, a.until, a.max_cloud)
    by_date = {}
    for x in sc:
        by_date.setdefault(x["t"][:10], []).append(x)
    print(f"scenes {len(sc)} on {len(by_date)} dates", flush=True)
    s = np.arange(0.0, S["s_max"] - 1, STEP)
    out = []
    env = rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR", AWS_NO_SIGN_REQUEST="YES", GDAL_HTTP_MAX_RETRY="3", GDAL_HTTP_RETRY_DELAY="2")
    with env:
        for date in sorted(by_date):
            row = dict(date=date)
            t = datetime.fromisoformat(by_date[date][0]["t"].replace("Z", "+00:00"))
            bt, b = nearest(recs, t)
            if b is None:
                row["skip"] = "no NDBC 51201 record within 35 min"; out.append(row); continue
            row.update(scene=None, overpass_utc=t.strftime("%Y-%m-%dT%H:%M"), buoy_utc=bt.strftime("%Y-%m-%dT%H:%M"), hs=b[0], dpd=b[1], mwd=b[2])
            best = None
            for it in sorted(by_date[date], key=lambda x: x["cloud"]):
                try:
                    nir, T, crs = read_window(it["nir"])
                except Exception as e:  # tile does not cover the line
                    continue
                v0 = sample(nir, T, crs, 0, s) * 1e-4 - 0.1
                if np.isnan(v0).mean() > 0.05 or np.nanmax(v0) <= -0.099:
                    continue                                  # no data on the line in this tile
                try:
                    sw, Ts, crs_s = read_window(it["swir"])
                    cl = np.concatenate([sample(sw, Ts, crs_s, o, s)[s >= SHORE_ZONE] for o in OFFSETS]) * 1e-4 - 0.1
                    cloudy = float((cl > CLOUD_B11).mean())
                except Exception:
                    cloudy = None
                off_dark = float(np.nanmedian(v0[s > 900]))
                best = (it, nir, T, crs, cloudy, off_dark); break
            if best is None:
                row["skip"] = "no tile with data on the line"; out.append(row); continue
            it, nir, T, crs, cloudy, off_dark = best
            row.update(scene=it["id"], scene_cloud=round(it["cloud"], 1), b11_cloud_frac=cloudy, offshore_b08=round(off_dark, 3))
            if cloudy is None or cloudy > 0.03 or off_dark > 0.0:
                row["skip"] = "cloud, cloud shadow or glint near the line"; out.append(row); continue
            obs, bands = {}, {}
            for o in OFFSETS:
                v = sample(nir, T, crs, o, s) * 1e-4 - 0.1
                obs[str(o)] = seaward_foam(v, s); bands[str(o)] = foam_bands(v, s)
            row["obs_foam_s"] = obs; row["obs_foam_bands"] = bands
            try:
                row["tide_msl"] = tide_msl(t)
            except Exception as e:
                row["tide_msl"] = None; row["tide_note"] = str(e)[:80]
            tide = row["tide_msl"] if row["tide_msl"] is not None else 0.0
            r = sa.run_stage_a(b[0], b[1], b[2] if b[2] >= 180 else b[2] + 360, tide, site=S)
            if r is None:
                row["model"] = None
            else:
                offs = list(S["profile_offsets"])
                row["model_break_s"] = {str(o): (None if not np.isfinite(r["break_s"][offs.index(o)]) else float(r["break_s"][offs.index(o)])) for o in OFFSETS}
                row["model_state"] = sa.house_state(r, tide, S)
                row["water_edge_s"] = sa.water_edge(tide, site=S)[len(offs) // 2]
            out.append(row)
            print(date, row.get("hs"), row.get("dpd"), row.get("mwd"), row.get("tide_msl"), "obs0", obs.get("0"), "model0",
                  row.get("model_break_s", {}).get("0"), flush=True)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(dict(
        what="Seaward edge of whitewater (Sentinel-2 B08 > 0.03, two consecutive 5 m samples, seaward of s = 66 m) vs Stage A break, per profile offset; "
             "s = metres from the Pipeline reference-line start (sites.PIPELINE). Generated by validate_s2.py.",
        credits=["Contains modified Copernicus Sentinel data (Sentinel-2 L2A, via Element 84 Earth Search / AWS Open Data)",
                 "NDBC 51201 Waimea Bay: data courtesy of CDIP (Scripps) / PacIOOS, via NOAA NDBC; used here for validation only",
                 "NOAA CO-OPS 1612340 Honolulu water level (MSL)"],
        foam_threshold_b08=FOAM, cloud_threshold_b11=CLOUD_B11, shore_zone_s_m=SHORE_ZONE, offsets_m=OFFSETS, rows=out), indent=1))
    print("wrote", OUT, len(out), "dates")




# ---------------------------------------------------------------------------------------------------- summary
# Rules fixed before looking at model-vs-observation differences (they only use the image and the buoy):
#  - whitecaps: if foam covers more than WHITECAP_FRAC of the 9 profiles between s = 700 m and the end, wind-sea whitecaps
#    (or haze) are on the water and the seaward edge of the surf zone cannot be told from them: the day is not scored.
#  - the observed surf-zone edge per profile is the seaward end of the outermost foam band that starts inside s = 700 m;
#    the day's value is the median over the 5 central profiles (-100..+100 m), if at least 3 have one; else "no reef foam".
#  - model: median of the same 5 profiles' break_s (at least 3 breaking), else "no reef break".
WHITECAP_FRAC = 0.02
CENTRAL = ["-100", "-50", "0", "50", "100"]


def summarise(path=OUT):
    d = json.loads(Path(path).read_text()); rows = d["rows"]
    shore = 55.7
    res = []
    for r in rows:
        if "obs_foam_bands" not in r or "model_break_s" not in r:
            continue
        far = sum(max(0.0, b - max(a, 700.0)) for bands in r["obs_foam_bands"].values() for a, b in bands)
        frac = far / (len(OFFSETS) * (S["s_max"] - 2 - 700.0))
        edges = []
        for k in CENTRAL:
            inner = [b for a, b in r["obs_foam_bands"][k] if a < 700.0]
            edges.append(max(inner) if inner else None)
        ok = [e for e in edges if e is not None]
        mod = [r["model_break_s"][k] for k in CENTRAL if r["model_break_s"][k] is not None]
        res.append(dict(date=r["date"], scene=r["scene"], hs=r["hs"], dpd=r["dpd"], mwd=r["mwd"], tide_msl=r["tide_msl"],
                        whitecaps=frac > WHITECAP_FRAC, far_foam_frac=round(frac, 3),
                        obs_from_shore=None if len(ok) < 3 else round(float(np.median(ok)) - shore, 1),
                        model_from_shore=None if len(mod) < 3 else round(float(np.median(mod)) - shore, 1)))
    return res


def print_summary():
    res = summarise()
    (OUT.parent / "s2_summary.json").write_text(json.dumps(res, indent=1))
    scored = [r for r in res if not r["whitecaps"]]
    print(f"used scenes {len(res)}, whitecap days {len(res) - len(scored)}, scored {len(scored)}")
    for r in sorted(scored, key=lambda r: r["hs"]):
        o, m = r["obs_from_shore"], r["model_from_shore"]
        print(f"{r['date']} Hs {r['hs']:.2f} Tp {r['dpd']:.1f} dir {r['mwd']:.0f} tide {r['tide_msl']} | obs {o} model {m} | diff "
              f"{None if o is None or m is None else round(m - o)}")
    return res


if __name__ == "__main__":
    if "--summary" in sys.argv:
        print_summary()
    else:
        main()
        print_summary()
