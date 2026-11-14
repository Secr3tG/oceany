"""Export a Basque-coast (Landes / Pays Basque) lidar box as a viewer data file.

Run:  python export_basque.py gravière      (or:  guethary)
Reads  data/raw/<cell>/**/MNT1m/*MNT*.asc   (Shom - IGN Litto3D NAQ 2020-2022, 1 m DEM, ASCII grid)
Writes ../01-seafloor/viewer/data/hossegor.json  or  guethary.json
       in the same format as pipeline.json / reefs.json:
       x_m, y_m (metres east / north of the origin), depth_m (positive down, land negative), shore (0/1).

The ASC tiles are in Lambert-93 (EPSG:2154, metres). The viewer works in lon/lat-based flat-earth metres,
so each pixel is converted Lambert-93 -> lon/lat. pyproj is not installed, so the conversion is written
here with numpy only (standard Lambert Conformal Conic 2SP inverse formulas, GRS80 ellipsoid).

Plain steps:
  1. Lay an empty grid of ~4 m cells over the box.
  2. Find every tile that overlaps the box (missing tiles give a clear message and stop the script).
  3. Read each tile ONE AT A TIME; convert pixel centres to lon/lat; drop nodata and pixels outside the box.
  4. Every valid 1 m pixel adds its height to the 4 m cell it falls in (running sum and count).
  5. Cell = sum / count, but only if >= 50 % of the ~16 pixels are valid. Others stay EMPTY (a gap is a gap, nothing is filled).
  6. Depth = -height (heights are IGN69, positive up, so the sea floor is negative height = positive depth).
"""
import json
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).parent
RAW_DIR = HERE / "data" / "raw"
OUT_DIR = HERE.parent / "01-seafloor" / "viewer" / "data"

# ---- spots: bounding box, origin, spot position, output file -----------------------------------
# Spot positions are published approximate positions, NOT snapped to a wet cell. After export we only REPORT
# the depth of the nearest cell, so a wrong position shows up as land or a silly depth.
SPOTS = {
    "gravière": dict(
        out="hossegor.json", layer="Reef map: La Gravière, Hossegor",
        box=dict(lon_min=-1.455, lon_max=-1.425, lat_min=43.655, lat_max=43.685),
        # La Gravière 43.675620 N, 1.443375 W. Source (fetched 2026-11-14): Ultimate France, "Lat Long: 43.675620, -1.443375",
        # https://www.ultimatefrance.com/surfing/south-west-france/hossegor (Mondo Surf lists the same value:
        # https://www.mondo.surf/surf-spot/la-graviere/guide/6348). An earlier guess of 43.669, -1.442 was ~750 m too far
        # south, so the source value is used. Still a surf-guide position, not a survey: labelled approx.
        spot=("La Gravière", 43.67562, -1.443375, "La Gravière (approx. spot position, surf-guide source)")),
    "guethary": dict(
        out="guethary.json", layer="Reef map: Guéthary (Parlementia)",
        box=dict(lon_min=-1.640, lon_max=-1.595, lat_min=43.410, lat_max=43.440),
        # Parlementia 43.427718 N, 1.611053 W. Source (fetched 2026-11-14): Ultimate France, "Lat Long: 43.427718, -1.611053",
        # https://www.ultimatefrance.com/surfing/south-west-france/guethary . Other sources differ by a few hundred m
        # (Tourisme64 43.4272, -1.60868). Surf-guide position, not a survey: labelled approx.
        spot=("Parlementia", 43.427718, -1.611053, "Parlementia (approx. spot position, surf-guide source)")),
}
CELL_M = 4.0
MIN_VALID = 0.5
MAX_POINTS = 400_000
LAND_KEEP_M = 250.0           # land further inland than this from the sea is dropped
M_PER_DEG = 111195.0          # same flat-earth scale as export_reefs.py / export_pipeline.py
NODATA = -99999.0


def lambert93_to_lonlat(E, N):
    """Lambert-93 (EPSG:2154) easting/northing in metres -> lon, lat in degrees (numpy only).
    Lambert Conformal Conic 2SP, GRS80, standard parallels 44 and 49 N, origin 46.5 N / 3 E, false E/N 700000/6600000."""
    a, f = 6378137.0, 1 / 298.257222101
    e = np.sqrt(2 * f - f * f)
    lat0, lat1, lat2, lon0 = np.radians([46.5, 44.0, 49.0, 3.0])
    x0, y0 = 700000.0, 6600000.0

    def m(phi):
        return np.cos(phi) / np.sqrt(1 - (e * np.sin(phi)) ** 2)

    def t(phi):
        es = e * np.sin(phi)
        return np.tan(np.pi / 4 - phi / 2) / ((1 - es) / (1 + es)) ** (e / 2)

    n = (np.log(m(lat1)) - np.log(m(lat2))) / (np.log(t(lat1)) - np.log(t(lat2)))
    F = m(lat1) / (n * t(lat1) ** n)
    rho0 = a * F * t(lat0) ** n
    dx, dy = np.asarray(E) - x0, rho0 - (np.asarray(N) - y0)
    rho = np.sign(n) * np.hypot(dx, dy)
    tt = (rho / (a * F)) ** (1 / n)
    theta = np.arctan2(dx, dy)
    phi = np.pi / 2 - 2 * np.arctan(tt)               # first guess, then iterate (converges in a few steps)
    for _ in range(6):
        es = e * np.sin(phi)
        phi = np.pi / 2 - 2 * np.arctan(tt * ((1 - es) / (1 + es)) ** (e / 2))
    lon = theta / n + lon0
    return np.degrees(lon), np.degrees(phi)


def read_asc_header(path):
    """The six header lines of an ESRI ASCII grid -> dict (xllcenter/yllcenter = centre of the lower-left pixel)."""
    hdr = {}
    with open(path) as fh:
        for _ in range(6):
            k, v = fh.readline().split()
            hdr[k.lower()] = float(v)
    return hdr


# ---- choose the spot --------------------------------------------------------------------------
if len(sys.argv) != 2 or sys.argv[1].lower() not in SPOTS:
    sys.exit("Usage: export_basque.py <spot>   where spot is one of: " + ", ".join(SPOTS))
cfg = SPOTS[sys.argv[1].lower()]
BOX = cfg["box"]
name, spot_lat, spot_lon, spot_label = cfg["spot"]
ORIGIN_LAT, ORIGIN_LON = spot_lat, spot_lon          # x = y = 0 at the (approx.) spot
COS0 = np.cos(np.radians(ORIGIN_LAT))


def to_metres(lon, lat):
    """Flat-earth degrees -> metres from the origin (x east, y north)."""
    return ((np.asarray(lon) - ORIGIN_LON) * M_PER_DEG * COS0, (np.asarray(lat) - ORIGIN_LAT) * M_PER_DEG)


# 1. The output grid
x_lo, y_lo = to_metres(BOX["lon_min"], BOX["lat_min"])
x_hi, y_hi = to_metres(BOX["lon_max"], BOX["lat_max"])
nx, ny = int(np.floor((x_hi - x_lo) / CELL_M)), int(np.floor((y_hi - y_lo) / CELL_M))
sums, counts = np.zeros(ny * nx), np.zeros(ny * nx)

# 2. Which tiles overlap the box? Test the four tile corners converted to lon/lat (a tile is only 1 km wide).
asc_files = sorted(RAW_DIR.glob("*/**/MNT1m/*MNT*.asc"))
if not asc_files:
    sys.exit(f"No 1 m ASC tiles found under {RAW_DIR}. Download and extract the Shom Litto3D cells first.")
todo = []
for p in asc_files:
    h = read_asc_header(p)
    e0, n0 = h["xllcenter"] - 0.5, h["yllcenter"] - 0.5          # lower-left CORNER of the tile
    cl, cb = lambert93_to_lonlat([e0, e0 + 1000, e0, e0 + 1000], [n0, n0, n0 + 1000, n0 + 1000])
    if cl.max() >= BOX["lon_min"] and cl.min() <= BOX["lon_max"] and cb.max() >= BOX["lat_min"] and cb.min() <= BOX["lat_max"]:
        todo.append((p, h))
if not todo:
    sys.exit(f"None of the {len(asc_files)} tiles found under {RAW_DIR} overlap the {sys.argv[1]} box "
             f"(lon {BOX['lon_min']}..{BOX['lon_max']}, lat {BOX['lat_min']}..{BOX['lat_max']}). "
             "The tiles for this spot have probably not been downloaded yet.")

# 3-4. Tiles one by one
for p, h in todo:
    nr, nc = int(h["nrows"]), int(h["ncols"])
    z = np.loadtxt(p, skiprows=6, dtype=np.float32).reshape(nr, nc)     # row 0 is the NORTH edge
    cols, rows = np.meshgrid(np.arange(nc), np.arange(nr))
    E = h["xllcenter"] + cols * h["cellsize"]
    N = h["yllcenter"] + (nr - 1 - rows) * h["cellsize"]
    ok = (z != NODATA) & np.isfinite(z)
    lon, lat = lambert93_to_lonlat(E[ok], N[ok])
    zz = z[ok].astype(float)
    x, y = to_metres(lon, lat)
    ci, ri = np.floor((x - x_lo) / CELL_M).astype(int), np.floor((y - y_lo) / CELL_M).astype(int)
    inside = (ci >= 0) & (ci < nx) & (ri >= 0) & (ri < ny)
    flat = ri[inside] * nx + ci[inside]
    sums += np.bincount(flat, weights=zz[inside], minlength=ny * nx)
    counts += np.bincount(flat, minlength=ny * nx)
    print("read", p.name, "valid px in box:", int(inside.sum()))

# 5. Average; need >= 50 % of the nominal CELL_M^2 = 16 pixels
sums, counts = sums.reshape(ny, nx), counts.reshape(ny, nx)
valid = counts >= MIN_VALID * CELL_M * CELL_M
depth = -np.where(valid, sums / np.maximum(counts, 1), np.nan)       # positive down, land negative

xc = x_lo + (np.arange(nx) + 0.5) * CELL_M
yc = y_lo + (np.arange(ny) + 0.5) * CELL_M
x, y = np.meshgrid(xc, yc)

# 6. Shore = sea cell (depth > 0) touching a land cell (depth <= 0)
sea, land = valid & (depth > 0), valid & (depth <= 0)
shore = sea & ndi.binary_dilation(land, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))

# Crop inland land: keep every sea cell, but land cells only within LAND_KEEP_M of the nearest sea cell
# (distance_transform_edt gives, for each cell, the distance in cells to the nearest sea cell).
dist_to_sea_m = ndi.distance_transform_edt(~sea) * CELL_M
keep, thinned = valid & (sea | (dist_to_sea_m <= LAND_KEEP_M)), False
if keep.sum() > MAX_POINTS:                          # safety valve: keep every 2nd cell in x and y
    mask = np.zeros_like(keep)
    mask[::2, ::2] = True
    keep &= mask
    thinned = True

# 7. Report the depth at the spot (nearest valid cell). Nothing is moved.
gx, gy = to_metres(spot_lon, spot_lat)
vx, vy, vd = x[valid], y[valid], depth[valid]
k = np.argmin(np.hypot(vx - gx, vy - gy))
spot_depth, spot_dist = float(vd[k]), float(np.hypot(vx[k] - gx, vy[k] - gy))
print(f"spot {name}: {spot_lat} N, {spot_lon} E, nearest-cell depth {spot_depth:.1f} m ({spot_dist:.0f} m away)"
      + ("  -> THIS IS LAND (depth <= 0)" if spot_depth <= 0 else ""))
cand = (vd >= 3) & (vd <= 6)                         # separate report: nearest 3-6 m cell as a candidate take-off
if cand.any():
    j = np.where(cand)[0][np.argmin(np.hypot(vx[cand] - gx, vy[cand] - gy))]
    print(f"nearest 3-6 m cell: depth {vd[j]:.1f} m at x={vx[j]:.0f} m, y={vy[j]:.0f} m, {np.hypot(vx[j]-gx, vy[j]-gy):.0f} m from the spot point")

# candidate take-off: reported as an extra in meta.spots, converted back to lon/lat with the flat-earth scale
extras = {}
if cand.any():
    cx, cy = float(vx[j]), float(vy[j])
    extras[name + " candidate take-off"] = {"lat": ORIGIN_LAT + cy / M_PER_DEG, "lon": ORIGIN_LON + cx / (M_PER_DEG * COS0),
        "label": "candidate take-off (from bathymetry, not a surveyed position)", "depth_m": round(float(vd[j]), 1),
        "x_m": round(cx, 1), "y_m": round(cy, 1)}
gap_fraction = 1 - valid.sum() / valid.size
credit = ("Shom - IGN, 2025. https://doi.org/10.17183/LITTO3D_NAQ_2020_2022. Free reuse (Etalab open licence). Not for navigation.")
meta = dict(
    layer=cfg["layer"],
    source="Shom - IGN Litto3D Nouvelle-Aquitaine 2020-2022 1 m DEM (Lambert-93), resampled to ~4 m",
    release="Litto3D NAQ 2020-2022, tiles dated 2025-05-31",
    datum="IGN69 (French land levelling datum, close to mean sea level; not LAT like the Portuguese layers)",
    resolution=f"{CELL_M:.0f} m x {CELL_M:.0f} m (block mean of 1 m cells, at least 50% valid)",
    n_points=int(keep.sum()), thinned=thinned, land_cropped_m=LAND_KEEP_M,
    origin={"lat": ORIGIN_LAT, "lon": ORIGIN_LON, "note": f"approx. {name} spot position, x=y=0"},
    spots={name: {"lat": spot_lat, "lon": spot_lon, "label": spot_label, "depth_m": round(spot_depth, 1),
                  "x_m": round(float(gx), 1), "y_m": round(float(gy), 1)}, **extras},
    depth_sign="positive down, land negative (height above IGN69 datum)",
    credit=credit,
)
meta["caption"] = (credit + " Depths relative to IGN69 (land levelling datum, close to mean sea level), not LAT like the Portuguese layers. "
                   "Spot position is a published approximate position. Gaps are left empty, not filled.")
out = {"meta": meta, "x_m": np.round(x[keep], 1).tolist(), "y_m": np.round(y[keep], 1).tolist(),
       "depth_m": np.round(depth[keep], 2).tolist(), "shore": shore[keep].astype(int).tolist()}
OUT_DIR.mkdir(parents=True, exist_ok=True)
(OUT_DIR / cfg["out"]).write_text(json.dumps(out, separators=(",", ":")))
print("wrote", cfg["out"], (OUT_DIR / cfg["out"]).stat().st_size // 1024, "KB,", int(keep.sum()), "points, thinned:", thinned)
print(f"grid {nx} x {ny} cells, tiles used {len(todo)}, gap fraction {gap_fraction:.3f}")
print(f"depth range {np.nanmin(depth[keep]):.1f} to {np.nanmax(depth[keep]):.1f} m (positive down)")
d = depth[valid]
print(f"sea cells {int(sea.sum())}, land cells {int(land.sum())}, shore cells {int(shore.sum())}; "
      f"sea depth mean {d[d>0].mean():.1f} m, median {np.median(d[d>0]):.1f} m; cells deeper than 10 m: {int((d>10).sum())}")
