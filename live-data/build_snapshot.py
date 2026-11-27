"""Write one small JSON per spot with every connected feed side by side: live-data/snapshots/<spot>.json

Run:  python build_snapshot.py [--spots porto_batel klitmoller ...]
      python build_snapshot.py --public [--spots ...]   slim live/<spot>.json for the static site, only the
      feeds spots.py lists as `public` (every spot has one; the viewer reads nothing else)
No Open-Meteo (2026-11-23, free tier non-commercial): waves and wind from NOAA GFS-Wave (public domain, NOMADS), plus
Copernicus / DMI where they cover the spot; tide from Copernicus regional sea level or NOAA CO-OPS (feeds.py).
Each snapshot holds: the forecast series from each model, the latest buoy observations, a model-vs-buoy comparison
over the last 48 h (bias and RMSE of Hs, and of the period where both sides have the same kind), fetch time,
attribution and licence per source. For spots with a Stage A lookup (Porto Batel) it adds, per model and forecast
hour, the four lookup inputs (Hs, Tp, direction, tide above LAT).
A feed that fails is written as status "unavailable" with the reason; the others still go out.
Nothing here schedules itself: how often this runs is a decision for Benn.
"""
import argparse
import datetime as dt
import json
import math
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))   # -I drops the script folder from the path
import feeds  # noqa: E402
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "pieces", "06-live-wave"))
from spots import SPOTS  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "snapshots")
MSL_MINUS_LAT, DATUM_UNC = SPOTS["porto_batel"]["msl_to_map_m"], [0.1, 0.3]   # LAT = MSL - 1.66 m (spots.json)
LOOKUP_RANGE = dict(hs=(0.5, 5.0), tp=(6, 20), dir=(250, 360), tide_lat=(0.0, 4.0))   # pieces/06-live-wave/lookup/
# Per reef-model site (spots.py stage_a_site): offset from the tide feed's MSL to the site's map datum, table range, wording.
# Porto Batel keeps the original constants. Pipeline: the lidar is on LMSL and the CO-OPS station MSL is taken as LMSL (offset 0, not checked).
STAGE_A_SITES = {
    "porto_batel": dict(site=None, msl_to_map=MSL_MINUS_LAT, range=LOOKUP_RANGE, lookup="pieces/06-live-wave/lookup/index.json",
                        datum=f"tide_lat = msl + {MSL_MINUS_LAT} m", unc=DATUM_UNC,
                        hs_note="forecast Hs is used as the lookup's H0 (height at the reef domain edge, ~14 m deep)",
                        geometry="offsets -600..600 m every 25 m, line 236 deg, along 326 deg from the house"),
    "pipeline": dict(site="pipeline", msl_to_map=SPOTS["pipeline"]["msl_to_map_m"], range=dict(hs=(0.5, 8.0), tp=(8, 22), dir=(270, 390), tide_lat=(-0.3, 0.9)),
                     lookup="pieces/06-live-wave/lookup_pipeline/index.json",
                     datum="tide_lat = CO-OPS Honolulu MSL prediction, taken as height above LMSL at Pipeline (the lidar datum; offset and timing not checked)", unc=None,
                     hs_note="forecast Hs is used as H0 at the seaward edge of the lidar (~1.2 km out, 14-35 m deep, ~17 m off Pipeline)",
                     geometry="offsets -600..600 m every 25 m, line 314 deg, along 44 deg from the line start 100 m landward of the take-off"),
}


def hourly_obs(recs):
    """Observation records -> {hour: record nearest that full hour, within 30 min}."""
    best = {}
    for r in recs:
        t = dt.datetime.strptime(r["time_utc"], "%Y-%m-%dT%H:%M")
        h = (t + dt.timedelta(minutes=30)).replace(minute=0)
        off = abs((t - h).total_seconds())
        k = h.strftime("%Y-%m-%dT%H:%M")
        if off <= 1800 and (k not in best or off < best[k][0]):
            best[k] = (off, r)
    return {k: v[1] for k, v in best.items()}


def stats(pairs):
    if not pairs:
        return None
    d = [m - o for m, o in pairs]
    return dict(n=len(d), bias=round(sum(d) / len(d), 3), rmse=round(math.sqrt(sum(x * x for x in d) / len(d)), 3))


def compare(model, obs, now_s):
    m = {r["time_utc"]: r for r in model["records"] if r["time_utc"] <= now_s}
    o = hourly_obs(obs["records"])
    out = dict(model=model["source"], buoy=obs["source"], window_h=feeds.HOURS_BACK, sign="model minus buoy")
    a, b = model.get("point") or {}, obs.get("point") or {}
    if all(isinstance(x.get(k), (int, float)) for x in (a, b) for k in ("lat", "lon")):
        cl = math.cos(math.radians(a["lat"]))
        out["km_model_point_to_buoy"] = round(111.195 * math.hypot(a["lat"] - b["lat"], (a["lon"] - b["lon"]) * cl), 1)
        out["note"] = "the model value is at the spot's grid cell, not at the buoy; a large distance makes this a regional check only"
    for field, label in (("hs", "hs_m"), ("tp", "tp_peak_s"), ("tm", "t_mean_s")):
        pairs = [(m[k][field], o[k][field]) for k in m if k in o and field in m[k] and field in o[k]]
        s = stats(pairs)
        if s:
            out[label] = s
    if "t_mean_s" in out:
        out["t_mean_note"] = "mean-period definitions differ between sources (Tm01 / Tm02 / Tz); read as indicative"
    return out if "hs_m" in out else None


def tz_check(a, b):
    """Hs RMSE between two observation series of the same buoy at lags -2..+2 h (b shifted)."""
    oa, ob = hourly_obs(a["records"]), hourly_obs(b["records"])
    res = {}
    for lag in (-2, -1, 0, 1, 2):
        pairs = []
        for k, r in oa.items():
            t = (dt.datetime.strptime(k, "%Y-%m-%dT%H:%M") + dt.timedelta(hours=lag)).strftime("%Y-%m-%dT%H:%M")
            if t in ob:
                pairs.append((r["hs"], ob[t]["hs"]))
        s = stats(pairs)
        if s:
            res[str(lag)] = s
    return res


def stage_a_period(r):
    """The period fed to Stage A. The lookup is built for one regular wave of period Tp, and the period that sets its
    wavelength over the reef is the spectral peak of the swell. NOAA GFS-Wave: the swell partition's peak period (SWPER 1)
    for the whole run. Copernicus gives no swell-partition peak: when the primary swell carries more
    energy than the wind sea (VHM0_SW1 >= VHM0_WW) the whole-sea peak VTPK sits on the swell, so VTPK is the closest
    available value; otherwise VTPK would be the wind-sea peak, and the swell mean period VTM01_SW1 is used (shorter than a
    peak period, so the modelled waves feel the bottom later). Same rule in live.js."""
    if r.get("swell_tp_kind") == "peak":
        return r["swell_tp"], "peak"
    if "tp" in r and r.get("swell_hs", 0) >= r.get("wind_sea_hs", float("inf")):
        return r["tp"], "peak (whole-sea VTPK, swell-dominated)"
    return r["swell_tp"], "mean (swell partition)"


def _stage_a_row(q):
    """Worker: one exact Stage A run (pieces/06-live-wave/stage_a.py) for one forecast hour. q[4]: sites.py key or None."""
    import stage_a as sa
    import sites
    hs, tp, d, tide = q[:4]
    site = sites.SITES[q[4]] if len(q) > 4 and q[4] else None
    r = sa.run_stage_a(hs, tp, d, tide, site)
    if r is None:
        return dict(state="none")
    f = lambda v, n: None if v is None or not math.isfinite(v) else round(float(v), n)
    return dict(state=sa.house_state(r, tide, site), break_house=f(r["break_house"], 0),
                breaker_H_house=f(r["breaker_H"][len(sa.PROFILE_OFFSETS) // 2], 2),
                peel_angle_near=f(r["peel_angle_near"], 0), peel_speed_near=f(r["peel_speed_near"], 1),
                break_s=[None if not math.isfinite(v) else int(round(v)) for v in r["break_s"]])


def run_exact(models, workers=None, site_key=None):
    """Run Stage A for every hour of every model, in parallel (about 0.5 s per run on one core)."""
    from multiprocessing import Pool
    import stage_a as sa
    import sites
    jobs = [(h["hs"], h["tp"], h["dir"], h["tide_lat"], site_key) for m in models for h in m["hours"] if h["tide_lat"] is not None]
    if not jobs:
        for m in models:
            for h in m["hours"]:
                h["exact"] = dict(state=None)
        return 0.0
    t0 = time.time()
    with Pool(workers or max(1, (os.cpu_count() or 2) - 1), initializer=sa.bed_grid,
              initargs=(sites.SITES[site_key] if site_key else None,)) as pool:
        res = pool.map(_stage_a_row, jobs, chunksize=4)
    k = 0
    for m in models:
        for h in m["hours"]:
            if h["tide_lat"] is None:
                h["exact"] = dict(state=None); continue
            h["exact"] = res[k]; k += 1
    return round(time.time() - t0, 1)


def tide_feed(spot_feeds):
    """The first tide feed (kind "tide") that came back ok, or None."""
    return next((f for f in spot_feeds if f["kind"] == "tide" and f["status"] == "ok"), None)


def stage_a_inputs(spot_feeds, site_key="porto_batel"):
    """Per forecast model, per hour: primary swell Hs/Tp/dir + the tide feed's sea level (MSL) -> tide above the map datum
    (Porto Batel: LAT; Pipeline: LMSL). The column keeps the name tide_lat for both (the viewer reads it as "tide on the map").
    Hours with no tide keep tide_lat None and get no Stage A run (the viewer says tide is not available; no value is made up)."""
    C = STAGE_A_SITES[site_key]
    tf = tide_feed(spot_feeds)
    tide = {r["time_utc"]: r["sea_level"] for r in tf["records"] if "sea_level" in r} if tf else {}
    out = []
    for f in spot_feeds:
        if f["kind"] != "forecast" or f["status"] != "ok":
            continue
        rows = []
        for r in f["records"]:
            if not all(k in r for k in ("swell_hs", "swell_tp", "swell_dir")):
                continue
            tp, kind = stage_a_period(r)
            sl = tide.get(r["time_utc"])
            row = dict(t=r["time_utc"], hs=r["swell_hs"], tp=tp, tp_kind=kind, dir=r["swell_dir"],
                       tide_lat=None if sl is None else round(sl + C["msl_to_map"], 3))
            d_ax = row["dir"] + 360 if (C["range"]["dir"][1] > 360 and row["dir"] < 180) else row["dir"]
            vals = dict(hs=row["hs"], tp=row["tp"], dir=d_ax, tide_lat=row["tide_lat"])
            row["in_range"] = sl is not None and all(C["range"][k][0] <= v <= C["range"][k][1] for k, v in vals.items())
            rows.append(row)
        out.append(dict(model=f["source"], hours=rows,
                        swell="primary swell partition (GFS-Wave SWELL/SWPER/SWDIR 1, Copernicus *_SW1); period rule in stage_a_period()"))
    secs = run_exact(out, site_key=C["site"])
    return dict(exact=f"Stage A run for every hour ({sum(len(m['hours']) for m in out)} runs, {secs} s): pieces/06-live-wave/stage_a.py run_stage_a"
                      + (f" (site {C['site']})" if C["site"] else ""),
                exact_seconds=secs,
                tide_source=(f"{tf['source']} for every model ({tf.get('sea_level_datum')})" if tf else
                             "none: no tide feed came back, so tide is not available and no Stage A run was made"),
                tide_feed=None if not tf else dict(source=tf["source"], feed=tf["feed"], point=tf.get("point"), doi=tf.get("doi"),
                                                   attribution=tf.get("attribution"), licence=tf.get("licence"),
                                                   datum=tf.get("sea_level_datum")),
                datum=C["datum"], datum_uncertainty_m=C["unc"],
                lookup=C["lookup"], lookup_range=C["range"], hs_note=C["hs_note"], models=out)


def build(key, write=True):
    spot = SPOTS[key]
    t0 = time.time()
    res = []
    for name, kw in spot["feeds"]:
        s = time.time()
        r = feeds.safe(feeds.FETCHERS[name], spot, **kw)
        if r["kind"] == "unknown":
            r["kind"] = ("forecast" if name in ("open_meteo", "cmems_wave", "dmi_wam", "gfs_wave")
                         else "tide" if name in ("cmems_sea_level", "coops_tide") else "observation")
        r["feed"] = name; r["fetch_seconds"] = round(time.time() - s, 1)
        res.append(r)
        print(f"  {key:12s} {name:16s} {r['status']:11s} {len(r['records']):4d} rec  {r['fetch_seconds']:5.1f} s"
              f"  {r.get('reason', '')[:160]}", flush=True)
    now_s = feeds.iso(feeds.now_utc())
    fc = [f for f in res if f["kind"] == "forecast" and f["status"] == "ok"]
    ob = [f for f in res if f["kind"] == "observation" and f["status"] == "ok" and any("hs" in r for r in f["records"])]
    comps = [c for m in fc for o in ob for c in [compare(m, o, now_s)] if c]
    snap = dict(spot=key, name=spot["name"], lat=spot["lat"], lon=spot["lon"], built_utc=now_s,
                build_seconds=round(time.time() - t0, 1),
                conventions="times UTC; directions coming FROM (deg); heights m; periods s; see feeds.py docstring",
                forecasts=[f for f in res if f["kind"] == "forecast"],
                observations=[f for f in res if f["kind"] == "observation"],
                tides=[f for f in res if f["kind"] == "tide"],
                model_vs_buoy=comps,
                feed_status={f["feed"] + ":" + f["source"]: f["status"] + (" - " + f["reason"] if f.get("reason") else "") for f in res})
    kb = [f for f in ob if f["feed"] == "kyst_buoy"]; cb = [f for f in ob if f["feed"] == "cmems_insitu"]
    if kb and cb:
        snap["time_zone_check"] = dict(what="kyst.dk Datotid vs Copernicus in-situ TIME (UTC) for the same buoy; lowest RMSE lag = offset to add to kyst time",
                                       hs_rmse_by_lag_h=tz_check(kb[0], cb[0]))
    if spot.get("stage_a"):
        snap["stage_a_inputs"] = stage_a_inputs(res, spot.get("stage_a_site", "porto_batel"))
    if not write:
        return snap
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"{key}.json")
    with open(path, "w") as f:
        json.dump(snap, f, separators=(",", ":"))
    print(f"  -> {os.path.relpath(path, HERE)} {os.path.getsize(path)/1024:.0f} KB", flush=True)
    return snap


B36 = "0123456789abcdefghijklmnopqrstuvwxyz"


def pack_profiles(bs):
    """49 break distances (whole metres, always even: Stage A samples every 2 m) -> 98-character string, two base-36
    digits of s/2 per profile, "--" where the profile does not break. About half the size of a JSON list."""
    if bs is None:
        return None
    return "".join("--" if v is None else B36[(v // 2) // 36] + B36[(v // 2) % 36] for v in bs)


PUBLIC_DIR = os.path.join(os.path.dirname(HERE), "live")
PUBLIC = os.path.join(PUBLIC_DIR, "porto_batel.json")


def _public_spot_cfg(key, with_insitu=False):
    """The spot with only the feeds allowed in its public file (spots.py `public`); with_insitu adds the buoy back."""
    spot = dict(SPOTS[key])
    keep = set(spot.get("public") or [])
    if with_insitu:
        keep.add("cmems_insitu")
    spot["feeds"] = [f for f in spot["feeds"] if f[0] in keep]
    return spot


def public_porto_batel(no_insitu=True, hours_back=6, key="porto_batel"):
    """Slim snapshot for the static site (live/porto_batel.json, < ~100 KB): Stage A inputs per model as columns,
    from 6 h ago to the end of the horizon, plus source status and attribution. This file is all the viewer reads. no_insitu: skip the buoy (slow to list, and the IH 6200199 wave
    sensor has reported NaN since 14 Nov 2026)."""
    spot = _public_spot_cfg(key, with_insitu=not no_insitu and key == "porto_batel")
    SPOTS["_public"] = spot
    snap = build("_public", write=False)
    del SPOTS["_public"]
    cut = feeds.iso(feeds.now_utc() - dt.timedelta(hours=hours_back))
    srcs = {f["source"]: f for f in snap["forecasts"] + snap["observations"]}
    idx = {f["source"]: {r["time_utc"]: r for r in f["records"]} for f in snap["forecasts"]}
    rec_at = lambda f, t: idx[f["source"]].get(t)
    models = []
    for m in snap["stage_a_inputs"]["models"]:
        hrs = [h for h in m["hours"] if h["t"] >= cut]
        f = srcs[m["model"]]
        models.append(dict(model=m["model"], feed=f["feed"], point=f.get("point"), attribution=f.get("attribution"),
                           licence=f.get("licence"), doi=f.get("doi"), period_rule=m["swell"],
                           model_name=f.get("model"), run_utc=f.get("run_utc"), run_label=f.get("run_label"),
                           wind_speed=[(rec_at(f, h["t"]) or {}).get("wind_speed") for h in hrs],
                           wind_dir=[(rec_at(f, h["t"]) or {}).get("wind_dir") for h in hrs],
                           wind_sea_hs=[(rec_at(f, h["t"]) or {}).get("wind_sea_hs") for h in hrs],
                           wind_sea_tp=[(rec_at(f, h["t"]) or {}).get("wind_sea_tp") for h in hrs],
                           wind_sea_dir=[(rec_at(f, h["t"]) or {}).get("wind_sea_dir") for h in hrs],
                           total_hs=[(rec_at(f, h["t"]) or {}).get("hs") for h in hrs],
                           t=[h["t"] for h in hrs], hs=[h["hs"] for h in hrs], tp=[h["tp"] for h in hrs],
                           tp_kind=[h["tp_kind"] for h in hrs], dir=[h["dir"] for h in hrs], tide_lat=[h["tide_lat"] for h in hrs],
                           exact=dict(state=[h["exact"]["state"] for h in hrs],
                                      break_house=[h["exact"].get("break_house") for h in hrs],
                                      breaker_H_house=[h["exact"].get("breaker_H_house") for h in hrs],
                                      peel_angle_near=[h["exact"].get("peel_angle_near") for h in hrs],
                                      peel_speed_near=[h["exact"].get("peel_speed_near") for h in hrs],
                                      break_s=[pack_profiles(h["exact"].get("break_s")) for h in hrs])))
    C = STAGE_A_SITES[SPOTS[key].get("stage_a_site", "porto_batel")]
    pub = dict(spot=key, built_utc=snap["built_utc"], conventions=snap["conventions"],
               exact=dict(what="Stage A (pieces/06-live-wave/stage_a.py) run for each listed hour; break_s = metres along the 49 profiles "
                               f"({C['geometry']}), packed as 98 characters: two base-36 digits of s/2 per profile, '--' = no break on that profile",
                          seconds=snap["stage_a_inputs"]["exact_seconds"]),
               tide=dict(source=snap["stage_a_inputs"]["tide_source"], datum=snap["stage_a_inputs"]["datum"],
                         uncertainty_m=C["unc"], feed=snap["stage_a_inputs"]["tide_feed"]),
               feed_status=snap["feed_status"], excluded=SPOTS[key].get("excluded_public", {}), models=models,
               comparison=snap["model_vs_buoy"])
    return _write_public(key, pub)


def _write_public(key, pub):
    os.makedirs(PUBLIC_DIR, exist_ok=True)
    path = os.path.join(PUBLIC_DIR, f"{key}.json")
    with open(path, "w") as fh:
        json.dump(pub, fh, separators=(",", ":"))
    kb = os.path.getsize(path) / 1024
    print(f"  -> {os.path.relpath(path, os.path.dirname(HERE))} {kb:.0f} KB", flush=True)
    return kb


FC_COLS = ("hs", "swell_hs", "swell_tp", "swell_tp_kind", "swell_dir", "wind_sea_hs", "wind_sea_tp", "wind_sea_dir",
           "wind_speed", "wind_dir")
OB_COLS = ("hs", "tp", "tm", "dir", "sea_level")


def public_spot(key, hours_back=6, obs_hours=24):
    """Slim public snapshot for a spot without a reef model (Danish coast, Tel Aviv): live/<spot>.json, < ~100 KB.
    Per forecast model, hourly columns from 6 h ago to the end of its horizon: total Hs, primary swell (Hs, period with its
    kind, direction), wind sea, 10 m wind where the model has it, and the tide feed's sea level (MSL) for the same hour. Per buoy or tide gauge,
    the hourly values of the last 24 h. Model-vs-buoy bias/RMSE over 48 h, only between sources that are in this file.
    Only the feeds listed in spots.py `public` are fetched; `excluded_public` says why the others are left out."""
    SPOTS["_public"] = _public_spot_cfg(key)
    try:
        snap = build("_public", write=False)
    finally:
        del SPOTS["_public"]
    cut = feeds.iso(feeds.now_utc() - dt.timedelta(hours=hours_back))
    ocut = feeds.iso(feeds.now_utc() - dt.timedelta(hours=obs_hours))
    tf = tide_feed(snap["tides"])
    msl = {r["time_utc"]: r.get("sea_level") for r in tf["records"]} if tf else {}
    meta = lambda f: dict(source=f["source"], feed=f["feed"], point=f.get("point"), attribution=f.get("attribution"),
                          licence=f.get("licence"), doi=f.get("doi"), provider=f.get("provider"), status=f["status"],
                          model_name=f.get("model"), run_utc=f.get("run_utc"), run_label=f.get("run_label"))
    models = []
    for f in snap["forecasts"]:
        if f["status"] != "ok":
            continue
        rs = [r for r in f["records"] if r["time_utc"] >= cut]
        m = meta(f); m["periods"] = f.get("periods")
        m["t"] = [r["time_utc"] for r in rs]
        for c in FC_COLS:
            m[c] = [r.get(c) for r in rs]
        m["sea_level_msl"] = [msl.get(r["time_utc"]) for r in rs]
        models.append(m)
    obs = []
    for f in snap["observations"]:
        if f["status"] != "ok":
            continue
        rows = sorted(hourly_obs([r for r in f["records"] if r["time_utc"] >= ocut]).items())
        o = meta(f); o["notes"] = f.get("notes"); o["sea_level_datum"] = f.get("sea_level_datum")
        o["kind"] = "water_level" if f["feed"] == "dmi_water_level" else "waves"
        o["t"] = [k for k, _ in rows]
        for c in OB_COLS:
            col = [r.get(c) for _, r in rows]
            if any(v is not None for v in col):
                o[c] = col
        latest = max(f["records"], key=lambda r: r["time_utc"]) if f["records"] else None
        o["latest"] = latest
        obs.append(o)
    pub = dict(spot=key, name=SPOTS[key]["name"], built_utc=snap["built_utc"], build_seconds=snap["build_seconds"],
               conventions=snap["conventions"],
               tide=(dict(source=tf["source"], feed=tf["feed"], point=tf.get("point"), doi=tf.get("doi"),
                          attribution=tf.get("attribution"), licence=tf.get("licence"), datum=tf.get("sea_level_datum"))
                     if tf else dict(source=None, note="no tide feed came back: tide not available")),
               feed_status=snap["feed_status"], excluded=SPOTS[key].get("excluded_public", {}),
               models=models, observations=obs, comparison=snap["model_vs_buoy"])
    return _write_public(key, pub)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--spots", nargs="*", default=list(SPOTS))
    ap.add_argument("--public", action="store_true",
                    help="write only the slim live/<spot>.json files for the static site (every spot with `public` feeds, or --spots)")
    ap.add_argument("--with-insitu", action="store_true", help="with --public: also fetch the Porto Batel in-situ buoy")
    a = ap.parse_args()
    if a.public:
        t0 = time.time()
        keys = [k for k in a.spots if SPOTS[k].get("public")]
        for k in keys:
            s = time.time()
            kb = public_porto_batel(no_insitu=not a.with_insitu, key=k) if SPOTS[k].get("stage_a") else public_spot(k)
            print(f"  {k}: {kb:.0f} KB in {time.time() - s:.0f} s", flush=True)
        print(f"public snapshots: {len(keys)} spots in {time.time() - t0:.0f} s", flush=True)
    else:
        for k in a.spots:
            build(k)
