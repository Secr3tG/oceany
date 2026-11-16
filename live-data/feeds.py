"""One fetcher per live feed, all returning the same tidy shape. Used by build_snapshot.py.

Every fetcher returns a dict:
    source, kind ("forecast" | "observation"), status ("ok" | "unavailable"), reason (when unavailable),
    point (where the data is: grid cell or buoy, lat/lon), attribution, licence, notes, records
and each record is a flat dict with only the fields that feed has (missing fields are left out, never zero):
    time_utc            ISO "YYYY-MM-DDTHH:MM" UTC
    hs, tp, tm, dir     total sea: significant height m, peak period s, mean period s, direction deg coming FROM
    swell_hs, swell_tp, swell_tp_kind ("peak"|"mean"), swell_dir     primary (or total) swell partition
    swell2_hs, swell2_tp, swell2_dir                                   secondary swell
    wind_sea_hs, wind_sea_tp, wind_sea_dir                             wind sea
    sea_level (m), with the datum stated in the feed's `sea_level_datum`
    wind_speed (m/s), wind_dir (deg from)
A fetcher that fails returns status "unavailable" with the reason; it never raises (safe() wraps them all).
Copernicus uses the login saved by `copernicusmarine login`; this module never opens the credentials file.
"""
import csv
import datetime as dt
import glob
import io
import json
import math
import os
import time
import traceback

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
UA = {"User-Agent": "oceany-live-data/0.1 (research script)"}
HOURS_BACK = 48


def now_utc():
    return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M")


def num(v, nd=2):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if (math.isnan(f) or math.isinf(f)) else round(f, nd)


def clean(rec):
    return {k: v for k, v in rec.items() if v is not None}


def result(source, kind, records=None, status="ok", reason=None, **extra):
    out = dict(source=source, kind=kind, status=status, fetched_utc=iso(now_utc()))
    if reason:
        out["reason"] = reason
    out.update(extra)
    out["records"] = records or []
    if status == "ok" and not out["records"]:
        out["status"], out["reason"] = "unavailable", reason or "no records in the time window"
    return out


def safe(fn, spot, **kw):
    try:
        return fn(spot, **kw)
    except Exception as e:  # any failure degrades to "unavailable" with a short reason
        msg = f"{type(e).__name__}: {str(e)[:300]}"
        return result(kw.get("label", fn.__name__), "unknown", status="unavailable", reason=msg,
                      trace=traceback.format_exc().splitlines()[-1][:200])


# ---------------------------------------------------------------- Open-Meteo Marine + Forecast (wind)
OM_MARINE = ["wave_height", "wave_period", "wave_direction",
             "swell_wave_height", "swell_wave_period", "swell_wave_peak_period", "swell_wave_direction",
             "secondary_swell_wave_height", "secondary_swell_wave_period", "secondary_swell_wave_direction",
             "wind_wave_height", "wind_wave_period", "wind_wave_direction", "sea_level_height_msl"]


def open_meteo(spot, days=16):
    p = dict(latitude=spot["lat"], longitude=spot["lon"], hourly=",".join(OM_MARINE), forecast_days=days,
             past_days=2, timezone="GMT")
    r = requests.get("https://marine-api.open-meteo.com/v1/marine", params=p, timeout=30, headers=UA)
    r.raise_for_status(); m = r.json()
    w = None
    try:
        rw = requests.get("https://api.open-meteo.com/v1/forecast", timeout=30, headers=UA, params=dict(
            latitude=spot["lat"], longitude=spot["lon"], hourly="wind_speed_10m,wind_direction_10m",
            wind_speed_unit="ms", forecast_days=days, past_days=2, timezone="GMT"))
        rw.raise_for_status(); w = rw.json()["hourly"]
        wind = {t: (s, d) for t, s, d in zip(w["time"], w["wind_speed_10m"], w["wind_direction_10m"])}
    except Exception as e:
        wind, w = {}, f"wind unavailable: {type(e).__name__}"
    h = m["hourly"]; recs = []
    for i, t in enumerate(h["time"]):
        g = lambda k: num(h[k][i])
        if g("wave_height") is None and g("swell_wave_height") is None:
            continue
        pk = g("swell_wave_peak_period")
        ws = wind.get(t, (None, None))
        recs.append(clean(dict(time_utc=t, hs=g("wave_height"), tm=g("wave_period"), dir=g("wave_direction"),
                               swell_hs=g("swell_wave_height"), swell_tp=pk if pk is not None else g("swell_wave_period"),
                               swell_tp_kind="peak" if pk is not None else "mean", swell_dir=g("swell_wave_direction"),
                               swell2_hs=g("secondary_swell_wave_height"), swell2_tp=g("secondary_swell_wave_period"),
                               swell2_dir=g("secondary_swell_wave_direction"), wind_sea_hs=g("wind_wave_height"),
                               wind_sea_tp=g("wind_wave_period"), wind_sea_dir=g("wind_wave_direction"),
                               sea_level=g("sea_level_height_msl"), wind_speed=num(ws[0], 1), wind_dir=num(ws[1], 0))))
    return result("Open-Meteo Marine + Forecast", "forecast", recs,
                  point=dict(lat=m.get("latitude"), lon=m.get("longitude"), note="model grid cell the API snapped to"),
                  sea_level_datum="global mean sea level (MSL); tide + surge",
                  periods="tm = total mean period; swell_tp = swell peak period where offered, else mean (swell_tp_kind)",
                  attribution="Weather data by Open-Meteo.com", licence="CC BY 4.0; free tier non-commercial",
                  browser_cors=True, notes=None if isinstance(w, dict) else w)


# ---------------------------------------------------------------- Copernicus Marine wave forecasts
# Product DOIs (copernicusmarine.describe, 2026-11-16), required in the credit line (licence 2.4a).
CM_DOI = {"cmems_mod_ibi_wav_anfc_0.027deg_PT1H-i": "10.48670/moi-00025",   # IBI_ANALYSISFORECAST_WAV_005_005
          "cmems_mod_nws_wav_anfc_1.5km_PT1H-i": "10.48670/moi-00055",       # NWSHELF_ANALYSISFORECAST_WAV_004_014
          "cmems_mod_med_wav_anfc_4.2km_PT1H-i": "10.48670/mds-00373"}       # MEDSEA_ANALYSISFORECAST_WAV_006_017
INSITU_DOI = "10.48670/moi-00036"                                            # INSITU_GLO_PHYBGCWAV_DISCRETE_MYNRT_013_030
CM_VARS = ["VHM0", "VTPK", "VTM10", "VMDR", "VHM0_WW", "VTM01_WW", "VMDR_WW",
           "VHM0_SW1", "VTM01_SW1", "VMDR_SW1", "VHM0_SW2", "VTM01_SW2", "VMDR_SW2"]


def cmems_wave(spot, dataset, label, pad=0.1, days_ahead=10):
    import copernicusmarine as cm
    t0 = now_utc() - dt.timedelta(hours=HOURS_BACK); t1 = now_utc() + dt.timedelta(days=days_ahead)
    try:
        ds = cm.open_dataset(dataset_id=dataset, variables=CM_VARS, minimum_latitude=spot["lat"] - pad,
                             maximum_latitude=spot["lat"] + pad, minimum_longitude=spot["lon"] - pad,
                             maximum_longitude=spot["lon"] + pad, start_datetime=iso(t0), end_datetime=iso(t1))
        vars_ok = CM_VARS
    except Exception:
        vars_ok = ["VHM0", "VTPK", "VMDR", "VHM0_WW", "VTM01_WW", "VMDR_WW", "VHM0_SW1", "VTM01_SW1", "VMDR_SW1",
                   "VHM0_SW2", "VTM01_SW2", "VMDR_SW2"]
        ds = cm.open_dataset(dataset_id=dataset, variables=vars_ok, minimum_latitude=spot["lat"] - pad,
                             maximum_latitude=spot["lat"] + pad, minimum_longitude=spot["lon"] - pad,
                             maximum_longitude=spot["lon"] + pad, start_datetime=iso(t0), end_datetime=iso(t1))
    ds = ds[vars_ok].load()
    da = ds["VHM0"].isel(time=0)
    cl = math.cos(math.radians(spot["lat"]))
    dist = ((da.latitude - spot["lat"]) ** 2 + ((da.longitude - spot["lon"]) * cl) ** 2).where(da.notnull())
    idx = dist.argmin(dim=("latitude", "longitude"))
    pt = ds.isel(latitude=int(idx["latitude"]), longitude=int(idx["longitude"]))
    plat, plon = float(pt.latitude), float(pt.longitude)
    km = 111.195 * math.sqrt((plat - spot["lat"]) ** 2 + ((plon - spot["lon"]) * cl) ** 2)
    recs = []
    for i in range(pt.time.size):
        r = pt.isel(time=i)
        g = lambda k: num(r[k].values) if k in r else None
        recs.append(clean(dict(time_utc=str(r.time.values)[:16], hs=g("VHM0"), tp=g("VTPK"), tm=g("VTM10"), dir=g("VMDR"),
                               swell_hs=g("VHM0_SW1"), swell_tp=g("VTM01_SW1"), swell_tp_kind="mean", swell_dir=g("VMDR_SW1"),
                               swell2_hs=g("VHM0_SW2"), swell2_tp=g("VTM01_SW2"), swell2_dir=g("VMDR_SW2"),
                               wind_sea_hs=g("VHM0_WW"), wind_sea_tp=g("VTM01_WW"), wind_sea_dir=g("VMDR_WW"))))
    recs = [r for r in recs if "hs" in r]
    return result(label, "forecast", recs, dataset=dataset, doi=CM_DOI.get(dataset),
                  point=dict(lat=round(plat, 4), lon=round(plon, 4), km_from_spot=round(km, 1), note="nearest wet model cell"),
                  periods="tp = total peak period (VTPK); partitions carry mean period VTM01 only",
                  attribution="E.U. Copernicus Marine Service Information", licence="Copernicus Marine Service licence (free, attribution)",
                  browser_cors=False, notes="needs the saved Copernicus login; reaches a static site only through the snapshot")


# ---------------------------------------------------------------- Copernicus in-situ buoys (latest part, daily files)
def cmems_insitu(spot, platform, label):
    import copernicusmarine as cm
    import xarray as xr
    d = os.path.join(CACHE, "insitu_" + platform); os.makedirs(d, exist_ok=True)
    days = [now_utc() - dt.timedelta(days=k) for k in (2, 1, 0)]
    got = []
    # Fast path: name the three daily files exactly (file_list). That skips listing the bucket: 10-17 s instead of
    # 3-6 min per buoy (measured 2026-11-16). A file that does not exist yet is simply skipped.
    flist = os.path.join(d, "file_list.txt")
    with open(flist, "w") as fh:
        fh.write("".join(f"latest/{day:%Y%m%d}/{platform}_{day:%Y%m%d}.nc\n" for day in days))
    n_fast = 0
    try:
        rg = cm.get(dataset_id="cmems_obs-ins_glo_phybgcwav_mynrt_na_irr", dataset_part="latest", file_list=flist,
                    no_directories=True, output_directory=d, overwrite=True, disable_progress_bar=True)
        n_fast = len(rg.files) if rg is not None and getattr(rg, "files", None) else 0
    except Exception as e:
        got.append(f"file_list: {type(e).__name__}")
    # Slow fallback (lists the bucket): all days in one call with a [..] character class when the days share
    # year+month (a glob class works in `filter`, checked 2026-11-16); else one call per day.
    ym = {x.strftime("%Y%m") for x in days}
    if len(ym) == 1 and len({x.strftime("%d")[0] for x in days}) == 1:
        pats = [f"*latest/{days[0]:%Y%m}{days[0].strftime('%d')[0]}[{''.join(x.strftime('%d')[1] for x in days)}]/{platform}_*.nc"]
    else:
        pats = [f"*latest/{day:%Y%m%d}/{platform}_{day:%Y%m%d}.nc" for day in days]
    for pat in ([] if n_fast else pats):
        try:
            cm.get(dataset_id="cmems_obs-ins_glo_phybgcwav_mynrt_na_irr", dataset_part="latest", filter=pat,
                   no_directories=True, output_directory=d, overwrite=True, disable_progress_bar=True)
        except Exception as e:
            got.append(f"{pat}: {type(e).__name__}")
    files = sorted(f for f in glob.glob(os.path.join(d, f"{platform}_*.nc"))
                   if os.path.basename(f)[-11:-3] >= days[0].strftime("%Y%m%d"))
    if not files:
        return result(label, "observation", status="unavailable", reason="no daily file for the last 3 days " + "; ".join(got))
    recs, lat, lon, has, provider = [], None, None, set(), None
    for f in files:
        ds = xr.open_dataset(f)
        provider = ds.attrs.get("institution") or ds.attrs.get("data_assembly_center") or provider
        lat = float(ds["LATITUDE"].values.ravel()[-1]) if "LATITUDE" in ds else lat
        lon = float(ds["LONGITUDE"].values.ravel()[-1]) if "LONGITUDE" in ds else lon
        tt = ds["TIME"].values.ravel()
        col = {}
        for v in ("VHM0", "VAVH", "VTPK", "VTM02", "VMDR", "VPED", "WSPD", "WDIR"):
            if v in ds:
                a = ds[v].values
                col[v] = a.reshape(a.shape[0], -1)[:, 0] if a.ndim > 1 else a
                has.add(v)
        for i, t in enumerate(tt):
            g = lambda v: num(col[v][i]) if v in col else None
            hs = g("VHM0") if g("VHM0") is not None else g("VAVH")
            if hs is None:
                continue
            recs.append(clean(dict(time_utc=str(t)[:16], hs=hs, tp=g("VTPK"), tm=g("VTM02"),
                                   dir=g("VMDR") if g("VMDR") is not None else g("VPED"),
                                   wind_speed=g("WSPD"), wind_dir=g("WDIR"))))
    cut = iso(now_utc() - dt.timedelta(hours=HOURS_BACK))
    recs = sorted({r["time_utc"]: r for r in recs if r["time_utc"] >= cut}.values(), key=lambda r: r["time_utc"])
    if not recs:
        return result(label, "observation", status="unavailable", platform=platform,
                      reason=f"{len(files)} daily file(s) found but every wave value (VHM0/VAVH) is NaN in the last "
                             f"{HOURS_BACK} h; the file has {', '.join(sorted(has))} (met sensors still reporting)")
    dnote = ("direction from VMDR" if "VMDR" in has else "direction from VPED (peak direction)" if "VPED" in has
             else "no wave direction in this platform's file")
    return result(label, "observation", recs, platform=platform, point=dict(lat=num(lat, 4), lon=num(lon, 4)), doi=INSITU_DOI,
                  provider=provider,
                  variables=sorted(has), notes=f"{dnote}; tm = VTM02 (zero-crossing mean period)",
                  attribution="E.U. Copernicus Marine Service Information (In Situ TAC), data provider in the file",
                  licence="Copernicus Marine Service licence (free, attribution)", browser_cors=False)


# ---------------------------------------------------------------- kyst.dk buoys (Danish Coastal Authority)
def kyst_buoy(spot, ident, label, lat=None, lon=None):
    t0 = now_utc() - dt.timedelta(hours=HOURS_BACK); t1 = now_utc() + dt.timedelta(days=1)
    r = requests.get("https://kystatlas.kyst.dk/data/boelge/response.aspx", timeout=30, headers=UA, params=dict(
        ident=ident, startdate=t0.strftime("%Y%m%d"), enddate=t1.strftime("%Y%m%d"), format="csv"))
    r.raise_for_status()
    rows = list(csv.reader(io.StringIO(r.text)))
    head = [c.strip() for c in rows[0]]; ix = {c: i for i, c in enumerate(head)}
    recs = []
    for row in rows[1:]:
        if len(row) < len(head) - 1:
            continue
        g = lambda c: num(row[ix[c]]) if c in ix and row[ix[c]].strip() else None
        # Datotid is UTC+1: on 2026-11-16 the same buoy in Copernicus in-situ (UTC) matched at -1 h with RMSE 0.001 m.
        # Whether it moves to UTC+2 in summer (CEST) is not checked.
        t = dt.datetime.strptime(row[0].strip()[:16], "%Y-%m-%d %H:%M") - dt.timedelta(hours=1)
        recs.append(clean(dict(time_utc=iso(t), hs=g("H_M0"), tm=g("T_z"), dir=g("Dir"))))
    recs = [x for x in recs if "hs" in x]
    return result(label, "observation", recs, point=dict(ident=ident, lat=lat, lon=lon),
                  notes="Columns H_M0 (Hs), T_z (mean zero-crossing period), Dir. No peak period, no swell split. "
                        "Last 2 weeks not quality-controlled. Datotid converted to UTC by -1 h (time_zone_check in the snapshot "
                        "re-tests it: after the fix the best lag should be 0).",
                  attribution="Kystdirektoratet / Miljostyrelsen, kystatlas.kyst.dk",
                  licence="Danish public data; terms not checked here", browser_cors=False)


# ---------------------------------------------------------------- DMI WAM (EDR, CoverageJSON) with cache and back-off
WAM_PARAMS = ["significant-wave-height", "mean-wave-period", "mean-wave-dir", "significant-windwave-height",
              "mean-windwave-period", "mean-windwave-dir", "significant-totalswell-height", "mean-totalswell-period",
              "mean-totalswell-dir", "wind-speed", "wind-dir"]


def dmi_wam(spot, lon, lat, max_age_h=6):
    os.makedirs(CACHE, exist_ok=True)
    cpath = os.path.join(CACHE, f"dmi_wam_{lat:g}_{lon:g}.json")
    t0 = now_utc() - dt.timedelta(hours=HOURS_BACK); t1 = now_utc() + dt.timedelta(days=7)
    url = "https://opendataapi.dmi.dk/v1/forecastedr/collections/wam_dw/position"
    # The API refuses (413) more than 1000 model steps x parameters per request, so ask in groups of 4 parameters
    # (~150 hourly steps each) and merge the ranges.
    d, note = None, None
    for wait in (0, 5, 20):
        time.sleep(wait)
        merged, busy = None, False
        for g in range(0, len(WAM_PARAMS), 4):
            p = {"coords": f"POINT({lon} {lat})", "crs": "crs84", "parameter-name": ",".join(WAM_PARAMS[g:g + 4]),
                 "datetime": f"{t0:%Y-%m-%dT%H:00:00Z}/{t1:%Y-%m-%dT%H:00:00Z}", "f": "CoverageJSON"}
            r = requests.get(url, params=p, timeout=60, headers=UA)
            if r.status_code == 429:
                busy = True; break
            r.raise_for_status(); part = r.json()
            if merged is None:
                merged = part
            elif part["domain"]["axes"]["t"]["values"] == merged["domain"]["axes"]["t"]["values"]:
                merged["ranges"].update(part["ranges"])
            else:
                raise ValueError("WAM parameter groups came back on different time axes")
        if busy:
            note = "HTTP 429 (busy)"; continue
        d = merged
        with open(cpath, "w") as f:
            json.dump(d, f)
        break
    if d is None:
        if os.path.exists(cpath) and time.time() - os.path.getmtime(cpath) < max_age_h * 3600:
            d = json.load(open(cpath)); note += f"; served from cache ({(time.time()-os.path.getmtime(cpath))/3600:.1f} h old)"
        else:
            return result("DMI WAM (wam_dw)", "forecast", status="unavailable", reason=f"{note}, no fresh cache")
    ax = d["domain"]["axes"]; rg = d["ranges"]
    v = lambda k, i: num(rg[k]["values"][i]) if k in rg else None
    recs = []
    for i, t in enumerate(ax["t"]["values"]):
        recs.append(clean(dict(time_utc=t[:16], hs=v("significant-wave-height", i), tm=v("mean-wave-period", i),
                               dir=v("mean-wave-dir", i), swell_hs=v("significant-totalswell-height", i),
                               swell_tp=v("mean-totalswell-period", i), swell_tp_kind="mean", swell_dir=v("mean-totalswell-dir", i),
                               wind_sea_hs=v("significant-windwave-height", i), wind_sea_tp=v("mean-windwave-period", i),
                               wind_sea_dir=v("mean-windwave-dir", i), wind_speed=v("wind-speed", i), wind_dir=v("wind-dir", i))))
    recs = [x for x in recs if "hs" in x]
    return result("DMI WAM (wam_dw)", "forecast", recs,
                  point=dict(lat=num(ax["y"]["values"][0], 4), lon=num(ax["x"]["values"][0], 4)),
                  periods="mean periods only; swell = total swell partition", notes=note,
                  attribution="Danish Meteorological Institute (DMI) open data", licence="CC BY 4.0 (DMI open data)",
                  browser_cors=True)   # position query sends Access-Control-Allow-Origin: * (checked 2026-11-16)


# ---------------------------------------------------------------- DMI water level (oceanObs)
def dmi_water_level(spot, station, label):
    t0 = now_utc() - dt.timedelta(hours=HOURS_BACK)
    r = requests.get("https://opendataapi.dmi.dk/v2/oceanObs/collections/observation/items", timeout=30, headers=UA,
                     params=dict(stationId=station, parameterId="sea_reg", limit=1000,
                                 datetime=f"{t0:%Y-%m-%dT%H:%M:%SZ}/..", sortorder="observed,DESC"))
    r.raise_for_status()
    feats = r.json().get("features", [])
    recs = [dict(time_utc=f["properties"]["observed"][:16], sea_level=num(f["properties"]["value"] / 100.0, 3))
            for f in feats if f["properties"].get("value") is not None]
    recs.sort(key=lambda x: x["time_utc"])
    c = feats[0]["geometry"]["coordinates"] if feats else [None, None]
    return result(label, "observation", recs, point=dict(lat=c[1], lon=c[0], station=station),
                  sea_level_datum="DMI parameter sea_reg, converted cm -> m; datum not verified (live-feeds.md)",
                  attribution="Danish Meteorological Institute (DMI) open data", licence="CC BY 4.0 (DMI open data)",
                  browser_cors=True)


# ---------------------------------------------------------------- NDBC realtime (Pipeline)
def _ndbc_table(text):
    lines = [l for l in text.splitlines() if l.strip()]
    head = lines[0].lstrip("#").split()
    rows = [l.split() for l in lines[2:]]
    return head, rows


def ndbc(spot, station, label):
    base = f"https://www.ndbc.noaa.gov/data/realtime2/{station}"
    r = requests.get(base + ".txt", timeout=30, headers=UA); r.raise_for_status()
    head, rows = _ndbc_table(r.text)
    spec = {}
    try:
        rs = requests.get(base + ".spec", timeout=30, headers=UA); rs.raise_for_status()
        sh, srows = _ndbc_table(rs.text)
        for row in srows:
            k = "{}-{}-{}T{}:{}".format(*row[:5]); spec[k] = dict(zip(sh, row))
    except Exception:
        pass
    cut = iso(now_utc() - dt.timedelta(hours=HOURS_BACK)); recs = []
    for row in rows:
        k = "{}-{}-{}T{}:{}".format(*row[:5])
        if k < cut:
            continue
        g = dict(zip(head, row)); f = lambda c: num(g.get(c)) if g.get(c) not in (None, "MM") else None
        s = spec.get(k, {}); fs = lambda c: num(s.get(c)) if s.get(c) not in (None, "MM") else None
        recs.append(clean(dict(time_utc=k, hs=f("WVHT"), tp=f("DPD"), tm=f("APD"), dir=f("MWD"),
                               swell_hs=fs("SwH"), swell_tp=fs("SwP"), swell_tp_kind="peak" if s else None,
                               wind_sea_hs=fs("WWH"), wind_sea_tp=fs("WWP"))))
    recs = [x for x in recs if "hs" in x]
    recs.sort(key=lambda x: x["time_utc"])
    return result(label, "observation", recs, point=dict(station=station),
                  notes="swell/wind-sea split from .spec (directions there are compass text, not kept)",
                  attribution="NOAA National Data Buoy Center", licence="US public domain", browser_cors=False)


FETCHERS = dict(open_meteo=open_meteo, cmems_wave=cmems_wave, cmems_insitu=cmems_insitu, kyst_buoy=kyst_buoy,
                dmi_wam=dmi_wam, dmi_water_level=dmi_water_level, ndbc=ndbc)
