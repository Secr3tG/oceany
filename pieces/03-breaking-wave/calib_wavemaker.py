"""Wavemaker calibration (session 6, 2026-11-13): short runs on a truncated Porto Batel domain.

    python calib_wavemaker.py --factor 0.99 --tend 33

Same dp, same paddle, same lidar bed as case_porto_batel for the first 85 m in front of the
paddle (s = 390 -> 305 m from the house, depth 8.1 -> 7.3 m), closed wall at 85 m with a
velocity sponge from 35 m to 85 m so reflections do not reach the gauges. The sponge lives in
this script (applied after each solver step); sim.py is unchanged.

Incident height definition (same as diagnostics_porto_batel.py): free surface = top particle per
2 dp column + dp/2; H = crest-to-trough between zero up-crossings. Waves are numbered by the
paddle period that made them: wave n crest left the paddle near t = (n-1) T, so wave 1 = ramp-up,
waves 2-4 = full stroke, wave 5 = ramp-down. Calibration H = mean over waves 2-4 and over gauges
x = 10, 15, 20, 25 m from the paddle (1.2-3.1 water depths, beyond the evanescent near field).
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import sim  # noqa: E402
import case_porto_batel as case  # noqa: E402
import diagnostics_porto_batel as D  # noqa: E402

GAUGES_X = [10.0, 15.0, 20.0, 25.0]
EXTRA_X = [40.0, 60.0, 70.0, 80.0]  # inside the sponge (starts 35 m): indicative only
ALL_X = GAUGES_X + EXTRA_X
X_END = 85.0
SPONGE = (35.0, X_END)
SIGMA_MAX = 3.0  # 1/s at the wall, quadratic ramp


def wave_table(t, eta, xg, T, c):
    """Zero up-crossing waves at one gauge, numbered by generation period."""
    out = {}
    for wv in D.wave_heights(t, eta):
        n = int(round((wv["t_crest"] - xg / c - 0.25 * T) / T)) + 1
        if 1 <= n <= 5 and (n not in out or wv["H"] > out[n]["H"]):
            out[n] = wv
    return out


def analyse(t, etas, T, c):
    per = {}
    for xg, e in zip(GAUGES_X, etas):
        per[f"{xg:g}m"] = wave_table(np.asarray(t), np.asarray(e), xg, T, c)
    H_wave = {}
    for n in range(1, 6):
        hs = [per[g][n]["H"] for g in per if n in per[g]]
        H_wave[n] = round(float(np.mean(hs)), 3) if len(hs) == len(per) else None
    full = [H_wave[n] for n in (2, 3, 4)]
    H_cal = round(float(np.mean(full)), 3) if None not in full else None
    # period: mean time between consecutive crests of waves 2-4 over gauges
    Ts = []
    for g in per:
        tc = [per[g][n]["t_crest"] for n in (2, 3, 4) if n in per[g]]
        Ts += list(np.diff(tc))
    return per, H_wave, H_cal, (round(float(np.mean(Ts)), 2) if Ts else None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--factor", type=float, required=True)
    ap.add_argument("--dp", type=float, default=0.1)
    ap.add_argument("--tend", type=float, default=33.0)
    ap.add_argument("--maxwall", type=float, default=900.0)
    ap.add_argument("--set", nargs="*", default=[])
    ap.add_argument("--outdir", default="calib_s6", help="folder under out/ (session 7: calib_s7)")
    args = ap.parse_args()
    cfg = dict(case.CFG)
    for kv in args.set:                      # session 7: e.g. --set H=1.5 c0_H=2.7 (s8)
        k_, v_ = kv.split("=")
        cfg[k_] = float(v_)
    cfg["stroke_factor"] = args.factor
    cfg["s_shore"] = cfg["s_piston"] - X_END
    dp = args.dp
    h = cfg["h_over_dp"] * dp
    xf, zf, uf, wf, rhof, bx, bz, c0, domain, info = case.build(dp, cfg)
    npist = info["n_piston"]
    S = sim.WCSPH(xf, zf, uf, wf, rhof, bx, bz, dp, h, c0, rho0=cfg["rho0"], alpha=cfg["alpha"],
                  delta=cfg["delta"], cfl=cfg["cfl"], domain=domain)
    nf = S.nf
    n = S.x.size
    S.piston_idx = np.arange(n - npist, n)
    S.piston_x0 = S.x[S.piston_idx].copy()
    print(f"factor={args.factor} stroke={info['stroke']:.3f} fluid={nf}", flush=True)
    t0 = time.time()
    S.damp_tau = cfg["settle_tau"]
    while S.t < cfg["t_settle"]:
        S.step()
    S.damp_tau = None
    S.u[:nf] = 0.0
    S.w[:nf] = 0.0
    S.t = 0.0
    S.nstep = 0
    motion, pinfo = case.piston_motion_factory(cfg)
    S.piston_motion = motion
    S.set_piston(0.0)
    S._rates(S.u, S.w, S.rho)
    t_settle_wall = time.time() - t0

    T = cfg["T"]
    c = pinfo["L"] / T
    ts, etas = [], [[] for _ in ALL_X]

    def record():
        x = np.rint(S.x[:nf] * 100) / 100
        z = np.rint(S.z[:nf] * 100) / 100
        xc, eta = D.eta_profile(x, z, dp, X_END)
        ts.append(round(S.t, 3))
        for i, g in enumerate(ALL_X):
            etas[i].append(float(np.interp(g, xc, np.nan_to_num(eta, nan=-9))))

    record()
    k = 0
    t_next = cfg["dt_out"]
    wall0 = time.time()
    aborted = False
    while S.t < args.tend - 1e-9:
        dt = S.step(dt_max=t_next - S.t if t_next - S.t > 1e-9 else None)
        xs = S.x[:nf]
        m = xs > SPONGE[0]
        if m.any():
            r = (xs[m] - SPONGE[0]) / (SPONGE[1] - SPONGE[0])
            f = np.exp(-dt * SIGMA_MAX * np.clip(r, 0, 1) ** 2)
            S.u[:nf][m] *= f
            S.w[:nf][m] *= f
        if S.t >= t_next - 1e-9:
            k += 1
            record()
            t_next = (k + 1) * cfg["dt_out"]
            if k % 50 == 0:
                el = time.time() - wall0
                print(f"t={S.t:6.2f} wall={el:6.0f}s eta_end={el / S.t * (args.tend - S.t) / 60:5.1f} min",
                      flush=True)
                if el / S.t * args.tend > args.maxwall:
                    print("projected wall time too long, aborting", flush=True)
                    aborted = True
                    break
    wall = time.time() - wall0 + t_settle_wall
    per, H_wave, H_cal, T_meas = analyse(ts, etas[:len(GAUGES_X)], T, c)
    extra = {f"{g:g}m": {n: v["H"] for n, v in wave_table(np.array(ts), np.array(e), g, T, c).items()}
             for g, e in zip(EXTRA_X, etas[len(GAUGES_X):])}
    rec = dict(stroke_factor=args.factor, stroke_m=round(info["stroke"], 4), dp=dp, t_end=round(S.t, 2),
               n_fluid=int(nf), H_waves_1_5=H_wave, H_cal_waves_2_4=H_cal, T_measured=T_meas,
               wall_s=round(wall, 1), aborted=aborted, per_gauge=per,
               extra_gauges_in_sponge=extra)
    out = HERE / "out" / args.outdir
    out.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out / f"gauges_f{args.factor:.4f}.npz", t=np.array(ts), eta=np.array(etas),
                        x=np.array(ALL_X))
    (out / f"run_f{args.factor:.4f}.json").write_text(json.dumps(rec, indent=1))
    print(json.dumps({k_: rec[k_] for k_ in ("stroke_factor", "stroke_m", "H_waves_1_5", "H_cal_waves_2_4",
                                             "T_measured", "wall_s")}), flush=True)


if __name__ == "__main__":
    main()
