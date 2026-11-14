"""Extract the Porto Batel bed profile along a straight line from the house on bearing 236 deg.

Run:  python -I profile_porto_batel.py
Reads  ../02-reefs/data/raw/590_HR_Lidar_Centro.nc   (2011 lidar in the EMODnet HR grid)
Writes data/porto_batel_profile_236.csv, out/porto_batel/profile_236.png

Grid convention (same as ../02-reefs/simulate_swell.py): `elevation` is height above LAT in
metres (positive up, sea floor negative), values are cell centres on a WGS84 lat/lon grid;
distances use the same flat-earth conversion (M_PER_DEG = 111195, cos(lat) for longitude).
The grid is about 11 m (east-west) x 14 m (north-south): everything between cell centres
is bilinear interpolation, not measured detail.
"""
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import xarray as xr

HERE = Path(__file__).resolve().parent
NC_FILE = HERE.parent / "02-reefs" / "data" / "raw" / "590_HR_Lidar_Centro.nc"
OUT_CSV = HERE / "data" / "porto_batel_profile_236.csv"
OUT_PNG = HERE / "out" / "porto_batel" / "profile_236.png"
OUT_META = HERE / "data" / "porto_batel_profile_236_meta.json"

HOUSE_LAT, HOUSE_LON = 39.319506, -9.355772
BEARING_DEG = 236.0
TIDE_ABOVE_LAT = 2.10
M_PER_DEG = 111195.0
S_MAX = 700.0          # look this far; the valid-data end is found below
DS = 1.0               # profile sample spacing (m)

ds = xr.open_dataset(NC_FILE)
box = ds.sel(lon=slice(HOUSE_LON - 0.012, HOUSE_LON + 0.004),
             lat=slice(HOUSE_LAT - 0.008, HOUSE_LAT + 0.004)).load()
lon = box.lon.values
lat = box.lat.values
elev = box.elevation.values.astype(float)            # (lat, lon), m above LAT
iflag = box.interpolation_flag.values.astype(float)

coslat = np.cos(np.radians(HOUSE_LAT))
s = np.arange(0.0, S_MAX + DS, DS)
east = s * np.sin(np.radians(BEARING_DEG))
north = s * np.cos(np.radians(BEARING_DEG))
plon = HOUSE_LON + east / (M_PER_DEG * coslat)
plat = HOUSE_LAT + north / M_PER_DEG

# bilinear interpolation between cell centres; NaN if any of the 4 corners is NaN
fi = np.interp(plon, lon, np.arange(lon.size))
fj = np.interp(plat, lat, np.arange(lat.size))
i0 = np.clip(np.floor(fi).astype(int), 0, lon.size - 2)
j0 = np.clip(np.floor(fj).astype(int), 0, lat.size - 2)
ti = fi - i0
tj = fj - j0
z = ((1 - ti) * (1 - tj) * elev[j0, i0] + ti * (1 - tj) * elev[j0, i0 + 1]
     + (1 - ti) * tj * elev[j0 + 1, i0] + ti * tj * elev[j0 + 1, i0 + 1])

# nearest cell along the line: which real samples does the profile rest on?
ni = np.rint(fi).astype(int)
nj = np.rint(fj).astype(int)

valid = np.isfinite(z)
# last valid sample of the first continuous valid run starting at the house side
first_bad = np.argmax(~valid[50:]) + 50 if (~valid[50:]).any() else s.size
s_end = s[first_bad - 1]
keep = (s >= 0) & (s <= s_end)

cells = {}
for k in np.where(keep)[0]:
    cells.setdefault((nj[k], ni[k]), []).append(s[k])
cell_list = sorted(((min(v) + max(v)) / 2, j, i) for (j, i), v in cells.items())
n_cells = len(cell_list)
n_cells_100 = sum(1 for c in cell_list if c[0] >= 100.0)
flag_on_line = np.array([iflag[j, i] for _, j, i in cell_list])

OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
OUT_PNG.parent.mkdir(parents=True, exist_ok=True)
with open(OUT_CSV, "w", newline="") as f:
    wr = csv.writer(f)
    wr.writerow(["distance_from_house_m", "lat", "lon", "bed_above_LAT_m",
                 "water_depth_at_tide_m", "nearest_cell_lat_index", "nearest_cell_lon_index"])
    for k in np.where(keep)[0]:
        wr.writerow([f"{s[k]:.1f}", f"{plat[k]:.7f}", f"{plon[k]:.7f}", f"{z[k]:.3f}",
                     f"{TIDE_ABOVE_LAT - z[k]:.3f}", int(nj[k]), int(ni[k])])

# sanity check against the session-4 handoff numbers
checks = {}
for d_target, s_target in [(1.0, 132), (2.0, 154), (3.5, 209), (4.8, 231)]:
    checks[f"depth_at_{s_target}m"] = dict(expected=d_target,
                                           got=round(float(TIDE_ABOVE_LAT - z[int(s_target / DS)]), 2))
shelf = z[(s >= 55) & (s <= 120)]
checks["shelf_55_120m_above_LAT"] = dict(expected="2.0-2.2", got_min=round(float(shelf.min()), 2),
                                         got_max=round(float(shelf.max()), 2),
                                         got_median=round(float(np.median(shelf)), 2))
meta = dict(house_lat=HOUSE_LAT, house_lon=HOUSE_LON, bearing_deg=BEARING_DEG,
            tide_above_lat_m=TIDE_ABOVE_LAT, valid_to_m=float(s_end),
            bed_at_valid_end_above_LAT_m=round(float(z[keep][-1]), 2),
            n_lidar_cells_on_line_0_to_end=n_cells, n_lidar_cells_on_line_100_to_end=n_cells_100,
            cells_with_interpolation_flag=int(np.nansum(flag_on_line > 0)),
            grid_spacing_m=dict(east_west=round(float(np.diff(lon).mean() * M_PER_DEG * coslat), 1),
                                north_south=round(float(np.diff(lat).mean() * M_PER_DEG), 1)),
            checks=checks)
OUT_META.write_text(json.dumps(meta, indent=1))
print(json.dumps(meta, indent=1))

fig, ax = plt.subplots(figsize=(12, 4.2))
ax.fill_between(s[keep], z[keep], z[keep].min() - 1, color="#6b5b45", lw=0)
ax.plot(s[keep], z[keep], color="k", lw=1, label="lidar, bilinear between cell centres")
cs = np.array([c[0] for c in cell_list])
cz = np.array([elev[j, i] for _, j, i in cell_list])
ax.plot(cs, cz, "o", ms=3, color="tab:orange", label=f"nearest lidar cell centres ({n_cells})")
ax.axhline(TIDE_ABOVE_LAT, color="tab:blue", lw=1, ls="--", label=f"tide {TIDE_ABOVE_LAT} m above LAT")
ax.axvline(115, color="tab:red", lw=1, ls=":")
ax.text(115, TIDE_ABOVE_LAT + 1.0, "sat here (user)", color="tab:red", fontsize=8, ha="center")
ax.set_xlabel("distance from the house along 236 deg (m)")
ax.set_ylabel("height above LAT (m)")
ax.set_title("Porto Batel bed profile from the 2011 lidar (11 x 14 m grid; shape between dots is interpolation)")
ax.invert_xaxis()
ax.legend(loc="lower left", fontsize=8)
ax.grid(alpha=0.3)
fig.tight_layout()
fig.savefig(OUT_PNG, dpi=130)
