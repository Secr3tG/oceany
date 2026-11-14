"""Depth profiles from Klitmoller along the bearings real swell actually arrives on.

Why: profile_wide.py looked due west (270), but swell at this spot comes (a) from the south-west,
up the southern North Sea "under England", and (b) from the north, through the gap between
Shetland and Norway. Here we (1) scan bearings to see which ones have open water, (2) pick one
SW and one N bearing, (3) work out where swell of 8-14 s "feels the bottom", (4) plot them.

Deep-water rule (same as profile_wide.py): wavelength L = 1.56 * T^2 metres (T in seconds);
a wave feels the bottom where depth < L / 2.
Run: python profile_bearings.py
Writes: profile_swell_bearings.png, data/profile_bearings.json, data/profile_lines_swell.json
"""
import json
from pathlib import Path
import numpy as np
import xarray as xr
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from scipy.interpolate import RegularGridInterpolator

# ---------------- settings you can change ----------------
HERE = Path(__file__).parent
LAT0, LON0 = 57.040, 8.4693              # Klitmoller shoreline point (same as profile_wide.py)
R = 6371.0                               # earth radius, km
SW_SCAN = range(200, 255, 5)             # south-west bearings to scan (degrees)
N_SCAN = range(300, 345, 5)              # north-west to north-north-west bearings to scan
SW_BEARING = 235                         # chosen SW bearing (longest open water, see scan output)
N_BEARING = 315                          # chosen N bearing (only clean window past Shetland and Norway: 313-316)
W_BEARING = 270                          # kept for comparison
NW_BEARING = 300                         # only gets statistics (no plot line): the Orkney-Shetland gap path to the Atlantic
PERIODS = [8, 10, 12, 14]                # swell periods, seconds
STEP_KM = 0.5                            # sample spacing along the line
MAX_KM = 3000.0                          # how far to walk at most
MAX_LEADING_LAND_KM = 5.0                # the grid is coarse: allow up to 5 km of "land" before the sea starts
DEEP_M = 200                             # "the bottom drops below 200 m"
# ----------------------------------------------------------

# 1. Load the wide depth grid (metres, positive down, land <= 0) as a function depth(lat, lon).
ds = xr.open_dataset(HERE / "data" / "seafloor_wide.nc")
depth_at = RegularGridInterpolator((ds.lat.values, ds.lon.values), ds.depth.values,
                                   bounds_error=False, fill_value=np.nan)

def destination(bearing_deg, d_km):
    """Point reached after d_km on a great circle that starts at Klitmoller on this bearing."""
    brg, ang = np.radians(bearing_deg), np.asarray(d_km) / R
    lat1, lon1 = np.radians(LAT0), np.radians(LON0)
    lat2 = np.arcsin(np.sin(lat1) * np.cos(ang) + np.cos(lat1) * np.sin(ang) * np.cos(brg))
    lon2 = lon1 + np.arctan2(np.sin(brg) * np.sin(ang) * np.cos(lat1),
                             np.cos(ang) - np.sin(lat1) * np.sin(lat2))
    return np.degrees(lat2), np.degrees(lon2)

def walk(bearing):
    """Profile along one bearing: from the first sea sample until land or the edge of the grid."""
    d = np.arange(0, MAX_KM, STEP_KM)
    lat, lon = destination(bearing, d)
    z = depth_at(np.column_stack([lat, lon]))
    sea = np.where(z > 0)[0]
    if len(sea) == 0 or d[sea[0]] > MAX_LEADING_LAND_KM:
        return None                                   # the line runs over land right away
    start, end = sea[0], len(z)
    for i in range(start, len(z)):
        if np.isnan(z[i]) or z[i] <= 0:               # next land cell, or outside the grid
            end = i
            break
    hit_edge = end >= len(z) or np.isnan(z[end])
    return dict(bearing=bearing, d=d[start:end], z=z[start:end], lat=lat[start:end], lon=lon[start:end],
                leading_land_km=float(d[start]), open_km=float(d[end - 1] - d[start]),
                ended_by="grid edge" if hit_edge else "land")

# 2. Scan: open-water length for every bearing.
print("SCAN (open-water km from first sea sample until land / grid edge)")
print("bearing  open_km  ended_by   end_lat  end_lon")
for b in list(SW_SCAN) + [W_BEARING] + list(N_SCAN):
    p = walk(b)
    if p is None:
        print(f"{b:6d}  runs over land (Jutland coast) for more than {MAX_LEADING_LAND_KM:.0f} km")
    else:
        print(f"{b:6d}  {p['open_km']:7.0f}  {p['ended_by']:9s}  {p['lat'][-1]:7.2f}  {p['lon'][-1]:7.2f}")

# 3. Statistics for the chosen bearings.
chosen = {"SW": SW_BEARING, "N": N_BEARING, "W": W_BEARING}
profiles = {k: walk(b) for k, b in chosen.items()}
stat_profiles = {**profiles, "NW": walk(NW_BEARING)}      # statistics for four bearings, plot only the first three
stats = {}
print("\nCHOSEN BEARINGS")
for k, p in stat_profiles.items():
    z, d = p["z"], p["d"]
    s = dict(bearing=p["bearing"], open_km=round(p["open_km"], 1), ended_by=p["ended_by"],
             end_lat=round(float(p["lat"][-1]), 2), end_lon=round(float(p["lon"][-1]), 2),
             min_depth=round(float(z.min())), median_depth=round(float(np.median(z))), max_depth=round(float(z.max())),
             feel_bottom={})
    for T in PERIODS:
        half_L = 1.56 * T ** 2 / 2                    # half the deep-water wavelength = depth where swell feels the bottom
        deeper = np.where(z >= half_L)[0]             # first sample deeper than that, walking out from the coast
        s["feel_bottom"][str(T)] = dict(half_wavelength_m=round(half_L, 1),
                                        km=None if len(deeper) == 0 else round(float(d[deeper[0]]), 1))
    over = np.where(z > DEEP_M)[0]
    s["first_deeper_than_200m_km"] = None if len(over) == 0 else round(float(d[over[0]]), 1)
    stats[k] = s
    print(k, json.dumps(s))

# 4. Features the data shows (printed so we can check them before labelling the plot).
def where(p, i):
    return f"{p['d'][i]:.0f} km ({p['lat'][i]:.2f} N, {p['lon'][i]:.2f} E)"
sw, n = profiles["SW"], profiles["N"]
far = (sw["d"] > 100) & (sw["d"] < sw["d"][-1] - 30)      # ignore the last 30 km: that is just the English coast
i_bank = np.where(far)[0][np.argmin(sw["z"][far])]
print("\nSW shallowest point between 100 km and 30 km short of the English coast:", round(float(sw["z"][i_bank])), "m at", where(sw, i_bank))
i_trench = np.argmax(np.where(n["d"] < 300, n["z"], 0))
print("N deepest point in first 300 km:", round(float(n["z"][i_trench])), "m at", where(n, i_trench))
for lim in (200, 500, 1000):
    j = np.where(n["z"] > lim)[0]
    j = j[j > np.argmax(n["d"] > 300)]                # beyond the trench, i.e. the shelf edge
    print(f"N first beyond trench deeper than {lim} m:", where(n, j[0]) if len(j) else "never")

# 5. Save results and the lines for the viewer (every 5 km; the viewer merges them via export_points.py).
json.dump(stats, open(HERE / "data" / "profile_bearings.json", "w"), indent=1)
json.dump({str(p["bearing"]): dict(lat=p["lat"][::10].round(3).tolist(), lon=p["lon"][::10].round(3).tolist())
           for k, p in profiles.items() if k != "W"},
          open(HERE / "data" / "profile_lines_swell.json", "w"))

# 6. Plot. Depth downward, one line per bearing, dashed lines at the half-wavelength depths.
BG, FG, GRID = "#0e1a22", "#dbe7ec", "#3a4d58"
cols = {"SW": "#ffb347", "N": "#7fe3f0", "W": "#b8a9ff"}
names = {"SW": f"SW {SW_BEARING} deg (up the southern North Sea)",
         "N": f"N {N_BEARING} deg (past Shetland, Norway gap)",
         "W": f"W {W_BEARING} deg (for comparison)"}
fig, ax = plt.subplots(figsize=(13, 6.5), facecolor=BG)
ax.set_facecolor(BG)
for k, p in profiles.items():
    ax.plot(p["d"], p["z"], color=cols[k], lw=1.8, label=names[k])
    dy = {"SW": -9, "W": 9, "N": 0}[k]                # small vertical offsets so the end labels do not overlap
    ax.annotate(f"{k} ends at {p['ended_by']}", xy=(p["d"][-1], p["z"][-1]), xytext=(5, dy), textcoords="offset points",
                color=cols[k], fontsize=8, va="center")
for T, ls in ((10, "--"), (14, "--")):
    zf = 1.56 * T ** 2 / 2
    ax.axhline(zf, color="#9fb3bd", ls=ls, lw=1)
    ax.text(1005, zf, f" {T} s: swell feels bottom shallower than {zf:.0f} m", color="#9fb3bd", fontsize=8.5, va="bottom", ha="right")
# Feature labels: positions come from the printout above (54.5 N 2.5 E = Dogger Bank; 57.8 N 7 E = Norwegian Trench;
# 61.5 N 1.5 W = the shelf edge north of Shetland).
ax.annotate(f"Dogger Bank\n(shallowest, {sw['z'][i_bank]:.0f} m)", xy=(sw["d"][i_bank], sw["z"][i_bank]),
            xytext=(sw["d"][i_bank] - 60, 170), color=cols["SW"], fontsize=8.5, ha="center",
            arrowprops=dict(arrowstyle="-", color=cols["SW"], lw=0.8))
ax.annotate(f"Norwegian Trench\n{n['z'][i_trench]:.0f} m", xy=(n["d"][i_trench], min(n["z"][i_trench], 700)),
            xytext=(n["d"][i_trench] + 40, 620), color=cols["N"], fontsize=8.5, ha="center",
            arrowprops=dict(arrowstyle="-", color=cols["N"], lw=0.8))
j = np.where(n["z"] > 500)[0]; j = j[j > np.argmax(n["d"] > 300)][0]
ax.annotate("shelf edge north of Shetland:\nbottom drops away", xy=(n["d"][j], 700), xytext=(n["d"][j] - 110, 520),
            color=cols["N"], fontsize=8.5, ha="center", arrowprops=dict(arrowstyle="-", color=cols["N"], lw=0.8))
ax.set_ylim(800, -20); ax.set_xlim(0, 1010)
ax.set_xlabel("distance from Klitmoller along the bearing (km)", color=FG)
ax.set_ylabel("water depth (m, downward)", color=FG)
ax.set_title("Seafloor along the swell bearings from Klitmoller (EMODnet, 1 arc-minute grid)", color=FG)
ax.tick_params(colors=FG); ax.grid(color=GRID, alpha=0.6, lw=0.5)
for sp in ax.spines.values():
    sp.set_color(GRID)
leg = ax.legend(loc="lower left", facecolor="#14242d", edgecolor=GRID, labelcolor=FG)
fig.savefig(HERE / "profile_swell_bearings.png", dpi=130, bbox_inches="tight", facecolor=BG)
print("saved profile_swell_bearings.png")
