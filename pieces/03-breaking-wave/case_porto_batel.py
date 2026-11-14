"""case_porto_batel: regular swell breaking on the real Porto Batel reef profile (2D slice).

ILLUSTRATIVE: one straight 2D line through the 2011 lidar (11 x 14 m grid, bilinear between
cell centres), so refraction, alongshore variation, the paddle-out channel through the shelf and
anything smaller than about one grid cell are not in it.

Coordinates inside the solver: x = metres from the wavemaker toward the house
(x = S_PISTON - distance_from_house), z = metres above the still water level (the tide).
Height above LAT = z + TIDE_ABOVE_LAT.
"""
import math
from pathlib import Path

import numpy as np

from geometry import polyline_wall, dedupe

G = 9.81
HERE = Path(__file__).resolve().parent

CFG = dict(
    name="porto_batel",
    tide_above_lat=2.10,     # m above LAT
    H=2.7,                   # target incident wave height (m)
    T=7.8,                   # wave period (s)
    s_piston=390.0,          # wavemaker position, distance from the house (m); a local low in the
                             # lidar (6.0 m below LAT, 8.1 m of water at this tide)
    stroke_factor=0.958,     # 2026-11-14 (session 7, h_over_dp 1.7 / n_layers 4, out/calib_s7/): H = 2.72 m,
                             # waves 2-4, gauges 10-25 m. Was 0.983 (session 6 numerics, below):
                             # wavemaker stroke / linear-theory stroke. Calibrated 2026-11-13
                             # (session 6, calib_wavemaker.py, out/calib_s6/): H = 2.68 m, waves
                             # 2-4, gauges 10-25 m from the paddle. Was 1.12 (over-corrected for
                             # damping; gave 3.08 m at the same gauges) until 2026-11-13, session 6.
    s_shore=40.0,            # shoreward end of the model, distance from the house (m): the drain
                             # line (particle sink) when shore_outflow is on, else a closed wall
    shore_outflow=1.0,       # 1: no end wall; bed continues to s_bed_end and water crossing s_shore
                             # is removed (session 6, 2026-11-13). 0: old closed wall at s_shore.
    s_bed_end=34.0,          # with the outflow: the lidar bed continues to here (m from the house)
    n_ramp_up=1.0,           # wavemaker ramp-up (periods)
    n_full=3.0,              # full-stroke periods
    n_ramp_down=1.0,         # ramp-down (periods)
    sat_here_m=115.0,        # where the owner sat (label only)
    rho0=1000.0,
    c0_factor=10.0,          # c0 = c0_factor * sqrt(g (h_gen + H))
    h_over_dp=1.7,           # was 1.3 until 2026-11-14 (session 7): too few neighbours for the
                             # Wendland kernel, ~30-35 % wave energy lost over 200 m (energy_s6/FINDINGS.md)
    alpha=0.01,
    delta=0.1,
    cfl=0.2,
    n_layers=4,              # was 3 until 2026-11-14 (session 7): kernel reach 2h = 3.4 dp needs 4 wall layers
    t_end=78.0,
    dt_out=0.1,
    t_settle=4.0,
    settle_tau=0.3,
    h0=None,                 # filled in (depth at the wavemaker)
)

_prof = None


def profile():
    global _prof
    if _prof is None:
        d = np.genfromtxt(HERE / "data" / "porto_batel_profile_236.csv", delimiter=",", names=True)
        _prof = (d["distance_from_house_m"].astype(float), d["bed_above_LAT_m"].astype(float))
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
