"""Depth profiles from Klitmoller out across the North Sea, and where swell 'feels the bottom'.

Deep-water rule used: wavelength L = 1.56 * T^2 (metres, T = period in seconds);
a wave starts to feel the bottom where depth < L / 2.
Run: python profile_wide.py     (writes profile_wide.png and data/profile_wide.json)
"""
import json
from pathlib import Path
import numpy as np
import xarray as xr
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.interpolate import RegularGridInterpolator

HERE = Path(__file__).parent
LAT0, LON0 = 57.040, 8.4693                    # Klitmoller shoreline point
R = 6371.0                                      # earth radius, km
BEARINGS = {270: "due west (270)", 300: "WNW (300)", 330: "NNW (330)"}
PERIODS = [6, 8, 10, 12, 14]                    # seconds
FEEL = {T: 1.56 * T ** 2 / 2 for T in PERIODS}  # feel-bottom depth in metres: 28, 50, 78, 112, 153

# 1. Load the wide depth grid (positive down, land negative) and make a function depth(lat, lon).
ds = xr.open_dataset(HERE / "data" / "seafloor_wide.nc")
depth_at = RegularGridInterpolator((ds.lat.values, ds.lon.values), ds.depth.values,
                                   bounds_error=False, fill_value=np.nan)

# 2. Walk along a great circle: from the start point, go `d` km on a fixed starting bearing.
def destination(bearing_deg, d_km):
    brg, ang = np.radians(bearing_deg), d_km / R
    lat1, lon1 = np.radians(LAT0), np.radians(LON0)
    lat2 = np.arcsin(np.sin(lat1) * np.cos(ang) + np.cos(lat1) * np.sin(ang) * np.cos(brg))
    lon2 = lon1 + np.arctan2(np.sin(brg) * np.sin(ang) * np.cos(lat1),
                             np.cos(ang) - np.sin(lat1) * np.sin(lat2))
    return np.degrees(lat2), np.degrees(lon2)

# 3. Sample every 1 km. The first km or two can still be "land" in this coarse grid, so skip
#    leading land; stop at the next land cell or when the line leaves the box.
profiles = {}
for b in BEARINGS:
    d = np.arange(0, 3000.0, 1.0)
    lat, lon = destination(b, d)
    z = depth_at(np.column_stack([lat, lon]))
    start = np.argmax(z > 0)                    # first sea sample
    end = len(z)
    for i in range(start, len(z)):
        if np.isnan(z[i]) or z[i] <= 0:
            end = i
            break
    profiles[b] = dict(d=d[start:end], z=z[start:end], lat=lat[start:end], lon=lon[start:end],
                       ended_by="land" if end < len(z) and not np.isnan(z[end]) else "edge of box")

# 4. For each period: walking from the coast outward, the first sample deeper than the feel-bottom
#    depth marks the last crossing; before that the water is shallower all the way in.
#    Also list shallow banks further out (stretches shallower than that depth beyond the crossing).
results = {}
for b, p in profiles.items():
    results[b] = {}
    for T, zf in FEEL.items():
        deeper = np.where(p["z"] >= zf)[0]
        if len(deeper) == 0:
            results[b][T] = dict(km=None, banks=[]); continue
        i = deeper[0]
        km = float(p["d"][i])
        banks, inside, j = [], False, i
        for k in range(i, len(p["z"])):         # find stretches beyond the crossing that are shallower again
            if p["z"][k] < zf and not inside:
                inside, j = True, k
            elif p["z"][k] >= zf and inside:
                inside = False
                if p["d"][k - 1] - p["d"][j] >= 5:
                    banks.append((float(p["d"][j]), float(p["d"][k - 1]), float(p["z"][j:k].min())))
        results[b][T] = dict(km=km, banks=banks)

# 5. Print a table.
print("distance (km) where depth last drops below the feel-bottom depth, coming in to the coast ('all' = whole line is shallower)")
print("bearing  length  maxdepth  ended_by   " + "  ".join(f"{T}s/{FEEL[T]:.0f}m" for T in PERIODS))
for b, p in profiles.items():
    print(f"{b:5d}  {p['d'][-1]:6.0f}  {p['z'].max():7.0f}  {p['ended_by']:11s}" +
          "  ".join(f"{results[b][T]['km']:8.0f}" if results[b][T]['km'] is not None else "     all" for T in PERIODS))
    print("   end point:", round(float(p["lat"][-1]), 2), "N", round(float(p["lon"][-1]), 2), "E")
    for T in (6, 10, 14):
        for s, e, zmin in results[b][T]["banks"]:
            print(f"   {T}s: shallower again {s:.0f}-{e:.0f} km (min {zmin:.0f} m)")
json.dump({str(b): dict(lat=p["lat"][::5].round(3).tolist(), lon=p["lon"][::5].round(3).tolist()) for b, p in profiles.items()},
          open(HERE / "data" / "profile_lines.json", "w"))
json.dump({str(b): {str(T): r["km"] for T, r in rs.items()} for b, rs in results.items()},
          open(HERE / "data" / "profile_wide.json", "w"), indent=1)

# 6. Plot: profiles (left) and a map of the lines (right).
fig, (ax, mp) = plt.subplots(1, 2, figsize=(14, 6), gridspec_kw=dict(width_ratios=[2.2, 1]))
cols = {270: "#1f77b4", 300: "#d62728", 330: "#2ca02c"}
for b, p in profiles.items():
    ax.plot(p["d"], p["z"], color=cols[b], lw=1.6, label=f"bearing {BEARINGS[b]}")
for T, zf in FEEL.items():
    ax.axhline(zf, color="grey", ls="--", lw=0.9)
    ax.annotate(f" {T} s: {zf:.0f} m", xy=(1.0, zf), xycoords=("axes fraction", "data"), va="center", fontsize=9, color="#444")
ax.set_ylim(250, 0); ax.set_xlim(0, 700)
ax.set_xlabel("distance from Klitmoller (km); coast at left")
ax.set_ylabel("water depth (m, increasing downward; deeper than 250 m is cut off)")
ax.set_title("Where does swell feel the bottom on its way to Klitmoller?")
ax.legend(loc="lower right"); ax.grid(alpha=0.25)
cs = mp.pcolormesh(ds.lon, ds.lat, np.ma.masked_less_equal(ds.depth.values, 0), cmap="Blues", vmin=0, vmax=300, shading="auto")
mp.set_facecolor("#d9d2b8")
for b, p in profiles.items():
    mp.plot(p["lon"], p["lat"], color=cols[b], lw=1.5)
mp.plot(LON0, LAT0, "k*", ms=11)
mp.set_aspect(1 / np.cos(np.radians(58))); mp.set_title("Map of the three lines")
mp.set_xlabel("lon E"); mp.set_ylabel("lat N")
fig.colorbar(cs, ax=mp, label="depth (m)", shrink=0.7)
fig.savefig(HERE / "profile_wide.png", dpi=120, bbox_inches="tight")
