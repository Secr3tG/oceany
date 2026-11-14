"""Short break-zone clip from an existing Porto Batel run (no new physics, a re-cut of the snapshots).

    python render_break_clip.py out/porto_batel_s8 --tracks 3,15 --out clip.mp4 [--wide]

For each followed wave (diagnostics.json track id) the clip runs from `pre` s before the model's
first vertical front to `post` s after it, at `speed` x real time (0.5 = half speed). The camera
follows that wave's crest from eta(x, t). Frames between the 0.1 s model snapshots are linear
interpolations of particle positions (same particle order in every snapshot); speed colours are
interpolated the same way. No vertical exaggeration in the main panel.
"""
import argparse
import json
import sys
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.animation import FFMpegWriter
from matplotlib.colors import LinearSegmentedColormap
import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import case_porto_batel as case  # noqa: E402

FPS = 25
CMAP = LinearSegmentedColormap.from_list(
    "sea", [(0.0, "#1b4f86"), (0.25, "#2577b5"), (0.5, "#2aa3b8"), (0.75, "#bfe9ef"), (1.0, "#ffffff")])
VMAX = 6.0
BG, SKY, BED, BEDLINE, INK, MUTED = "#081018", "#0b1620", "#4a3d2e", "#8a7558", "#eef3f6", "#93a3ad"


def crest_track(ex, E, ts, tb, s_b, sp_):
    track = np.full(ts.size, np.nan)
    kb = int(np.argmin(np.abs(ts - tb)))
    xprev = sp_ - s_b
    for k in range(kb, -1, -1):
        m = np.abs(ex - xprev) < 6.0
        if not m.any():
            break
        j = np.where(m)[0][np.argmax(E[k][m])]
        track[k] = sp_ - ex[j]
        xprev = ex[j]
    xprev = sp_ - s_b
    for k in range(kb, ts.size):
        m = (ex > xprev - 2.0) & (ex < xprev + 6.0)
        if not m.any():
            break
        j = np.where(m)[0][np.argmax(E[k][m])]
        if E[k][j] < 0.15:
            break
        track[k] = sp_ - ex[j]
        xprev = ex[j]
    ok = np.isfinite(track)
    track = np.interp(np.arange(ts.size), np.where(ok)[0], track[ok])
    return np.convolve(np.pad(track, 7, mode="edge"), np.ones(15) / 15, mode="valid")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("run")
    ap.add_argument("--tracks", required=True, help="comma list of diagnostics track ids to show, in order")
    ap.add_argument("--out", required=True)
    ap.add_argument("--speed", type=float, default=0.5)
    ap.add_argument("--pre", type=float, default=1.0)
    ap.add_argument("--post", type=float, default=3.4)
    ap.add_argument("--width", type=float, default=0.0, help="camera width in m (0 = auto from H_b)")
    ap.add_argument("--wide", action="store_true", help="16:9 1920x1080 instead of 4:5 1080x1350")
    ap.add_argument("--label", default="", help="wave-size line, e.g. 'Typical wave: 1.5 m offshore'")
    a = ap.parse_args()

    run = Path(a.run)
    d = json.loads((run / "diagnostics.json").read_text())
    cfg = json.loads((run / "meta.json").read_text())["cfg"]
    dp = json.loads((run / "meta.json").read_text())["dp"]
    tide, sp_ = cfg["tide_above_lat"], cfg["s_piston"]
    files = sorted(run.glob("snap_*.npz"))
    exy = np.load(run / "eta_xt.npz")
    ts, ex = exy["t"], exy["x"]
    E = np.nan_to_num(exy["eta"], nan=-9)
    waves = {w["track"]: w for w in d["waves"]}
    s_all, z_all = case.profile()
    sel = (s_all >= cfg["s_shore"]) & (s_all <= sp_)
    s_bed, z_bed = s_all[sel], z_all[sel]

    segs = []
    for tid in [int(x) for x in a.tracks.split(",")]:
        fb = waves[tid]["first_break"]
        tr = crest_track(ex, E, ts, fb["t"], fb["s_from_house_m"], sp_)
        segs.append(dict(tid=tid, fb=fb, track=tr, t0=fb["t"] - a.pre, t1=fb["t"] + a.post))
    Hb = max(s["fb"]["H_b_m"] for s in segs)
    W = a.width or (max(16.0, 7.5 * Hb) * (1.6 if a.wide else 1.0))

    if a.wide:
        PX = (1920, 1080)
        R_TITLE, R_MAIN, R_OV, R_FOOT = (0.89, 0.11), (0.0, 0.215, 1.0, 0.655), (0.04, 0.035, 0.44, 0.13), (0.53, 0.03)
    else:
        PX = (1080, 1350)
        R_TITLE, R_MAIN, R_OV, R_FOOT = (0.905, 0.095), (0.0, 0.30, 1.0, 0.585), (0.06, 0.135, 0.88, 0.11), (0.06, 0.025)
    dpi = 100
    fig = plt.figure(figsize=(PX[0] / dpi, PX[1] / dpi), dpi=dpi, facecolor=BG)
    plt.rcParams["font.family"] = "Helvetica"
    ax = fig.add_axes(R_MAIN)
    ax.set_facecolor(SKY)
    ax.set_xticks([]); ax.set_yticks([])
    for sp in ax.spines.values():
        sp.set_visible(False)
    ax.fill_between(s_bed, z_bed, z_bed.min() - 5, color=BED, lw=0, zorder=4)
    ax.plot(s_bed, z_bed, color=BEDLINE, lw=1.2, zorder=5)
    ax.axhline(tide, color="#3a4852", lw=0.8, ls=(0, (4, 4)), zorder=1)
    px_per_m = R_MAIN[2] * PX[0] / W
    Hv = R_MAIN[3] * PX[1] / px_per_m
    ms = (1.05 * dp * px_per_m * 72 / dpi) ** 2

    # overview strip
    ov = fig.add_axes(R_OV)
    ov.set_facecolor(BG)
    VE = 5.0
    ov.fill_between(s_bed, z_bed, z_bed.min() - 1, color=BED, lw=0)
    ov.fill_between(s_bed, np.maximum(z_bed, tide), z_bed, where=z_bed < tide, color="#2577b5", lw=0)
    ov.set_xlim(sp_, 30)
    ov.set_ylim(z_bed.min() - 0.5, 6)
    ov.set_yticks([])
    ov.set_xticks([300, 200, 100, 0]) if False else ov.set_xticks([350, 300, 250, 200, 150, 100, 50])
    ov.tick_params(labelsize=10 if a.wide else 11, colors=MUTED, length=2)
    for k in ("top", "right", "left"):
        ov.spines[k].set_visible(False)
    ov.spines["bottom"].set_color("#3a4852")
    ov.set_title(f"metres from the house  (whole 2D slice, height x{VE:g})", fontsize=10 if a.wide else 11,
                 color=MUTED, loc="left", pad=3)
    ov.set_aspect(VE)
    ov.annotate("house", xy=(cfg["s_shore"] + 2, tide + 0.3), fontsize=9, color=MUTED, ha="right")
    box = ov.add_patch(plt.Rectangle((0, 0), 1, 1, fill=False, ec="#ff7a45", lw=1.4, zorder=6))

    fs_t, fs_s = (24, 15) if a.wide else (30, 17)
    fig.text(0.04 if a.wide else 0.06, R_TITLE[0] + 0.06 * (1 if a.wide else 0.75), "Porto Batel reef, Portugal",
             fontsize=fs_t, color=INK, weight="bold", va="center")
    sub = (f"{a.label + '. ' if a.label else ''}Period {cfg['T']:g} s, tide {tide:g} m above LAT.\n"
           "Illustrative 2D model, not a forecast.")
    fig.text(0.04 if a.wide else 0.06, R_TITLE[0] - 0.005, sub, fontsize=fs_s, color=MUTED, va="center",
             linespacing=1.35)
    foot = ("Each dot is a 10 cm parcel of water (SPH model); colour = speed, white = fastest.\n"
            "Frames between 0.1 s model outputs are interpolated. Cuts between waves are edits.")
    fig.text(R_FOOT[0], R_FOOT[1], foot, fontsize=10 if a.wide else 11, color=MUTED, va="bottom", linespacing=1.4)
    badge = ax.text(0.025, 0.955, "", transform=ax.transAxes, fontsize=fs_s + 3, color="#081018", weight="bold",
                    va="top", zorder=10, bbox=dict(boxstyle="round,pad=0.35", fc="#ffd166", ec="none", alpha=0.85))
    info = ax.text(0.975, 0.955, "", transform=ax.transAxes, fontsize=fs_s, color=INK, ha="right", va="top",
                   zorder=10, linespacing=1.4)
    # 5 m scale bar
    sb_x, sb_y = 0.025, 0.06
    ax.plot([sb_x, sb_x + 5 / W], [sb_y, sb_y], transform=ax.transAxes, color="white", lw=3, zorder=10,
            solid_capstyle="butt")
    ax.text(sb_x, sb_y + 0.015, "5 m", transform=ax.transAxes, color="white", fontsize=fs_s - 2, zorder=10)
    # colour key
    ck = fig.add_axes([0.70 if not a.wide else 0.80, R_MAIN[1] - (0.03 if not a.wide else 0.045),
                       0.24 if not a.wide else 0.16, 0.008 if not a.wide else 0.012])
    ck.imshow(np.linspace(0, 1, 256)[None], aspect="auto", cmap=CMAP, extent=(0, VMAX, 0, 1))
    ck.set_yticks([]); ck.set_xticks([0, 3, 6]); ck.set_xticklabels(["0", "3", "6 m/s"])
    ck.tick_params(labelsize=10, colors=MUTED, length=0, pad=2)
    for sp in ck.spines.values():
        sp.set_visible(False)

    state = dict(sc=None, cache={})

    def snap(i):
        if i not in state["cache"]:
            z = np.load(files[i])
            state["cache"] = {k: v for k, v in state["cache"].items() if k >= i - 1}
            state["cache"][i] = (z["x_cm"], z["z_cm"].astype(float) / 100, z["u_cms"].astype(float) / 100,
                                 z["w_cms"].astype(float) / 100)
        return state["cache"][i]

    writer = FFMpegWriter(fps=FPS, codec="libx264",
                          extra_args=["-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow", "-movflags", "+faststart"])
    nfr = 0
    with writer.saving(fig, a.out, dpi):
        for si, sg in enumerate(segs):
            n = int(round((sg["t1"] - sg["t0"]) / a.speed * FPS))
            for f in range(n):
                t = sg["t0"] + f * a.speed / FPS
                k = min(int(np.floor(t / 0.1 + 1e-6)), len(files) - 2)
                al = (t - ts[k]) / (ts[k + 1] - ts[k])
                xa, za, ua, wa = snap(k)
                xb, zb, ub, wb = snap(k + 1)
                alive = (xa != 65535) & (xb != 65535)
                xs = (1 - al) * xa[alive].astype(float) / 100 + al * xb[alive].astype(float) / 100
                zz = (1 - al) * za[alive] + al * zb[alive] + tide
                spd = (1 - al) * np.hypot(ua[alive], wa[alive]) + al * np.hypot(ub[alive], wb[alive])
                s = sp_ - xs
                crest = np.interp(t, ts, sg["track"])
                c = crest - 0.12 * W          # crest a little left of centre, room for the lip ahead
                zlo = float(np.interp([c + W / 2, c, c - W / 2], s_bed, z_bed).min()) - 0.8
                ax.set_xlim(c + W / 2, c - W / 2)
                ax.set_ylim(zlo, zlo + Hv)
                m = (s > c - W / 2 - 1) & (s < c + W / 2 + 1)
                if state["sc"] is not None:
                    state["sc"].remove()
                state["sc"] = ax.scatter(s[m], zz[m], s=ms, c=spd[m], cmap=CMAP, vmin=0, vmax=VMAX, lw=0,
                                         zorder=3, rasterized=True)
                box.set_bounds(c - W / 2, zlo, W, Hv)
                badge.set_text(f"{a.speed:g}x slow motion" if a.speed != 1 else "real time")
                info.set_text(f"{c:.0f} m from the house\nwave {si + 1} of {len(segs)}")
                writer.grab_frame()
                nfr += 1
    print(f"wrote {a.out}: {nfr} frames, {nfr / FPS:.1f} s, W {W:.1f} m, tracks {a.tracks}")


if __name__ == "__main__":
    main()
