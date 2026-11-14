"""Parse NDBC realtime data_spec (station 51101) into data/spectra.nc."""
import re, sys
from pathlib import Path
import numpy as np, pandas as pd, xarray as xr

here = Path(__file__).parent
raw = here / "data/raw/51101.data_spec.txt"
rows, freqs = [], set()
for line in raw.read_text().splitlines():
    if line.startswith("#") or not line.strip():
        continue
    head = line.split("(")[0].split()
    t = pd.Timestamp(*map(int, head[:5]))
    pairs = re.findall(r"(\S+)\s+\(([\d.]+)\)", line)
    d = {float(f): (np.nan if v == "MM" else float(v)) for v, f in pairs}
    freqs.update(d)
    rows.append((t, d))
f = np.array(sorted(freqs))
rows.sort(key=lambda r: r[0])
times = [r[0] for r in rows]
E = np.array([[d.get(x, np.nan) for x in f] for _, d in rows])
ds = xr.Dataset(
    {"energy": (("time", "frequency"), E, {"units": "m^2/Hz", "long_name": "spectral wave density"})},
    coords={"time": ("time", pd.DatetimeIndex(times), {"long_name": "time (UTC)"}),
            "frequency": ("frequency", f, {"units": "Hz"})},
    attrs={"station_id": "51101", "station_name": "NORTHWESTERN HAWAII TWO",
           "latitude": 24.340, "longitude": -162.073, "water_depth_m": 4847.0,
           "source": "NOAA NDBC realtime2 data_spec", "time_zone": "UTC"})
ds.to_netcdf(here / "data/spectra.nc")
print(ds.sizes, str(ds.time.values[0]), str(ds.time.values[-1]), float(f[0]), float(f[-1]))
