"""The 2D breaking-wave case, shared by every spot: bed profile, wavemaker and the starting particles.

A "case" is one straight 2D line through a spot's lidar, a wavemaker (piston) at its seaward end, and still water
above the bed. What differs between spots is only the settings (CFG: tide, wave height and period, where the
wavemaker stands, run length) and the bed profile along the line. Everything else is the code below, which was
case_porto_batel.py's own functions until 2026-11-27, moved here unchanged so the other spots use the same code
instead of a text copy of it.

    case = SliceCase(CFG, load_profile)    load_profile() -> (s, bed height above datum), s ascending
    case.profile(), case.bed_z(x), case.build(dp), case.piston_motion_factory(cfg)

Coordinates inside the solver: x = metres from the wavemaker toward the shore (x = s_piston - s), z = metres above
the still water level (the tide). Height above the map datum = z + tide_above_lat (the key keeps its Porto Batel name).

What to understand: CFG and profile(). bed_z, piston_stroke (the Biesel wavemaker formula) and build are worth a read;
the particle layout inside build is plumbing.
"""
import math

import numpy as np

from geometry import polyline_wall, dedupe

G = 9.81


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


class SliceCase:
    """One spot's case. CFG is the settings dict (the same object the functions use when no c is given);
    load_profile is called once, on first use, and returns (s, bed height above datum)."""

    def __init__(self, cfg, load_profile):
        self.CFG = cfg
        self._load_profile = load_profile
        self._prof = None

    def names(self):
        """What a case module offers the tools (run_porto_batel.py, render_porto_batel.py, ...)."""
        return dict(CFG=self.CFG, profile=self.profile, s_of_x=self.s_of_x, bed_z=self.bed_z,
                    piston_motion_factory=self.piston_motion_factory, build=self.build,
                    dispersion_k=dispersion_k, piston_stroke=piston_stroke, G=G)

    def profile(self):
        if self._prof is None:
            self._prof = self._load_profile()
        return self._prof

    def s_of_x(self, x, c=None):
        c = self.CFG if c is None else c
        return c["s_piston"] - np.asarray(x, float)

    def bed_z(self, x, c=None):
        """Bed elevation above still water at solver x (flat behind the wavemaker)."""
        c = self.CFG if c is None else c
        s, zl = self.profile()
        sx = np.clip(self.s_of_x(x, c), s[0], c["s_piston"])
        return np.interp(sx, s, zl) - c["tide_above_lat"]

    def piston_motion_factory(self, c):
        h = -float(self.bed_z(0.0, c))
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

    def build(self, dp, c=None, still=True):
        c = self.CFG if c is None else c
        bed_z = self.bed_z
        nl = c["n_layers"]
        s, zl = self.profile()
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
