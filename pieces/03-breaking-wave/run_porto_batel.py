"""Run case_porto_batel (illustrative 2D slice of the Porto Batel reef).

    python run_porto_batel.py --dp 0.15
    python run_porto_batel.py --dp 0.3 --tend 5 --tag _test   # quick check

Shoreward outflow (session 6, cfg shore_outflow=1, the default): there is no end wall; every fluid
particle that crosses x_sink (s_shore from the house) is removed after the solver step: it is parked on
a sparse lattice far above the model (no neighbours, so it exerts and feels no force) and re-parked
every step. Its energy m (v^2/2 + g z) and the time are added to out/.../outflow.npz. In snapshots a
removed particle is written at the sentinel x_cm = 65535, z_cm = 32767, u = w = 0. sim.py is unchanged.

Snapshots: out/porto_batel_dp<dp><tag>/snap_NNNN.npz (or --outdir), compact integers:
x_cm (uint16, solver x), z_cm (int16, above still water), u_cms, w_cms (int16), plus t and the
piston position. Settling of the still water happens first (cfg t_settle).
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

ap = argparse.ArgumentParser()
ap.add_argument("--dp", type=float, default=0.15)
ap.add_argument("--tend", type=float, default=None)
ap.add_argument("--tag", default="")
ap.add_argument("--set", nargs="*", default=[])
ap.add_argument("--outdir", default=None, help="output folder name under out/ (default porto_batel_dp<dp><tag>)")
args = ap.parse_args()

cfg = dict(case.CFG)
if args.tend:
    cfg["t_end"] = args.tend
for kv in args.set:
    k_, v_ = kv.split("=")
    cfg[k_] = float(v_)
dp = args.dp
h = cfg["h_over_dp"] * dp
xf, zf, uf, wf, rhof, bx, bz, c0, domain, info = case.build(dp, cfg)
npist = info["n_piston"]
out = HERE / "out" / (args.outdir or f"porto_batel_dp{dp:g}{args.tag}")
out.mkdir(parents=True, exist_ok=True)
for f in out.glob("snap_*.npz"):
    f.unlink()
print(f"dp={dp} fluid={xf.size} wall={bx.size} c0={c0:.1f} h_gen={info['h_gen']:.2f} "
      f"stroke={info['stroke']:.2f} L={info['L']:.1f} Ursell={info['ursell_at_gen']:.1f}", flush=True)

S = sim.WCSPH(xf, zf, uf, wf, rhof, bx, bz, dp, h, c0, rho0=cfg["rho0"], alpha=cfg["alpha"],
              delta=cfg["delta"], cfl=cfg["cfl"], domain=domain)
nf = S.nf
n = S.x.size
pidx = np.arange(n - npist, n)
S.piston_idx = pidx
S.piston_x0 = S.x[pidx].copy()

# ---- settle still water (piston at rest)
S.damp_tau = cfg["settle_tau"]
t0 = time.time()
while S.t < cfg["t_settle"]:
    S.step()
sp = np.sqrt(S.u[:nf] ** 2 + S.w[:nf] ** 2)
print(f"settled {cfg['t_settle']} s in {time.time() - t0:.0f} s ({S.nstep} steps), residual vmax {sp.max():.3f}",
      flush=True)
S.damp_tau = None
S.u[:nf] = 0.0
S.w[:nf] = 0.0
S.t = 0.0
S.nstep = 0
motion, pinfo = case.piston_motion_factory(cfg)
S.piston_motion = motion
S.set_piston(0.0)

# ---- shoreward outflow (particle sink)
sink_on = bool(info.get("shore_outflow"))
x_sink = info.get("x_sink")
removed = np.zeros(nf, bool)
park_slot = np.full(nf, -1, np.int64)
n_parked = 0
park_sp = 2.5 * h                                   # > kernel support 2h: parked particles never interact
park_x0 = domain[0] + park_sp
park_M = int((domain[1] - domain[0] - 2 * park_sp) / park_sp)
park_z0 = domain[3] + 40.0                          # far above the model (clamped into the top cell row)
out_t, out_n, out_E = [0.0], [0], [0.0]
E_out = 0.0


def park(idx):
    sl = park_slot[idx]
    S.x[idx] = park_x0 + (sl % park_M) * park_sp
    S.z[idx] = park_z0 + (sl // park_M) * park_sp
    S.u[idx] = 0.0
    S.w[idx] = 0.0
    S.rho[idx] = cfg["rho0"]
    S.p[idx] = 0.0


def apply_sink():
    global n_parked, E_out
    if not sink_on:
        return
    new = np.where((S.x[:nf] > x_sink) & ~removed)[0]
    if new.size:
        E_out += float(np.sum(S.mass[new] * (0.5 * (S.u[new] ** 2 + S.w[new] ** 2) + sim.G * S.z[new])))
        removed[new] = True
        park_slot[new] = n_parked + np.arange(new.size)
        n_parked += new.size
        out_t.append(S.t)
        out_n.append(n_parked)
        out_E.append(E_out)
    if n_parked:
        park(np.where(removed)[0])


bed_check_x = np.linspace(0.0, info["x_bed_end"], 4000)
bed_check_z = case.bed_z(bed_check_x, cfg)


def leaks():
    """Fluid particles more than 1 dp below the bed, or outside the model box (not counting removed ones)."""
    a = ~removed
    xa, za = S.x[:nf][a], S.z[:nf][a]
    below = za < np.interp(xa, bed_check_x, bed_check_z) - dp
    outside = (xa < domain[0]) | (xa > domain[1]) | (za < domain[2]) | (za > domain[3])
    return int(below.sum()), int(outside.sum())


S._rates(S.u, S.w, S.rho)

meta = dict(cfg=cfg, dp=dp, h=h, c0=c0, n_fluid=int(nf), n_wall=int(bx.size), info=info,
            piston=pinfo, settle_wall_s=time.time() - t0,
            outflow=dict(on=sink_on, x_sink=x_sink, s_sink=cfg["s_shore"] if sink_on else None,
                         x_bed_end=info["x_bed_end"], sentinel="x_cm=65535, z_cm=32767 for removed particles"))
(out / "meta.json").write_text(json.dumps(meta, indent=1))
np.savez(out / "walls.npz", x=bx[:bx.size - npist].astype(np.float32), z=bz[:bx.size - npist].astype(np.float32))


def save(k):
    x = S.x[:nf]
    xc = np.clip(np.rint(x * 100), 0, 65534).astype(np.uint16)
    zc = np.clip(np.rint(S.z[:nf] * 100), -32768, 32766).astype(np.int16)
    xc[removed] = 65535
    zc[removed] = 32767
    np.savez_compressed(out / f"snap_{k:04d}.npz", t=S.t, piston_X=getattr(S, "piston_X", 0.0),
                        x_cm=xc, z_cm=zc,
                        u_cms=np.clip(np.rint(S.u[:nf] * 100), -32768, 32767).astype(np.int16),
                        w_cms=np.clip(np.rint(S.w[:nf] * 100), -32768, 32767).astype(np.int16))


k = 0
save(k)
t_next = cfg["dt_out"]
wall0 = time.time()
last = 0.0
while S.t < cfg["t_end"] - 1e-9:
    S.step(dt_max=t_next - S.t if t_next - S.t > 1e-9 else None)
    apply_sink()
    if S.t >= t_next - 1e-9:
        k += 1
        save(k)
        t_next = (k + 1) * cfg["dt_out"]
        if not np.all(np.isfinite(S.x[:nf])):
            print("NaN detected, stopping", flush=True)
            break
    if S.t - last >= 1.0:
        last = S.t
        vmax = math.sqrt(np.max(S.u[:nf] ** 2 + S.w[:nf] ** 2))
        el = time.time() - wall0
        lb, lo = leaks()
        ra = S.rho[:nf][~removed]
        print(f"t={S.t:7.2f} steps={S.nstep:8d} dt={S.timestep():.2e} vmax={vmax:5.2f} "
              f"rho[{ra.min():.0f},{ra.max():.0f}] removed={n_parked} below_bed={lb} outside={lo} wall={el:7.0f}s "
              f"eta_end={el / S.t * (cfg['t_end'] - S.t) / 60:5.1f} min", flush=True)
meta["wall_seconds"] = time.time() - wall0
meta["steps"] = S.nstep
lb, lo = leaks()
meta["final_check"] = dict(n_removed=int(n_parked), E_out_J_per_m=E_out, below_bed=lb, outside=lo)
np.savez(out / "outflow.npz", t=np.array(out_t), n=np.array(out_n), E=np.array(out_E),
         mass=float(S.m), removed=removed)
(out / "meta.json").write_text(json.dumps(meta, indent=1))
print(f"done t={S.t:.2f} steps={S.nstep} wall={meta['wall_seconds']:.0f}s", flush=True)
