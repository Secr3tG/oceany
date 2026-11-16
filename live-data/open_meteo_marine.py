"""Open-Meteo Marine forecast for Porto Batel as tidy hourly records, with the tide on the lidar datum (LAT).

Use from Python:
    from open_meteo_marine import fetch_porto_batel
    recs, meta = fetch_porto_batel()          # recs: list of dicts, one per hour; meta: grid point, units, datum
Or run:  python open_meteo_marine.py [--days 10]   (prints every 6th hour; writes nothing)

No API key. Data: Open-Meteo.com Marine Weather API (CC BY 4.0, non-commercial free tier).
Checked live 2026-11-16: the API snaps the spot (39.3195 N, 9.3558 W) to grid point 39.2917 N, 9.3750 W, about
3.5 km south-southwest of the house. Horizon about 9 days of non-null values (216 h); the request asks for more and
trailing nulls are dropped. `swell_wave_peak_period` is only filled for the first ~3 days (67 h on 11-16), so `tp`
falls back to `swell_wave_period` (mean period) after that and `tp_source` says which one it is.
`wave_peak_period` is not offered (units "undefined", all null), so it is not requested.

Datum: sea_level_height_msl is relative to mean sea level. The lidar DEM is above LAT. MSL = LAT + 1.66 m
(notes/forecast-fields.md; IH Peniche 2026 table), uncertain by about 0.1-0.3 m. Every record carries
tide_lat (= msl + 1.66) and the uncertainty band, so nothing downstream forgets it.
"""
import argparse
import requests

URL = "https://marine-api.open-meteo.com/v1/marine"
SPOT = dict(name="Porto Batel", latitude=39.3195, longitude=-9.3558)
MSL_MINUS_LAT = 1.66
DATUM_UNCERTAINTY = (0.1, 0.3)   # m, the stated range, not a standard deviation
HOURLY = [
    "wave_height", "wave_period", "wave_direction",
    "swell_wave_height", "swell_wave_period", "swell_wave_peak_period", "swell_wave_direction",
    "secondary_swell_wave_height", "secondary_swell_wave_period", "secondary_swell_wave_direction",
    "wind_wave_height", "wind_wave_period", "wind_wave_direction",
    "sea_level_height_msl",
]


def fetch_porto_batel(days=16, timeout=30):
    """Return (records, meta). Times are UTC (ISO, no offset). Hours where the swell or the sea level is null are dropped."""
    params = dict(latitude=SPOT["latitude"], longitude=SPOT["longitude"], hourly=",".join(HOURLY),
                  forecast_days=days, timezone="GMT")
    r = requests.get(URL, params=params, timeout=timeout)
    r.raise_for_status()
    d = r.json()
    h = d["hourly"]
    recs = []
    for i, t in enumerate(h["time"]):
        v = {k: h[k][i] for k in HOURLY}
        if v["swell_wave_height"] is None or v["sea_level_height_msl"] is None:
            continue
        peak = v["swell_wave_peak_period"]
        recs.append(dict(
            time_utc=t,
            hs=v["swell_wave_height"], tp=peak if peak is not None else v["swell_wave_period"],
            tp_source="swell_wave_peak_period" if peak is not None else "swell_wave_period (mean, peak missing)",
            direction=v["swell_wave_direction"],
            total_hs=v["wave_height"], total_period=v["wave_period"], total_direction=v["wave_direction"],
            swell2_hs=v["secondary_swell_wave_height"], swell2_period=v["secondary_swell_wave_period"],
            swell2_direction=v["secondary_swell_wave_direction"],
            wind_hs=v["wind_wave_height"], wind_period=v["wind_wave_period"], wind_direction=v["wind_wave_direction"],
            sea_level_msl=v["sea_level_height_msl"],
            tide_lat=round(v["sea_level_height_msl"] + MSL_MINUS_LAT, 3),
            tide_lat_uncertainty_m=DATUM_UNCERTAINTY,
        ))
    meta = dict(source=URL, requested=SPOT, grid_latitude=d.get("latitude"), grid_longitude=d.get("longitude"),
                units=d.get("hourly_units"), datum=f"tide_lat = sea_level_height_msl + {MSL_MINUS_LAT} m (MSL = LAT + 1.66)",
                datum_uncertainty_m=DATUM_UNCERTAINTY, directions="coming FROM, deg, 0 = north", n_hours=len(recs),
                first=recs[0]["time_utc"] if recs else None, last=recs[-1]["time_utc"] if recs else None)
    return recs, meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--days", type=int, default=16); a = ap.parse_args()
    recs, meta = fetch_porto_batel(a.days)
    print(f"grid point {meta['grid_latitude']}, {meta['grid_longitude']}; {meta['n_hours']} h, {meta['first']} to {meta['last']} UTC")
    print("time UTC          | swell Hs  Tp  dir | total Hs | tide MSL  LAT | Tp source")
    for r in recs[::6]:
        print(f"{r['time_utc'].replace('T', ' ')} | {r['hs']:5.2f} {r['tp']:5.1f} {r['direction']:4.0f} | {r['total_hs']:5.2f}    | "
              f"{r['sea_level_msl']:5.2f} {r['tide_lat']:5.2f} | {r['tp_source'][:9]}")
