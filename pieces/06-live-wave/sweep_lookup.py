"""Sweep Stage A over (Tp, direction, tide, H0) and write the browser lookup table to lookup/.

Run (detached):  nohup python sweep_lookup.py --workers 12 > lookup/sweep.log 2>&1 &
Pipeline:        nohup python sweep_lookup.py --site pipeline --workers 12 > lookup_pipeline/sweep.log 2>&1 &
(--site picks the grid and output folder below; Porto Batel stays the default and its files are unchanged.)
Resumable: every (Tp, dir, tide) node is written to lookup/parts/ as soon as it is done (atomic rename), and nodes
already there are skipped. When all nodes exist, the parts are packed into lookup/index.json + lookup/T{Tp}.bin.
`--assemble` packs only. `--time N` times N random nodes and exits.
"""
import argparse
import json
import os
import sys
import time
from multiprocessing import Pool
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import stage_a as sa  # noqa: E402
import sites  # noqa: E402

OUT = HERE / "lookup"
PARTS = OUT / "parts_v2"
SITE = None   # None = Porto Batel (the original code path); set by --site

# ---- grid v2 (2026-11-16, see lookup/README.md). v1 (9 H0 x 15 tides) put the 400-point check's p95 error at 28 m,
# worst at H0 >= 3 m (1 m steps) and low tide; v2 halves the H0 and tide steps and makes direction 5 deg throughout.
TP = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20]
DIR = list(range(250, 361, 5))                                         # 23
TIDE = [round(0.125 * i, 3) for i in range(33)]                        # 0-4 m every 0.125 m
HS = [round(0.5 + 0.25 * i, 2) for i in range(19)]                     # 0.5-5 m every 0.25 m
NPROF = len(sa.PROFILE_OFFSETS)
# ---- Pipeline grid (2026-11-16): North Shore climatology. Hs 0.5-8 m (0.25 m), Tp 8-18 s every 1 then 20, 22 s,
# direction 270-390 deg every 5 (390 = 30 deg: the axis runs through north so it is monotonic), tide -0.3..0.9 m LMSL every 0.1 m.
PIPELINE_GRID = dict(TP=[8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22], DIR=list(range(270, 391, 5)),
                     TIDE=[round(-0.3 + 0.1 * i, 2) for i in range(13)], HS=[round(0.5 + 0.25 * i, 2) for i in range(31)],
                     OUT=HERE / "lookup_pipeline")
SCALARS = ["status", "break_house", "breaker_H_house", "peel_angle_near", "peel_speed_near",
           "peel_angle_line", "peel_speed_line"]
SCALAR_SCALE = [1, 10, 100, 100, 100, 100, 100]    # uint16 = round(value x scale): 0.1 m, 0.01 m, 0.01 deg, 0.01 m/s
# status: 0 breaks on the house line, 1 breaks on the reef but not on the house line, 2 no break in the domain,
#         3 no phase (no upwind seed cell deeper than 1 m)
NOBREAK = 65535


def part_path(tp, d, tide):
    return PARTS / f"T{tp:g}_D{d:g}_tide{tide:g}.npz"


def do_node(args):
    tp, d, tide = args
    path = part_path(tp, d, tide)
    if path.exists():
        return args, 0.0, True
    t0 = time.perf_counter()
    P = sa.phase_part(float(tp), float(d), float(tide), SITE)
    nh = len(HS)
    break_s = np.full((nh, NPROF), np.nan, np.float32)
    scal = np.full((nh, len(SCALARS)), np.nan, np.float32)
    i0 = int(np.argmin(np.abs(sa.PROFILE_OFFSETS)))
    for q, hs in enumerate(HS):
        if P is None:
            scal[q, 0] = 3
            continue
        r = sa.height_part(P, hs)
        break_s[q] = r["break_s"]
        status = 0 if np.isfinite(r["break_house"]) else (1 if r["n_broken"] > 0 else 2)
        scal[q] = [status, r["break_house"], r["breaker_H"][i0], r["peel_angle_near"], r["peel_speed_near"],
                   r["peel_angle_line"], r["peel_speed_line"]]
    tmp = path.with_suffix(".tmp.npz")
    np.savez(tmp, break_s=break_s, scalars=scal)
    os.replace(tmp, path)
    return args, time.perf_counter() - t0, False


def init_worker(site_key=None):
    global SITE
    if site_key:
        use_site(site_key)
    sa.bed_grid(SITE)


def use_site(key):
    """Switch the module to another site's grid, axes and output folder (Porto Batel = the defaults above)."""
    global SITE, TP, DIR, TIDE, HS, OUT, PARTS
    if key in (None, "porto_batel"):
        return
    SITE = sites.SITES[key]
    g = PIPELINE_GRID if key == "pipeline" else None
    TP, DIR, TIDE, HS, OUT = g["TP"], g["DIR"], g["TIDE"], g["HS"], g["OUT"]
    PARTS = OUT / "parts"


def site_index(index):
    """Pipeline (or any non-default site) index.json fields: generic tide axis name, site geometry, datum, reef bands."""
    S = SITE
    ax = index["axes"]; ax["tide_above_datum_m"] = ax.pop("tide_above_LAT_m")
    x, y, bed, _ = sa.bed_grid(S)
    i0 = int(np.argmin(np.abs(x))); line = bed[:, i0]
    j = int(np.nonzero(line < 0)[0][0])                         # first cell below 0 m on the reference line
    shore_s = float(y[j - 1] + (y[j] - y[j - 1]) * line[j - 1] / (line[j - 1] - line[j]))   # linear crossing of 0 m LMSL
    index.update(
        description=f"{S['name']} Stage A lookup (pieces/06-live-wave/stage_a.py, site '{S['key']}' in sites.py). See README.md.",
        site=S["key"], profile_line_deg=S["line_deg"], profile_along_deg=S["along_deg"], grid_deg=S["grid_deg"],
        house=dict(lat=S["origin_lat"], lon=S["origin_lon"], what=S["origin_name"]),
        takeoff=S["takeoff"], datum=dict(name=S["datum"], words=S["tide_words"], msl_minus_datum_m=0.0,
                                         note="Open-Meteo sea level (MSL, tide + surge) is taken as height above LMSL; not checked"),
        shore_s_lmsl_m=round(shore_s, 1), reefs=[dict(name=n, from_shore_m=[a, b if b < 1e8 else None]) for n, a, b in S["reefs"]],
        profile_s_max_m=S["s_max"] - 2.0,
    )
    index["axes"] = dict(tp_s=ax["tp_s"], dir_from_deg=ax["dir_from_deg"], tide_above_datum_m=ax["tide_above_datum_m"], H0_m=ax["H0_m"])
    index["dir_note"] = "directions run 270-390 through north (390 = 30 deg); a forecast direction d < 180 is used as d + 360"
    return index


def q16(a, scale, cap=65534):
    """Quantise to uint16; NaN -> 65535."""
    out = np.full(a.shape, NOBREAK, np.uint16)
    m = np.isfinite(a)
    out[m] = np.clip(np.rint(a[m] * scale), 0, cap).astype(np.uint16)
    return out


def assemble():
    nd, nt, nh = len(DIR), len(TIDE), len(HS)
    n = nd * nt * nh
    index = dict(
        description="Porto Batel Stage A lookup v2 (pieces/06-live-wave/stage_a.py). See README.md.",
        format="v2", axes=dict(tp_s=TP, dir_from_deg=DIR, tide_above_LAT_m=TIDE, H0_m=HS),
        node_order="for each Tp file: [dir][tide][H0], row-major",
        profile_offsets_m=sa.PROFILE_OFFSETS.tolist(), profile_line_deg=sa.LINE_DEG, profile_along_deg=sa.ALONG_DEG,
        house=dict(lat=sa.HOUSE_LAT, lon=sa.HOUSE_LON), datum=dict(msl_minus_lat_m=1.66, uncertainty_m=[0.1, 0.3]),
        gamma=sa.GAMMA, nobreak_u16=NOBREAK, scalar_columns=SCALARS, scalar_scale=SCALAR_SCALE,
        arrays=[dict(name="break_s", dtype="uint16", per_node=NPROF, scale=10.0, byte_offset=0, byte_length=n * NPROF * 2,
                     unit="m along the profile, value/10; 65535 = no break on that profile"),
                dict(name="scalars", dtype="uint16", per_node=len(SCALARS), byte_offset=n * NPROF * 2,
                     byte_length=n * len(SCALARS) * 2, unit="value/scalar_scale per column; 65535 = NaN")],
        files={},
        status_codes={"0": "breaks on the house line", "1": "breaks on the reef, not on the house line",
                      "2": "no break in the domain", "3": "no phase (no upwind seed deeper than 1 m)"},
    )
    if SITE is not None:
        index = site_index(index)
    missing = 0
    for tp in TP:
        bs = np.full((nd, nt, nh, NPROF), np.nan, np.float32)
        sc = np.full((nd, nt, nh, len(SCALARS)), np.nan, np.float32)
        for a, d in enumerate(DIR):
            for b, tide in enumerate(TIDE):
                p = part_path(tp, d, tide)
                if not p.exists():
                    missing += 1; continue
                z = np.load(p)
                bs[a, b], sc[a, b] = z["break_s"], z["scalars"]
        scq = np.full(sc.shape, NOBREAK, np.uint16)
        for c, k in enumerate(SCALAR_SCALE):
            scq[..., c] = q16(sc[..., c], k)
        blob = q16(bs, 10).tobytes() + scq.tobytes()
        fn = f"T{tp:g}.bin"
        (OUT / fn).write_bytes(blob)
        index["files"][str(tp)] = fn
    index["missing_nodes"] = missing
    (OUT / "index.json").write_text(json.dumps(index, indent=1))
    print(f"assembled {len(TP)} files, {len(blob)/1e6:.2f} MB each, missing phase nodes {missing}", flush=True)


def shore_table():
    """lookup/shore.json: per tide and profile, the distance s of the first dry cell (h <= 0.05 m) met walking shoreward from
    the seaward end of the profile. Lets the browser tell a break on the reef from one at the water's edge (shore or dry rock).
    Bed only, no wave physics; same grid and profile stepping as stage_a.height_part."""
    out = [sa.water_edge(t, site=SITE) for t in TIDE]
    if SITE is None:
        (OUT / "shore.json").write_text(json.dumps(dict(
            what="distance along each profile (m) of the first dry cell (h <= 0.05 m) walking shoreward from 698 m; null = none",
            tide_above_LAT_m=TIDE, profile_offsets_m=sa.PROFILE_OFFSETS.tolist(), edge_s_m=out)))
    else:
        (OUT / "shore.json").write_text(json.dumps(dict(
            what=f"distance along each profile (m) of the first dry cell (h <= 0.05 m) walking shoreward from {SITE['s_max'] - 2:.0f} m; null = none",
            tide_above_LAT_m=TIDE, tide_above_datum_m=TIDE, datum=SITE["datum"], profile_offsets_m=SITE["profile_offsets"].tolist(), edge_s_m=out)))
    print("wrote shore.json; house line edge by tide:", [r[len(sa.PROFILE_OFFSETS) // 2] for r in out])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--assemble", action="store_true")
    ap.add_argument("--time", type=int, default=0)
    ap.add_argument("--shore", action="store_true", help="write lookup/shore.json only")
    ap.add_argument("--site", default="porto_batel", choices=sorted(sites.SITES))
    a = ap.parse_args()
    use_site(a.site)
    PARTS.mkdir(parents=True, exist_ok=True)
    if a.shore:
        return shore_table()
    if a.assemble:
        return assemble()
    nodes = [(tp, d, t) for tp in TP for d in DIR for t in TIDE]
    if a.time:
        rng = np.random.default_rng(0)
        sa.bed_grid(SITE)
        for k in rng.choice(len(nodes), a.time, replace=False):
            tp, d, t = nodes[k]; t0 = time.perf_counter(); P = sa.phase_part(tp, d, t, SITE); t1 = time.perf_counter()
            if P is not None:
                [sa.height_part(P, hs) for hs in HS]
            print(f"T{tp} D{d} tide{t}: phase {t1-t0:.2f} s, {len(HS)} heights {time.perf_counter()-t1:.2f} s", flush=True)
        return
    todo = [n for n in nodes if not part_path(*n).exists()]
    print(f"{time.strftime('%H:%M:%S')} grid {len(TP)}x{len(DIR)}x{len(TIDE)} phase nodes = {len(nodes)} "
          f"(x {len(HS)} H0 = {len(nodes)*len(HS)} nodes); to do {len(todo)}; workers {a.workers}", flush=True)
    t0 = time.time(); done = 0
    with Pool(a.workers, initializer=init_worker, initargs=(SITE and SITE["key"],)) as pool:
        for (node, dt, skipped) in pool.imap_unordered(do_node, todo, chunksize=1):
            done += 1
            if done <= 5 or done % 100 == 0 or done == len(todo):
                el = time.time() - t0
                eta = el / done * (len(todo) - done)
                print(f"{time.strftime('%H:%M:%S')} {done}/{len(todo)} last T{node[0]} D{node[1]} tide{node[2]} {dt:.2f} s; "
                      f"elapsed {el/60:.1f} min, ETA {eta/60:.1f} min", flush=True)
    assemble()
    if SITE is not None:
        shore_table()
    print(f"{time.strftime('%H:%M:%S')} done", flush=True)


if __name__ == "__main__":
    main()
