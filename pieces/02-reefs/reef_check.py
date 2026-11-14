"""Check the 2011 lidar depth grid around Consolacao and Porto Batel (Peniche, Portugal).

Run:  python -I reef_check.py
Reads data/raw/590_HR_Lidar_Centro.nc (EMODnet high-resolution patch, same grid as the .emo text file).
Prints a table of checks and writes reef_check.png.

Sign convention: the .nc file stores ELEVATION (up is positive, sea floor negative).
The viewer wants DEPTH (down is positive), so depth = -elevation. I checked a few cells against the
.emo text file: the .emo third column is depth, positive down, and equals -elevation.
"""
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import xarray as xr
from matplotlib.colors import LightSource
from scipy import ndimage as ndi

HERE = Path(__file__).parent

# ---- constants -------------------------------------------------------------------------------
NC_FILE = HERE / "data" / "raw" / "590_HR_Lidar_Centro.nc"
# The two spots (lat, lon). Sources are in the report; Porto Batel is the less certain of the two.
SPOTS = {"Consolação": (39.3245, -9.3613),     # Fortaleza da Praia da Consolação (OSM) = Wannasurf spot position
         "Porto Batel": (39.3196, -9.3548)}    # OSM "Porto Batel" viewpoint (Nominatim)
BOX = dict(lon_min=-9.385, lon_max=-9.340, lat_min=39.310, lat_max=39.334)   # spots + ~1 km margin
M_PER_DEG = 111195.0
ORIGIN_LAT = 39.322
ORIGIN_LON = -9.3625
SEA_STRIP_M = 600        # "the first 600 m of sea"
ALONG_M = 300            # half-width of the study strip along the coast
BG, FG, GRID = "#0b1418", "#d7e3e8", "#2b3f48"      # dark theme, as in the other plots


def to_metres(lon, lat):
    """Flat-earth conversion (fine for a 4 km box): east, north in metres from the origin."""
    return ((np.asarray(lon) - ORIGIN_LON) * M_PER_DEG * np.cos(np.radians(ORIGIN_LAT)),
            (np.asarray(lat) - ORIGIN_LAT) * M_PER_DEG)


def load_box():
    """Return lon, lat vectors and the depth grid (positive down, NaN = no data) for the box."""
    d = xr.open_dataset(NC_FILE)
    s = d.sel(lon=slice(BOX["lon_min"], BOX["lon_max"]), lat=slice(BOX["lat_min"], BOX["lat_max"])).load()
    return s.lon.values, s.lat.values, -s.elevation.values.astype(float)


lon, lat, depth = load_box()
X, Y = to_metres(*np.meshgrid(lon, lat))
dx = np.diff(to_metres(lon, lat[0])[0]).mean()
dy = np.diff(to_metres(lon[0], lat)[1]).mean()
valid = np.isfinite(depth)
sea = valid & (depth > 0)
print(f"box grid {depth.shape[1]} x {depth.shape[0]} cells, cell size {dx:.1f} m E-W x {dy:.1f} m N-S")
print(f"valid cells {valid.sum()}, sea cells {sea.sum()}, depth range {np.nanmin(depth):.1f} to {np.nanmax(depth):.1f} m "
      f"(negative = land height)")


def lookup(x, y):
    """Nearest-cell depth at metre coordinates (no interpolation: NaN stays NaN)."""
    j = np.rint((x - X[0, 0]) / dx).astype(int)
    i = np.rint((y - Y[0, 0]) / dy).astype(int)
    ok = (i >= 0) & (i < depth.shape[0]) & (j >= 0) & (j < depth.shape[1])
    out = np.full(np.shape(x), np.nan)
    out[ok] = depth[i[ok], j[ok]]
    return out


# ---- per-spot analysis -----------------------------------------------------------------------
# Shoreline cells = sea cells with a land cell (depth <= 0) next to them.
land = valid & (depth <= 0)
shore = sea & ndi.binary_dilation(land, structure=np.ones((3, 3)))

results, frames = {}, {}
for name, (la, lo) in SPOTS.items():
    sx, sy = to_metres(lo, la)
    k0 = np.argmin(np.where(shore, np.hypot(X - sx, Y - sy), np.inf).ravel())   # shoreline cell nearest the spot
    cx, cy = X.ravel()[k0], Y.ravel()[k0]
    near = shore & (np.hypot(X - cx, Y - cy) < 600)     # wider window = smoother coast direction
    px, py = X[near], Y[near]
    # Coast direction = main axis of the shoreline cells near the spot; seaward normal points west.
    c = np.cov(np.vstack([px - px.mean(), py - py.mean()]))
    w, v = np.linalg.eigh(c)
    along = v[:, 1]                                   # unit vector along the coast
    normal = np.array([-along[1], along[0]])
    if normal[0] > 0:
        normal = -normal                              # seaward = west
    # Start the profile at the shoreline cell nearest the spot.
    k = np.argmin(np.hypot(px - sx, py - sy))
    o = np.array([px[k], py[k]])
    bearing = (np.degrees(np.arctan2(normal[0], normal[1]))) % 360
    # Profile: every 5 m, 200 m landward to 900 m seaward.
    u = np.arange(-200, 901, 5.0)
    prof = lookup(o[0] + normal[0] * u, o[1] + normal[1] * u)
    # Strip for statistics: u in 0..600 m seaward, +-300 m along the coast, sampled every 11 m.
    uu, vv = np.meshgrid(np.arange(0, SEA_STRIP_M + 1, 11.0), np.arange(-ALONG_M, ALONG_M + 1, 11.0))
    sxs, sys_ = o[0] + normal[0] * uu + along[0] * vv, o[1] + normal[1] * uu + along[1] * vv
    strip = lookup(sxs, sys_)
    # Seaward reach: first empty sample after the shoreline along the profile.
    seaward = u >= 0
    pv = prof[seaward]
    first_nan = np.argmax(~np.isfinite(pv)) if (~np.isfinite(pv)).any() else len(pv)
    reach = u[seaward][max(first_nan - 1, 0)]
    # Reach across the whole +-300 m strip: for each alongshore line, how far the data goes.
    reach_lines = []
    for r in range(strip.shape[0]):
        bad = ~np.isfinite(strip[r])
        reach_lines.append(uu[r][np.argmax(bad) - 1] if bad.any() else SEA_STRIP_M)
    # Relief: height of each cell above a smoothed surface (cells nearly 100 m across), where depth 0.5-8 m.
    filled = np.where(valid, depth, np.nanmedian(depth))
    smooth = ndi.uniform_filter(filled, size=9)
    resid = np.where(valid, depth - smooth, np.nan)
    box_mask = (np.hypot(X - o[0], Y - o[1]) < 350) & sea & (depth < 8)
    results[name] = dict(
        spot=(la, lo), bearing=bearing, reach_profile=reach, reach_median=float(np.median(reach_lines)),
        reach_min=float(np.min(reach_lines)), deepest_profile=float(np.nanmax(pv)),
        deepest_strip=float(np.nanmax(strip)), empty_600=float(np.mean(~np.isfinite(strip))),
        empty_300=float(np.mean(~np.isfinite(strip[:, uu[0] <= 300]))),
        depth_at_reach=float(pv[max(first_nan - 1, 0)]),
        relief_std=float(np.nanstd(resid[box_mask])),
        step_std=float(np.nanstd(np.diff(prof[(u > 20) & (u < reach - 20)]))) if reach > 60 else np.nan,
        shallow_cells=int(box_mask.sum()))
    frames[name] = dict(o=o, normal=normal, u=u, prof=prof)

print()
hdr = ["check"] + list(SPOTS)
rows = [
    ("spot lat, lon", lambda r: f"{r['spot'][0]:.4f}, {r['spot'][1]:.4f}"),
    ("profile looks toward (compass deg)", lambda r: f"{r['bearing']:.0f}"),
    ("data reaches seaward on profile (m)", lambda r: f"{r['reach_profile']:.0f}"),
    ("  ... median over +-300 m of coast (m)", lambda r: f"{r['reach_median']:.0f}"),
    ("  ... shortest over +-300 m of coast (m)", lambda r: f"{r['reach_min']:.0f}"),
    ("depth where data stops, profile (m)", lambda r: f"{r['depth_at_reach']:.1f}"),
    ("deepest valid depth, profile (m)", lambda r: f"{r['deepest_profile']:.1f}"),
    ("deepest valid depth, 600 m strip (m)", lambda r: f"{r['deepest_strip']:.1f}"),
    ("empty cells, first 600 m of sea", lambda r: f"{100 * r['empty_600']:.0f} %"),
    ("empty cells, first 300 m of sea", lambda r: f"{100 * r['empty_300']:.0f} %"),
    ("relief std above 100 m smooth, <8 m deep (m)", lambda r: f"{r['relief_std']:.2f}"),
    ("cell-to-cell step std along profile (m)", lambda r: f"{r['step_std']:.2f}"),
]
print(f"{hdr[0]:46s}" + "".join(f"{h:>16s}" for h in hdr[1:]))
for label, f in rows:
    print(f"{label:46s}" + "".join(f"{f(results[n]):>16s}" for n in SPOTS))

# ---- plot ------------------------------------------------------------------------------------
fig = plt.figure(figsize=(15, 8.5), facecolor=BG)
gs = fig.add_gridspec(2, 2, width_ratios=[1.35, 1], hspace=0.28, wspace=0.18)
ax = fig.add_subplot(gs[:, 0], facecolor=BG)
axp = [fig.add_subplot(gs[r, 1], facecolor=BG) for r in range(2)]

# Hillshade of the sea floor. Empty cells are left NaN so they show the background colour.
z = np.ma.masked_invalid(-depth)                                   # elevation (up positive)
ls = LightSource(azdeg=315, altdeg=40)
filled = np.where(valid, -depth, np.nanmedian(-depth))
shade = ls.hillshade(filled, vert_exag=3, dx=dx, dy=dy)
shade = np.ma.masked_where(~valid, shade)
ext = [X.min() - dx / 2, X.max() + dx / 2, Y.min() - dy / 2, Y.max() + dy / 2]
ax.imshow(np.ma.masked_where(~valid, -depth), extent=ext, origin="lower", cmap="viridis", vmin=-14, vmax=14,
          interpolation="nearest")
ax.imshow(shade, extent=ext, origin="lower", cmap="gray", alpha=0.45, interpolation="nearest")
ax.contour(X, Y, np.where(sea, depth, np.nan), levels=range(1, 11), colors="white", linewidths=0.5, alpha=0.8)
ax.contour(X, Y, np.where(valid, depth, np.nan), levels=[0], colors="#ffd36b", linewidths=0.9)   # shoreline
ax.text(0.0, -0.12, "dark background = no data (empty cells); white lines = 1 m depth contours (1-10 m); gold = shoreline",
        transform=ax.transAxes, color=FG, fontsize=8, va="top")
for name, (la, lo) in SPOTS.items():
    sx, sy = to_metres(lo, la)
    ax.plot(sx, sy, "o", color="#ff6b6b", ms=7, mec="white")
    ax.annotate(name, (sx, sy), xytext=(-130, 22), textcoords="offset points", color="#ff6b6b", fontsize=11, weight="bold",
                arrowprops=dict(arrowstyle="-", color="#ff6b6b", lw=0.8))
    f = frames[name]
    e = f["o"] + f["normal"] * 700
    ax.plot([f["o"][0], e[0]], [f["o"][1], e[1]], "--", color="#ffffff", lw=1.6, zorder=5)
ax.set_aspect("equal")
ax.set_xlabel("east (m)", color=FG); ax.set_ylabel("north (m)", color=FG)
ax.set_title("Sea floor off Peniche, 2011 lidar (EMODnet 590_HR_Lidar_Centro), ~11 x 14 m cells", color=FG)
ax.tick_params(colors=FG)
for sp in ax.spines.values():
    sp.set_color(GRID)

# Shore-normal profiles (dashed lines in the map). Gaps in the line = empty cells.
for a, name in zip(axp, SPOTS):
    f, r = frames[name], results[name]
    a.plot(f["u"], f["prof"], color="#4aa3ff", lw=1.3, marker=".", ms=2)
    a.axhline(0, color="#ffd36b", lw=0.8)
    a.axvline(r["reach_profile"], color="#ff6b6b", ls=":", lw=1)
    a.text(r["reach_profile"], 0.97, f" data stops {r['reach_profile']:.0f} m out, at {r['depth_at_reach']:.1f} m",
           transform=a.get_xaxis_transform(), color="#ff6b6b", fontsize=8.5, va="top", ha="right")
    a.set_xlim(-200, 900); a.invert_yaxis()
    a.set_title(f"{name}: depth along the dashed line (looking {r['bearing']:.0f} deg)", color=FG, fontsize=10)
    a.set_xlabel("distance seaward of the shoreline (m)", color=FG); a.set_ylabel("depth (m, down)", color=FG)
    a.tick_params(colors=FG); a.grid(color=GRID, alpha=0.6, lw=0.5)
    for sp in a.spines.values():
        sp.set_color(GRID)
fig.savefig(HERE / "reef_check.png", dpi=110, bbox_inches="tight", facecolor=BG)
print("\nwrote reef_check.png")
