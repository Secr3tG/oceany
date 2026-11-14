"""Diagnostics for case_porto_batel (illustrative 2D slice).

    python diagnostics_porto_batel.py out/porto_batel_dp0.125

Writes <run>/diagnostics.json and prints a short table. Distances are from the house along
bearing 236 deg; heights are above LAT unless stated.

Definitions
* free surface eta(x): top particle in each 2 dp column + dp/2, columns with >= 2 particles.
* incident wave height at a gauge: crest-to-trough height of each wave in the eta time series
  (zero up-crossing method around the still water level).
* crests: local maxima of eta >= 0.4 m above still water, >= 15 m apart, tracked from frame to
  frame (each track = one wave).
* vertical front: the shoreward face x_f(z) (most shoreward particle per dp height bin,
  between 30 % and 90 % of the crest-to-trough height, 5-bin smoothing) is vertical or
  overhanging over at least two consecutive bins.
  Break position = crest position then; h_b = still-water depth there; H_b = crest minus the
  lowest eta within half a wavelength; crest elevation also given.
* breaker type: plunging if the free surface becomes multi-valued (overturning jet over an air
  gap, occupancy grid) within 3 s after the vertical front in the 25 m shoreward of it;
  otherwise spilling. Surging/collapsing are not detected automatically.
* second break / reform: a later vertical-front event on the same wave, after >= 1.5 s
  without one, at least 10 m further shoreward.
* bore onto the shelf: the most shoreward water (layer >= 2 dp thick) per wave passage, and
  the deepest water over the shelf at 100 m.
* energy budget (added session 6): E(t) = sum m (|v|^2/2 + g z) over the water still in the model,
  minus E(0) (settled still water), plus the energy carried out through the shoreward drain
  (outflow.npz, runs with shore_outflow). Wave energy put in = E at the end of the paddle motion.
  Tait internal energy is left out (density is not stored; it is about 1 % of the change).
  Particles removed by the drain have the sentinel x_cm = 65535 and are left out everywhere.
"""
import json
import math
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import case_porto_batel as case  # noqa: E402
import diagnostics as D  # noqa: E402


def load_snap(f):
    d = np.load(f)
    x = d["x_cm"].astype(float) / 100
    z = d["z_cm"].astype(float) / 100
    u = d["u_cms"].astype(float) / 100
    w = d["w_cms"].astype(float) / 100
    return float(d["t"]), x, z, u, w


def eta_profile(x, z, dp, xmax):
    bw = 2 * dp
    nb = int(xmax / bw) + 1
    ib = (x / bw).astype(int)
    ok = (ib >= 0) & (ib < nb)
    top = np.full(nb, -np.inf)
    np.maximum.at(top, ib[ok], z[ok])
    cnt = np.bincount(ib[ok], minlength=nb)
    top[cnt < 2] = np.nan
    top[~np.isfinite(top)] = np.nan
    xc = (np.arange(nb) + 0.5) * bw
    return xc, top + 0.5 * dp


def wave_heights(t, eta):
    """Crest-to-trough heights between zero up-crossings."""
    e = np.nan_to_num(eta, nan=0.0)
    up = np.where((e[:-1] < 0) & (e[1:] >= 0))[0]
    H = []
    for a, b in zip(up[:-1], up[1:]):
        seg = e[a:b + 1]
        if seg.max() > 0.2:
            H.append(dict(t_crest=round(float(t[a + np.argmax(seg)]), 1), H=round(float(seg.max() - seg.min()), 2),
                          crest=round(float(seg.max()), 2), trough=round(float(seg.min()), 2)))
    return H


def face_vertical(x, z, dp, xc, zc, ztr):
    """Vertical tangent on the shoreward (+x) face of a crest at (xc, zc); trough level ztr."""
    sel = (x > xc - 3.0) & (x < xc + 15.0) & (z > ztr)
    xs, zs = x[sel], z[sel]
    zlo, zhi = ztr + 0.3 * (zc - ztr), ztr + 0.9 * (zc - ztr)
    edges = np.arange(zlo, zhi + dp, dp)
    if edges.size < 9:
        return False, np.nan
    xf = np.full(edges.size - 1, np.nan)
    for i in range(edges.size - 1):
        m = (zs >= edges[i]) & (zs < edges[i + 1])
        if m.any():
            xf[i] = xs[m].max()
    good = ~np.isnan(xf)
    if good.sum() < 0.7 * xf.size:
        return False, np.nan
    idx = np.arange(xf.size)
    xf = np.interp(idx, idx[good], xf[good])
    xs5 = np.convolve(xf, np.ones(5) / 5, mode="valid")
    dxdz = np.diff(xs5) / dp
    ang = np.degrees(np.arctan2(1.0, -dxdz))
    # vertical (or overhanging) over at least two consecutive smoothed bins
    vert = bool(np.any((dxdz[:-1] >= 0.0) & (dxdz[1:] >= 0.0))) if dxdz.size > 1 else False
    return vert, float(ang.max())


def main(run):
    run = Path(run)
    meta = json.loads((run / "meta.json").read_text())
    cfg = meta["cfg"]
    dp = meta["dp"]
    tide = cfg["tide_above_lat"]
    L = meta["info"]["L"]
    T = cfg["T"]
    walls = np.load(run / "walls.npz")
    wx, wz = walls["x"].astype(float), walls["z"].astype(float)
    xmax = meta["info"]["x_end"]
    s_of = lambda xx: cfg["s_piston"] - np.asarray(xx)  # noqa: E731
    x_of = lambda ss: cfg["s_piston"] - np.asarray(ss)  # noqa: E731
    files = sorted(run.glob("snap_*.npz"))
    gauges_s = [370.0, 300.0, 250.0, 200.0, 150.0]
    g_eta = {g: [] for g in gauges_s}
    ts = []
    tracks = []          # each: dict(id, xs, ts, zc, events)
    shelf_front = []     # most shoreward water s (thickness >= 2 dp), per frame
    shelf_depth100 = []
    eta_store = []
    E_t = []
    m_p = cfg["rho0"] * dp * dp
    for f in files:
        t, x, z, u, w = load_snap(f)
        ts.append(t)
        al = x < 655.0
        E_t.append(float(m_p * np.sum(0.5 * (u[al] ** 2 + w[al] ** 2) + 9.81 * z[al])))
        xc, eta = eta_profile(x, z, dp, xmax)
        eta_store.append(eta.astype(np.float32))
        for g in gauges_s:
            g_eta[g].append(float(np.interp(x_of(g), xc, np.nan_to_num(eta, nan=-9))))
        # water front on the shelf: shoreward-most column with water >= 2 dp above the bed
        zb = case.bed_z(xc, cfg)
        thick = eta - zb
        wet = np.where(np.isfinite(thick) & (thick >= 2 * dp))[0]
        shelf_front.append(float(s_of(xc[wet.max()])) if wet.size else np.nan)
        k100 = int(np.argmin(np.abs(s_of(xc) - 100.0)))
        shelf_depth100.append(float(np.nan_to_num(thick[k100], nan=0.0)))
        # crests
        e = np.nan_to_num(eta, nan=-9)
        cand = np.where((e[1:-1] >= e[:-2]) & (e[1:-1] > e[2:]) & (e[1:-1] >= 0.4))[0] + 1
        cand = cand[np.argsort(-e[cand])]
        chosen = []
        for c in cand:
            if all(abs(xc[c] - xc[o]) > 15.0 for o in chosen):
                chosen.append(c)
        chosen.sort()
        for c in chosen:
            xcr, zcr = xc[c], e[c]
            # match to a track
            best = None
            for tr in tracks:
                if tr["ts"][-1] < t - 0.35:
                    continue
                dx = xcr - tr["xs"][-1]
                if -1.0 <= dx <= 3.0 * (t - tr["ts"][-1]) / 0.1 and (best is None or abs(dx) < best[1]):
                    best = (tr, abs(dx))
            if best is None:
                tr = dict(id=len(tracks) + 1, xs=[], ts=[], zc=[], ztr=[], events=[])
                tracks.append(tr)
            else:
                tr = best[0]
            half = (xc > xcr - L / 2) & (xc < xcr + L / 2)
            ztr = float(np.nanmin(np.where(half, eta, np.nan)))
            tr["xs"].append(float(xcr))
            tr["ts"].append(t)
            tr["zc"].append(float(zcr))
            tr["ztr"].append(ztr)
            vert, ang = face_vertical(x, z, dp, xcr, zcr, ztr)
            if vert:
                tr["events"].append(dict(t=t, x=float(xcr), zc=float(zcr), ztr=ztr, frame=str(f.name)))
    ts = np.array(ts)
    # ---- incident wave heights at gauges
    gauges = {f"{int(g)}m": wave_heights(ts, np.array(g_eta[g])) for g in gauges_s}
    # ---- breaking per wave
    waves = []
    for tr in tracks:
        if len(tr["ts"]) < 30 or max(tr["zc"]) < 0.8:
            continue
        ev = tr["events"]
        rec = dict(track=tr["id"], t_first_seen=tr["ts"][0], s_first_seen=round(float(s_of(tr["xs"][0])), 1),
                   s_last_seen=round(float(s_of(tr["xs"][-1])), 1), max_crest_m_above_SWL=round(max(tr["zc"]), 2))
        if ev:
            e0 = ev[0]
            hb = -float(case.bed_z(e0["x"], cfg))
            Hb = e0["zc"] - e0["ztr"]
            rec["first_break"] = dict(
                t=round(e0["t"], 1), s_from_house_m=round(float(s_of(e0["x"])), 1),
                still_depth_h_b_m=round(hb, 2), H_b_m=round(Hb, 2),
                crest_above_SWL_m=round(e0["zc"], 2), H_b_over_h_b=round(Hb / hb, 2) if hb > 0 else None,
                rule_078_breaking_depth_m=round(Hb / 0.78, 2))
            # breaker type: overturning within 3 s, 25 m shoreward
            kf = int(np.argmin(np.abs(ts - e0["t"])))
            btype = "spilling"
            t_over = None
            t_touch = None
            for k in range(kf, min(kf + 31, len(files))):
                tk, x, z, _, _ = load_snap(files[k])
                xr = e0["x"] + (tk - e0["t"]) * 6.0
                box = (xr - 8.0, xr + 25.0, float(np.min(case.bed_z(np.linspace(xr - 8, xr + 25, 50), cfg))) - 0.5, 8.0)
                over, cav, xo = D.overturn_and_cavity(x, z, wx, wz, dp, cfg, box,
                                                      bedfun=case.bed_z, min_cav=15)
                if over and t_over is None:
                    btype = "plunging"
                    t_over = (tk, float(s_of(xo)), cav)
                if t_over is not None and cav > 0:
                    t_touch = tk
                    break
            if t_touch is not None:
                rec["first_break"]["t_jet_touchdown"] = round(t_touch, 1)
            rec["first_break"]["breaker_type"] = btype
            if t_over:
                rec["first_break"]["overturn_seen"] = dict(t=round(t_over[0], 1), s_m=round(t_over[1], 1))
            # later vertical events = second break / reform
            reforms = []
            last_t = e0["t"]
            last_x = e0["x"]
            for e in ev[1:]:
                if e["t"] - last_t >= 1.5 and e["x"] - last_x >= 10.0:
                    hb2 = -float(case.bed_z(e["x"], cfg))
                    reforms.append(dict(t=round(e["t"], 1), s_from_house_m=round(float(s_of(e["x"])), 1),
                                        still_depth_m=round(hb2, 2), H_m=round(e["zc"] - e["ztr"], 2)))
                    last_x = e["x"]
                last_t = e["t"]
            rec["later_vertical_fronts"] = reforms
            rec["n_vertical_frames"] = len(ev)
        waves.append(rec)
    # ---- shelf
    sf = np.array(shelf_front)
    d100 = np.array(shelf_depth100)
    shelf = dict(most_shoreward_water_s_m=round(float(np.nanmin(sf)), 1),
                 t_most_shoreward=float(ts[int(np.nanargmin(sf))]),
                 max_water_depth_at_100m_m=round(float(d100.max()), 2),
                 t_max_depth_100m=float(ts[int(np.argmax(d100))]),
                 still_water_front_s_m=round(float(sf[0]), 1),
                 bore_onto_shelf=bool(np.nanmin(sf) < 110.0))
    # ---- energy budget
    E_t = np.array(E_t) - E_t[0]
    of = run / "outflow.npz"
    if of.exists():
        o = np.load(of)
        E_out = np.interp(ts, o["t"], o["E"])
        n_out = np.interp(ts, o["t"], o["n"])
    else:
        E_out = np.zeros_like(ts)
        n_out = np.zeros_like(ts)
    t_m = meta["piston"]["t_motion_end"]
    k_m = int(np.argmin(np.abs(ts - t_m)))
    E_in = float(E_t[k_m])
    energy = dict(
        note="per metre of crest; E = kinetic + potential of the water in the model relative to still water; "
             "paddle stops at t_motion_end; dissipated = breaking (physical) + numerical loss together",
        t_motion_end_s=round(t_m, 1), E_wave_in_J_per_m=round(E_in),
        t_end_s=round(float(ts[-1]), 1),
        E_in_model_at_end_pct=round(100 * float(E_t[-1]) / E_in, 1),
        E_out_through_drain_pct=round(100 * float(E_out[-1]) / E_in, 1),
        E_dissipated_pct=round(100 * (E_in - float(E_t[-1]) - float(E_out[-1])) / E_in, 1),
        particles_removed_by_drain=int(n_out[-1]),
        volume_removed_m2=round(float(n_out[-1]) * dp * dp, 2),
        series_every_2s=dict(t=[round(float(v), 1) for v in ts[::20]],
                             E_model_pct=[round(100 * float(v) / E_in, 1) for v in E_t[::20]],
                             E_out_pct=[round(100 * float(v) / E_in, 1) for v in E_out[::20]]))
    res = dict(run=run.name, dp=dp, n_fluid=meta["n_fluid"], n_wall=meta["n_wall"],
               wall_seconds=meta.get("wall_seconds"), steps=meta.get("steps"),
               config=dict(H_target=cfg["H"], T=T, tide_above_LAT=tide, s_piston=cfg["s_piston"],
                           h_gen=round(meta["info"]["h_gen"], 2), stroke=round(meta["info"]["stroke"], 2),
                           L_at_gen=round(L, 1), ursell_at_gen=round(meta["info"]["ursell_at_gen"], 1)),
               gauges=gauges, waves=waves, shelf=shelf, energy=energy,
               uncertainty=dict(
                   lidar_grid_m="11 x 14",
                   lidar_cells_on_line_100m_to_end=65,
                   profile_position_uncertainty_m="9-12 (about one grid cell); session-4 handoff depths were "
                                                  "one cell off, checked independently by the coordinator",
                   bed_detail="bilinear between cell centres; no ledges, blocks or exact shelf-step shape; "
                              "the paddle-out channel through the shelf is not in the lidar",
                   two_d="2D slice: no refraction, no alongshore variation, no air phase"),
               compare_linear_model=dict(first_break_s_m="200-204", second_break_s_m="164-176",
                                         source="pieces/02-reefs/simulate_swell.py (session 4 handoff)"),
               sat_here_user_s_m=cfg["sat_here_m"])
    np.savez_compressed(run / "eta_xt.npz", t=ts, x=eta_profile(np.zeros(1), np.zeros(1), dp, xmax)[0],
                        eta=np.array(eta_store))
    (run / "diagnostics.json").write_text(json.dumps(res, indent=1))
    pr(res)
    return res


def pr(r):
    print(f"dp {r['dp']} m, {r['n_fluid']} particles, wall {r['wall_seconds']}")
    for g, hs in r["gauges"].items():
        print(f"  gauge {g}: H = {[h['H'] for h in hs]}")
    for w in r["waves"]:
        fb = w.get("first_break")
        if fb:
            print(f"  wave track {w['track']}: break s={fb['s_from_house_m']} m, h_b={fb['still_depth_h_b_m']} m, "
                  f"H_b={fb['H_b_m']} m, H_b/h_b={fb['H_b_over_h_b']}, {fb['breaker_type']}; "
                  f"later fronts {[(e['s_from_house_m'], e['H_m']) for e in w['later_vertical_fronts']]}")
        else:
            print(f"  wave track {w['track']}: no vertical front, seen {w['s_first_seen']}->{w['s_last_seen']} m")
    print("  shelf:", r["shelf"])


if __name__ == "__main__":
    main(sys.argv[1])
