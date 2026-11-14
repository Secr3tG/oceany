"""Render case_porto_batel and export the viewer slice.

    python render_porto_batel.py out/porto_batel_dp0.125

    python render_porto_batel.py out/porto_batel_s6 --out out/porto_batel_s6 [--slice-v2]

With --out DIR (session 6) everything goes to DIR instead: DIR/porto_batel.mp4, DIR/frames/,
DIR/porto_batel_slice.json, DIR/porto_batel_slice_v2<suffix>.bin/.json (suffix from --v2-suffix).
Particles removed by the shoreward drain (sentinel x_cm 65535) are never picked for the slices.

Needs <run>/diagnostics.json (run diagnostics_porto_batel.py first). Writes
out/porto_batel.mp4 (2.5x real speed: 0.1 s snapshots at 25 frames/s), out/porto_batel/frames/,
out/porto_batel/diagnostics.json and out/porto_batel_slice.json.
"""
import json
import math
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
import case_porto_batel as case  # noqa: E402
from diagnostics_porto_batel import load_snap, eta_profile  # noqa: E402

VMAX = 10.0
FIG = (16, 9)
DPI = 110
VE = 5.0             # vertical exaggeration of the overview panel only
OUT = HERE / "out"   # output folder (--out)
SPLIT = False        # True with --out: mp4/frames/slices directly in OUT, not OUT/porto_batel/
V2_SUFFIX = ""       # file name suffix of the v2 slice (--v2-suffix)


def pick_wave(d):
    """The wave to follow: the broken wave with the largest H_b."""
    best = None
    for w in d["waves"]:
        fb = w.get("first_break")
        if fb and (best is None or fb["H_b_m"] > best["first_break"]["H_b_m"]):
            best = w
    return best


def main(run):
    run = Path(run)
    d = json.loads((run / "diagnostics.json").read_text())
    meta = json.loads((run / "meta.json").read_text())
    cfg = meta["cfg"]
    dp = meta["dp"]
    tide = cfg["tide_above_lat"]
    sp_ = cfg["s_piston"]
    files = sorted(run.glob("snap_*.npz"))
    ts = np.array([float(np.load(f)["t"]) for f in files])
    exy = np.load(run / "eta_xt.npz")
    wave = pick_wave(d)
    if wave is None:          # no break detected: follow the highest wave instead
        wave = max(d["waves"], key=lambda w_: w_["max_crest_m_above_SWL"])
        wave["first_break"] = dict(t=float(ts[-1]) * 0.8, s_from_house_m=wave["s_last_seen"], H_b_m=0.0,
                                   note="no break detected; placeholder for the camera only")
    fb = wave["first_break"]
    # crest track of the followed wave, re-derived from eta(x, t)
    tb = fb["t"]
    s_b = fb["s_from_house_m"]
    ex = exy["x"]
    E = np.nan_to_num(exy["eta"], nan=-9)
    track_s = np.full(ts.size, np.nan)
    kb = int(np.argmin(np.abs(ts - tb)))
    xprev = sp_ - s_b
    for k in range(kb, -1, -1):          # backward from the break
        m = np.abs(ex - xprev) < 6.0
        if not m.any():
            break
        j = np.where(m)[0][np.argmax(E[k][m])]
        track_s[k] = sp_ - ex[j]
        xprev = ex[j] - 0.9 * 0.0
    xprev = sp_ - s_b
    for k in range(kb, ts.size):          # forward (bore)
        m = (ex > xprev - 2.0) & (ex < xprev + 6.0)
        if not m.any():
            break
        j = np.where(m)[0][np.argmax(E[k][m])]
        if E[k][j] < 0.15:
            break
        track_s[k] = sp_ - ex[j]
        xprev = ex[j]
    ok = np.isfinite(track_s)
    track_s = np.interp(np.arange(ts.size), np.where(ok)[0], track_s[ok])
    track_s = np.convolve(np.pad(track_s, 5, mode="edge"), np.ones(11) / 11, mode="valid")

    def cam(k):
        W = 50.0
        c = min(300.0, track_s[k] - 12.0)
        return max(c, 85.0), W

    s_all, zl_all = case.profile()
    sel = (s_all >= cfg["s_shore"]) & (s_all <= sp_)
    s_bed, z_bed = s_all[sel], zl_all[sel]
    breaks = [(w["track"], w["first_break"]["s_from_house_m"]) for w in d["waves"] if w.get("first_break")]

    fig = plt.figure(figsize=FIG, dpi=DPI, facecolor="white")
    ax0 = fig.add_axes([0.05, 0.72, 0.84, 0.17])
    ax1 = fig.add_axes([0.05, 0.08, 0.84, 0.55])
    cax = fig.add_axes([0.91, 0.08, 0.012, 0.55])
    pos1 = ax1.get_position()
    for ax in (ax0, ax1):
        ax.fill_between(s_bed, z_bed, z_bed.min() - 2, color="#8a7a63", lw=0, zorder=1)
        ax.plot(s_bed, z_bed, color="#4a3f30", lw=0.8, zorder=2)
        ax.axhline(tide, color="0.55", lw=0.6, ls="--", zorder=0)
        ax.axvline(cfg["sat_here_m"], color="tab:red", lw=0.8, ls=":", zorder=5)
    ax0.text(cfg["sat_here_m"], 9.5, "sat here (user)", color="tab:red", fontsize=7, ha="center")
    for tid, sb in breaks:
        ax0.axvline(sb, color="k", lw=0.5, ls="--", zorder=5)
    ax0.set_xlim(sp_ + 2, cfg["s_shore"])
    ax0.set_ylim(z_bed.min() - 0.5, 10.5)
    ax0.set_aspect(VE)
    ax0.tick_params(labelsize=7)
    ax0.set_ylabel("m above LAT", fontsize=7)
    ax0.set_title(f"whole slice, vertical exaggeration {VE:g}x; dashed lines = first break of each wave; "
                  f"wavemaker at {sp_:g} m", fontsize=8)
    ax1.set_xlabel("distance from the house along 236 deg (m)")
    ax1.set_ylabel("height above LAT (m)")
    sat_txt = ax1.text(cfg["sat_here_m"], 0, "sat here (user)", color="tab:red", fontsize=8, ha="right",
                       rotation=90, va="bottom")
    title = fig.suptitle("", fontsize=12, y=0.975)
    state = dict(art=[], cb=False)

    def draw(k, label=None):
        t, x, z, u, w = load_snap(files[k])
        s = sp_ - x
        zz = z + tide
        spd = np.hypot(u, w)
        for a in state["art"]:
            a.remove()
        art = [ax0.scatter(s[::6], zz[::6], s=0.15, c=spd[::6], cmap="turbo", vmin=0, vmax=VMAX, lw=0, zorder=3)]
        c, W = cam(k)
        Hv = W * (pos1.height * FIG[1]) / (pos1.width * FIG[0])
        zlo = float(np.interp([c + W / 2, c, c - W / 2], s_bed, z_bed).min()) - 1.0
        ax1.set_xlim(c + W / 2, c - W / 2)
        ax1.set_ylim(zlo, zlo + Hv)
        sat_txt.set_y(zlo + 0.3)
        m = (s > c - W / 2 - 2) & (s < c + W / 2 + 2)
        px = pos1.width * FIG[0] * DPI / W
        ms = (0.95 * dp * px * 72 / DPI) ** 2
        sc = ax1.scatter(s[m], zz[m], s=ms, c=spd[m], cmap="turbo", vmin=0, vmax=VMAX, lw=0, zorder=3)
        art.append(sc)
        art.append(ax0.add_patch(plt.Rectangle((c - W / 2, zlo), W, Hv, fill=False, ec="k", lw=0.7, zorder=6)))
        if not state["cb"]:
            fig.colorbar(sc, cax=cax).set_label("speed (m/s)")
            state["cb"] = True
        title.set_text(f"Porto Batel reef, 236 deg line: H {cfg['H']} m, T {cfg['T']} s, tide {tide} m above LAT "
                       f"(illustrative, 2D slice)   t = {t:5.1f} s" + (f"   [{label}]" if label else ""))
        state["art"] = art

    out = OUT
    sub = out if SPLIT else out / "porto_batel"
    (sub / "frames").mkdir(parents=True, exist_ok=True)
    writer = FFMpegWriter(fps=25, bitrate=8000, codec="libx264", extra_args=["-pix_fmt", "yuv420p"])
    with writer.saving(fig, str(out / "porto_batel.mp4"), DPI):
        for k in range(len(files)):
            draw(k)
            writer.grab_frame()
    # key frames of the followed wave
    kt = {}
    kt["approach"] = float(ts[int(np.argmin(np.abs(track_s - min(300.0, s_b + 80))))])
    kt["shoaling"] = float(ts[int(np.argmin(np.abs(track_s - (s_b + 25))))])
    kt["vertical_front"] = tb
    if "overturn_seen" in fb:
        kt["jet"] = fb["overturn_seen"]["t"]
    if "t_jet_touchdown" in fb:
        kt["jet_touchdown"] = fb["t_jet_touchdown"]
    k130 = np.where((track_s < 130.0) & (ts > tb))[0]
    if k130.size:
        kt["bore_at_shelf_edge"] = float(ts[k130[0]])
    k100 = np.where((track_s < 100.0) & (ts > tb))[0]
    kt["bore_on_shelf"] = float(ts[k100[0]]) if k100.size else min(float(ts[-1]), tb + 8.0)
    for i, (name, tk) in enumerate(kt.items()):
        k = int(np.argmin(np.abs(ts - tk)))
        draw(k, name.replace("_", " ") + f", wave {wave['track']}")
        fig.savefig(sub / "frames" / f"{i + 1}_{name}.png", dpi=DPI)
    d["key_times_followed_wave"] = dict(track=wave["track"], times=kt)
    (run / "diagnostics.json").write_text(json.dumps(d, indent=1))
    if (sub / "diagnostics.json").resolve() != (run / "diagnostics.json").resolve():
        shutil.copy(run / "diagnostics.json", sub / "diagnostics.json")
    export_slice(run, meta, d, files, ts, track_s, kt, wave)
    print("wrote video, frames, slice")


def export_slice(run, meta, d, files, ts, track_s, kt, wave, n_part=2400, max_frames=150, mode="random",
                 fname="porto_batel_slice.json"):
    """v1 viewer slice. mode "random": a fixed random particle subset (sessions 4-6).
    mode "surface" (session 7, 2026-11-14): per frame, particles in a thin band at the free surface
    (same neighbour-count test as export_slice_surface, so an overturning lip with air below counts as
    surface), spread evenly along s: 1 m bins from 60 to 340 m, each bin a fixed number of slots in every
    frame, filled in order of s. Slot j therefore stays inside the same 1 m bin from frame to frame, so the
    viewer's per-index blend between frames only moves a point within its bin. Identity is not kept.
    Bins with fewer band particles than slots repeat them; dry bins borrow the nearest wet bin's."""
    cfg = meta["cfg"]
    dp = meta["dp"]
    tide = cfg["tide_above_lat"]
    sp_ = cfg["s_piston"]
    t0 = kt["approach"]
    t1 = min(float(ts[-1]), kt["bore_on_shelf"] + 4.0)
    ks = np.where((ts >= t0) & (ts <= t1))[0]
    step = max(1, int(math.ceil(ks.size / max_frames)))
    ks = ks[::step]
    # fixed particle subset: particles between 60 and 340 m from the house at the first frame
    _, x0, z0, _, _ = load_snap(files[ks[0]])
    s0 = sp_ - x0
    _, xl, _, _, _ = load_snap(files[ks[-1]])
    cand = np.where((s0 > 60) & (s0 < 340) & (xl < 655.0))[0]     # never removed by the drain in the window
    rng = np.random.default_rng(1)
    pick = np.sort(rng.choice(cand, size=min(n_part, cand.size), replace=False))
    if mode == "surface":
        edges = np.arange(60.0, 340.0 + 1e-9, 1.0)
        slots = np.array([a.size for a in np.array_split(np.arange(n_part), edges.size - 1)])
        overhangs = {}
    s_grid = np.arange(60.0, 340.0 + 1e-9, 1.0)
    frames = []
    prev = None
    for k in ks:
        t, x, z, u, w = load_snap(files[k])
        if mode == "surface":
            pick = surface_pick(x, z, dp, sp_, tide, edges, slots, rng)
            # lip / air pocket: overhang columns in ALL particles (0.1 m columns, gap > 3 dp), then how many
            # exported particles sit on the water above that gap
            ov = coherent_runs(overhang_columns(sp_ - x, z + tide, s_lo=100.0, s_hi=320.0, col=0.1, gap=0.3))
            if ov:
                sp_k, zp_k = sp_ - x[pick], z[pick] + tide
                on_lip = sum(int(np.sum((sp_k >= c_) & (sp_k < c_ + 0.1) & (zp_k >= ztop_ - 0.01)))
                             for c_, _, ztop_ in ov)
                overhangs[round(t, 2)] = (ov, on_lip)
        s_cm = np.rint((sp_ - x[pick]) * 100).astype(int)
        z_cm = np.rint((z[pick] + tide) * 100).astype(int)
        v = np.rint(np.hypot(u[pick], w[pick]) * 10).astype(int)       # dm/s
        xc, eta = eta_profile(x, z, dp, meta["info"]["x_end"])
        sc = sp_ - xc
        o = np.argsort(sc)
        e_s = np.interp(s_grid, sc[o], np.nan_to_num(eta[o], nan=-99.0))
        bed = np.interp(s_grid, *case.profile())
        surf = [int(round((e + tide) * 100)) if e > -50 and (e + tide) > b + 0.05 else None
                for e, b in zip(e_s, bed)]
        if prev is None:
            fr = dict(t=round(t, 2), s_cm=s_cm.tolist(), z_cm=z_cm.tolist(), v_dms=v.tolist(), surface_cm=surf)
        else:
            fr = dict(t=round(t, 2), ds_cm=(s_cm - prev[0]).tolist(), dz_cm=(z_cm - prev[1]).tolist(),
                      v_dms=v.tolist(), surface_cm=surf)
        prev = (s_cm, z_cm)
        frames.append(fr)
    s_b, zl_b = case.profile()
    m = (s_b >= cfg["s_shore"]) & (s_b <= sp_)
    # local frame of the viewer (same flat-earth origin as simulate_swell.py / reefs.json)
    O_LAT, O_LON, MPD = 39.322, -9.3625, 111195.0
    hx = (-9.355772 - O_LON) * MPD * math.cos(math.radians(O_LAT))
    hy = (39.319506 - O_LAT) * MPD
    fb = wave["first_break"]
    out = dict(
        meta=dict(
            case="Porto Batel reef, regular swell on the 236 deg line (illustrative 2D slice)",
            label="illustrative 2D slice",
            house_lat=39.319506, house_lon=-9.355772, bearing_deg=236.0,
            house_x_m=round(hx, 2), house_y_m=round(hy, 2),
            frame_origin="x_m east / y_m north of 39.322 N, -9.3625 E (M_PER_DEG 111195), as reefs.json",
            direction_unit_xy=[round(math.sin(math.radians(236)), 5), round(math.cos(math.radians(236)), 5)],
            vertical_datum="LAT", tide_above_lat_m=tide, H_m=cfg["H"], T_s=cfg["T"], dp_m=dp,
            frame_dt_s=round(float(ts[ks[1]] - ts[ks[0]]), 3) if ks.size > 1 else None,
            n_frames=len(frames), n_particles=int(pick.size), followed_wave=wave["track"],
            first_break_s_m=fb["s_from_house_m"], sat_here_user_s_m=cfg["sat_here_m"],
            fields=dict(
                s_cm="distance from the house along the bearing (cm); first frame absolute",
                ds_cm="change of s_cm since the previous frame (cm); later frames",
                z_cm="height above LAT (cm); first frame absolute", dz_cm="change of z_cm since previous frame",
                v_dms="particle speed (dm/s)",
                surface_cm="free surface height above LAT (cm) every 1 m of surface_s_m; null where dry"),
            surface_s_m=dict(start=60, stop=340, step=1),
            notes=["2D simulation (WCSPH) on one line through the 2011 lidar (11 x 14 m grid, interpolated "
                   "between cells); no refraction or alongshore variation; the paddle-out channel is missing",
                   ("particles are a fixed random subset; the same index is the same particle in every frame"
                    if mode == "random" else
                    "particles are a thin band at the free surface (overturning lips included), the same number "
                    "in every 1 m of s; index j stays in the same 1 m bin, but is not the same particle between "
                    "frames"),
                   "profile position uncertain by about one grid cell (9-12 m)"]),
        bed=dict(s_m=[round(float(v), 1) for v in s_b[m][::2]],
                 z_above_lat_m=[round(float(v), 2) for v in zl_b[m][::2]]),
        frames=frames)
    p = OUT / fname
    p.write_text(json.dumps(out, separators=(",", ":")))
    print(f"slice ({mode}): {len(frames)} frames, {pick.size} particles, {p.stat().st_size / 1e6:.2f} MB")
    if mode == "surface":
        frame_t = [fr["t"] for fr in frames]
        rep = {str(t_): dict(frame=frame_t.index(t_), n_columns_0p1m=len(v), s_range_m=[v[0][0], v[-1][0]],
                             exported_particles_on_lip=n_, example_s_zbelow_zabove=v[:2])
               for t_, (v, n_) in overhangs.items()}
        rep = dict(note="runs of >= 5 adjacent 0.1 m columns, s 100-320 m, where ALL simulated particles show water above a gap > 0.3 m "
                        "above water (air under a lip); exported_particles_on_lip = slice particles on the water "
                        "above that gap", by_t=rep)
        (OUT / (Path(fname).stem + "_overhangs.json")).write_text(json.dumps(rep, indent=1))
        for t_, r_ in rep["by_t"].items():
            print(f"  t {t_}: frame {r_['frame']}, {r_['n_columns_0p1m']} overhang cols, s {r_['s_range_m']}, "
                  f"{r_['exported_particles_on_lip']} slice pts on lip")


def coherent_runs(cols, min_cols=5, join=0.25):
    """Keep overhang columns that belong to a run of >= min_cols columns (each within `join` m of the
    next), i.e. a lip at least about 0.5 m long; drops single stray particles above the surface."""
    cols = sorted(cols)
    runs, cur = [], []
    for c in cols:
        if cur and c[0] - cur[-1][0] > join:
            runs.append(cur)
            cur = []
        cur.append(c)
    if cur:
        runs.append(cur)
    return [c for r in runs if len(r) >= min_cols for c in r]


def surface_pick(x, z, dp, sp_, tide, edges, slots, rng, ring=0.12):
    """Indices for one frame of the surface-band v1 slice (see export_slice). Removed (drained) particles
    are skipped. Surface test as export_slice_surface: < 11 neighbours within 2 dp and > 0.25 m above the
    bed, grown by `ring` m (about 1-2 dp) so the surface reads as a band."""
    from scipy.spatial import cKDTree
    alive = np.where(x < 655.0)[0]
    s = sp_ - x[alive]
    zz = z[alive] + tide
    win = (s > edges[0] - 1.0) & (s < edges[-1] + 1.0)
    alive, s, zz = alive[win], s[win], zz[win]
    P = np.c_[s, zz]
    tree = cKDTree(P)
    nn = tree.query_ball_point(P, 2 * dp, return_length=True)
    s_all, zl_all = case.profile()
    core = (nn < 11) & ((zz - np.interp(s, s_all, zl_all)) > 0.25)
    surf = np.zeros(s.size, bool)
    if core.any():
        near = tree.query_ball_point(P[core], ring)
        surf[np.unique(np.concatenate([np.asarray(a, int) for a in near]))] = True
    band = np.where(surf & (s >= edges[0]) & (s < edges[-1]))[0]
    b = np.digitize(s[band], edges) - 1
    members = [band[b == i] for i in range(edges.size - 1)]
    wet = np.array([m.size > 0 for m in members])
    wet_i = np.where(wet)[0]
    out = []
    for i, n in enumerate(slots):
        m = members[i] if wet[i] else members[wet_i[np.argmin(np.abs(wet_i - i))]]
        ch = rng.choice(m, size=n, replace=m.size < n)
        out.append(ch[np.argsort(s[ch])])
    return alive[np.concatenate(out)]


def overhang_columns(s, z, s_lo=150.0, s_hi=210.0, col=0.1, gap=0.3):
    """Columns (width col) in [s_lo, s_hi] where water sits above air above water: a vertical gap
    > gap between consecutive particles in the column. Returns a list of (s, z_below_top, z_above_bottom)."""
    m = (s > s_lo) & (s < s_hi)
    ic = np.floor(s[m] / col).astype(int)
    zz = z[m]
    o = np.lexsort((zz, ic))
    ic, zz = ic[o], zz[o]
    same = ic[1:] == ic[:-1]
    dz = zz[1:] - zz[:-1]
    hit = np.where(same & (dz > gap))[0]
    return [(round(float(ic[i] * col), 2), round(float(zz[i]), 2), round(float(zz[i + 1]), 2)) for i in hit]


def export_slice_surface(run, n_interior=6000, ring=0.12, s_lo=60.0, s_hi=340.0):
    """Slice export v2: every particle at or near the free surface plus a thin random interior sample.

    Free surface: fewer than 11 neighbours (self included) within 2 dp (a bulk particle has about 13),
    more than 0.25 m above the bed (fluid on the bed also lacks neighbours), then grown by `ring` m so the
    surface is two to three particles thick. This works for an overturning jet, unlike a single-valued
    eta(s). Per frame the surface set is new, so frames store absolute positions in a binary side file:
    for each frame n x uint16 (s cm - 6000), n x int16 (z cm above LAT), n x uint8 (speed dm/s), padded to
    an even byte count. The first n_surface of each frame are surface particles."""
    from scipy.spatial import cKDTree
    run = Path(run)
    d = json.loads((run / "diagnostics.json").read_text())
    meta = json.loads((run / "meta.json").read_text())
    cfg = meta["cfg"]
    dp = meta["dp"]
    tide = cfg["tide_above_lat"]
    sp_ = cfg["s_piston"]
    kt = d["key_times_followed_wave"]["times"]
    track = d["key_times_followed_wave"]["track"]
    wave = next(w for w in d["waves"] if w["track"] == track)
    fb = wave["first_break"]
    t0 = kt["approach"]
    t1 = min(78.0, kt["bore_on_shelf"] + 4.0)
    tv, ttd = kt["vertical_front"], kt.get("jet_touchdown", kt["vertical_front"] + 0.7)
    fine0, fine1 = math.floor(tv - 2.7), math.ceil(ttd + 2.6)       # 40-46 s for this run
    times = sorted(set([round(t, 1) for t in np.arange(t0, t1 + 1e-6, 0.2)] +
                       [round(t, 1) for t in np.arange(fine0, fine1 + 1e-6, 0.1)]))
    s_all, zl_all = case.profile()
    rng = np.random.default_rng(1)
    blobs, frames, off = [], [], 0
    over = {}
    for t in times:
        f = run / f"snap_{int(round(t / cfg['dt_out'])):04d}.npz"
        tt, x, z, u, w = load_snap(f)
        assert abs(tt - t) < 1e-6, (f, tt, t)
        s = sp_ - x
        zz = z + tide
        win = (s > s_lo) & (s < s_hi)
        s, zz, spd = s[win], zz[win], np.hypot(u[win], w[win])
        P = np.c_[s, zz]
        tree = cKDTree(P)
        nn = tree.query_ball_point(P, 2 * dp, return_length=True)
        bed = np.interp(s, s_all, zl_all)
        core = (nn < 11) & ((zz - bed) > 0.25)
        near = tree.query_ball_point(P[core], ring)
        surf = np.zeros(s.size, bool)
        surf[np.unique(np.concatenate([np.asarray(a, int) for a in near]))] = True
        isurf = np.where(surf)[0]
        rest = np.where(~surf)[0]
        iint = np.sort(rng.choice(rest, size=min(n_interior, rest.size), replace=False))
        idx = np.concatenate([isurf, iint])
        sc = np.rint((s[idx] - s_lo) * 100).astype(np.uint16)
        zc = np.rint(zz[idx] * 100).astype(np.int16)
        vc = np.clip(np.rint(spd[idx] * 10), 0, 255).astype(np.uint8)
        b = sc.tobytes() + zc.tobytes() + vc.tobytes()
        if len(b) % 2:
            b += b"\0"
        frames.append(dict(t=t, off=off, n=int(idx.size), n_surface=int(isurf.size)))
        blobs.append(b)
        off += len(b)
        if tv - 0.5 <= t <= ttd + 0.6:
            over[t] = (overhang_columns(s, zz),)                   # all particles, full resolution
    p_bin = OUT / f"porto_batel_slice_v2{V2_SUFFIX}.bin"
    p_bin.write_bytes(b"".join(blobs))
    # anchor of the label: the first vertical front of the followed wave
    tf, xf, zf, _, _ = load_snap(run / f"snap_{int(round(tv / cfg['dt_out'])):04d}.npz")
    sf = sp_ - xf
    mm = np.abs(sf - fb["s_from_house_m"]) < 3.0
    z_front = float(zf[mm].max() + tide) if mm.any() else None
    m = (s_all >= cfg["s_shore"]) & (s_all <= sp_)
    O_LAT, O_LON, MPD = 39.322, -9.3625, 111195.0
    hx = (-9.355772 - O_LON) * MPD * math.cos(math.radians(O_LAT))
    hy = (39.319506 - O_LAT) * MPD
    ns = [fr["n"] for fr in frames]
    out = dict(
        meta=dict(
            case="Porto Batel reef, regular swell on the 236 deg line (illustrative 2D slice)",
            label="illustrative 2D slice, true scale",
            version=2, binary=f"porto_batel_slice_v2{V2_SUFFIX}.bin",
            binary_layout="per frame at byte off: n x uint16 (s cm - s0_cm), n x int16 (z cm above LAT), "
                          "n x uint8 (speed dm/s), padded to even; first n_surface are surface particles",
            s0_cm=int(s_lo * 100),
            house_lat=39.319506, house_lon=-9.355772, bearing_deg=236.0,
            house_x_m=round(hx, 2), house_y_m=round(hy, 2),
            frame_origin="x_m east / y_m north of 39.322 N, -9.3625 E (M_PER_DEG 111195), as reefs.json",
            direction_unit_xy=[round(math.sin(math.radians(236)), 5), round(math.cos(math.radians(236)), 5)],
            vertical_datum="LAT", tide_above_lat_m=tide, H_m=cfg["H"], T_s=cfg["T"], dp_m=dp,
            frame_dt_s=dict(coarse=0.2, fine=0.1, fine_from_s=fine0, fine_to_s=fine1),
            n_frames=len(frames), n_particles_min=min(ns), n_particles_max=max(ns),
            followed_wave=track, first_break_s_m=fb["s_from_house_m"],
            vertical_front=dict(t=tv, s_m=fb["s_from_house_m"], crest_z_above_lat_m=round(z_front, 2)),
            jet_touchdown_t=ttd, sat_here_user_s_m=cfg["sat_here_m"],
            overhang_check=dict(note="0.1 m columns in s 150-210 m where all simulated particles show water above "
                                    "a gap > 0.3 m (3 dp) above water",
                               by_t={str(k): dict(n_columns=len(v[0]), example=v[0][:3]) for k, v in over.items()}),
            notes=["2D simulation (WCSPH) on one line through the 2011 lidar (11 x 14 m grid, interpolated "
                   "between cells); no refraction or alongshore variation; the paddle-out channel is missing",
                   "every particle within about 3 dp of the free surface is kept (neighbour count), plus a "
                   "random interior sample; particle identity is not kept between frames",
                   "profile position uncertain by about one grid cell (9-12 m)"]),
        bed=dict(s_m=[round(float(v), 1) for v in s_all[m][::2]],
                 z_above_lat_m=[round(float(v), 2) for v in zl_all[m][::2]]),
        frames=frames)
    p = OUT / f"porto_batel_slice_v2{V2_SUFFIX}.json"
    p.write_text(json.dumps(out, separators=(",", ":")))
    print(f"slice v2: {len(frames)} frames, {min(ns)}-{max(ns)} particles/frame, "
          f"json {p.stat().st_size / 1e3:.0f} kB, bin {p_bin.stat().st_size / 1e6:.2f} MB")
    for k, v in over.items():
        print(f"  t {k:5.1f}: overhang columns {len(v[0])} {v[0][:3]}")


if __name__ == "__main__":
    argv = sys.argv[1:]
    if "--out" in argv:
        i = argv.index("--out")
        OUT = Path(argv[i + 1]).resolve()
        SPLIT = True
        del argv[i:i + 2]
    if "--v2-suffix" in argv:
        i = argv.index("--v2-suffix")
        V2_SUFFIX = argv[i + 1]
        del argv[i:i + 2]
    OUT.mkdir(parents=True, exist_ok=True)
    if len(argv) > 1 and argv[1] == "--slice-v2":
        export_slice_surface(argv[0])
    elif len(argv) > 1 and argv[1] in ("--slice-v1-surface", "--slice-v1-random"):
        # session 7: v1 slice only, from an already rendered run (needs key_times_followed_wave in
        # diagnostics.json). Writes OUT/porto_batel_slice_surface.json or porto_batel_slice_random.json.
        run_ = Path(argv[0])
        d_ = json.loads((run_ / "diagnostics.json").read_text())
        meta_ = json.loads((run_ / "meta.json").read_text())
        files_ = sorted(run_.glob("snap_*.npz"))
        ts_ = np.array([float(np.load(f)["t"]) for f in files_])
        kt_ = d_["key_times_followed_wave"]["times"]
        wave_ = next(w for w in d_["waves"] if w["track"] == d_["key_times_followed_wave"]["track"])
        mode_ = "surface" if argv[1] == "--slice-v1-surface" else "random"
        export_slice(run_, meta_, d_, files_, ts_, None, kt_, wave_, mode=mode_,
                     fname=f"porto_batel_slice_{mode_}.json")
    else:
        main(argv[0])
