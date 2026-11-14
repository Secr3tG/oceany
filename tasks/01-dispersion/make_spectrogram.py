"""Spectrogram of buoy spectral wave density: data/spectra.nc -> spectrogram.png."""
from pathlib import Path
import numpy as np, xarray as xr
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
from matplotlib.colors import LogNorm

here = Path(__file__).parent
ds = xr.open_dataset(here / "data/spectra.nc")
ds = ds.sortby("time").sel(frequency=slice(0.03, 0.20))
E = ds.energy.where(ds.energy > 0)
fig, ax = plt.subplots(figsize=(14, 6))
pm = ax.pcolormesh(ds.time.values, ds.frequency.values, E.values.T, norm=LogNorm(vmin=1e-2, vmax=np.nanmax(E.values)),
                   cmap="viridis", shading="auto")
ax.set_ylim(0.03, 0.20)
ax.set_xlabel("Time (UTC)")
ax.set_ylabel("Frequency (Hz)")
ax.xaxis.set_major_locator(mdates.AutoDateLocator())
ax.xaxis.set_major_formatter(mdates.ConciseDateFormatter(ax.xaxis.get_major_locator()))
ax.set_title(f"Spectral wave density, NDBC station {ds.attrs['station_id']}")
fig.colorbar(pm, ax=ax, pad=0.08, label="Energy density (m$^2$/Hz)")
sec = ax.secondary_yaxis("right", functions=(lambda f: 1 / np.maximum(f, 1e-6), lambda T: 1 / np.maximum(T, 1e-6)))
sec.set_ylabel("Period (s)")
sec.set_yticks([5, 6, 8, 10, 12, 15, 20, 30])
fig.tight_layout()
fig.savefig(here / "spectrogram.png", dpi=130)
