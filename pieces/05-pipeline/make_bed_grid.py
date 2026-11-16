"""Pipeline bed grid for Stage A: the 2013 1 m lidar block-averaged onto a local 10 m grid.

Run:  python make_bed_grid.py            -> ../06-live-wave/data/bed_grid_pipeline.npz
      python make_bed_grid.py --probe X.npz   (elevations at the published points; 4 km north-up grid to X.npz)

Same contents as Porto Batel's saved grid (stage_a.load_bed): x, y = cell centres in metres, every 10 m; bed = elevation
in m above the lidar datum (here LMSL, local mean sea level); filled = True where the cell had too few valid lidar pixels
and was filled from the nearest valid cell (the same nearest-cell fill stage_a.load_bed applies to the Portuguese gaps).
The frame is the site's (sites.PIPELINE): origin = start of the reference line, +y = seaward along the 314 deg shore
normal, +x = alongshore toward 44 deg. Stage A turns the swell direction into this frame (grid_deg).

Why a block mean, not a point sample: the Portuguese lidar (~11 x 14 m) is coarser than the 10 m model grid, so
stage_a.load_bed interpolates it bilinearly. Here the lidar is 1 m, ten times finer than the grid, and a point sample would
alias single boulders or holes into a 10 m cell. A 10 x 10 m block mean (about 120 pixels at this latitude) is the cell's
average depth, which is what the model's wavenumber and shoaling need.

Why 10 m (not finer): Stage A's constants (phi smoothing 2 cells, the H/h >= 0.78 test per cell, the 2 m profile steps
read cell by cell) were set and checked on a 10 m grid; keeping 10 m keeps the model unchanged. 10 m is also fine enough:
the shortest wave in the Pipeline sweep (Tp 8 s) is ~45 m long in 3 m of water (>= 4 cells), and the three reefs are
~60-300 m from shore. It cannot resolve the 1-5 m ledges of First Reef; that is a stated limit.
"""
import sys
from pathlib import Path

import numpy as np
import rasterio
from rasterio.windows import from_bounds
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "06-live-wave"))
import sites  # noqa: E402

RAW = HERE / "data" / "raw"
SITE = sites.PIPELINE
M_PER_DEG = 111195.0
MIN_VALID = 0.5            # a cell needs at least half its 1 m pixels valid, else it is gap-filled (and marked)


def block_mean(lat0, lon0, xr, yr, dx, grid_deg=0.0):
    """Block mean of the 1 m tiles on cell centres x = xr[0]..xr[1], y = yr[0]..yr[1] every dx, in a frame turned so that
    +y points to compass bearing grid_deg (+x to grid_deg + 90). Returns x, y, bed (NaN where < MIN_VALID), valid."""
    x = np.linspace(xr[0], xr[1], int(round((xr[1] - xr[0]) / dx)) + 1)
    y = np.linspace(yr[0], yr[1], int(round((yr[1] - yr[0]) / dx)) + 1)
    nx, ny = len(x), len(y)
    coslat = np.cos(np.radians(lat0)); g = np.radians(grid_deg)
    cx = np.array([x[0], x[-1], x[0], x[-1]]); cy = np.array([y[0], y[0], y[-1], y[-1]])
    E = cx * np.cos(g) + cy * np.sin(g); N = -cx * np.sin(g) + cy * np.cos(g)
    lon_lo = lon0 + (E.min() - dx) / (M_PER_DEG * coslat); lon_hi = lon0 + (E.max() + dx) / (M_PER_DEG * coslat)
    lat_lo = lat0 + (N.min() - dx) / M_PER_DEG; lat_hi = lat0 + (N.max() + dx) / M_PER_DEG
    sums = np.zeros(nx * ny); counts = np.zeros(nx * ny); px = None
    for tif in sorted(RAW.glob("*.tif")):
        with rasterio.open(tif) as src:
            b = src.bounds
            if b.right < lon_lo or b.left > lon_hi or b.top < lat_lo or b.bottom > lat_hi:
                continue
            w = from_bounds(max(b.left, lon_lo), max(b.bottom, lat_lo), min(b.right, lon_hi), min(b.top, lat_hi), src.transform)
            w = w.round_offsets().round_lengths()
            if w.width < 1 or w.height < 1:
                continue
            el = src.read(1, window=w, masked=True)
            t = src.window_transform(w); px = src.res
        rows, cols = np.indices(el.shape)
        lon = t.c + (cols + 0.5) * t.a; lat = t.f + (rows + 0.5) * t.e
        ok = ~np.ma.getmaskarray(el) & np.isfinite(el.data) & (np.abs(el.data) < 1e4)
        Em = (lon[ok] - lon0) * M_PER_DEG * coslat; Nm = (lat[ok] - lat0) * M_PER_DEG
        u = Em * np.cos(g) - Nm * np.sin(g); v = Em * np.sin(g) + Nm * np.cos(g)
        ci = np.floor((u - (x[0] - dx / 2)) / dx).astype(int); ri = np.floor((v - (y[0] - dx / 2)) / dx).astype(int)
        inside = (ci >= 0) & (ci < nx) & (ri >= 0) & (ri < ny)
        flat = ri[inside] * nx + ci[inside]
        sums += np.bincount(flat, weights=el.data[ok][inside].astype(float), minlength=nx * ny)
        counts += np.bincount(flat, minlength=nx * ny)
    sums, counts = sums.reshape(ny, nx), counts.reshape(ny, nx)
    px_per_cell = dx * dx / (px[0] * M_PER_DEG * coslat * px[1] * M_PER_DEG)
    valid = counts >= MIN_VALID * px_per_cell
    bed = np.where(valid, sums / np.maximum(counts, 1), np.nan)
    return x, y, bed, valid


def fill(bed):
    """Nearest-valid-cell fill, as stage_a.load_bed does for the Portuguese lidar; returns bed_f and the filled mask."""
    nan = ~np.isfinite(bed)
    idx = ndi.distance_transform_edt(nan, return_distances=False, return_indices=True)
    return bed[tuple(idx)], nan


if __name__ == "__main__":
    if "--probe" in sys.argv:
        T = SITE["takeoff"]
        x, y, bed, valid = block_mean(T["lat"], T["lon"], (-2000, 2000), (-2000, 2000), 10.0)
        coslat = np.cos(np.radians(T["lat"]))
        for name, (la, lo, src) in SITE["points"].items():
            ex = (lo - T["lon"]) * M_PER_DEG * coslat; ny = (la - T["lat"]) * M_PER_DEG
            i = int(np.argmin(np.abs(x - ex))); j = int(np.argmin(np.abs(y - ny)))
            print(f"{name:34s} {la:.5f} {lo:.5f}  E {ex:6.0f} N {ny:6.0f}  bed {bed[j, i]:7.2f} m LMSL")
        np.savez_compressed(sys.argv[-1], x=x, y=y, bed=bed)
        sys.exit(0)
    x, y, bed, valid = block_mean(SITE["origin_lat"], SITE["origin_lon"], SITE["x_range"], SITE["y_range"], SITE["dx"], SITE["grid_deg"])
    bed_f, filled = fill(bed)
    out = Path(SITE["bed_npz"])
    np.savez_compressed(out, x=x, y=y, bed=bed_f, filled=filled)
    print(f"wrote {out.name} ({out.stat().st_size/1024:.0f} KB): {bed.shape} (ny, nx), filled {filled.mean():.3f}, "
          f"bed {np.nanmin(bed):.1f}..{np.nanmax(bed):.1f} m LMSL")
    top = bed[-1]
    print(f"seaward edge row (y = {y[-1]:.0f} m): valid {np.isfinite(top).mean():.2f}, depth min / median / max "
          f"{-np.nanmax(top):.1f} / {-np.nanmedian(top):.1f} / {-np.nanmin(top):.1f} m")
    for side, col in (("x = -1200 (WSW side)", bed[:, 0]), ("x = +1200 (ENE side)", bed[:, -1])):
        print(f"{side}: valid {np.isfinite(col).mean():.2f}, deepest {-np.nanmin(col):.1f} m")
    i0 = int(np.argmin(np.abs(x))); line = bed[:, i0]
    j = np.nonzero(np.isfinite(line) & (line < 0))[0][0]
    jt = int(np.argmin(np.abs(y - SITE["takeoff"]["s"])))
    print(f"reference line: first cell below 0 m LMSL at s = {y[j]:.0f} m; take-off at s = {SITE['takeoff']['s']:.0f} m (bed {line[jt]:.2f} m)")
    print("bed along the reference line every 50 m:", [(int(y[k]), round(float(line[k]), 1)) for k in range(0, len(y), 5)])
