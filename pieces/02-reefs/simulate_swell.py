"""A simple, honest swell model over the Consolação and Porto Batel reefs (Peniche, Portugal).

Run:  python simulate_swell.py
Reads  data/raw/590_HR_Lidar_Centro.nc           (2011 lidar, the same grid export_reefs.py uses)
       data/surf_zones.json                       (observer marks and the camera)
Writes simulate_swell.png                         (headline plot, two panels)
       ../01-seafloor/viewer/data/swell_sim.json  (one value per reef point, same order as reefs.json)

WHAT THIS MODEL DOES (in plain words)
  1. Shoaling:   a wave slows down as the water gets shallower; its energy bunches up, so it grows taller.
  2. Refraction: the part of a crest in shallower water is slower, so the crest bends to face the shore.
                 Bending spreads the crest over a longer stretch of coast, which makes the wave SMALLER.
  3. Breaking:   a wave is marked "broken" once its height reaches gamma x water depth (gamma = 0.78).
                 Inside the surf zone the height is held at gamma x depth. If the water deepens again,
                 the held-down wave is smaller than gamma x depth and counts as unbroken again (a "reform").

WHAT IT DOES NOT DO
  - It does not simulate the shape of a breaking wave (no lip, no barrel). It only says WHERE a wave of
    this size would be broken.
  - One wave height and one period stand in for the whole sea (real seas are a mix of sizes; sets are
    bigger than the average).
  - Refraction assumes the depth contours are straight and parallel to the local shore (Snell's law for a
    straight beach). Real reefs focus and spread waves in ways this cannot see.
  - It knows nothing outside the ~600 m lidar strip: no Peniche headland shadow, no offshore canyon.

WHY THERE ARE TWO MODES
  STRICT  (WRAPPED = False): the offshore wave direction is used as it is. Result for this case: both spots
          face SW to S, while a 337 or 325 deg swell travels towards the SSE, i.e. ALONG or AWAY from this
          coast. Straight-contour refraction cannot bring that wave in, so (nearly) every cell at the spots is
          flagged "not reachable". That is the honest answer of the simple model: the swell that reaches
          Consolação and Porto Batel has bent around the Peniche headland, which this model cannot compute.
  WRAPPED (WRAPPED = True, the default for the plot and viewer): a stated assumption instead. The wave is
          assumed to arrive at the outer edge of the lidar strip heading straight at the coast's general line
          (the shore direction averaged over ~600 m), with the full offshore height. Inside the strip it then
          shoals, refracts on the local contours and breaks as above. The full offshore height is an UPPER
          bound: wrapping round a headland always loses energy, and we do not know how much.
"""
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")                     # draw to a file, not to a window
import matplotlib.pyplot as plt
import numpy as np
import xarray as xr
from scipy import ndimage as ndi

# =====================================================================================================
# CONFIG: the one block to edit. The default is the "total sea" case from the model forecast.
# =====================================================================================================
H0 = 2.7                    # offshore wave height (m), model total significant height, 17 Sep 2026 18:00 local
T = 12                   # wave period (s)
DIRECTION_FROM_DEG = 337    # where the waves come FROM, compass degrees (337 = NNW)
TIDE_ABOVE_LAT = 0.5       # tide (m above Lowest Astronomical Tide); water depth = lidar depth + this
GAMMA = 0.78                # breaking ratio: broken when height >= GAMMA x water depth
WRAPPED = True              # see "WHY THERE ARE TWO MODES" below; True = the wave is assumed to have wrapped
# Extra runs (numbers only, printed at the end):
CASES = {"total sea 2.7 m / 7.8 s / 337": (2.7, 7.8, 337),
         "swell only 1.9 m / 9.7 s / 325": (1.9, 9.7, 325)}
GAMMAS = [0.6, 0.78, 1.0]
# Model knobs (rarely touched):
NORMAL_SMOOTH_M = 100       # the shore direction is averaged over about this many metres
REGIONAL_SMOOTH_M = 600     # WRAPPED mode: the coast's general direction, averaged over about this many metres
EDGE_DEPTH_M = 12.0         # WRAPPED mode: water depth at the outer edge of the lidar strip (8-11 m + tide)
SET_FACTORS = [1.0, 1.2, 1.4]   # set waves: individual waves this many times the average height (numbers only)
# Where things happened on 17 Sep at Porto Batel. All points are observer marks from Google Earth (2026-11-12/13),
# checked against the lidar, so each is good to a few metres. (lat, lon)
# There is no outer-break pin yet: the old one (39.3183, -9.3591) was scaled from a sketch and was ~220 m out.
# Rock contact was observed in the take-off zone (2026-11-14), so it shares the take-off pin. The footage puts the
# take-off at the outer break, about 115 m (90-145 m) from the camera. Old rock-contact pin (39.3192267, -9.3562366) was on the
# dry shelf and is removed.
USER_SKETCH = {"filming position (13 m above water)": (39.319506, -9.355772),
               "take-off zone, where the observer sat; rock contact here (observed)": (39.318870, -9.356829)}
MAX_THETA0_DEG = 80         # waves meeting the coast at more than this angle: "not reachable by this model"
WET_MIN_M = 0.05            # cells with less water than this are treated as dry
# =====================================================================================================

g = 9.81                    # gravity (m/s^2)
HERE = Path(__file__).parent
NC_FILE = HERE / "data" / "raw" / "590_HR_Lidar_Centro.nc"
REEFS_JSON = HERE.parent / "01-seafloor" / "viewer" / "data" / "reefs.json"
OUT_JSON = HERE.parent / "01-seafloor" / "viewer" / "data" / "swell_sim.json"
OUT_PNG = HERE / "simulate_swell.png"
# Same box and flat-earth conversion as export_reefs.py, so every cell lines up with reefs.json.
BOX = dict(lon_min=-9.385, lon_max=-9.340, lat_min=39.310, lat_max=39.334)
ORIGIN_LAT, ORIGIN_LON = 39.322, -9.3625
M_PER_DEG = 111195.0


def to_metres(lon, lat):
    """Degrees -> metres east (x) and north (y) of the box middle."""
    return ((np.asarray(lon) - ORIGIN_LON) * M_PER_DEG * np.cos(np.radians(ORIGIN_LAT)),
            (np.asarray(lat) - ORIGIN_LAT) * M_PER_DEG)


# -----------------------------------------------------------------------------------------------------
# 1. WAVE PHYSICS FOR ONE DEPTH: the dispersion relation
# -----------------------------------------------------------------------------------------------------
# omega^2 = g k tanh(k d) links the wave's period (omega = 2 pi / T) to its wavenumber k (k = 2 pi / wavelength)
# in water of depth d. There is no neat formula for k, so we guess and improve the guess (Newton's method):
# each step moves k to where the straight-line approximation of the equation says it should be.
def wavenumber(T, d):
    omega = 2 * np.pi / T
    d = np.asarray(d, dtype=float)
    k = omega**2 / g / np.sqrt(np.tanh(omega**2 * d / g))       # a very good first guess (Eckart-style)
    for _ in range(20):                                          # 20 steps is far more than needed
        th = np.tanh(k * d)
        f = g * k * th - omega**2                                # how far we are from satisfying the equation
        df = g * th + g * k * d * (1 - th**2)                    # how fast f changes when k changes
        k = k - f / df
    return k


def wave_speeds(T, d):
    """Return k, phase speed c (crest speed) and group speed Cg (energy speed) at depth d."""
    k = wavenumber(T, d)
    c = (2 * np.pi / T) / k
    kd2 = np.minimum(2 * k * d, 700)                             # avoid overflow of sinh in very deep water
    Cg = c / 2 * (1 + kd2 / np.sinh(kd2))
    return k, c, Cg


# -----------------------------------------------------------------------------------------------------
# 2. LOAD THE GRID (exactly as export_reefs.py does)
# -----------------------------------------------------------------------------------------------------
ds = xr.open_dataset(NC_FILE)
s = ds.sel(lon=slice(BOX["lon_min"], BOX["lon_max"]), lat=slice(BOX["lat_min"], BOX["lat_max"])).load()
lidar = -s.elevation.values.astype(float)                        # depth below LAT, positive down (land negative)
lon2d, lat2d = np.meshgrid(s.lon.values, s.lat.values)           # rows = south to north, columns = west to east
X, Y = to_metres(lon2d, lat2d)
valid = np.isfinite(lidar)
dx = float(np.diff(X[0, :]).mean()); dy = float(np.diff(Y[:, 0]).mean())

# Check that our cells are the reefs.json points, in the same order (row by row, only cells with data).
reefs = json.loads(REEFS_JSON.read_text())
n_reef = len(reefs["depth_m"])
assert valid.sum() == n_reef, f"cell count {valid.sum()} != reefs.json {n_reef}"
for idx in [0, n_reef // 3, n_reef // 2, n_reef - 1]:            # spot-check a few coordinates and depths
    assert abs(X[valid][idx] - reefs["x_m"][idx]) < 0.11 and abs(Y[valid][idx] - reefs["y_m"][idx]) < 0.11
    assert abs(lidar[valid][idx] - reefs["depth_m"][idx]) < 0.006
print(f"grid {lidar.shape}, cells {dx:.1f} m x {dy:.1f} m; {n_reef} cells match reefs.json in count, order and position")

# -----------------------------------------------------------------------------------------------------
# 3. WHICH WAY IS "TOWARDS THE SHORE" AT EACH CELL? (depends on the tide, not on the wave)
# -----------------------------------------------------------------------------------------------------
# Distance from every cell to the nearest dry cell, then smoothed over ~100 m. Walking downhill on that
# smoothed distance map points straight at the coast; that direction is the local "shore-normal".
def shore_normal(tide, smooth_m=NORMAL_SMOOTH_M):
    d = lidar + tide
    dry = valid & (d <= WET_MIN_M)
    dist = ndi.distance_transform_edt(~dry, sampling=(dy, dx))   # metres to the nearest dry cell
    sm = ndi.gaussian_filter(dist, sigma=(smooth_m / 2 / dy, smooth_m / 2 / dx))
    gy, gx = np.gradient(sm, dy, dx)                             # slope of the distance map (points to sea)
    norm = np.hypot(gx, gy) + 1e-9
    return -gx / norm, -gy / norm, sm, norm                      # unit vector TOWARDS the shore, smoothed distance, its slope


# -----------------------------------------------------------------------------------------------------
# 4. RUN ONE CASE
# -----------------------------------------------------------------------------------------------------
def run(H0, T, direction_from, tide, gamma, wrapped=WRAPPED):
    d = lidar + tide                                             # water depth (m)
    wet = valid & (d > WET_MIN_M)
    nx, ny, smdist, slope = shore_normal(tide)

    # Wave travel direction offshore: it comes FROM direction_from, so it travels towards direction_from + 180.
    # Compass bearing b -> map vector (east, north) = (sin b, cos b).
    to = np.radians(direction_from + 180)
    ux0, uy0 = np.sin(to), np.cos(to)
    ux_off, uy_off = ux0, uy0                                    # kept for the plot arrow
    c0 = g * T / (2 * np.pi)                                     # deep-water crest speed
    c_ref = c0                                                   # Snell's law compares speeds with this one
    if wrapped:
        # WRAPPED: the incoming direction is the coast's general shoreward direction (one per cell, smooth),
        # and Snell's law starts at the edge of the lidar strip, so it compares with the crest speed there.
        ux0, uy0, _, _ = shore_normal(tide, REGIONAL_SMOOTH_M)
        c_ref = wave_speeds(T, EDGE_DEPTH_M)[1]

    # theta0 = angle between the offshore travel direction and the shoreward normal (0 = waves head straight in).
    cos_t0 = np.clip(ux0 * nx + uy0 * ny, -1, 1)
    theta0 = np.arccos(cos_t0)
    side = np.sign(nx * uy0 - ny * ux0)                          # which way the wave is turned from the normal
    reachable = wet & (np.degrees(theta0) < MAX_THETA0_DEG)

    # Physics at every wet cell
    dd = np.where(wet, d, 1.0)                                   # dummy depth on dry cells (masked out later)
    k, c, Cg = wave_speeds(T, dd)
    Cg0 = c0 / 2                                                 # deep-water energy speed = g T / (4 pi)
    Ks = np.sqrt(Cg0 / Cg)                                       # shoaling: slower energy -> taller wave
    sin_t = np.sin(theta0) * c / c_ref                              # Snell's law: sin(theta)/c stays the same
    theta = np.arcsin(np.clip(sin_t, -1, 1))                     # local angle of the crest to the depth contours
    Kr = np.sqrt(np.clip(np.cos(theta0), 1e-6, None) / np.cos(theta))   # refraction: crests spread -> smaller
    Hlin = H0 * Ks * Kr                                          # height if nothing broke on the way in

    # Local travel direction: the shoreward normal turned by theta towards the offshore direction.
    ct, st = np.cos(theta), np.sin(theta) * side
    ux = nx * ct - ny * st                                       # rotate (nx, ny) by angle st
    uy = nx * st + ny * ct

    # ---- March shoreward: from the outer cells inwards, each cell looks one step back out to sea ----
    # Cells are visited from far-from-shore to near-shore. For each cell we find the cell one step seaward along
    # the shore-normal ("upstream"). Its height is carried in with shoaling + refraction; breaking caps it.
    step = max(dx, dy)
    rows, cols = np.nonzero(reachable)
    order = np.argsort(-smdist[rows, cols], kind="stable")
    H = np.full(lidar.shape, np.nan)
    broken = np.zeros(lidar.shape, bool)
    first = np.zeros(lidar.shape, bool)                          # outermost cell of each surf zone (break onset)
    phase = np.full(lidar.shape, np.nan)
    rank = np.full(lidar.shape, -1)
    rank[rows[order], cols[order]] = np.arange(len(order))
    n_edge = n_shelter = 0
    for r, cc in zip(rows[order], cols[order]):
        ur = int(round(r - ny[r, cc] * step / dy))               # one step seaward (minus the shoreward normal)
        uc = int(round(cc - nx[r, cc] * step / dx))
        inside = 0 <= ur < lidar.shape[0] and 0 <= uc < lidar.shape[1]
        if inside and valid[ur, uc] and not (d[ur, uc] > WET_MIN_M):
            H[r, cc] = np.nan; n_shelter += 1                    # dry land right seaward: in its lee, not modelled
            continue
        if inside and 0 <= rank[ur, uc] < rank[r, cc] and np.isfinite(H[ur, uc]):
            # carry the upstream height in: scale by how much shoaling+refraction changes between the two cells
            h = H[ur, uc] * (Ks[r, cc] * Kr[r, cc]) / (Ks[ur, uc] * Kr[ur, uc])
            # phase: add k x (metres moved towards the shore). "Metres towards the shore" is the drop in the smoothed
            # distance-to-shore map, so the crests (lines of equal phase) follow the shape of the coast.
            ph = phase[ur, uc] + k[r, cc] * (smdist[ur, uc] - smdist[r, cc]) / max(slope[r, cc], 0.5)
            up_broken = broken[ur, uc]
        else:
            # no usable upstream cell: this is the outer edge of the data (or a gap); start from the offshore wave
            h = Hlin[r, cc]
            ph = -k[r, cc] * smdist[r, cc]                       # crest lines at the edge follow the coast's shape
            up_broken = False; n_edge += 1
        if h >= gamma * d[r, cc]:                                # too tall for this depth: broken, held at gamma*d
            h = gamma * d[r, cc]; broken[r, cc] = True
            first[r, cc] = not up_broken
        H[r, cc] = h; phase[r, cc] = ph

    drawn = np.isfinite(H)
    return dict(d=d, wet=wet, reachable=reachable, drawn=drawn, H=H, broken=broken & drawn, first=first & drawn,
                k=k, phase=phase, theta0=np.degrees(theta0), Ks=Ks, Kr=Kr, nx=nx, ny=ny, ux0=ux_off, uy0=uy_off,
                n_edge=n_edge, n_shelter=n_shelter)


# -----------------------------------------------------------------------------------------------------
# 5. SANITY CHECKS ON THE PHYSICS
# -----------------------------------------------------------------------------------------------------
for TT in (7.8, 9.7):
    k4, c4, Cg4 = wave_speeds(TT, 4.0)
    print(f"check: T={TT} s, d=4 m -> wavelength {2*np.pi/k4:.0f} m, Ks = {np.sqrt(g*TT/(4*np.pi)/Cg4):.3f}")
kdeep = wavenumber(7.8, 500.0)
print(f"check: deep water k = {kdeep:.5f}, omega^2/g = {(2*np.pi/7.8)**2/g:.5f}")

# -----------------------------------------------------------------------------------------------------
# 6. THE MARKS, AND A HELPER THAT READS THE MODEL ALONG A LINE THROUGH A MARK
# -----------------------------------------------------------------------------------------------------
zones = json.loads((HERE / "data" / "surf_zones.json").read_text())
marks = [dict(m, x=float(to_metres(m["lon"], m["lat"])[0]), y=float(to_metres(m["lon"], m["lat"])[1])) for m in zones["marks"]]
cam = zones["camera"]; cam_x, cam_y = (float(v) for v in to_metres(cam["lon"], cam["lat"]))
x1, y1 = X[0, :], Y[:, 0]


def cell_of(x, y):
    return int(round((y - y1[0]) / dy)), int(round((x - x1[0]) / dx))


def transect(res, x, y, back=450, fwd=80, ds=2.0):
    """Walk along the shore-normal through (x, y), from `back` m seaward to `fwd` m shoreward.
    Returns positions s (m, positive = seaward of the mark) and the model state at each sample."""
    r, c = cell_of(x, y)
    nx, ny = res["nx"][r, c], res["ny"][r, c]
    out = []
    for s_ in np.arange(back, -fwd - ds, -ds):                   # from sea to shore
        rr, cc = cell_of(x - nx * s_, y - ny * s_)
        if 0 <= rr < lidar.shape[0] and 0 <= cc < lidar.shape[1] and res["drawn"][rr, cc]:
            out.append((s_, rr, cc))
    return out


def break_onsets(res, x, y):
    """Break onsets (unbroken -> broken, walking shoreward) along the transect through a mark."""
    tr = transect(res, x, y)
    ons, prev = [], False
    for s_, rr, cc in tr:
        b = res["broken"][rr, cc]
        if b and not prev:
            ons.append(dict(s=s_, H=res["H"][rr, cc], d=res["d"][rr, cc], lidar=lidar[rr, cc]))
        prev = b
    return ons


def near_spot(res, x, y, radius=60):
    m = res["wet"] & (np.hypot(X - x, Y - y) < radius)       # all wet cells, drawn or not
    return {k_: float(np.nanmedian(res[k_][m])) for k_ in ("theta0", "Ks", "Kr")}


def compass(nx, ny):
    return (np.degrees(np.arctan2(nx, ny)) + 360) % 360


pb = [m for m in marks if m["spot"] == "Porto Batel"]            # marks 4 and 5 (inner reform line)
co = [m for m in marks if m["spot"] == "Consolação"]
SPOTS = {"Porto Batel": (np.mean([m["x"] for m in pb]), np.mean([m["y"] for m in pb]), pb),
         "Consolação": (np.mean([m["x"] for m in co]), np.mean([m["y"] for m in co]), co)}


def summary(res, label):
    print(f"\n== {label} ==  edge starts {res['n_edge']}, lee-of-dry cells dropped {res['n_shelter']}, "
          f"not reachable {int((res['wet'] & ~res['reachable']).sum())}, drawn {int(res['drawn'].sum())}, "
          f"broken {int(res['broken'].sum())}")
    for spot, (sx, sy, ms) in SPOTS.items():
        r, c = cell_of(sx, sy)
        loc = near_spot(res, sx, sy)
        print(f"  {spot}: shore-normal points to {compass(res['nx'][r, c], res['ny'][r, c]):.0f} deg "
              f"(coast faces {(compass(res['nx'][r, c], res['ny'][r, c]) + 180) % 360:.0f} deg); "
              f"theta0 {loc['theta0']:.0f} deg, Ks {loc['Ks']:.2f}, Kr {loc['Kr']:.2f} (median within 60 m)")
        for m in ms:
            ons = break_onsets(res, m["x"], m["y"])
            mr, mc = cell_of(m["x"], m["y"])
            state = ("broken" if res["broken"][mr, mc] else "unbroken") if res["drawn"][mr, mc] else "not drawn"
            txt = "; ".join(f"onset {o['s']:+.0f} m (H {o['H']:.2f} m, water {o['d']:.2f} m, lidar {o['lidar']:.2f} m)" for o in ons)
            print(f"    {m['name']} (lidar {m['depth_m_below_lat']} m, model {state} there): {txt or 'no break on its transect'}")


# -----------------------------------------------------------------------------------------------------
# 7. RUN: main case (for the plot and the viewer), the two forecast cases, and gamma sensitivity
# -----------------------------------------------------------------------------------------------------
main = run(H0, T, DIRECTION_FROM_DEG, TIDE_ABOVE_LAT, GAMMA)
assert not np.isnan(main["k"][main["wet"]]).any() and not np.isnan(main["Ks"][main["wet"]]).any(), "NaN in wet cells"
assert not np.isnan(main["H"][main["drawn"]]).any()
print("check: no NaNs in k, Ks for wet cells, nor in H/phase where drawn:",
      not np.isnan(main["phase"][main["drawn"]]).any())
results = {}
for mode in (False, True):                                       # STRICT first, then WRAPPED
    for name, (h, tt, dr) in CASES.items():
        results[(name, mode)] = run(h, tt, dr, TIDE_ABOVE_LAT, GAMMA, wrapped=mode)
        summary(results[(name, mode)], f"{'WRAPPED' if mode else 'STRICT'}: {name}, gamma {GAMMA}")


def first_onsets(res):
    parts = []
    for m in pb:
        ons = break_onsets(res, m["x"], m["y"])
        parts.append(f"{m['name']}: " + (f"{ons[0]['s']:+.0f} m, lidar {ons[0]['lidar']:.2f} m, H {ons[0]['H']:.2f} m" if ons else "none"))
    return " | ".join(parts)


print(f"\n== gamma sensitivity (main case, {'WRAPPED' if WRAPPED else 'STRICT'}): outermost break onset on the transects through marks 4 and 5 ==")
for gm in GAMMAS:
    rg = main if gm == GAMMA else run(H0, T, DIRECTION_FROM_DEG, TIDE_ABOVE_LAT, gm)
    print(f"  gamma {gm}: broken cells {int(rg['broken'].sum())}; " + first_onsets(rg))
print("\n== set waves (main case): offshore height x factor ==")
for f_ in SET_FACTORS:
    rs = main if f_ == 1.0 else run(H0 * f_, T, DIRECTION_FROM_DEG, TIDE_ABOVE_LAT, GAMMA)
    print(f"  H0 {H0 * f_:.2f} m: " + first_onsets(rs))

# -----------------------------------------------------------------------------------------------------
# 7b. OBSERVER MARKS, 17 SEP: what the lidar and the model say at the outer break, take-off and rock
# -----------------------------------------------------------------------------------------------------
sketch = {name: tuple(float(v) for v in to_metres(lo, la)) for name, (la, lo) in USER_SKETCH.items()}
print("\n== Observer marks, 17 Sep (Google Earth, a few metres) ==")
for name, (sx_, sy_) in sketch.items():
    near30 = valid & (np.hypot(X - sx_, Y - sy_) <= 30)
    r_, c_ = cell_of(sx_, sy_)
    inside = 0 <= r_ < lidar.shape[0] and 0 <= c_ < lidar.shape[1] and valid[r_, c_]
    dep = lidar[near30]
    print(f"  {name}: inside lidar: {inside}; lidar depth within 30 m: median {np.median(dep):.2f} m, "
          f"range {dep.min():.2f} to {dep.max():.2f} m ({dep.size} cells)" if dep.size else f"  {name}: no lidar within 30 m")
    for (cname, mode), res in results.items():
        cell = res["drawn"][r_, c_] if inside else False
        fbd = np.hypot(X[res["first"]] - sx_, Y[res["first"]] - sy_)
        j = int(np.argmin(fbd)) if fbd.size else None
        where = (f"nearest model first-break cell {fbd[j]:.0f} m away (lidar {lidar[res['first']][j]:.2f} m)" if j is not None else "no first-break cells")
        state = (f"water {res['d'][r_, c_]:.2f} m, H {res['H'][r_, c_]:.2f} m, {'broken' if res['broken'][r_, c_] else 'unbroken'}"
                 if cell else ("not reachable" if inside and res["wet"][r_, c_] else "not drawn"))
        print(f"    {'WRAPPED' if mode else 'STRICT '} {cname}: {state}; {where}")
# Lidar profile from the filming position out through the take-off mark, to 250 m (the line the waves came in along)
hx, hy = sketch["filming position (13 m above water)"]
sx2, sy2 = sketch["take-off zone, where the observer sat; rock contact here (observed)"]
ux, uy = (sx2 - hx) / np.hypot(sx2 - hx, sy2 - hy), (sy2 - hy) / np.hypot(sx2 - hx, sy2 - hy)   # unit step, 1 m
prof = []
for dist in range(40, 251, 10):
    r_, c_ = cell_of(hx + dist * ux, hy + dist * uy)
    ok = 0 <= r_ < lidar.shape[0] and 0 <= c_ < lidar.shape[1] and valid[r_, c_]
    prof.append(f"{dist}m:{lidar[r_, c_]:.1f}" if ok else f"{dist}m:gap")
print(f"  lidar depth below LAT along the line filming position -> take-off mark -> 250 m (distance from the filming position):")
print("   ", " ".join(prof))

# -----------------------------------------------------------------------------------------------------
# 8. VIEWER FILE: one value per reefs.json point, same order
# -----------------------------------------------------------------------------------------------------
v = valid                                                        # row-by-row order of cells with data = reefs.json order
state = np.zeros(lidar.shape, int)                               # 0 dry / not drawn, 1 unbroken, 2 broken, 3 not reachable
state[main["drawn"]] = 1
state[main["broken"]] = 2
state[main["wet"] & ~main["reachable"]] = 3
viewer = dict(
    meta=dict(case="17 Sep 2026 about 18:00 local, Porto Batel and Consolação",
              config=dict(H0_m=H0, T_s=T, direction_from_deg=DIRECTION_FROM_DEG, tide_above_lat_m=TIDE_ABOVE_LAT,
                          gamma=GAMMA, omega_rad_s=round(2 * np.pi / T, 5), normal_smooth_m=NORMAL_SMOOTH_M,
                          max_theta0_deg=MAX_THETA0_DEG),
              mode="WRAPPED" if WRAPPED else "STRICT",
              viewer_note=("Assumed: the swell bends round Peniche and reaches the edge of the lidar strip head-on at full "
                           "offshore height (an upper bound). Taken as it is, a 337 deg swell runs along this coast and the "
                           "simple model cannot bring it in." if WRAPPED else ""),
              order="same order and count as reefs.json", n_points=int(v.sum()),
              fields=dict(H="wave height (m), -1 where not drawn", broken="1 = broken (height held at gamma x depth)",
                          k="wavenumber (rad/m), 0 where dry", phase="phase (rad): k summed along the shoreward march (crests follow the 100 m smoothed shore line), wrapped to 0..2pi",
                          state="0 dry or in the lee of dry land, 1 unbroken, 2 broken, 3 not reachable (wave runs along/away from coast)"),
              assumptions=["linear waves, one height and one period for the whole sea",
                           "offshore height treated as deep-water height; no losses before the lidar edge",
                           "refraction by Snell's law for straight contours parallel to the local (100 m smoothed) shore",
                           "no sheltering by the Peniche headland, no bathymetry outside the ~600 m lidar strip",
                           "breaking when H >= gamma x depth; inside the surf zone H is held at gamma x depth; reform when the water deepens",
                           "it does not simulate the shape of a breaking wave"]),
    H=np.round(np.where(main["drawn"], main["H"], -1)[v], 2).tolist(),
    broken=main["broken"][v].astype(int).tolist(),
    k=np.round(np.where(main["wet"], main["k"], 0)[v], 4).tolist(),
    phase=np.round(np.where(main["drawn"], np.mod(main["phase"], 2 * np.pi), 0)[v], 3).tolist(),
    state=state[v].tolist(),
)
assert len(viewer["H"]) == n_reef
OUT_JSON.write_text(json.dumps(viewer, separators=(",", ":")))
print(f"\nwrote {OUT_JSON.name}: {n_reef} points, {OUT_JSON.stat().st_size // 1024} KB")

# -----------------------------------------------------------------------------------------------------
# 9. HEADLINE PLOT
# -----------------------------------------------------------------------------------------------------
BG, FG = "#04060a", "#d8e2ea"
fig, axes = plt.subplots(1, 2, figsize=(15, 7.6), facecolor=BG)
Hmap = np.ma.masked_invalid(main["H"])
land = np.ma.masked_where(~(valid & ~main["wet"]), np.ones_like(lidar))
unreach = np.ma.masked_where(~(main["wet"] & ~main["drawn"]), np.ones_like(lidar))
xe = np.append(x1 - dx / 2, x1[-1] + dx / 2); ye = np.append(y1 - dy / 2, y1[-1] + dy / 2)
for ax, (spot, (sx, sy, ms)) in zip(axes, SPOTS.items()):
    ax.set_facecolor(BG)
    ax.pcolormesh(xe, ye, land, cmap=matplotlib.colors.ListedColormap(["#3a332b"]), shading="flat")
    ax.pcolormesh(xe, ye, unreach, cmap=matplotlib.colors.ListedColormap(["#2a2f38"]), shading="flat")
    pm = ax.pcolormesh(xe, ye, Hmap, cmap="viridis", vmin=0, vmax=max(2.5, H0), shading="flat")
    fb = main["first"]
    ax.scatter(X[fb], Y[fb], s=7, c="#ff4fd8", marker="s", lw=0, label="first break (onset of breaking)")
    bk = main["broken"] & ~fb
    ax.scatter(X[bk], Y[bk], s=2, c="white", alpha=0.45, lw=0, label="broken (held at 0.78 x depth)")
    for m in ms:
        ax.plot(m["x"], m["y"], "o", ms=9, mfc="none", mec="#3dffa0", mew=2)
        ax.annotate(m["name"].replace("Surf zone ", "mark "), (m["x"], m["y"]), xytext=(-46 if m["name"].endswith("4") else 6, 8), textcoords="offset points",
                    color="#3dffa0", fontsize=9)
    if spot == "Porto Batel":
        ax.plot(cam_x, cam_y, "^", ms=10, color="#ffd36b")
        for nm, (ux_, uy_) in sketch.items():                    # observer marks: dashed circles = 10 m
            ax.add_patch(plt.Circle((ux_, uy_), 10, fill=False, ls="--", lw=1.4, ec="#ff9f43"))
            ax.plot(ux_, uy_, "D", ms=6, color="#ff9f43")
            off, ha = {"filmi": ((8, 6), "left"), "take-": ((6, -30), "left")}.get(nm[:5], ((6, 6), "left"))
            ax.annotate(nm.replace(" with whitewater", ""), (ux_, uy_), xytext=off, textcoords="offset points",
                        color="#ff9f43", fontsize=8.5, ha=ha)
        ax.annotate("camera", (cam_x, cam_y), xytext=(6, -12), textcoords="offset points", color="#ffd36b", fontsize=9)
    half = 330
    ax.set_xlim(sx - half, sx + half); ax.set_ylim(sy - half * 0.9, sy + half * 0.9); ax.set_aspect("equal")
    ax.set_xticks([]); ax.set_yticks([])
    for sp in ax.spines.values(): sp.set_color("#334")
    r, c = cell_of(sx, sy); loc = near_spot(main, sx, sy)
    ax.set_title(f"{spot}: coast faces {(compass(main['nx'][r, c], main['ny'][r, c]) + 180) % 360:.0f} deg; "
                 f"wave meets it at {loc['theta0']:.0f} deg" + (" (wrapped)" if WRAPPED else "") + f"; refraction x{loc['Kr']:.2f}",
                 color=FG, fontsize=10.5)
    # north arrow and scale bar
    x0, y0 = sx + half - 50, sy + half * 0.9 - 110
    ax.annotate("", (x0, y0 + 70), (x0, y0), arrowprops=dict(arrowstyle="-|>", color=FG, lw=1.6))
    ax.text(x0, y0 + 78, "N", color=FG, ha="center", fontsize=11, weight="bold")
    bx, by = sx - half + 30, sy - half * 0.9 + 30
    ax.plot([bx, bx + 100], [by, by], color=FG, lw=3); ax.text(bx + 50, by + 10, "100 m", color=FG, ha="center", fontsize=9)
    # offshore wave direction arrow
    ax.annotate("", (sx - half + 130 + main["ux0"] * 80, sy + half * 0.9 - 80 + main["uy0"] * 80),
                (sx - half + 130, sy + half * 0.9 - 80), arrowprops=dict(arrowstyle="-|>", color="#7fe3f0", lw=2))
    ax.text(sx - half + 20, sy + half * 0.9 - 40, f"offshore swell, from {DIRECTION_FROM_DEG} deg", color="#7fe3f0", fontsize=9)
leg = axes[0].legend(loc="lower right", fontsize=8.5, facecolor=BG, edgecolor="#334", labelcolor=FG, markerscale=2.5)
cb = fig.colorbar(pm, ax=axes, orientation="horizontal", fraction=0.035, pad=0.03, aspect=50); cb.set_label("wave height H (m)", color=FG)
cb.ax.tick_params(colors=FG); cb.outline.set_edgecolor("#334")
fig.text(0.02, 0.0, "dark grey-blue = wet but not reachable by this model (wave runs along or away from the coast, or in the lee of dry rock); brown = dry at this tide",
         color="#9ab", fontsize=8.5)
fig.suptitle(f"17 Sep 2026, about 18:00 local. Offshore {H0} m, {T} s, from {DIRECTION_FROM_DEG} deg; tide {TIDE_ABOVE_LAT} m above LAT; "
             f"broken where H >= {GAMMA} x depth\nSimple shoaling + refraction model, not a breaking-wave simulation. "
             "Lidar 2011 (EMODnet / DGT)." + (
                 "\nWRAPPED assumption: the swell travels along this coast, so it is assumed to bend round Peniche and reach the lidar edge "
                 "head-on at full offshore height (an upper bound)." if WRAPPED else ""), color=FG, fontsize=11.5)
fig.savefig(OUT_PNG, dpi=110, bbox_inches="tight", facecolor=BG)
print("wrote", OUT_PNG.name)
