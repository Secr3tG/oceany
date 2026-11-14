"""Compare EMODnet (115 m, LAT) with Danmarks Dybdemodel (50 m, MSL) at Klitmoller.
Prints the numbers and writes compare_plot.png.  Run: python -I compare_ddm.py
"""
from pathlib import Path
import numpy as np, xarray as xr, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy import ndimage as ndi

HERE = Path(__file__).parent
LAT0, LON0 = 57.040, 8.4693
K = 111195.0
KX = K * np.cos(np.radians(LAT0))
def local(lon, lat): return (lon - LON0) * KX, (lat - LAT0) * K      # metres east/north of the shore point

# --- load both, put both in local metres
e = xr.open_dataset(HERE / "data" / "seafloor.nc")
ex, ey = np.meshgrid((e.lon.values - LON0) * KX, (e.lat.values - LAT0) * K)
ed = e.depth.values
d = xr.open_dataset(HERE / "data" / "seafloor_ddm.nc")
dx_, dy_ = local(d.lon.values, d.lat.values)
dd, kilde, aar = d.depth.values, d.kilde.values, d.aar.values

# --- 1. depth straight west of the shore point (nearest cell; for DDM also say how far the cell is)
print("dist west | EMODnet | DDM")
for dist in [100, 200, 300, 500, 1000, 2000, 5000]:
    px = -dist
    ie = np.unravel_index(np.argmin((ex - px) ** 2 + ey ** 2), ex.shape)
    idd = np.unravel_index(np.nanargmin((dx_ - px) ** 2 + dy_ ** 2 + np.where(np.isnan(dd), 1e12, 0)), dd.shape)
    print(f"{dist:5d} m | {ed[ie]:6.1f} | {dd[idd]:6.1f}")
# where does the DDM first have data going west->east, and what does it say at the shoreline?
row = (np.abs(dy_) < 25) & (dx_ > -300) & (dx_ < 600)
print("DDM cells near the shore point (x_m, depth, kilde, aar):")
for i in np.argsort(dx_[row]):
    print("  ", round(dx_[row][i]), dd[row][i], kilde[row][i], aar[row][i])

# --- 2. cells within 2 km of the shore on the 57.02-57.06 stretch
def shore_dist(depth, land, dxm, dym):
    return ndi.distance_transform_edt(~land, sampling=(dym, dxm))     # metres to nearest land cell
land_e = ed <= 0
de = shore_dist(ed, land_e, 63.0, 115.8)
land_d = np.isnan(dd)
dd_dist = shore_dist(dd, land_d, 50.0, 50.0)
# keep only valid sea cells that are not at the far edge of the window
stretch_e = (np.abs(ey / K) <= 0.02) & ~land_e
stretch_d = (np.abs(dy_ / K) <= 0.02) & ~land_d
for lim in (500, 2000):
    print(f"within {lim} m: EMODnet {(stretch_e & (de <= lim)).sum()}  DDM {(stretch_d & (dd_dist <= lim)).sum()}")
names = {1: "DIGI", 2: "SB", 3: "MB", 4: "ALB", 5: "SDB", 6: "CSB", 7: "Historical", 8: "Interpolated"}
for lim in (500, 2000):
    m = stretch_d & (dd_dist <= lim)
    k = kilde[m]; a = aar[m]
    print(f"DDM within {lim} m kilde:", {names.get(int(v), v): int((k == v).sum()) for v in np.unique(k[~np.isnan(k)])})
    print(f"   aar:", {int(v): int((a == v).sum()) for v in np.unique(a[~np.isnan(a)])}, "nan:", int(np.isnan(a).sum()))

# --- 3. reef hunt: depth minus the typical cross-shore profile (median depth per 50 m of shore distance)
for name, dep, dist, m in (("EMODnet", ed, de, stretch_e), ("DDM", dd, dd_dist, stretch_d)):
    near = m & (dist <= 1500)
    bins = np.floor(dist[near] / 50).astype(int)
    med = {b: np.median(dep[near][bins == b]) for b in np.unique(bins)}
    res = dep[near] - np.array([med[b] for b in bins])
    w = dist[near] <= 1000
    print(f"{name}: residual std {res[w].std():.2f} m, min {res[w].min():.2f}, max {res[w].max():.2f} (within 1 km)")
    big = np.abs(res[w]) > 1.0
    print(f"   cells with |residual|>1 m within 1 km: {int(big.sum())} of {int(w.sum())}")
    prof = [(b * 50, round(float(med[b]), 1)) for b in sorted(med) if b * 50 % 250 == 0 and b * 50 <= 1500]
    print("   median profile (m from shore, depth):", prof)

# --- 4. side-by-side plot, 4 km x 4 km
fig, axs = plt.subplots(1, 2, figsize=(13, 6.3), sharex=True, sharey=True)
H = 2000
levels = np.arange(0, 30, 2)
for ax, X, Y, Z, title in ((axs[0], ex, ey, ed, "EMODnet DTM, ~115 x 63 m cells, LAT"),
                           (axs[1], dx_, dy_, dd, "Danmarks Dybdemodel v2.0, 50 m cells, MSL")):
    Zm = np.ma.masked_where(np.isnan(Z) | (Z <= 0), Z)
    pm = ax.pcolormesh(X, Y, Zm, cmap="viridis_r", vmin=0, vmax=25, shading="nearest")
    ax.contour(X, Y, np.where(np.isnan(Z), -1, Z), levels=levels[1:], colors="k", linewidths=0.5)
    ax.contour(X, Y, np.where(np.isnan(Z), -1, Z), levels=[0.0001], colors="red", linewidths=1.2)
    ax.plot(0, 0, "o", c="orange", mec="k", ms=9)
    ax.set_xlim(-H, H); ax.set_ylim(-H, H); ax.set_aspect(1); ax.set_facecolor("#cfc7a8")
    ax.set_title(title); ax.set_xlabel("metres east of shore point")
axs[0].set_ylabel("metres north of shore point")
fig.colorbar(pm, ax=axs, label="depth (m), contours every 2 m, red = coast", shrink=0.8)
fig.savefig(HERE / "compare_plot.png", dpi=110, bbox_inches="tight")
