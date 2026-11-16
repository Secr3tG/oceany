"""Smoke test for CMEMS wave forecasts. Run AFTER `copernicusmarine login` (user does that themselves):
    copernicusmarine login
    python live-data/cmems_test.py
Subsets the latest ~24 h of the nearest grid cell for three spots and prints a few lines each.
Directions are "coming from" (deg). Needs only stdlib + copernicusmarine.
"""
import datetime as dt
import copernicusmarine as cm

VARS = ["VHM0", "VTPK", "VMDR",
        "VHM0_WW", "VTM01_WW", "VMDR_WW",
        "VHM0_SW1", "VTM01_SW1", "VMDR_SW1",
        "VHM0_SW2", "VTM01_SW2", "VMDR_SW2"]

SPOTS = [
    # name, lat, lon, dataset_id
    ("Klitmoller (NWSHELF 1.5km)", 57.04, 8.49, "cmems_mod_nws_wav_anfc_1.5km_PT1H-i"),
    ("Peniche (IBI 0.027deg)", 39.37, -9.38, "cmems_mod_ibi_wav_anfc_0.027deg_PT1H-i"),
    ("Tel Aviv (MEDSEA 4.2km)", 32.08, 34.76, "cmems_mod_med_wav_anfc_4.2km_PT1H-i"),
]

# Use the model's own end of coverage is unknown here, so take the last 24 h up to "now"
# (analysis part is current; forecast extends days beyond).
now = dt.datetime.utcnow().replace(minute=0, second=0, microsecond=0)
start = (now - dt.timedelta(hours=24)).strftime("%Y-%m-%dT%H:%M:%S")
end = now.strftime("%Y-%m-%dT%H:%M:%S")
PAD = 0.1  # degrees; small bbox, then nearest valid cell is picked below


def first_valid(ds, name):
    # nearest cell may be land (NaN) at coast; take the wet cell closest to the point
    da = ds["VHM0"].isel(time=-1)
    stacked = da.stack(p=("latitude", "longitude")).dropna("p")
    return stacked.p.values if stacked.size else None


for name, lat, lon, dsid in SPOTS:
    print(f"\n== {name}")
    try:
        ds = cm.open_dataset(
            dataset_id=dsid,
            variables=VARS,
            minimum_latitude=lat - PAD, maximum_latitude=lat + PAD,
            minimum_longitude=lon - PAD, maximum_longitude=lon + PAD,
            start_datetime=start, end_datetime=end,
        )
    except Exception as e:  # not logged in, bad name, etc.
        print("  FAILED:", repr(e)[:300])
        continue
    # pick the wet cell nearest to the spot
    da = ds["VHM0"].isel(time=-1)
    dist = (da.latitude - lat) ** 2 + (da.longitude - lon) ** 2
    dist = dist.where(da.notnull())
    idx = dist.argmin(dim=("latitude", "longitude"))
    pt = ds.isel(latitude=int(idx["latitude"]), longitude=int(idx["longitude"]))
    print(f"  cell lat={float(pt.latitude):.3f} lon={float(pt.longitude):.3f}, {pt.time.size} hourly steps")
    for i in list(range(0, pt.time.size, 6))[:5] + [pt.time.size - 1]:
        r = pt.isel(time=i)
        t = str(r.time.values)[:16]
        print(f"  {t}Z Hs={float(r.VHM0):.2f}m Tp={float(r.VTPK):.1f}s dir={float(r.VMDR):.0f} | "
              f"wind-sea {float(r.VHM0_WW):.2f}m/{float(r.VTM01_WW):.1f}s/{float(r.VMDR_WW):.0f} | "
              f"swell1 {float(r.VHM0_SW1):.2f}m/{float(r.VTM01_SW1):.1f}s/{float(r.VMDR_SW1):.0f} | "
              f"swell2 {float(r.VHM0_SW2):.2f}m/{float(r.VTM01_SW2):.1f}s/{float(r.VMDR_SW2):.0f}")
