"""case_hossegor: regular swell breaking on the Hossegor / La Graviere, France profile (2D slice). ILLUSTRATIVE, NOT A FORECAST.

Built from case_porto_batel.py (same solver set-up and numerics: h_over_dp 1.7, n_layers 4, shoreward
outflow); only the profile, the swell and the tide differ. One straight 2D line through the lidar along
the local wave direction at the take-off (pieces/02-reefs/simulate_swell_spot.py writes the profile), so
refraction, alongshore variation and anything smaller than a grid cell are not in it.
Swell: Open-Meteo Marine hindcast, 43.45 N 1.70 W, Nov-Mar 2024-26 median swell (1.58 m, 13.5 s, 305 deg).
Coordinates: s = distance along the line from a "profile origin" 60 m landward of the shoreline (so the
Porto Batel tools, which work in s = 60-340 m, apply unchanged); s = 60 is the shoreline at this tide.
Solver x = S_PISTON - s, z = metres above still water. Height above IGN69 = z + tide_above_lat (the key
keeps its Porto Batel name; here it is the tide above IGN69).
"""
import math
from pathlib import Path

import numpy as np

from geometry import polyline_wall, dedupe

G = 9.81
HERE = Path(__file__).resolve().parent

CFG = dict(
    name="hossegor",
    tide_above_lat=0.0,       # m above IGN69 (~ mean sea level on this coast, within ~0.2 m)
    H=1.6,                   # target incident wave height (m), the spot's typical winter swell
    T=13.5,                  # wave period (s)
    s_piston=535.0,           # wavemaker 475 m seaward of the shoreline (s = 60 + 475); 8.1 m of water, seaward of the outer bar (crest ~6.0 m at 350-360 m out). Long domain: spot_run.py widens the tool window to s 60-515
    stroke_factor=0.976,       # wavemaker stroke / linear-theory stroke (calibrated: see out/calib_hossegor/)
    s_shore=50.0,            # drain line (particle sink), 10 m landward of the shoreline
    shore_outflow=1.0,
    s_bed_end=44.0,          # the lidar bed continues to here
    n_ramp_up=1.0,
    n_full=3.0,
    n_ramp_down=1.0,
    sat_here_m=159.0,         # take-off marker (label only): published La Graviere position (approx.), 99 m from the shoreline
    rho0=1000.0,
    c0_factor=10.0,
    h_over_dp=1.7,           # corrected numerics (session 7)
    alpha=0.01,
    delta=0.1,
    cfl=0.2,
    n_layers=4,              # corrected numerics (session 7)
    t_end=100.0,
    dt_out=0.1,
    t_settle=4.0,
    settle_tau=0.3,
    h0=None,
)
S_OFFSET = 60.0              # profile origin is this far landward of the shoreline


_prof = None


def profile():
    global _prof
    if _prof is None:
        d = np.genfromtxt(HERE / "data" / "hossegor_profile.csv", delimiter=",", names=True)
        s = d["distance_from_shore_m"].astype(float) + S_OFFSET
        o = np.argsort(s)
        _prof = (s[o], d["bed_above_datum_m"].astype(float)[o])
    return _prof


def s_of_x(x, c=CFG):
    return c["s_piston"] - np.asarray(x, float)


def bed_z(x, c=CFG):
    """Bed elevation above still water at solver x (flat behind the wavemaker)."""
    s, zl = profile()
    sx = np.clip(s_of_x(x, c), s[0], c["s_piston"])
    return np.interp(sx, s, zl) - c["tide_above_lat"]


def dispersion_k(T, h):
    w = 2 * math.pi / T
    k = w * w / G
    for _ in range(100):
        k = w * w / (G * math.tanh(k * h))
    return k


def piston_stroke(H, T, h):
    """Linear full-stroke S for a piston wavemaker (Biesel transfer function)."""
    k = dispersion_k(T, h)
    kh = k * h
    ratio = 2 * (math.cosh(2 * kh) - 1) / (math.sinh(2 * kh) + 2 * kh)
    return H / ratio, k


def piston_motion_factory(c):
    h = -float(bed_z(0.0, c))
    S, k = piston_stroke(c["H"], c["T"], h)
    S *= c.get("stroke_factor", 1.0)
    w = 2 * math.pi / c["T"]
    t1 = c["n_ramp_up"] * c["T"]
    t2 = t1 + c["n_full"] * c["T"]
    t3 = t2 + c["n_ramp_down"] * c["T"]

    def env(t):
        if t <= 0:
            return 0.0
        if t < t1:
            return 0.5 - 0.5 * math.cos(math.pi * t / t1)
        if t < t2:
            return 1.0
        if t < t3:
            return 0.5 + 0.5 * math.cos(math.pi * (t - t2) / (t3 - t2))
        return 0.0

    def X(t):
        return 0.5 * S * env(t) * math.sin(w * t)

    def motion(t):
        e = 1e-4
        x0, xp, xm = X(t), X(t + e), X(t - e)
        return x0, (xp - xm) / (2 * e), (xp - 2 * x0 + xm) / (e * e)
    return motion, dict(stroke=S, k=k, h_gen=h, L=2 * math.pi / k, t_motion_end=t3)


def build(dp, c=CFG, still=True):
    nl = c["n_layers"]
    s, zl = profile()
    x_end = c["s_piston"] - c["s_shore"]
    outflow = bool(c.get("shore_outflow", 0))
    x_bed = c["s_piston"] - c["s_bed_end"] if outflow else x_end
    h_gen = -float(bed_z(0.0, c))
    c["h0"] = h_gen
    S, k = piston_stroke(c["H"], c["T"], h_gen)
    S *= c.get("stroke_factor", 1.0)
    # ---- bed polyline: flat behind the wavemaker (assumed, only under the paddle), then lidar
    x_back = -(0.5 * S + nl * dp + 1.0)
    xs_l = np.arange(0.0, x_bed + 1e-9, 1.0)
    px = np.concatenate([[x_back], xs_l])
    pz = np.concatenate([[bed_z(0.0, c)], bed_z(xs_l, c)])
    bx, bz = polyline_wall(px, pz, dp, nl)
    # shoreward end wall (only without the outflow; with it the end is a drain line, see run_porto_batel.py)
    ztop = 8.0
    zb_end = float(bed_z(x_bed, c))
    zw = zb_end + (np.arange(int((ztop - zb_end) / dp)) + 0.5) * dp
    for kk in range(nl if not outflow else 0):
        bx = np.append(bx, np.full_like(zw, x_bed + (kk + 0.5) * dp))
        bz = np.append(bz, zw)
    bx, bz = dedupe(bx, bz, dp)
    # ---- piston (moving wall particles), listed last
    zp = float(bed_z(0.0, c)) + (np.arange(int((h_gen + 5.0) / dp)) + 0.5) * dp
    pxs, pzs = [], []
    for kk in range(nl):
        pxs.append(np.full_like(zp, -(kk + 0.5) * dp))
        pzs.append(zp)
    pxs = np.concatenate(pxs)
    pzs = np.concatenate(pzs)
    # ---- still water on a lattice
    xs = (np.arange(int(x_end / dp)) + 0.5) * dp
    zmin = float(np.min(pz))
    zs = zmin + (np.arange(int(-zmin / dp) + 1) + 0.5) * dp
    zs = zs[zs < 0]
    X, Z = np.meshgrid(xs, zs, indexing="ij")
    X = X.ravel()
    Z = Z.ravel()
    zb = bed_z(X, c)
    slope = np.gradient(bed_z(xs, c), dp)
    cos_t = 1.0 / np.sqrt(1.0 + np.interp(X, xs, slope) ** 2)
    keep = (Z < 0) & ((Z - zb) * cos_t >= 0.5 * dp * 0.999)   # (no still water near x_end: bed > tide there)
    xf, zf = X[keep], Z[keep]
    # c0_H (session 7, 2026-11-14): optional wave height used only for the sound speed, so a smaller-wave run
    # (s8, H 1.5 m) keeps the same c0, time step and artificial viscosity as the H 2.7 m run. Default: H.
    c0 = c["c0_factor"] * math.sqrt(G * (h_gen + c.get("c0_H", c["H"])))
    B = c["rho0"] * c0 * c0 / 7.0
    rhof = c["rho0"] * (1.0 + c["rho0"] * G * (-zf) / B) ** (1.0 / 7.0)
    uf = np.zeros_like(xf)
    wf = np.zeros_like(xf)
    bx_all = np.concatenate([bx, pxs])
    bz_all = np.concatenate([bz, pzs])
    n_piston = pxs.size
    domain = (x_back - 0.5, x_bed + nl * dp + 0.5, zmin - nl * dp - 0.5, 9.0)
    info = dict(H=c["H"], T=c["T"], h_gen=h_gen, stroke=S, k=k, L=2 * math.pi / k, c0=c0,
                x_end=x_end, x_bed_end=x_bed, shore_outflow=outflow, x_sink=x_end if outflow else None,
                n_piston=n_piston, x_back=x_back,
                ursell_at_gen=c["H"] * (2 * math.pi / k) ** 2 / h_gen ** 3)
    return xf, zf, uf, wf, rhof, bx_all, bz_all, c0, domain, info
