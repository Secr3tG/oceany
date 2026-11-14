"""Diagnostics for the flume validation case.

    python -I diagnostics.py out/flume_r40

Writes <run>/diagnostics.json and prints a table of measured values vs literature.
Definitions (all from the particle snapshots, dt_out = 0.01 s):
* crest: highest point of the upper free-surface envelope (bin width 2 dp), refined by a
  parabola fit over +-0.15 m.
* vertical front: first snapshot in which the front face x_f(z) (most shoreward particle
  per dp height bin, smoothed over 3 bins) has dx_f/dz >= 0 between 30 % and 90 % of the
  crest elevation, i.e. a vertical tangent on the front face.
  x_b = crest position at that instant, h_b = still-water depth there, H_b = crest elevation
  above the still water line.
* overturning: occupancy grid (cell = dp, fluid + solid occupied, one-cell dilation). A
  column with water of the main body above an air gap of >= 2 cells above more water =
  multi-valued free surface.
* jet touchdown: first instant after overturning with an enclosed air pocket (air region not
  connected to the open atmosphere) of >= 10 cells.
* energy: kinetic + potential + Tait internal energy of all fluid particles; drift is
  relative to the solitary-wave energy (KE(0) + 1/2 rho g int eta^2 dx).
* runup: highest fluid particle within 2 dp (normal distance) of the slope.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi
from scipy.spatial import cKDTree

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import case_flume  # noqa: E402

G = 9.81


def load(run):
    run = Path(run)
    meta = json.loads((run / "meta.json").read_text())
    files = sorted(run.glob("snap_*.npz"))
    walls = np.load(run / "walls.npz")
    return run, meta, files, walls


def envelope(x, z, dp, x0=-0.1, x1=None):
    bw = 2 * dp
    x1 = x1 if x1 is not None else x.max() + bw
    nb = int((x1 - x0) / bw) + 1
    ib = ((x - x0) / bw).astype(int)
    ok = (ib >= 0) & (ib < nb)
    top = np.full(nb, -np.inf)
    np.maximum.at(top, ib[ok], z[ok])
    xc = x0 + (np.arange(nb) + 0.5) * bw
    return xc, top


def crest(x, z, dp, xmax=None, V=None, h=None):
    """Crest position and elevation.

    With V (particle volumes) and h, the elevation is the level where the SPH colour
    function sum_j V_j W(r) drops to 0.5 (the free surface sits about half a particle
    spacing above the top particle centres); otherwise the top particle centre is used.
    """
    xc, top = envelope(x, z, dp)
    if xmax is not None:
        top = np.where(xc <= xmax, top, -np.inf)
    k = int(np.argmax(top))
    if V is None:
        return xc[k], top[k]
    tree = cKDTree(np.c_[x, z])
    ad = 7.0 / (4.0 * math.pi * h * h)
    xq = xc[k] + np.arange(-0.15, 0.15 + 1e-9, dp)
    zq = top[k] + 2 * h - np.arange(0, 6 * h, dp / 4)
    XQ, ZQ = np.meshgrid(xq, zq, indexing="ij")
    pts = np.c_[XQ.ravel(), ZQ.ravel()]
    nb = tree.query_ball_point(pts, 2 * h)
    col = np.zeros(len(pts))
    for i, js in enumerate(nb):
        if js:
            js = np.asarray(js)
            q = np.hypot(x[js] - pts[i, 0], z[js] - pts[i, 1]) / h
            t = 1 - 0.5 * q
            col[i] = np.sum(V[js] * ad * t ** 4 * (2 * q + 1))
    col = col.reshape(XQ.shape)
    eta = np.full(xq.size, -np.inf)
    for i in range(xq.size):
        wet = np.where(col[i] >= 0.5)[0]
        if wet.size:
            j = wet[0]                       # highest level with colour >= 0.5 (zq descending)
            if j > 0:                        # linear interpolation to the 0.5 crossing
                c1, c2 = col[i, j - 1], col[i, j]
                eta[i] = zq[j - 1] + (zq[j] - zq[j - 1]) * (0.5 - c1) / (c2 - c1)
            else:
                eta[i] = zq[0]
    if not np.isfinite(eta).any():
        return xc[k], top[k]
    i = int(np.argmax(eta))
    return xq[i], eta[i]


def front_face(x, z, dp, xcr, zcr):
    """Return (vertical?, max face angle in deg, z of vertical point, x of it)."""
    bz = dp
    sel = (x > xcr - 0.15) & (x < xcr + 0.8)
    xs, zs = x[sel], z[sel]
    zlo, zhi = 0.3 * zcr, 0.9 * zcr
    edges = np.arange(zlo, zhi + bz, bz)
    if edges.size < 5:
        return False, np.nan, np.nan, np.nan
    xf = np.full(edges.size - 1, np.nan)
    for i in range(edges.size - 1):
        m = (zs >= edges[i]) & (zs < edges[i + 1])
        if m.any():
            xf[i] = xs[m].max()
    good = ~np.isnan(xf)
    if good.sum() < 0.7 * xf.size or good.sum() < 5:
        return False, np.nan, np.nan, np.nan
    idx = np.arange(xf.size)
    xf = np.interp(idx, idx[good], xf[good])
    xs3 = np.convolve(xf, np.ones(3) / 3, mode="valid")
    zc = 0.5 * (edges[:-1] + edges[1:])[1:-1]
    dxdz = np.diff(xs3) / bz
    # face angle measured from horizontal on the front side: 90 deg when dx/dz = 0
    ang = np.degrees(np.arctan2(1.0, -dxdz))
    k = int(np.argmax(ang))
    return bool(dxdz[k] >= 0.0), float(ang[k]), float(zc[k]), float(xs3[k])


def occupancy(x, z, wx, wz, dp, cfg, box, bedfun=None):
    x0, x1, z0, z1 = box
    nx = int((x1 - x0) / dp) + 1
    nz = int((z1 - z0) / dp) + 1
    occ = np.zeros((nx, nz), bool)
    for xx, zz in ((x, z), (wx, wz)):
        i = ((xx - x0) / dp).astype(int)
        j = ((zz - z0) / dp).astype(int)
        ok = (i >= 0) & (i < nx) & (j >= 0) & (j < nz)
        occ[i[ok], j[ok]] = True
    fl = np.zeros_like(occ)
    i = ((x - x0) / dp).astype(int)
    j = ((z - z0) / dp).astype(int)
    ok = (i >= 0) & (i < nx) & (j >= 0) & (j < nz)
    fl[i[ok], j[ok]] = True
    xc = x0 + (np.arange(nx) + 0.5) * dp
    zc = z0 + (np.arange(nz) + 0.5) * dp
    bedfun = bedfun or case_flume.bed_z
    solid = zc[None, :] < bedfun(xc, cfg)[:, None]
    occ |= solid
    occ = ndi.binary_dilation(occ, structure=np.ones((3, 3), bool))
    fl = ndi.binary_dilation(fl, structure=np.ones((3, 3), bool)) & ~solid
    return occ, fl, solid, xc, zc


def overturn_and_cavity(x, z, wx, wz, dp, cfg, box, bedfun=None, min_cav=10):
    occ, fl, solid, xc, zc = occupancy(x, z, wx, wz, dp, cfg, box, bedfun)
    lab, n = ndi.label(fl)
    if n == 0:
        return False, 0, np.nan
    sizes = ndi.sum(np.ones_like(lab), lab, index=np.arange(1, n + 1))
    main = lab == (int(np.argmax(sizes)) + 1)
    # multivalued surface: main-body water above an air gap >= 2 cells above water/solid
    over = False
    x_over = np.nan
    for i in range(occ.shape[0]):
        col = occ[i]
        if not main[i].any():
            continue
        top_main = np.where(main[i])[0].max()
        # walk down from the top main cell
        j = top_main
        while j >= 0 and occ[i, j]:
            j -= 1
        upper_thick = top_main - j
        gap = 0
        while j >= 0 and not occ[i, j]:
            gap += 1
            j -= 1
        if j >= 0 and gap >= 2 and upper_thick >= 2 and main[i, top_main]:
            over = True
            x_over = xc[i]
            break
    # enclosed air: empty regions not connected to the grid top
    air = ~occ
    alab, an = ndi.label(air)
    open_ids = set(np.unique(alab[:, -1])) | set(np.unique(alab[0, :])) | set(np.unique(alab[-1, :]))
    open_ids.discard(0)
    cav = 0
    if an:
        asz = ndi.sum(np.ones_like(alab), alab, index=np.arange(1, an + 1))
        for idx in range(1, an + 1):
            if idx not in open_ids and asz[idx - 1] >= min_cav:
                cav = max(cav, int(asz[idx - 1]))
    return over, cav, x_over


def tait_e(rho, rho0, B, gam=7.0):
    r = rho / rho0
    return (B / rho0) * ((r ** (gam - 1) - 1) / (gam - 1) + (1.0 / r - 1.0))


def main(run):
    run, meta, files, walls = load(run)
    cfg = meta["cfg"]
    dp, m, B, rho0 = meta["dp"], meta["mass"], meta["B"], cfg["rho0"]
    h0 = cfg["h0"]
    H = cfg["H_over_h0"] * h0
    c_th = math.sqrt(G * (h0 + H))
    wx, wz = walls["x"].astype(float), walls["z"].astype(float)
    mp = Path(run) / "mass.npy"
    if mp.exists():
        m = np.load(mp).astype(float)
    x_toe, s = cfg["x_toe"], cfg["slope"]
    x_sl = x_toe + h0 / s
    cents = []
    ts, xcs, zcs, E, KE, PE, IE, runup, leak, angs = [], [], [], [], [], [], [], [], [], []
    rho_min, rho_max = 1e9, 0
    t_b = None
    rec_b = None
    t_over = None
    x_over = None
    t_touch = None
    cav_hist = []
    over_hist = []
    box = (x_toe, x_sl + 3.5, -h0 - 0.05, 0.6)
    eta0 = None
    for f in files:
        d = np.load(f)
        t = float(d["t"])
        x, z = d["x"].astype(float), d["z"].astype(float)
        u, w, rho = d["u"].astype(float), d["w"].astype(float), d["rho"].astype(float)
        if eta0 is None:
            xg = np.linspace(0, cfg["x_toe"], 8000)
            eta_a = case_flume.solitary(xg, cfg)[0]
            pe_wave = 0.5 * rho0 * G * np.trapezoid(eta_a ** 2, xg)
            eta0 = True
        ke = 0.5 * np.sum(m * (u * u + w * w))
        pe = G * np.sum(m * z)
        ie = np.sum(m * tait_e(rho, rho0, B))
        ts.append(t); KE.append(ke); PE.append(pe); IE.append(ie); E.append(ke + pe + ie)
        rho_min, rho_max = min(rho_min, rho.min()), max(rho_max, rho.max())
        V = m / rho if np.ndim(m) else np.full(x.size, m) / rho
        xcr, zcr = crest(x, z, dp, V=V, h=meta["h"])
        xcs.append(xcr); zcs.append(zcr)
        xe_, top_ = envelope(x, z, dp)
        hump = np.isfinite(top_) & (top_ > 0.5 * zcr) & (np.abs(xe_ - xcr) < 1.0)
        cents.append(float(np.sum(xe_[hump] * top_[hump]) / np.sum(top_[hump])) if hump.any() else np.nan)
        zb = case_flume.bed_z(x, cfg)
        cos_t = np.where(x < x_toe, 1.0, 1 / math.sqrt(1 + s * s))
        dn = (z - zb) * cos_t
        leak.append(int(np.sum(dn < -0.25 * dp) + np.sum(x < -0.25 * dp)))
        near = np.where((dn < 2 * dp) & (x > x_toe))[0]
        if near.size:
            # ignore isolated droplets: need >= 3 other fluid particles within 1.5 dp
            tree = cKDTree(np.c_[x, z])
            cnt = np.array([len(v) - 1 for v in tree.query_ball_point(np.c_[x[near], z[near]], 1.5 * dp)])
            near = near[cnt >= 3]
        runup.append(float(z[near].max()) if near.size else np.nan)
        if t_touch is None and xcr > x_toe:
            vert, ang, zv, xv = front_face(x, z, dp, xcr, zcr)
            angs.append((t, ang))
            if vert and t_b is None:
                t_b = t
                rec_b = dict(t=t, x_crest=xcr, z_crest=zcr, z_vertical=zv, x_vertical=xv)
        if t_b is not None and t_touch is None and t <= t_b + 1.0:
            over, cav, xo = overturn_and_cavity(x, z, wx, wz, dp, cfg, box)
            over_hist.append((t, over, cav))
            if over and t_over is None:
                t_over, x_over = t, xo
            if t_over is not None and cav > 0 and t_touch is None:
                t_touch = t
    ts = np.array(ts); xcs = np.array(xcs); zcs = np.array(zcs); E = np.array(E)
    E_wave = KE[0] + pe_wave
    # propagation speed on the flat
    x0 = cfg["x0"]
    # speed from the centroid of the upper half of the hump (less noisy than the crest point),
    # while the hump is on the flat and >= 1 m from the toe; first 0.2 s skipped (adjustment)
    cents = np.array(cents)
    sel = (cents < x_toe - 1.0) & (ts >= 0.2) & np.isfinite(cents)
    c_num = float(np.polyfit(ts[sel], cents[sel], 1)[0])
    res_speed_window = [float(ts[sel][0]), float(ts[sel][-1])]
    # height when the crest passes the toe
    k = int(np.argmax(xcs >= x_toe))
    H_toe = float(np.interp(x_toe, xcs[k - 1:k + 1], zcs[k - 1:k + 1]))
    H_start = float(np.median(zcs[(ts >= 0.05) & (ts <= 0.2)]))
    res = dict(run=str(run.name), dp=dp, n_fluid=meta["n_fluid"], n_wall=meta["n_wall"],
               wall_seconds=meta.get("wall_seconds"), steps=meta.get("steps"), S0=meta["info"]["S0"])
    res["c_flat_m_s"] = round(c_num, 4)
    res["c_flat_fit_window_s"] = res_speed_window
    res["c_theory_with_measured_H"] = round(math.sqrt(G * (h0 + float(np.median(zcs[sel])))), 4)
    res["c_theory_sqrt_g_h0_plus_H"] = round(c_th, 4)
    res["c_error_pct"] = round(100 * (c_num / c_th - 1), 2)
    res["H_initial_nominal_m"] = H
    res["H_measured_t0.05-0.2_m"] = round(H_start, 4)
    res["H_at_toe_m"] = round(H_toe, 4)
    res["damping_vs_nominal_pct"] = round(100 * (1 - H_toe / H), 2)
    res["damping_vs_measured_start_pct"] = round(100 * (1 - H_toe / H_start), 2)
    if rec_b:
        hb = float(-case_flume.bed_z(rec_b["x_crest"], cfg))
        res.update(t_vertical_front_s=rec_b["t"], x_b_m=round(rec_b["x_crest"], 3),
                   x_b_from_toe_m=round(rec_b["x_crest"] - x_toe, 3),
                   h_b_m=round(hb, 4), H_b_m=round(rec_b["z_crest"], 4),
                   H_b_over_h_b=round(rec_b["z_crest"] / hb, 3),
                   h_b_over_h0=round(hb / h0, 3), H_b_over_h0=round(rec_b["z_crest"] / h0, 3),
                   vertical_point_x_z=[round(rec_b["x_vertical"], 3), round(rec_b["z_vertical"], 3)])
        kb = int(np.argmin(np.abs(ts - rec_b["t"])))
        res["energy_drift_to_vertical_front_pct_of_wave_energy"] = round(100 * (E[kb] - E[0]) / E_wave, 2)
        kt = int(np.argmin(np.abs(xcs - x_toe)))
        res["energy_drift_to_toe_pct_of_wave_energy"] = round(100 * (E[kt] - E[0]) / E_wave, 2)
    res["overturning_occurred"] = t_over is not None
    res["t_overturn_first_detected_s"] = t_over
    res["x_overturn_m"] = None if x_over is None else round(float(x_over), 3)
    res["t_jet_touchdown_s"] = t_touch
    res["vertical_front_to_touchdown_s"] = None if (t_touch is None or t_b is None) else round(t_touch - t_b, 3)
    ru = np.array(runup)
    res["max_runup_m_above_SWL"] = round(float(np.nanmax(ru)), 4)
    res["t_max_runup_s"] = float(ts[int(np.nanargmax(ru))])
    res["max_runup_over_h0"] = round(float(np.nanmax(ru)) / h0, 3)
    res["slope_top_m"] = cfg["z_top_slope"]
    res["leaked_particles_max"] = int(max(leak))
    res["rho_min_max"] = [round(float(rho_min), 1), round(float(rho_max), 1)]
    res["E_wave_J_per_m"] = round(float(E_wave), 2)
    res["series"] = dict(t=ts.round(3).tolist(), x_crest=xcs.round(4).tolist(), z_crest=zcs.round(4).tolist(),
                         E_minus_E0_over_Ewave=((E - E[0]) / E_wave).round(5).tolist(),
                         runup=np.round(ru, 4).tolist(), face_angle=[[a, round(b, 1)] for a, b in angs if np.isfinite(b)],
                         overturn=[[a, bool(b), int(c)] for a, b, c in over_hist])
    res["key_times"] = key_times(res, ts, xcs, x_toe)
    (run / "diagnostics.json").write_text(json.dumps(res, indent=1))
    print_table(res)
    return res


def key_times(res, ts, xcs, x_toe):
    tb = res.get("t_vertical_front_s")
    to = res.get("t_overturn_first_detected_s")
    tt = res.get("t_jet_touchdown_s")
    kt = {"initial": 0.0}
    if tb:
        xm = 0.5 * (x_toe + res["x_b_m"])
        kt["shoaling"] = float(ts[int(np.argmax(xcs >= xm))])
        kt["vertical_front"] = tb
    if to and tt:
        kt["jet_formed"] = round(0.5 * (to + tt), 2) if tt - to > 0.04 else to
    elif to:
        kt["jet_formed"] = to
    if tt:
        kt["jet_impact"] = tt
        kt["splash_up_runup"] = round(min(tt + 0.2, ts[-1]), 2)
    return kt


LIT = {
    "c_flat_m_s": "sqrt(g(h0+H)) = {c:.3f} m/s (Rayleigh/Boussinesq); fully nonlinear speed is within ~1-2 %",
    "damping": "ideally ~0 %: a solitary wave keeps its height on a flat bed; < 3 % is a good SPH result",
    "S0": "Grilli et al. 1997: plunging for 0.025 < S0 < 0.30 (spilling below, surging 0.30-0.37)",
    "Hb_hb": "Grilli et al. 1997 BEM, slope 1:35, H0/h0 0.2-0.4: H_b/h_b 1.38-1.40 (as tabulated by a later "
             "paper, arXiv:1601.06822); index grows with slope, so >1.4 expected on 1:15; I have no verified "
             "1:15 number. McCowan 0.78 is the flat-bed limit and is far too low on slopes.",
}


def print_table(r):
    rows = [
        ("Grilli slope parameter S0", f"{r['S0']:.3f}", LIT["S0"]),
        ("Speed on flat (m/s)", f"{r['c_flat_m_s']:.3f} ({r['c_error_pct']:+.1f} %)",
         LIT["c_flat_m_s"].format(c=r["c_theory_sqrt_g_h0_plus_H"])),
        ("H at toe / H nominal", f"{r['H_at_toe_m']:.4f} m, damping {r['damping_vs_nominal_pct']:.1f} % "
         f"({r['damping_vs_measured_start_pct']:.1f} % vs t=0.05-0.2 s)", LIT["damping"]),
    ]
    if "x_b_m" in r:
        rows += [
            ("Vertical front t, x_b", f"{r['t_vertical_front_s']:.2f} s, x_b {r['x_b_m']:.2f} m "
             f"({r['x_b_from_toe_m']:.2f} m past toe)", "no verified reference number"),
            ("h_b, H_b", f"{r['h_b_m']:.3f} m, {r['H_b_m']:.3f} m (H_b/h0 {r['H_b_over_h0']:.2f})", ""),
            ("Breaking index H_b/h_b", f"{r['H_b_over_h_b']:.2f}", LIT["Hb_hb"]),
            ("Energy drift to vertical front", f"{r['energy_drift_to_vertical_front_pct_of_wave_energy']:.1f} % of E_wave",
             "0 % for an ideal fluid; this is the numerical dissipation"),
        ]
    rows += [
        ("Overturning (multi-valued surface)", f"{r['overturning_occurred']} at t={r['t_overturn_first_detected_s']}",
         "expected yes (plunging)"),
        ("Vertical front -> jet touchdown", f"{r['vertical_front_to_touchdown_s']} s", "no verified reference number"),
        ("Max runup above SWL", f"{r['max_runup_m_above_SWL']:.3f} m (R/h0 {r['max_runup_over_h0']:.2f}) at t={r['t_max_runup_s']:.2f} s",
         "uncertain: no verified breaking-solitary-wave runup law for 1:15 at hand"),
        ("Leaked particles (max)", f"{r['leaked_particles_max']}", "0"),
        ("Density range (kg/m3)", f"{r['rho_min_max']}", "+-1-2 % in the bulk; isolated spray can drift"),
    ]
    w = max(len(a) for a, _, _ in rows)
    for a, b, c in rows:
        print(f"{a:<{w}}  {b}\n{'':<{w}}    ref: {c}" if c else f"{a:<{w}}  {b}")


if __name__ == "__main__":
    main(sys.argv[1])
