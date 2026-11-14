"""Export the Pipeline (Oahu North Shore) reef box as a viewer data file.

Run:  python export_pipeline.py
Reads  data/raw/*.tif   (20 NOAA/USACE 2013 NCMP topobathy tiles, 1 m, lon/lat, elevation in m above mean sea level)
Writes ../01-seafloor/viewer/data/pipeline.json  in the same format as reefs.json:
  x_m, y_m (metres east / north of the origin), depth_m (positive down, land negative), shore (0/1).

How it works (plain steps):
  1. Lay an empty grid of ~8 m cells over the box (cells are 8 m x 8 m on the ground).
  2. Read the tiles ONE AT A TIME, only the part inside the box (keeps memory small, single thread).
  3. Every valid 1 m pixel adds its elevation to the cell it falls in (a running sum and a count).
  4. Cell value = sum / count (the average). A cell needs >= 50 % of its ~64 pixels to be valid, else it is left empty.
  5. Depth = -elevation. Empty cells are NOT written and nothing is filled in: a gap in the viewer is a gap in the data.
"""
import json
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from scipy import ndimage as ndi

HERE = Path(__file__).parent

# ---- constants -------------------------------------------------------------------------------
RAW_DIR = HERE / "data" / "raw"
OUT_FILE = HERE.parent / "01-seafloor" / "viewer" / "data" / "pipeline.json"
BOX = dict(lon_min=-158.075, lon_max=-158.035, lat_min=21.640, lat_max=21.685)
ORIGIN_LAT, ORIGIN_LON = 21.6650, -158.0515        # x = y = 0 (approx the Pipeline break)
# Spot positions come from published sources, NOT from snapping a guess to the nearest wet cell (that would hide a wrong position).
# After export we only REPORT the depth of the nearest cell, so a wrong position shows up as land or a silly depth.
#  Pipeline   21 deg 39' 50" N, 158 deg 03' 14" W (21.66389, -158.05389)  https://en.wikipedia.org/wiki/Banzai_Pipeline
#  Backdoor   21.666971 N, 158.051569 W, "approximate geographical coordinates", right of Pipeline  https://www.surfertoday.com/surfing/the-mechanics-of-backdoor
#             (a surf-site estimate, not a survey: labelled unverified; it lies ~250 m EAST of the Pipeline point, not west)
#  Waimea Bay 21.640296 N, 158.063779 W (the bay, not a specific break)  https://en.wikipedia.org/wiki/Waimea_Bay,_Hawaii
# label = the text shown on the marker in the viewer.
SPOT_SRC = {"Pipeline": (21.66389, -158.05389, "Pipeline (approx. spot position)"),
            "Backdoor": (21.666971, -158.051569, "Backdoor (approx. spot position, unverified)"),
            "Waimea Bay": (21.640296, -158.063779, "Waimea Bay (approx. spot position)")}
CELL_M = 8.0                                        # output cell size in metres
MIN_VALID = 0.5                                     # a cell needs at least this fraction of valid 1 m pixels
MAX_POINTS = 400_000
M_PER_DEG = 111195.0                                # same flat-earth scale as export_reefs.py
COS0 = np.cos(np.radians(ORIGIN_LAT))


def to_metres(lon, lat):
    """Flat-earth degrees -> metres from the origin (x east, y north)."""
    return ((np.asarray(lon) - ORIGIN_LON) * M_PER_DEG * COS0,
            (np.asarray(lat) - ORIGIN_LAT) * M_PER_DEG)


# 1. The output grid, laid out in metres from the origin. Column i covers x in [x0 + i*8, x0 + (i+1)*8).
x_lo, y_lo = to_metres(BOX["lon_min"], BOX["lat_min"])
x_hi, y_hi = to_metres(BOX["lon_max"], BOX["lat_max"])
nx, ny = int(np.floor((x_hi - x_lo) / CELL_M)), int(np.floor((y_hi - y_lo) / CELL_M))
sums = np.zeros(ny * nx)       # running sum of elevation per cell
counts = np.zeros(ny * nx)     # how many valid 1 m pixels fell in each cell
n_tiles_used = 0

# 2-3. Tiles one by one: cut out the box, drop nodata, add into the cells.
for tif in sorted(RAW_DIR.glob("*.tif")):
    with rasterio.open(tif) as src:
        b = src.bounds
        w = from_bounds(max(b.left, BOX["lon_min"]), max(b.bottom, BOX["lat_min"]),
                        min(b.right, BOX["lon_max"]), min(b.top, BOX["lat_max"]), src.transform)
        if w.width < 1 or w.height < 1:
            continue                                   # tile is outside the box
        w = w.round_offsets().round_lengths()
        elev = src.read(1, window=w, masked=True)      # masked array: nodata is already masked
        t = src.window_transform(w)
        rows, cols = np.indices(elev.shape)
        lon = t.c + (cols + 0.5) * t.a                 # pixel-centre lon / lat
        lat = t.f + (rows + 0.5) * t.e
    ok = ~np.ma.getmaskarray(elev) & np.isfinite(elev.data)
    x, y = to_metres(lon[ok], lat[ok])
    ci = np.floor((x - x_lo) / CELL_M).astype(int)
    ri = np.floor((y - y_lo) / CELL_M).astype(int)
    inside = (ci >= 0) & (ci < nx) & (ri >= 0) & (ri < ny)
    flat = ri[inside] * nx + ci[inside]
    sums += np.bincount(flat, weights=elev.data[ok][inside].astype(float), minlength=ny * nx)
    counts += np.bincount(flat, minlength=ny * nx)
    n_tiles_used += 1
    print("read", tif.name[-30:], "valid px in box:", int(inside.sum()))

# 4. Average, and demand at least half of the (8 m / 1 m)^2 = ~64 pixels (about 69 px given the lon/lat 1 m grid).
sums, counts = sums.reshape(ny, nx), counts.reshape(ny, nx)
px_per_cell = CELL_M * CELL_M / (src.res[0] * M_PER_DEG * COS0 * src.res[1] * M_PER_DEG)
valid = counts >= MIN_VALID * px_per_cell
elev_mean = np.where(valid, sums / np.maximum(counts, 1), np.nan)
depth = -elev_mean                                      # viewer wants depth: positive down, land negative

xc = x_lo + (np.arange(nx) + 0.5) * CELL_M              # cell centres, metres
yc = y_lo + (np.arange(ny) + 0.5) * CELL_M
x, y = np.meshgrid(xc, yc)

# 5. A "shore" cell is a sea cell (depth > 0) with a land cell (depth <= 0) next to it.
sea = valid & (depth > 0)
land = valid & (depth <= 0)
shore = sea & ndi.binary_dilation(land, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))

keep = valid.copy()
thinned = False
if keep.sum() > MAX_POINTS:                             # safety valve, normally not triggered
    mask = np.zeros_like(keep)
    mask[::2, ::2] = True
    keep &= mask
    thinned = True

# 6. Report the water depth at each spot (nearest valid cell). Nothing is moved.
SPOTS, SPOT_DEPTH = {}, {}
vx, vy, vd = x[valid], y[valid], depth[valid]
for name, (la, lo, _) in SPOT_SRC.items():
    gx, gy = to_metres(lo, la)
    k = np.argmin(np.hypot(vx - gx, vy - gy))
    SPOTS[name] = (la, lo)
    SPOT_DEPTH[name] = float(vd[k])
    print(f"spot {name}: {la:.6f} N, {lo:.6f} E, nearest-cell depth {vd[k]:.1f} m ({np.hypot(vx[k]-gx, vy[k]-gy):.0f} m away)")

gap_fraction = 1 - valid.sum() / valid.size
meta = dict(
    layer="Reef map: Pipeline, Oahu",
    source="2013 USACE NCMP topobathy lidar (CZMIL) DEM, NOAA dataset 9365, 1 m tiles resampled to ~8 m",
    release="survey 2013",
    datum="LMSL (mean sea level), not LAT like the Portuguese layers",
    resolution=f"{CELL_M:.0f} m x {CELL_M:.0f} m (block mean of 1 m cells, at least 50% valid)",
    n_points=int(keep.sum()), thinned=thinned,
    origin={"lat": ORIGIN_LAT, "lon": ORIGIN_LON, "note": "approx. the Pipeline break, x=y=0"},
    spots={name: {"lat": la, "lon": lo, "label": SPOT_SRC[name][2], "depth_m": round(SPOT_DEPTH[name], 1), "x_m": round(float(to_metres(lo, la)[0]), 1), "y_m": round(float(to_metres(lo, la)[1]), 1)}
           for name, (la, lo) in SPOTS.items()},
    depth_sign="positive down, land negative (height above LMSL, mean sea level)",
    credit=("NOAA Office for Coastal Management / USACE JALBTCX, via NOAA Digital Coast. Believed public domain (US federal data); "
            "written confirmation requested 2026-11-14. 2013 USACE NCMP topobathy lidar (CZMIL), 1 m, resampled to ~8 m. Not for navigation."),
)
meta["caption"] = (meta["credit"] + " Depths relative to LMSL (mean sea level), not LAT like the Portuguese layers. "
                   "Spot positions are published approximate positions (Backdoor unverified). Gaps are left empty, not filled.")
out = {"meta": meta,
       "x_m": np.round(x[keep], 1).tolist(), "y_m": np.round(y[keep], 1).tolist(),
       "depth_m": np.round(depth[keep], 2).tolist(), "shore": shore[keep].astype(int).tolist()}
OUT_FILE.write_text(json.dumps(out, separators=(",", ":")))
print("wrote", OUT_FILE.name, OUT_FILE.stat().st_size // 1024, "KB,", int(keep.sum()), "points, thinned:", thinned)
print(f"grid {nx} x {ny} cells, tiles used {n_tiles_used}, gap fraction {gap_fraction:.3f}")
print(f"depth range {np.nanmin(depth[keep]):.1f} to {np.nanmax(depth[keep]):.1f} m (positive down)")
