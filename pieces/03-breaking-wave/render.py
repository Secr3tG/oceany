"""Render the flume validation run: animation + six key frames.

    python -I render.py out/flume_r40

Needs diagnostics.json in the run folder (run diagnostics.py first).
Writes out/flume/breaking_wave.mp4 and out/flume/frames/*.png.
The movie plays at half real speed (snapshots every 0.02 s shown at 25 frames/s).
"""
import json
import shutil
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FFMpegWriter
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import case_flume  # noqa: E402

VMAX = 3.0          # colour scale top (m/s), about 1.5 x the solitary wave speed
FIGSIZE = (16, 9)
DPI = 120


def smooth(y, n=9):
    k = np.ones(n) / n
    yp = np.pad(y, n // 2, mode="edge")
    return np.convolve(yp, k, mode="valid")


def camera(t, d, cfg):
    """Return (x centre, view width) for time t."""
    s = d["series"]
    ts = np.array(s["t"])
    xc = smooth(np.array(s["x_crest"]))
    tb = d.get("t_vertical_front_s") or ts[-1]
    tt = d.get("t_jet_touchdown_s") or tb + 0.3
    xb = d.get("x_b_m", xc[-1])
    follow = (float(np.interp(min(t, tb - 0.5), ts, xc)) + 0.4, 3.2)
    zoom = (xb + 0.45, 1.4)
    wide = (xb + 1.3, 3.2)

    def mix(a, b, f):
        f = 0.5 - 0.5 * np.cos(np.pi * np.clip(f, 0, 1))
        return (a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)
    if t < tb - 0.5:
        return follow
    if t < tt + 0.25:
        return mix(follow, zoom, (t - (tb - 0.5)) / 0.4)
    return mix(zoom, wide, (t - (tt + 0.25)) / 0.5)


def setup(cfg, walls, d):
    fig = plt.figure(figsize=FIGSIZE, dpi=DPI, facecolor="white")
    ax0 = fig.add_axes([0.05, 0.80, 0.90, 0.13])
    ax1 = fig.add_axes([0.05, 0.08, 0.84, 0.66])
    ax1._fixed_pos = ax1.get_position()
    cax = fig.add_axes([0.91, 0.08, 0.012, 0.66])
    xe = d["_x_end"]
    xx = np.linspace(-0.05, xe, 600)
    for ax in (ax0, ax1):
        ax.fill_between(xx, case_flume.bed_z(xx, cfg), -cfg["h0"] - 0.2, color="#8a7a63", lw=0, zorder=1)
        ax.plot(xx, case_flume.bed_z(xx, cfg), color="#4a3f30", lw=1, zorder=2)
        ax.axhline(0, color="0.6", lw=0.6, ls="--", zorder=0)
    ax0.set_aspect("equal")        # ax1 keeps equal scale through its computed limits
    ax0.set_xlim(-0.05, xe)
    ax0.set_ylim(-cfg["h0"] - 0.03, 0.25)
    ax0.set_yticks([-0.3, 0, 0.2])
    ax0.tick_params(labelsize=8)
    ax1.set_xlabel("x (m from the left wall)")
    ax1.set_ylabel("z (m above still water)")
    return fig, ax0, ax1, cax


def draw(fig, ax0, ax1, cax, snap, t, cfg, d, state):
    x, z = snap["x"], snap["z"]
    sp = np.hypot(snap["u"], snap["w"])
    for a in state.get("art", []):
        a.remove()
    art = []
    art.append(ax0.scatter(x[::3], z[::3], s=0.3, c=sp[::3], cmap="turbo", vmin=0, vmax=VMAX, lw=0, zorder=3))
    xc, W = camera(t, d, cfg)
    pos = ax1._fixed_pos
    Hview = W * (pos.height * FIGSIZE[1]) / (pos.width * FIGSIZE[0])
    zlo = min(float(case_flume.bed_z(xc - 0.3 * W, cfg)) - 0.05, -0.05)
    ax1.set_xlim(xc - W / 2, xc + W / 2)
    ax1.set_ylim(zlo, zlo + Hview)
    px_per_m = pos.width * FIGSIZE[0] * DPI / W
    dpix = d["_dp"] * px_per_m
    s = (0.95 * dpix * 72 / DPI) ** 2
    sc = ax1.scatter(x, z, s=s, c=sp, cmap="turbo", vmin=0, vmax=VMAX, lw=0, zorder=3)
    art.append(sc)
    rect = plt.Rectangle((xc - W / 2, zlo), W, Hview, fill=False, ec="k", lw=0.8, zorder=4)
    ax0.add_patch(rect)
    art.append(rect)
    if not state.get("cbar"):
        cb = fig.colorbar(sc, cax=cax)
        cb.set_label("speed (m/s)")
        state["cbar"] = True
    title = (f"Solitary wave H/h0 = {cfg['H_over_h0']}, h0 = {cfg['h0']} m, slope 1:{round(1 / cfg['slope'])}  "
             f"(WCSPH, dp = h0/{round(cfg['h0'] / d['_dp'])}, {d['n_fluid']} particles)    t = {t:5.2f} s")
    if state.get("title"):
        state["title"].set_text(title)
    else:
        state["title"] = fig.suptitle(title, fontsize=12, y=0.975)
    state["art"] = art


def main(run):
    run = Path(run)
    d = json.loads((run / "diagnostics.json").read_text())
    meta = json.loads((run / "meta.json").read_text())
    cfg = meta["cfg"]
    d["_dp"] = meta["dp"]
    d["_x_end"] = meta["info"]["x_end"]
    walls = np.load(run / "walls.npz")
    files = sorted(run.glob("snap_*.npz"))
    outdir = HERE / "out" / cfg["name"]
    (outdir / "frames").mkdir(parents=True, exist_ok=True)
    fig, ax0, ax1, cax = setup(cfg, walls, d)
    state = {}
    writer = FFMpegWriter(fps=25, bitrate=6000, codec="libx264", extra_args=["-pix_fmt", "yuv420p"])
    with writer.saving(fig, str(outdir / "breaking_wave.mp4"), DPI):
        for f in files[::2]:
            snap = np.load(f)
            t = float(snap["t"])
            draw(fig, ax0, ax1, cax, snap, t, cfg, d, state)
            writer.grab_frame()
    # key frames
    times = d["key_times"]
    ts = np.array([float(np.load(f)["t"]) for f in files])
    for i, (name, tk) in enumerate(times.items()):
        k = int(np.argmin(np.abs(ts - tk)))
        snap = np.load(files[k])
        draw(fig, ax0, ax1, cax, snap, float(snap["t"]), cfg, d, state)
        state["title"].set_text(state["title"].get_text() + f"   [{name.replace('_', ' ')}]")
        fig.savefig(outdir / "frames" / f"{i + 1}_{name}.png", dpi=DPI)
    shutil.copy(run / "diagnostics.json", outdir / "diagnostics.json")
    print("wrote", outdir)


if __name__ == "__main__":
    main(sys.argv[1])
