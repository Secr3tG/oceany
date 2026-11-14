"""Run a case and save snapshots.

    python -I run.py flume --res 20          # dp = h0/20 (development)
    python -I run.py flume --res 40          # dp = h0/40 (final, ~30k particles)

Snapshots go to out/<case>_r<res>/snap_NNNN.npz (fluid x, z, u, w, rho as float32).
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

ap = argparse.ArgumentParser()
ap.add_argument("case", choices=["flume"])
ap.add_argument("--res", type=int, default=20, help="dp = h0 / res")
ap.add_argument("--tend", type=float, default=None)
ap.add_argument("--set", nargs="*", default=[], help="override config: key=value")
ap.add_argument("--tag", default="")
args = ap.parse_args()

if args.case == "flume":
    import case_flume as case
cfg = dict(case.CFG)
if args.tend:
    cfg["t_end"] = args.tend
for kv in args.set:
    k_, v_ = kv.split("=")
    cfg[k_] = type(cfg[k_])(float(v_))
dp = cfg["h0"] / args.res
h = cfg["h_over_dp"] * dp
settle = cfg.get("t_settle", 0.0)
xf, zf, uf, wf, rhof, bx, bz, c0, domain, info = case.build(dp, cfg, still=settle > 0)
mass_f = None
if settle > 0:
    # settle still water first (velocity relaxation), then put the wave on the settled particles
    S0_ = sim.WCSPH(xf, zf, uf, wf, rhof, bx, bz, dp, h, c0, rho0=cfg["rho0"],
                    alpha=cfg["alpha"], delta=cfg["delta"], cfl=cfg["cfl"], domain=domain)
    S0_.damp_tau = cfg.get("settle_tau", 0.05)
    t0_ = time.time()
    while S0_.t < settle:
        S0_.step()
    nf_ = S0_.nf
    print(f"settled {settle} s in {time.time() - t0_:.1f} s, residual vmax "
          f"{np.sqrt(np.max(S0_.u[:nf_]**2 + S0_.w[:nf_]**2)):.4f} m/s", flush=True)
    xf = S0_.x[:nf_].copy()
    zs_ = S0_.z[:nf_].copy()
    zf, uf, wf, rhof, mass_f = case.insert_wave(xf, zs_, dp, cfg, rho0=cfg["rho0"], B=S0_.B)
    del S0_
out = HERE / "out" / f"{cfg['name']}_r{args.res}{args.tag}"
out.mkdir(parents=True, exist_ok=True)
for f in out.glob("snap_*.npz"):
    f.unlink()

S = sim.WCSPH(xf, zf, uf, wf, rhof, bx, bz, dp, h, c0, rho0=cfg["rho0"],
              alpha=cfg["alpha"], delta=cfg["delta"], cfl=cfg["cfl"], domain=domain, mass_f=mass_f)
meta = dict(cfg=cfg, dp=dp, h=h, c0=c0, n_fluid=int(xf.size), n_wall=int(bx.size),
            mass=S.m, B=S.B, info=info)
np.save(out / "mass.npy", S.mass[:S.nf].astype(np.float32))
(out / "meta.json").write_text(json.dumps(meta, indent=1))
np.savez(out / "walls.npz", x=bx.astype(np.float32), z=bz.astype(np.float32))
print(f"case {cfg['name']} dp={dp:.5f} h={h:.5f} c0={c0:.2f} fluid={xf.size} wall={bx.size} "
      f"S0={info['S0']:.3f}", flush=True)


def save(k):
    nf = S.nf
    np.savez(out / f"snap_{k:04d}.npz", t=S.t, x=S.x[:nf].astype(np.float32),
             z=S.z[:nf].astype(np.float32), u=S.u[:nf].astype(np.float32),
             w=S.w[:nf].astype(np.float32), rho=S.rho[:nf].astype(np.float32))


k = 0
save(k)
t_next = cfg["dt_out"]
wall0 = time.time()
last_print = 0.0
while S.t < cfg["t_end"] - 1e-9:
    S.step(dt_max=t_next - S.t if t_next - S.t > 1e-9 else None)
    if S.t >= t_next - 1e-9:
        k += 1
        save(k)
        t_next = (k + 1) * cfg["dt_out"]
        if not np.all(np.isfinite(S.x[:S.nf])):
            print("NaN detected, stopping", flush=True)
            break
    if S.t - last_print >= 0.1:
        last_print = S.t
        nf = S.nf
        vmax = math.sqrt(np.max(S.u[:nf] ** 2 + S.w[:nf] ** 2))
        el = time.time() - wall0
        print(f"t={S.t:7.3f} steps={S.nstep:7d} dt={S.timestep():.2e} vmax={vmax:5.2f} "
              f"rho[{S.rho[:nf].min():.1f},{S.rho[:nf].max():.1f}] wall={el:7.1f}s "
              f"({S.nstep / max(el, 1e-9):.0f} steps/s)", flush=True)
print(f"done t={S.t:.3f} steps={S.nstep} wall={time.time() - wall0:.1f}s", flush=True)
meta["wall_seconds"] = time.time() - wall0
meta["steps"] = S.nstep
(out / "meta.json").write_text(json.dumps(meta, indent=1))
