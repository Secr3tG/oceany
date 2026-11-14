"""Compare the nearshore bottom at Klitmoller, Norre Vorupor and Agger, from open data.

Two datasets per spot:
  DDM     Danmarks Dybdemodel 50 m v2.0 (depth, kilde = source, aar = year), vertical datum MSL
  EMODnet DTM 2024 at native 1/16 arc-minute (~116 m N-S, ~65 m E-W), vertical datum LAT
For each spot we cut three straight lines out to sea, at right angles to the coast: one through the spot
and two 300 m to either side (alongshore). Then we read depth and data source along them.
Run: python -I compare_spots.py     (needs download_spots.py to have run)
Writes compare_spots.png and data/compare_spots.json
"""
import json, os
from pathlib import Path
import numpy as np
import rasterio
from rasterio.warp import transform as warp
from scipy.ndimage import map_coordinates
from scipy.interpolate import RegularGridInterpolator
from scipy.stats import theilslopes
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

# ---------------- settings you can change ----------------
HERE = Path(__file__).parent
DDM = HERE / "data" / "raw" / "danmarks dybdemodel 50m 2024"
# lat, lon of the spot on the beach (Klitmoller = the project's shoreline point; Vorupor = OSM "Vorupor Landingsplads";
# Agger = OSM village point, which is at the coast; each is snapped to the DDM shoreline below)
SPOTS = {"Klitmoller": (57.040, 8.4693), "Norre Vorupor": (56.9588, 8.3675), "Agger": (56.782, 8.2415)}
EMODNET_FILES = {"Klitmoller": "klitmoller", "Norre Vorupor": "vorupor", "Agger": "agger"}
OFFSETS = (-300, 0, 300)                  # alongshore offsets of the three lines (m); 0 = through the spot
CONTOURS = [2, 4, 6, 10, 15, 20]          # depths (m) whose distance from the shore we want
SLOPE_RANGES = [(0, 500), (500, 2000), (2000, 6000)]   # metres from the shore
ROT_DEG = float(os.environ.get('BEARING_ROT', 0))   # sensitivity test: turn every line by this many degrees (0 = normal run)
MAX_KM = 6.5                              # profile length
STEP = 10.0                               # sample spacing along the line (m)
COLS = {"Klitmoller": "#7fe3f0", "Norre Vorupor": "#ffb347", "Agger": "#ff7fb0"}
MEASURED = (2, 3, 4, 6)                   # source codes that are real soundings: singlebeam, multibeam, lidar, crowdsourced
KILDE = {1: "digitised fairsheet", 2: "singlebeam", 3: "multibeam", 4: "airborne lidar", 5: "satellite-derived",
         6: "crowdsourced", 7: "historical", 8: "interpolated"}
# ----------------------------------------------------------

def read_ddm_window(lat, lon, half=14000):
    """Read a square window (metres) of the three DDM rasters around a point. Returns arrays + transform helpers."""
    with rasterio.open(DDM / "ddm_50m.dybde.tiff") as s:
        crs = s.crs
        x, y = warp("EPSG:4326", crs, [lon], [lat])
        r, c = s.index(x[0], y[0])
        n = int(half / 50)
        win = rasterio.windows.Window(c - n, r - n, 2 * n + 1, 2 * n + 1)
        tf = s.window_transform(win)
        out = {}
        for name in ("dybde", "kilde", "aar"):
            with rasterio.open(DDM / f"ddm_50m.{name}.tiff") as t:
                a = t.read(1, window=win).astype("float32")
                a[a == t.nodata] = np.nan
                out[name] = a
    return out, tf, crs, (x[0], y[0])

def to_pix(tf, x, y):
    """Map coordinates (EPSG:3034, m) -> fractional row, column of cell CENTRES (for map_coordinates)."""
    return (tf.f - y) / (-tf.e) - 0.5, (x - tf.c) / tf.a - 0.5

def true_bearing(crs, x0, y0, dx, dy):
    """Compass bearing (true north) of the map direction (dx, dy), computed via lon/lat of two points."""
    lo, la = warp(crs, "EPSG:4326", [x0, x0 + dx * 1000], [y0, y0 + dy * 1000])
    dl = np.radians(lo[1] - lo[0]) * np.cos(np.radians(la[0])); dp = np.radians(la[1] - la[0])
    return float(np.degrees(np.arctan2(dl, dp)) % 360)

results, prof_store = {}, {}
for spot, (lat, lon) in SPOTS.items():
    d, tf, crs, (x0, y0) = read_ddm_window(lat, lon)
    sea = ~np.isnan(d["dybde"])
    nearest_valid = lambda x, y: map_coordinates(sea.astype(float), to_pix(tf, np.atleast_1d(x), np.atleast_1d(y)), order=0, mode="nearest") > 0.5

    # --- 1. Find the coast direction. For rows of points +-3 km along the coast, walk from 4 km offshore
    #        (west) towards land until the first non-sea cell; those points are the coast. Fit a line, take its normal.
    normal = np.array([-1.0, 0.0])                       # first guess: the sea is to the west (map direction)
    for _ in range(3):                                   # repeat with the improved normal
        tangent = np.array([-normal[1], normal[0]])
        pts = []
        for t in np.arange(-3000, 3001, 100):
            for dist in np.arange(4000, -3000, -10):     # from sea (4 km out) towards land
                px, py = x0 + dist * normal[0] + t * tangent[0], y0 + dist * normal[1] + t * tangent[1]
                if not nearest_valid(px, py)[0]:
                    pts.append((px, py)); break
        pts = np.array(pts)
        # Fit the coast with a robust line (Theil-Sen: median of all pairwise slopes), so one odd kink in the
        # generalised coastline does not tilt the answer. Coordinates: t along the old tangent, n along the old normal.
        tt = (pts - [x0, y0]) @ tangent
        nn = (pts - [x0, y0]) @ normal
        slope = theilslopes(nn, tt)[0]                   # how far the coast moves seaward per metre along the tangent
        tangent = (tangent + slope * normal); tangent /= np.linalg.norm(tangent)
        normal = np.array([tangent[1], -tangent[0]])     # perpendicular
        if normal[0] > 0: normal = -normal               # point it out to sea (west)
    r = np.radians(ROT_DEG)                              # optional sensitivity rotation (clockwise = +, seen on a map)
    normal = np.array([normal[0] * np.cos(r) + normal[1] * np.sin(r), -normal[0] * np.sin(r) + normal[1] * np.cos(r)])
    # --- 2. Snap the spot to the DDM shoreline along the normal, and build the three lines.
    brg = true_bearing(crs, x0, y0, *normal)
    tangent = np.array([-normal[1], normal[0]])
    dist = np.arange(-1500.0, MAX_KM * 1000 + 1, STEP)   # distance along the normal measured from the spot
    spot_shore = None
    prof = {}
    for off in OFFSETS:
        px, py = x0 + off * tangent[0] + dist * normal[0], y0 + off * tangent[1] + dist * normal[1]
        ok = nearest_valid(px, py)
        # shoreline of this line = first sea cell when walking from land (negative dist) towards the sea
        # the inland end is not sea; walking out, the first valid sample after the last land sample
        land_idx = np.where(~ok)[0]; land_idx = land_idx[land_idx < np.argmax(dist > 3000)]
        first = (land_idx.max() + 1) if len(land_idx) else 0
        shore_d = dist[first] - STEP / 2                 # edge of the first sea cell
        sel = dist >= shore_d
        pr, pc = to_pix(tf, px[sel], py[sel])
        z = map_coordinates(np.nan_to_num(d["dybde"], nan=-999), (pr, pc), order=1, mode="nearest")
        zn = map_coordinates(d["dybde"], (pr, pc), order=0, mode="nearest")      # nearest cell, for the half-cell at the edge
        z = np.where(z < -100, zn, z)                    # bilinear touched a no-data cell -> use the nearest cell instead
        kil = map_coordinates(np.nan_to_num(d["kilde"], nan=0), (pr, pc), order=0, mode="nearest").astype(int)
        aar = map_coordinates(np.nan_to_num(d["aar"], nan=0), (pr, pc), order=0, mode="nearest").astype(int)
        lons, lats = warp(crs, "EPSG:4326", px[sel].tolist(), py[sel].tolist())
        prof[off] = dict(d=dist[sel] - shore_d, z=z, kilde=kil, aar=aar, lon=np.array(lons), lat=np.array(lats))
        if off == 0:
            spot_shore = (px[sel][0], py[sel][0])
    # --- 3. EMODnet along exactly the same points.
    import rasterio as rio
    with rio.open(HERE / "data" / "raw" / "spots" / f"emodnet_{EMODNET_FILES[spot]}.tif") as s:
        elev = s.read(1).astype(float)
        elon = s.bounds.left + s.res[0] * (np.arange(s.width) + 0.5)
        elat = s.bounds.top - s.res[1] * (np.arange(s.height) + 0.5)
    interp = RegularGridInterpolator((elat[::-1], elon), -elev[::-1], bounds_error=False, fill_value=np.nan)
    for off, p in prof.items():
        p["z_emo"] = interp(np.column_stack([p["lat"], p["lon"]]))
        # Negative "depths" are land or drying cells (e.g. -6 m at the Vorupor mole): not sea floor, so blank them (NaN)
        p["z"] = np.where(p["z"] < 0, np.nan, p["z"]); p["z_emo"] = np.where(p["z_emo"] < 0, np.nan, p["z_emo"])
    # --- 4. Contours and slopes.
    def contour_km(dd, zz, level):
        """Distance where the depth reaches `level` and stays at or below it... i.e. stays >= level for the next 100 m.
        (A single odd cell near the shore, such as a -6 m cell at the Vorupor mole, then cannot fake a crossing.)"""
        n = int(100 / STEP)
        for j in range(1, len(zz) - n):
            if zz[j - 1] < level <= zz[j] and (zz[j:j + n] >= level).all():
                return float(dd[j - 1] + (level - zz[j - 1]) / (zz[j] - zz[j - 1]) * (dd[j] - dd[j - 1]))
        return None
    def slope_n(dd, zz, a, b):
        za, zb = np.interp(a, dd, zz), np.interp(b, dd, zz)
        return float((b - a) / (zb - za)) if zb > za else None
    res = dict(bearing_true=round(brg, 1), lat0=lat, lon0=lon)
    for key, zname in (("ddm", "z"), ("emodnet", "z_emo")):
        res[key] = {}
        for off, p in prof.items():
            ok = ~np.isnan(p[zname])
            res[key][off] = dict(
                contour_m={c: contour_km(p["d"][ok], p[zname][ok], c) for c in CONTOURS},
                slope_1_in={f"{a}-{b}": slope_n(p["d"][ok], p[zname][ok], a, b) for a, b in SLOPE_RANGES},
                depth_at={str(m): float(np.interp(m, p["d"][ok], p[zname][ok])) for m in (0, 100, 250, 500, 1000, 2000, 6000)})
    # --- 5. DDM source split in a strip: 0-500 m and 0-2 km offshore of the shoreline, 2 km wide alongshore (+-1 km).
    gx, gy = np.meshgrid(tf.c + tf.a * (np.arange(d["dybde"].shape[1]) + 0.5), tf.f + tf.e * (np.arange(d["dybde"].shape[0]) + 0.5))
    sx, sy = spot_shore
    n_ = (gx - sx) * normal[0] + (gy - sy) * normal[1]
    t_ = (gx - sx) * tangent[0] + (gy - sy) * tangent[1]
    res["strip"] = {}
    for far in (500, 2000):
        m = (n_ >= -25) & (n_ <= far) & (np.abs(t_) <= 1000) & ~np.isnan(d["dybde"])
        k = d["kilde"][m].astype(int); yrs = d["aar"][m]
        split = {KILDE[c]: int((k == c).sum()) for c in KILDE if (k == c).any()}
        years = {KILDE[c]: sorted({int(y) for y in yrs[k == c] if y > 0}) for c in KILDE if (k == c).any()}
        res["strip"][str(far)] = dict(n_cells=int(m.sum()), by_source=split, years=years,
                                      measured_cells=int(np.isin(k, MEASURED).sum()))
    # share of each line (by length) that comes from each source, for all three lines; p0 = the central line
    p0 = prof[0]
    res["profile_split"] = {}
    for off, p in prof.items():
        res["profile_split"][str(off)] = {}
        for far in (500, 2000):
            k = p["kilde"][p["d"] <= far]; y = p["aar"][p["d"] <= far]
            res["profile_split"][str(off)][str(far)] = dict(
                share={KILDE[c]: round(float((k == c).mean()), 2) for c in KILDE if (k == c).any()},
                years={KILDE[c]: sorted({int(v) for v in y[k == c] if v > 0}) for c in KILDE if (k == c).any()})
    res["emodnet_cells_in_500m"] = int(len({(round(float(a), 4), round(float(b), 4)) for a, b in zip(
        np.interp(p0["lon"][p0["d"] <= 500], elon, np.arange(len(elon))).round().astype(int),
        np.interp(p0["lat"][p0["d"] <= 500], elat[::-1], np.arange(len(elat))).round().astype(int))}))
    res["ddm_cells_in_500m"] = int(len({(int(a), int(b)) for a, b in zip(*[np.round(v).astype(int) for v in to_pix(tf, *[
        np.array(v) for v in warp("EPSG:4326", crs, p0["lon"][p0["d"] <= 500].tolist(), p0["lat"][p0["d"] <= 500].tolist())])])}))
    results[spot] = res
    prof_store[spot] = prof
    print(spot, "shore-normal true bearing", res["bearing_true"], "| snapped shore point lat/lon:",
          round(float(prof[0]["lat"][0]), 5), round(float(prof[0]["lon"][0]), 5))

json.dump(results, open(HERE / "data" / ("compare_spots.json" if ROT_DEG == 0 else f"compare_spots_rot{ROT_DEG:+.0f}.json"), "w"), indent=1, default=float)
if ROT_DEG != 0:
    raise SystemExit(0)                                   # sensitivity runs: no plot

# ---------------- plot ----------------
BG, FG, GRID = "#0e1a22", "#dbe7ec", "#3a4d58"
fig, (ax, ax2) = plt.subplots(1, 2, figsize=(15, 6), facecolor=BG, gridspec_kw=dict(width_ratios=[1.5, 1]))
for a, xmax, zmax in ((ax, 6.0, 26), (ax2, 1.0, 12)):
    a.set_facecolor(BG)
    for spot, prof in prof_store.items():
        zs = np.array([np.interp(prof[0]["d"], prof[o]["d"], prof[o]["z"]) for o in OFFSETS])
        a.fill_between(prof[0]["d"] / 1000, zs.min(0), zs.max(0), color=COLS[spot], alpha=0.25, lw=0)
        a.plot(prof[0]["d"] / 1000, prof[0]["z"], color=COLS[spot], lw=1.8, label=f"{spot} (DDM 50 m, bearing {results[spot]['bearing_true']:.0f})")
        a.plot(prof[0]["d"] / 1000, prof[0]["z_emo"], color=COLS[spot], lw=1, ls="--", label=f"{spot} (EMODnet 115 m)" if a is ax else None)
        # source markers every 50 m along the central DDM line: filled = measured, open ring = satellite-derived, x = interpolated, small dot = historical/digitised
        idx = np.arange(0, len(prof[0]["d"]), 5)
        d_, z_, k_ = prof[0]["d"][idx] / 1000, prof[0]["z"][idx], prof[0]["kilde"][idx]
        for mask, kw in ((np.isin(k_, MEASURED), dict(marker="o", s=34, c=COLS[spot], edgecolors="white", linewidths=0.8, zorder=5)),
                         (k_ == 5, dict(marker="o", s=34, facecolors="none", edgecolors=COLS[spot], linewidths=1.2, zorder=5)),
                         (k_ == 8, dict(marker="x", s=26, c=COLS[spot], linewidths=1.2, zorder=5)),
                         (np.isin(k_, (1, 7)), dict(marker="s", s=14, c=COLS[spot], zorder=5))):
            a.scatter(d_[mask & (d_ <= xmax)], z_[mask & (d_ <= xmax)], **kw)
    a.set_xlim(0, xmax); a.set_ylim(zmax, -0.5)
    a.set_xlabel("distance from the shoreline (km)", color=FG); a.set_ylabel("depth (m, downward)", color=FG)
    a.tick_params(colors=FG); a.grid(color=GRID, alpha=0.6, lw=0.5)
    for sp in a.spines.values(): sp.set_color(GRID)
ax.set_title("Shore-normal profiles, 0-6 km (shaded: spread of lines 300 m either side)", color=FG, fontsize=11)
ax2.set_title("First 1 km. Markers every 50 m on the DDM line:\nfilled dot = measured, ring = satellite-derived, x = interpolated, square = historical", color=FG, fontsize=9.5)
leg = ax.legend(loc="lower left", fontsize=8, facecolor="#14242d", edgecolor=GRID, labelcolor=FG)
fig.savefig(HERE / "compare_spots.png", dpi=130, bbox_inches="tight", facecolor=BG)
print("saved compare_spots.png")
