"""Export the Peniche lidar box (Consolacao + Porto Batel) as a viewer data file.

Run:  python -I export_reefs.py
Reads  data/raw/590_HR_Lidar_Centro.nc   (EMODnet high-resolution patch, 2011 lidar)
Writes ../01-seafloor/viewer/data/reefs.json  in the same format as the other layers:
  x_m, y_m (metres east / north of the origin), depth_m (positive down, land negative), shore (0/1).
Cells with no data are NOT written, and nothing is interpolated: a gap in the viewer is a gap in the data.
"""
import json
from pathlib import Path

import numpy as np
import xarray as xr
from scipy import ndimage as ndi

HERE = Path(__file__).parent

# ---- constants -------------------------------------------------------------------------------
NC_FILE = HERE / "data" / "raw" / "590_HR_Lidar_Centro.nc"
OUT_FILE = HERE.parent / "01-seafloor" / "viewer" / "data" / "reefs.json"
BOX = dict(lon_min=-9.385, lon_max=-9.340, lat_min=39.310, lat_max=39.334)   # both spots + ~1 km margin
ORIGIN_LAT, ORIGIN_LON = 39.322, -9.3625          # x = y = 0 (middle of the box)
SPOTS = {"Consolação": (39.3245, -9.3613),        # Fortaleza da Praia da Consolação (OSM / Wannasurf)
         "Porto Batel": (39.3196, -9.3548)}       # OSM "Porto Batel" viewpoint, on the cliff above the break
MAX_POINTS = 400_000                              # thin to every 2nd cell if the box ever holds more than this
M_PER_DEG = 111195.0


def to_metres(lon, lat):
    """Flat-earth degrees -> metres (fine for a 4 km box)."""
    return ((np.asarray(lon) - ORIGIN_LON) * M_PER_DEG * np.cos(np.radians(ORIGIN_LAT)),
            (np.asarray(lat) - ORIGIN_LAT) * M_PER_DEG)


# 1. Cut the box out of the big file. The file stores elevation (up positive); the viewer wants depth (down positive).
d = xr.open_dataset(NC_FILE)
s = d.sel(lon=slice(BOX["lon_min"], BOX["lon_max"]), lat=slice(BOX["lat_min"], BOX["lat_max"])).load()
depth = -s.elevation.values.astype(float)
lon2d, lat2d = np.meshgrid(s.lon.values, s.lat.values)
x, y = to_metres(lon2d, lat2d)

# 2. A "shore" cell is a sea cell (depth > 0) with a land cell (depth <= 0) next to it.
valid = np.isfinite(depth)
sea = valid & (depth > 0)
land = valid & (depth <= 0)
shore = sea & ndi.binary_dilation(land, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))

# 3. Keep only cells that have data (empty cells stay empty). Thin only if there are too many.
keep = valid.copy()
thinned = False
if keep.sum() > MAX_POINTS:
    mask = np.zeros_like(keep)
    mask[::2, ::2] = True
    keep &= mask
    thinned = True

cell_x = float(np.diff(x[0, :3]).mean())
cell_y = float(np.diff(y[:3, 0]).mean())
meta = dict(
    layer="Reef maps: Consolação and Porto Batel",
    source="EMODnet Bathymetry high-resolution patch 590_HR_Lidar_Centro (DGT / Portuguese Environment Agency topo-bathymetric lidar)",
    release="survey 2011",
    datum="LAT",
    resolution=f"{cell_x:.0f} m east-west x {cell_y:.0f} m north-south",
    n_points=int(keep.sum()), thinned=thinned,
    origin={"lat": ORIGIN_LAT, "lon": ORIGIN_LON, "note": "middle of the box, x=y=0"},
    spots={name: {"lat": la, "lon": lo, "x_m": round(float(to_metres(lo, la)[0]), 1), "y_m": round(float(to_metres(lo, la)[1]), 1)}
           for name, (la, lo) in SPOTS.items()},
    depth_sign="positive down, land negative (height above LAT)",
    caption=("Source: EMODnet Bathymetry high-resolution patch 590_HR_Lidar_Centro, DGT/APA airborne lidar survey, 2011. "
             "Licence CC BY 4.0 (as reported by EMODnet; the patch record itself does not restate it). Not for navigation. "
             f"Grid cells about {cell_x:.0f} x {cell_y:.0f} m; depths relative to LAT (Lowest Astronomical Tide, as stated by EMODnet). "
             "The data stops about 500-600 m offshore at roughly 8-11 m depth: nothing is known beyond that, and gaps are left empty, not filled."
             + (" Thinned to every 2nd cell." if thinned else " All cells with data are shown (no thinning).")),
)
out = {"meta": meta,
       "x_m": np.round(x[keep], 1).tolist(), "y_m": np.round(y[keep], 1).tolist(),
       "depth_m": np.round(depth[keep], 2).tolist(), "shore": shore[keep].astype(int).tolist()}
OUT_FILE.write_text(json.dumps(out, separators=(",", ":")))
print("wrote", OUT_FILE.name, OUT_FILE.stat().st_size // 1024, "KB,", int(keep.sum()), "points, thinned:", thinned)
