"""Stage A as one callable: run_stage_a(hs, tp, direction, tide_lat) -> dict of break / peel outputs.

Same physics as crest_lines.py (depth, dispersion, eikonal phase by fast marching) and height_break_peel.py
(shoaling x refraction, H/h >= gamma breaking, peel angle from the break line). The code below is moved, not
changed: the numerical steps, constants (gamma 0.78, phi smoothing 2 cells, Kr clip 0.3-2.5, 10 m cells,
2.4 km domain) and the 236 deg house line are the same. Nothing is written to disk and nothing is plotted.

Split into two parts because only the second depends on the wave height:
  phase_part(tp, direction, tide_lat)  -> phi, k, Cg, Ks*Kr per unit H0, peel geometry inputs  (the cost, ~1-2 s)
  height_part(P, hs)                   -> break line, breaker height, peel                          (cheap)
run_stage_a() calls both. The lookup sweep (sweep_lookup.py) calls phase_part once per (Tp, dir, tide) and
height_part for every Hs.

hs is used as H0, the height at the domain's upwind edge (about 14 m deep), exactly as height_break_peel.py
uses --H0. A forecast Hs is a model value about 4 km further offshore; feeding it in as H0 is the same
assumption milestone 2 made. tide_lat is the still-water level in metres above LAT (the lidar datum).

Sites (2026-11-16): every function takes an optional `site` (sites.py). The default is sites.PORTO_BATEL, whose values are
the constants below, so Porto Batel runs are bit-for-bit what they were. A site changes geometry and datum only: the bed
grid, the domain, an optional rotation of the grid (grid_deg = compass bearing of the grid's +y axis, 0 = north), the
reference line and profile length. The physics and its constants (gamma, smoothing, Kr clip, cell size) are shared.

Run directly for the regression check:  python stage_a.py   (add --site pipeline for the Pipeline cases)
"""
import heapq
import time
from pathlib import Path

import numpy as np
import xarray as xr
from scipy import ndimage as ndi

HERE = Path(__file__).resolve().parent
NC = HERE.parent / "02-reefs" / "data" / "raw" / "590_HR_Lidar_Centro.nc"
HOUSE_LAT, HOUSE_LON = 39.319506, -9.355772
M_PER_DEG = 111195.0
G = 9.81
HALF, DX = 1200.0, 10.0          # crest_lines.py defaults
GAMMA = 0.78                     # height_break_peel.py default (not tuned)
SMOOTH = 2.0                     # height_break_peel.py default
LINE_DEG, ALONG_DEG = 236.0, 326.0   # house line toward the sea, and alongshore offset direction
PROFILE_OFFSETS = np.arange(-600.0, 600.0 + 1, 25.0)   # alongshore offsets of the break-line profiles, m (49)
import sys as _sys
_sys.path.insert(0, str(HERE))
import sites as _sites  # noqa: E402
PB = _sites.PORTO_BATEL   # its values are the constants above (checked in __main__)

# ---------------------------------------------------------------- moved from crest_lines.py (unchanged)
def wavenumber(T, h):
    """Solve omega^2 = g k tanh(k h) for k, any h > 0 (array). Newton on k, started from the shallow/deep blend."""
    w2 = (2 * np.pi / T) ** 2
    h = np.maximum(h, 1e-3)
    k = np.maximum(np.sqrt(w2 / (G * h)), w2 / G)
    for _ in range(60):
        t = np.tanh(k * h)
        f = G * k * t - w2
        df = G * t + G * k * h * (1 - t * t)
        k = np.maximum(k - f / df, 1e-6)
    return k


def load_bed(half=HALF, dx=DX):
    """Lidar bed (m above LAT) resampled to a local 10 m grid; returns x, y, bed, nan-filled mask."""
    n = int(round(2 * half / dx)) + 1
    x = np.linspace(-half, half, n); y = np.linspace(-half, half, n)
    X, Y = np.meshgrid(x, y)
    coslat = np.cos(np.radians(HOUSE_LAT))
    LON = HOUSE_LON + X / (M_PER_DEG * coslat); LAT = HOUSE_LAT + Y / M_PER_DEG
    ds = xr.open_dataset(NC)
    box = ds.sel(lon=slice(LON.min() - 0.001, LON.max() + 0.001), lat=slice(LAT.min() - 0.001, LAT.max() + 0.001)).load()
    el = box.elevation.values.astype(float)
    nan = ~np.isfinite(el)
    idx = ndi.distance_transform_edt(nan, return_distances=False, return_indices=True)
    el_f = el[tuple(idx)]
    lon, lat = box.lon.values, box.lat.values
    fi = np.interp(LON, lon, np.arange(lon.size)); fj = np.interp(LAT, lat, np.arange(lat.size))
    i0 = np.clip(np.floor(fi).astype(int), 0, lon.size - 2); j0 = np.clip(np.floor(fj).astype(int), 0, lat.size - 2)
    ti, tj = fi - i0, fj - j0
    def bil(A):
        return ((1 - ti) * (1 - tj) * A[j0, i0] + ti * (1 - tj) * A[j0, i0 + 1]
                + (1 - ti) * tj * A[j0 + 1, i0] + ti * tj * A[j0 + 1, i0 + 1])
    return x, y, bil(el_f), bil(nan.astype(float)) > 0


def fast_march(k, wet, seeds, seed_phi, dx):
    """First-order fast marching for |grad phi| = k on wet cells. seeds: boolean array; seed_phi: phi there."""
    ny, nx = k.shape
    phi = np.full(k.shape, np.inf)
    done = np.zeros(k.shape, bool)
    heap = []
    for j, i in zip(*np.nonzero(seeds & wet)):
        phi[j, i] = seed_phi[j, i]; heapq.heappush(heap, (phi[j, i], j, i))
    def update(j, i):
        ax = min(phi[j, i - 1] if i > 0 else np.inf, phi[j, i + 1] if i < nx - 1 else np.inf)
        ay = min(phi[j - 1, i] if j > 0 else np.inf, phi[j + 1, i] if j < ny - 1 else np.inf)
        s = k[j, i] * dx
        if np.isfinite(ax) and np.isfinite(ay) and abs(ax - ay) < s:
            return 0.5 * (ax + ay + np.sqrt(2 * s * s - (ax - ay) ** 2))
        return min(ax, ay) + s
    while heap:
        p, j, i = heapq.heappop(heap)
        if done[j, i]:
            continue
        done[j, i] = True
        for jj, ii in ((j - 1, i), (j + 1, i), (j, i - 1), (j, i + 1)):
            if 0 <= jj < ny and 0 <= ii < nx and wet[jj, ii] and not done[jj, ii]:
                v = update(jj, ii)
                if v < phi[jj, ii]:
                    phi[jj, ii] = v; heapq.heappush(heap, (v, jj, ii))
    return phi


_BEDS = {}
BED_NPZ = HERE / "data" / "bed_grid_porto_batel.npz"   # load_bed() output saved by `stage_a.py --save-bed`, for machines without the raw lidar
def bed_grid(site=None):
    """The bed is the same for every run: load it once per process and site. Porto Batel: from the raw lidar when it is
    here (source of truth), else from the saved grid (bit-identical, checked by --save-bed). The saved grid lets a CI job
    run Stage A. Other sites: their saved grid (built from their raw lidar by the site's own script, e.g.
    pieces/05-pipeline/make_bed_grid.py), in the grid's own (possibly rotated) frame."""
    site = site or PB
    key = site["key"]
    if key not in _BEDS:
        if site["bed"][0] == "porto_batel_lidar" and NC.exists():
            _BEDS[key] = load_bed()
        else:
            z = np.load(site["bed_npz"])
            _BEDS[key] = (z["x"], z["y"], z["bed"], z["filled"])
    return _BEDS[key]


def _bil(A, fy, fx):
    j0 = int(np.clip(np.floor(fy), 0, A.shape[0] - 2)); i0 = int(np.clip(np.floor(fx), 0, A.shape[1] - 2))
    ty, tx = fy - j0, fx - i0
    return (1 - ty) * ((1 - tx) * A[j0, i0] + tx * A[j0, i0 + 1]) + ty * ((1 - tx) * A[j0 + 1, i0] + tx * A[j0 + 1, i0 + 1])


def phase_part(tp, direction, tide_lat, site=None):
    """Everything that does not depend on the wave height. crest_lines.py body, then height_break_peel.py up to H_lin.
    direction is the compass bearing the swell comes FROM; on a rotated grid it is turned into the grid's frame."""
    site = site or PB
    x, y, bed, filled = bed_grid(site)
    X, Y = np.meshgrid(x, y)
    h = tide_lat - bed
    wet0 = h > 0.05
    k = np.full(h.shape, np.nan)
    k[wet0] = wavenumber(tp, h[wet0])
    to = np.radians(direction + 180.0 - site["grid_deg"])   # Porto Batel: grid_deg 0.0, so the same float as before
    d = np.array([np.sin(to), np.cos(to)])
    edge = np.zeros(h.shape, bool)
    edge[0, :] = d[1] > 0.05
    edge[-1, :] = d[1] < -0.05
    edge[:, 0] = d[0] > 0.05
    edge[:, -1] = d[0] < -0.05
    seeds = edge & wet0 & (h > 1.0)
    if not seeds.any():
        return None
    k_ref = float(np.nanmean(k[seeds]))
    seed_phi = k_ref * (X * d[0] + Y * d[1])
    seed_phi -= seed_phi[seeds].min()
    phi = fast_march(np.nan_to_num(k, nan=1.0), wet0, seeds, seed_phi, DX)
    phi[~np.isfinite(phi) | ~wet0] = np.nan
    # crest_lines.py saves phi as float64 .npy and height_break_peel.py reloads it: no precision change here.

    # ---- height_break_peel.py, H0-independent part
    dx = float(x[1] - x[0])
    wet = np.isfinite(phi)
    w = 2 * np.pi / tp
    kk = np.where(wet, k, np.nan)
    c = w / kk
    with np.errstate(invalid="ignore", divide="ignore"):
        Cg = 0.5 * c * (1 + 2 * kk * h / np.sinh(2 * kk * np.maximum(h, 1e-3)))
    Cg0 = float(np.nanmedian(Cg[seeds]))
    Ks = np.sqrt(Cg0 / Cg)
    idx = ndi.distance_transform_edt(~wet, return_distances=False, return_indices=True)
    ps = ndi.gaussian_filter(phi[tuple(idx)], SMOOTH)
    gy, gx = np.gradient(ps, dx); gm = np.hypot(gx, gy) + 1e-12
    sx, sy = gx / gm, gy / gm
    div = np.gradient(sx, dx, axis=1) + np.gradient(sy, dx, axis=0)
    lnb = np.zeros(h.shape)
    order = np.argsort(np.where(wet, phi, np.inf), axis=None)
    n_wet = int(wet.sum())
    ny, nx = h.shape
    for flat in order[:n_wet]:
        j, i = divmod(int(flat), nx)
        if seeds[j, i]:
            continue
        fy, fx = j - sy[j, i], i - sx[j, i]
        if 0 <= fy <= ny - 1 and 0 <= fx <= nx - 1:
            up = _bil(lnb, fy, fx)
        else:
            up = 0.0
        lnb[j, i] = up + div[j, i] * dx
    Kr = np.exp(-0.5 * np.clip(lnb, -3, 3))
    Kr = np.clip(Kr, 0.3, 2.5)
    A = Ks * Kr                                   # H_lin = H0 * A
    return dict(x=x, y=y, h=h, wet=wet, sx=sx, sy=sy, c=c, A=A, Ks=Ks, dx=dx, n_wet=n_wet,
                kr_clipped=int(((Kr <= 0.3001) | (Kr >= 2.4999))[wet].sum()), tp=tp, direction=direction, tide_lat=tide_lat,
                seeds=seeds, site=site)


def _profile_cells(P):
    """Cell indices visited along each profile (same stepping as height_break_peel.py: s = 0..698 every 2 m; a site may
    set a longer s_max). Line and offset bearings are compass bearings, turned into the grid frame by grid_deg."""
    x, y, dx = P["x"], P["y"], P["dx"]
    site = P.get("site") or PB
    s = np.arange(0, site["s_max"], 2.0)
    L, A = site["line_deg"] - site["grid_deg"], site["along_deg"] - site["grid_deg"]   # Porto Batel: 236.0, 326.0 exactly
    out = []
    for off in site["profile_offsets"]:
        e = s * np.sin(np.radians(L)) + off * np.sin(np.radians(A))
        n = s * np.cos(np.radians(L)) + off * np.cos(np.radians(A))
        i = np.rint((e - x[0]) / dx).astype(int); j = np.rint((n - y[0]) / dx).astype(int)
        out.append((s, i, j))
    return out
# note: height_break_peel.py uses int(round(...)) per point; np.rint and round() both round half to even.


def water_edge(tide_lat, P=None, site=None):
    """Bed only, no wave physics: per profile, the distance s of the first dry cell (h <= 0.05 m) met walking shoreward
    from the seaward end (None if none). A break within one cell of it is at the water's edge, not on the reef."""
    site = site or (P.get("site") if P else None) or PB
    x, y, bed, _ = bed_grid(site)
    P = P or dict(x=x, y=y, dx=float(x[1] - x[0]), site=site)
    h = tide_lat - bed
    ny, nx = bed.shape
    out = []
    for s, i, j in _profile_cells(P):
        edge = None
        for q in range(len(s) - 1, -1, -1):
            if 0 <= i[q] < nx and 0 <= j[q] < ny and h[j[q], i[q]] <= 0.05:
                edge = float(s[q]); break
        out.append(edge)
    return out


EDGE_M = 10.0   # one cell: same threshold as the viewer (live_lookup.js EDGE_M)


def house_state(r, tide_lat, site=None):
    """'reef' | 'edge' | 'off-house' | 'none' for one run_stage_a result (same wording rules as the viewer)."""
    if r is None:
        return "none"
    if not np.isfinite(r["break_house"]):
        return "off-house" if r["n_broken"] > 0 else "none"
    site = site or PB
    e = water_edge(tide_lat, site=site)[len(site["profile_offsets"]) // 2]
    return "edge" if e is not None and r["break_house"] - e <= EDGE_M else "reef"


def height_part(P, hs):
    """Breaking for one H0 on a phase_part result. Returns per-profile and summary outputs."""
    h, wet, sx, sy, c, x, y, dx = P["h"], P["wet"], P["sx"], P["sy"], P["c"], P["x"], P["y"], P["dx"]
    H_lin = hs * P["A"]
    with np.errstate(invalid="ignore"):
        ratio = H_lin / np.maximum(h, 1e-3)
        broken = wet & (ratio >= GAMMA) & (h > 0.05)
    rs = ndi.gaussian_filter(np.where(wet, ratio, 0.0), 1.5)
    ry, rx = np.gradient(rs, dx); rm = np.hypot(rx, ry) + 1e-12
    bl = broken & ~ndi.binary_erosion(broken, iterations=1)
    bl &= (ndi.binary_dilation(~broken & wet, iterations=1))
    cos_t = np.abs(sx * rx + sy * ry) / rm
    theta = np.degrees(np.arccos(np.clip(cos_t, 0, 1)))
    with np.errstate(invalid="ignore"):
        peel_speed = c / np.maximum(np.sin(np.radians(theta)), 0.05)

    if "_prof" not in P:
        P["_prof"] = _profile_cells(P)
    ny, nx = h.shape
    offsets = (P.get("site") or PB)["profile_offsets"]
    nprof = len(offsets)
    s_brk = np.full(nprof, np.nan); hb = np.full(nprof, np.nan); db = np.full(nprof, np.nan)
    pa = np.full(nprof, np.nan); ps = np.full(nprof, np.nan)
    for p, (s, i, j) in enumerate(P["_prof"]):
        inside = (i >= 0) & (i < nx) & (j >= 0) & (j < ny)
        ii, jj = np.where(inside, i, 0), np.where(inside, j, 0)
        with np.errstate(invalid="ignore"):
            hit = inside & wet[jj, ii] & (ratio[jj, ii] >= GAMMA)
        if hit.any():
            q = np.nonzero(hit)[0][-1]                       # largest s: seaward-most broken cell
            jq, iq = jj[q], ii[q]
            s_brk[p] = s[q]; hb[p] = H_lin[jq, iq]; db[p] = h[jq, iq]
            pa[p] = theta[jq, iq]; ps[p] = peel_speed[jq, iq]
    near = (np.hypot(*np.meshgrid(x, y)) < 250) & bl
    med = lambda a, m: float(np.median(a[m])) if m.any() else np.nan
    return dict(
        profile_offsets=offsets, break_s=s_brk, breaker_H=hb, breaker_depth=db, peel_angle=pa, peel_speed=ps,
        break_house=float(s_brk[np.argmin(np.abs(offsets))]),
        peel_angle_near=med(theta, near), peel_speed_near=med(peel_speed, near),
        peel_angle_line=med(theta, bl), peel_speed_line=med(peel_speed, bl),
        n_broken=int(broken.sum()), n_break_line=int(bl.sum()), kr_clipped=P["kr_clipped"],
        H_max=float(np.nanmax(np.where(broken, GAMMA * h, H_lin)[wet])),
    )


def run_stage_a(hs, tp, direction, tide_lat, site=None):
    """One sea state over a site's reef (default Porto Batel). hs = H0 at the domain's upwind edge (m), tp (s), direction
    FROM (deg), tide_lat = still-water level above the site's datum (Porto Batel: LAT; Pipeline: LMSL), in m.
    Returns height_part's dict; break_house is NaN if no break on the reference line."""
    P = phase_part(tp, direction, tide_lat, site)
    if P is None:
        return None
    return height_part(P, hs)


def house_break_reference(P, hs):
    """height_break_peel.py's own `along()` loop, verbatim stepping, for the regression check."""
    h, wet, x, y, dx = P["h"], P["wet"], P["x"], P["y"], P["dx"]
    ratio = hs * P["A"] / np.maximum(h, 1e-3)
    out = None
    for s in np.arange(0, 700, 2.0):
        e = s * np.sin(np.radians(236)); n = s * np.cos(np.radians(236))
        i = int(round((e - x[0]) / dx)); j = int(round((n - y[0]) / dx))
        if not (0 <= i < len(x) and 0 <= j < len(y)) or not wet[j, i]:
            continue
        if ratio[j, i] >= GAMMA:
            out = s
    return out


if __name__ == "__main__":
    import sys
    if "--save-bed" in sys.argv:
        x, y, bed, filled = load_bed()
        BED_NPZ.parent.mkdir(exist_ok=True)
        np.savez_compressed(BED_NPZ, x=x, y=y, bed=bed, filled=filled)
        z = np.load(BED_NPZ)
        same = all(np.array_equal(a, z[k], equal_nan=True) for a, k in ((x, "x"), (y, "y"), (bed, "bed"), (filled, "filled")))
        print(f"saved {BED_NPZ.name} ({BED_NPZ.stat().st_size/1024:.0f} KB), identical to load_bed(): {same}")
        sys.exit(0)
    assert (PB["half"], PB["dx"], PB["line_deg"], PB["along_deg"], PB["grid_deg"], PB["origin_lat"], PB["origin_lon"]) == \
        (HALF, DX, LINE_DEG, ALONG_DEG, 0.0, HOUSE_LAT, HOUSE_LON) and np.array_equal(PB["profile_offsets"], PROFILE_OFFSETS)
    bed_grid()
    expect = {0.5: 204, 1.0: 198, 1.5: 168, 2.1: 152, 2.5: 152, 3.0: 134}
    for tide, ref in expect.items():
        t0 = time.perf_counter(); P = phase_part(13.0, 325.0, tide); t1 = time.perf_counter()
        r = height_part(P, 1.5); t2 = time.perf_counter()
        print(f"tide {tide}: house-line break {r['break_house']:.0f} m (reference loop {house_break_reference(P, 1.5)}, "
              f"RESULTS {ref}); offsets -200..200 {[r['break_s'][list(PROFILE_OFFSETS).index(o)] for o in (-200, -100, 0, 100, 200)]}; "
              f"peel line {r['peel_angle_line']:.0f} deg; phase {t1-t0:.2f} s, height {t2-t1:.3f} s", flush=True)
