"""Check plot: depth map, 0 m coastline, 5 m contours, Klitmoller marked."""
from pathlib import Path
import numpy as np, xarray as xr, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

HERE = Path(__file__).parent
ds = xr.open_dataset(HERE / "data" / "seafloor.nc")
d = ds.depth.values
fig, ax = plt.subplots(figsize=(8, 8))
land = np.ma.masked_less_equal(d, 0)
ax.set_facecolor("#cfc7a8")                                   # land colour
pm = ax.pcolormesh(ds.lon, ds.lat, land, cmap="viridis_r", shading="auto")
ax.contour(ds.lon, ds.lat, d, levels=np.arange(5, d.max(), 5), colors="k", linewidths=0.4)
ax.contour(ds.lon, ds.lat, d, levels=[0], colors="red", linewidths=1.2)
ax.plot(8.4985, 57.0402, "w*", ms=14, mec="k", label="Klitmoller village (OSM)")
ax.plot(8.469, 57.040, "o", c="orange", mec="k", label="shoreline at Klitmoller (~0 m)")
ax.set_aspect(1 / np.cos(np.radians(57.04)))
ax.set_xlabel("lon E"); ax.set_ylabel("lat N"); ax.legend(loc="lower right")
fig.colorbar(pm, label="depth below LAT (m), contours every 5 m, red = 0 m")
ax.set_title("EMODnet DTM ~115 m, Klitmoller")
fig.savefig(HERE / "check_plot.png", dpi=130, bbox_inches="tight")
