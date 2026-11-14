"""The simulate_swell.py swell model, run on other spots (Pipeline, Supertubos, Basque coast).

Run:  python simulate_swell_spot.py --spot pipeline      (or supertubos, basque)
Reads  a points file in the reefs.json format (x_m, y_m, depth_m, shore; one regular grid, gaps allowed)
Writes ../01-seafloor/viewer/data/<spot>_swell.json   (same format as swell_sim.json, same order as the points file)
       ../03-breaking-wave/data/<spot>_profile.csv     (bed profile through the take-off along the wave's path, for the SPH case)
       out_spots/<spot>_swell.png                      (map: wave height, surf zone, take-off, profile line)
       out_spots/<spot>_swell_summary.json

The physics is a copy of simulate_swell.py (shoaling, Snell refraction on the local smoothed shore, breaking at
gamma x depth, march shoreward). simulate_swell.py itself is NOT changed: it runs at import time and is tied to
reefs.json and the Porto Batel marks. Read its docstring for what the model does and does not do.

Every result here is ILLUSTRATIVE, NOT A FORECAST: one "typical" swell per spot, from a buoy or a hindcast
climatology (source and numbers in SPOTS below and in the output meta).
"""
import argparse
import csv
import json
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from scipy import ndimage as ndi

HERE = Path(__file__).parent
VIEW = HERE.parent / "01-seafloor" / "viewer" / "data"
SPH_DATA = HERE.parent / "03-breaking-wave" / "data"
OUT = HERE / "out_spots"
g = 9.81
M_PER_DEG = 111195.0
GAMMA = 0.78
WET_MIN_M = 0.05
MAX_THETA0_DEG = 80
NORMAL_SMOOTH_M = 100
REGIONAL_SMOOTH_M = 600

# ------------------------------------------------------------------------------------------------------------
# One block per spot. "typical swell" = median of the long-period winter swell at the source (Nov-Mar).
# ------------------------------------------------------------------------------------------------------------
SPOTS = {
    "pipeline": dict(
        title="Pipeline, Oahu",
        points=VIEW / "pipeline.json",
        H0=2.1, T=14.3, direction_from=320, tide=0.0, wrapped=False, edge_depth=None,
        swell_source=("NOAA NDBC 51201 Waimea Bay buoy (public domain), historical stdmet 2024 + 2025, months Nov-Mar, "
                      "records with MWD 280-350 deg and DPD >= 12 s (n = 8,321): median WVHT 2.11 m, DPD 14.29 s, "
                      "MWD 320 deg (p75 WVHT 2.62 m). All winter records: median WVHT 2.01 m, DPD 13.3 s. "
                      "Files pieces/05-pipeline/data/raw/ndbc_51201/51201h2024.txt.gz, 51201h2025.txt.gz"),
        tide_note="0.0 m = LMSL (the datum of the lidar); Haleiwa spring range is only ~0.6 m",
        datum="LMSL",
        takeoff=dict(lat=21.66389, lon=-158.05389, how="published spot position (Wikipedia, Banzai Pipeline), approximate"),
        shore_side=0,          # profile shoreward end: walk from the take-off until the bed is above the water
    ),
    "supertubos": dict(
        title="Supertubos, Peniche",
        points=VIEW / "reefs_wide.json",
        H0=2.2, T=13.5, direction_from=304, tide=1.7, wrapped=False, edge_depth=None,
        swell_source=("Open-Meteo Marine hindcast (model, not a buoy), point 39.375 N 9.458 W (requested 39.36, -9.45), "
                      "hourly Nov 2024-Mar 2025 + Nov 2025-Mar 2026 (n = 7,248): median swell_wave_height 2.22 m, "
                      "swell_wave_peak_period 13.5 s, swell_wave_direction 304 deg. No open Peniche buoy with direction "
                      "was found. Files pieces/02-reefs/data/raw/openmeteo_hindcast/peniche_*.json"),
        tide_note="1.7 m above LAT ~ Peniche mean level (IH: mean level 2.00 m above ZH, LAT 2026 ~ ZH + 0.34 m)",
        datum="LAT",
        # The cited Supertubos coordinate (39.34, -9.36) is on land. The take-off is picked from the model: the outermost
        # break onset (first broken cell) nearest to the cited point. Labelled approximate.
        takeoff=dict(lat=39.34, lon=-9.36, how="model break onset nearest the cited Supertubos coordinate (39.34, -9.36, "
                     "which is on land); approximate", from_model=True),
        caveat="Sand beach break: the 2011 lidar seabed; the bars have moved since. Illustrative.",
    ),
    "guethary": dict(
        title="Guethary / Parlementia, France",
        points=VIEW / "guethary.json",
        H0=1.6, T=13.5, direction_from=305, tide=0.0, wrapped=False, edge_depth=None,
        swell_source=("Open-Meteo Marine hindcast (model, not a buoy), point near 43.45 N 1.70 W, hourly Nov 2024-Mar 2025 "
                      "+ Nov 2025-Mar 2026 (n = 7,248): median swell_wave_height 1.58 m, swell_wave_peak_period 13.5 s, "
                      "swell_wave_direction 305 deg. Files pieces/02-reefs/data/raw/openmeteo_hindcast/basque_*.json"),
        tide_note="0.0 m above IGN69 ~ mean sea level on this coast (IGN69 zero lies within ~0.2 m of mean level at Bayonne/Socoa); spring range ~4 m",
        datum="IGN69",
        takeoff=dict(lat=43.427718, lon=-1.611053, how="published Parlementia position (surf-guide source), approximate"),
        caveat="Litto3D lidar (Shom - IGN, 2025, NAQ 2020-2022) reaches only ~17-29 m depth near the spot; deeper refraction is not modelled. Spot position approximate. Illustrative.",
    ),
    "hossegor": dict(
        title="Hossegor / La Graviere, France",
        points=VIEW / "hossegor.json",
        H0=1.6, T=13.5, direction_from=305, tide=0.0, wrapped=False, edge_depth=None,
        swell_source=("Open-Meteo Marine hindcast (model, not a buoy), point near 43.45 N 1.70 W, hourly Nov 2024-Mar 2025 "
                      "+ Nov 2025-Mar 2026 (n = 7,248): median swell_wave_height 1.58 m, swell_wave_peak_period 13.5 s, "
                      "swell_wave_direction 305 deg. Files pieces/02-reefs/data/raw/openmeteo_hindcast/basque_*.json"),
        tide_note="0.0 m above IGN69 ~ mean sea level on this coast (IGN69 zero lies within ~0.2 m of mean level at Bayonne/Socoa); spring range ~4 m",
        datum="IGN69",
        takeoff=dict(lat=43.67562, lon=-1.443375, how="published La Graviere position (surf-guide source), approximate"),
        caveat="Litto3D lidar (Shom - IGN, 2025, NAQ 2020-2022) reaches only ~17-29 m depth near the spot; deeper refraction is not modelled. Spot position approximate. Illustrative.".replace("Spot position", "Sand beach break, seabed 2020-2022; the bars move. Spot position"),
    ),
}


def wavenumber(T, d):
    omega = 2 * np.pi / T
    d = np.asarray(d, dtype=float)
    k = omega**2 / g / np.sqrt(np.tanh(omega**2 * d / g))
    for _ in range(20):
        th = np.tanh(k * d)
        f = g * k * th - omega**2
        df = g * th + g * k * d * (1 - th**2)
        k = k - f / df
    return k


def wave_speeds(T, d):
    k = wavenumber(T, d)
    c = (2 * np.pi / T) / k
    kd2 = np.minimum(2 * k * d, 700)
    Cg = c / 2 * (1 + kd2 / np.sinh(kd2))
    return k, c, Cg


def load_grid(path):
    """Points file (reefs.json format) -> 2D arrays. Returns depth grid (NaN = no data) and the (row, col) of each point."""
    P = json.loads(Path(path).read_text())
    x = np.asarray(P["x_m"], float); y = np.asarray(P["y_m"], float); z = np.asarray(P["depth_m"], float)
    def step(v):
        u = np.unique(np.round(v, 1)); dv = np.diff(u)            # file values are rounded, so use the full span
        n_steps = int(np.round((u[-1] - u[0]) / np.mean(dv[(dv > 0.5) & (dv < 1.5 * np.median(dv[dv > 0.5]))])))
        return float((u[-1] - u[0]) / n_steps)
    dx, dy = step(x), step(y)
    ic = np.round((x - x.min()) / dx).astype(int); ir = np.round((y - y.min()) / dy).astype(int)
    grid = np.full((ir.max() + 1, ic.max() + 1), np.nan)
    grid[ir, ic] = z
    assert np.isfinite(grid).sum() == len(z), "two points fell in one cell"
    xs = x.min() + np.arange(grid.shape[1]) * dx; ys = y.min() + np.arange(grid.shape[0]) * dy
    X, Y = np.meshgrid(xs, ys)
    return P, grid, X, Y, dx, dy, ir, ic


def model(lidar, dx, dy, H0, T, direction_from, tide, gamma=GAMMA, wrapped=False, edge_depth=None):
    valid = np.isfinite(lidar)

    def shore_normal(smooth_m):
        d = lidar + tide
        dry = valid & (d <= WET_MIN_M)
        dist = ndi.distance_transform_edt(~dry, sampling=(dy, dx))
        sm = ndi.gaussian_filter(dist, sigma=(smooth_m / 2 / dy, smooth_m / 2 / dx))
        gy, gx = np.gradient(sm, dy, dx)
        norm = np.hypot(gx, gy) + 1e-9
        return -gx / norm, -gy / norm, sm, norm

    d = lidar + tide
    wet = valid & (d > WET_MIN_M)
    nx, ny, smdist, slope = shore_normal(NORMAL_SMOOTH_M)
    to = np.radians(direction_from + 180)
    ux0, uy0 = np.sin(to), np.cos(to)
    c0 = g * T / (2 * np.pi); c_ref = c0
    if wrapped:
        ux0, uy0, _, _ = shore_normal(REGIONAL_SMOOTH_M)
        c_ref = wave_speeds(T, edge_depth)[1]
    cos_t0 = np.clip(ux0 * nx + uy0 * ny, -1, 1)
    theta0 = np.arccos(cos_t0)
    side = np.sign(nx * uy0 - ny * ux0)
    reachable = wet & (np.degrees(theta0) < MAX_THETA0_DEG)
    dd = np.where(wet, d, 1.0)
    k, c, Cg = wave_speeds(T, dd)
    Ks = np.sqrt((c0 / 2) / Cg)
    theta = np.arcsin(np.clip(np.sin(theta0) * c / c_ref, -1, 1))
    Kr = np.sqrt(np.clip(np.cos(theta0), 1e-6, None) / np.cos(theta))
    Hlin = H0 * Ks * Kr
    ct, st = np.cos(theta), np.sin(theta) * side
    ux = nx * ct - ny * st; uy = nx * st + ny * ct

    step = max(dx, dy)
    rows, cols = np.nonzero(reachable)
    order = np.argsort(-smdist[rows, cols], kind="stable")
    H = np.full(lidar.shape, np.nan); broken = np.zeros(lidar.shape, bool); first = np.zeros(lidar.shape, bool)
    phase = np.full(lidar.shape, np.nan); rank = np.full(lidar.shape, -1)
    rank[rows[order], cols[order]] = np.arange(len(order))
    for r, cc in zip(rows[order], cols[order]):
        ur = int(round(r - ny[r, cc] * step / dy)); uc = int(round(cc - nx[r, cc] * step / dx))
        inside = 0 <= ur < lidar.shape[0] and 0 <= uc < lidar.shape[1]
        if inside and valid[ur, uc] and not (d[ur, uc] > WET_MIN_M):
            continue
        if inside and 0 <= rank[ur, uc] < rank[r, cc] and np.isfinite(H[ur, uc]):
            h = H[ur, uc] * (Ks[r, cc] * Kr[r, cc]) / (Ks[ur, uc] * Kr[ur, uc])
            ph = phase[ur, uc] + k[r, cc] * (smdist[ur, uc] - smdist[r, cc]) / max(slope[r, cc], 0.5)
            up_broken = broken[ur, uc]
        else:
            h = Hlin[r, cc]; ph = -k[r, cc] * smdist[r, cc]; up_broken = False
        if h >= gamma * d[r, cc]:
            h = gamma * d[r, cc]; broken[r, cc] = True; first[r, cc] = not up_broken
        H[r, cc] = h; phase[r, cc] = ph
    drawn = np.isfinite(H)
    return dict(d=d, wet=wet, reachable=reachable, drawn=drawn, H=H, broken=broken & drawn, first=first & drawn,
                k=k, phase=phase, ux=ux, uy=uy, theta0=np.degrees(theta0))


def bilinear(grid, X, Y, dx, dy, px, py):
    """Bilinear sample of a grid (NaN-aware: NaN if any corner is NaN)."""
    fc = (np.asarray(px) - X[0, 0]) / dx; fr = (np.asarray(py) - Y[0, 0]) / dy
    return ndi.map_coordinates(grid, [fr, fc], order=1, mode="constant", cval=np.nan, prefilter=False)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--spot", required=True, choices=list(SPOTS))
    ap.add_argument("--points", default=None, help="override the points file")
    ap.add_argument("--tide", type=float, default=None)
    args = ap.parse_args()
    S = dict(SPOTS[args.spot])
    if args.points: S["points"] = Path(args.points)
    if args.tide is not None: S["tide"] = args.tide
    OUT.mkdir(exist_ok=True)

    P, lidar, X, Y, dx, dy, ir, ic = load_grid(S["points"])
    org = P["meta"]["origin"]; olat, olon = org["lat"], org["lon"]
    cos0 = np.cos(np.radians(olat))
    to_xy = lambda lat, lon: ((lon - olon) * M_PER_DEG * cos0, (lat - olat) * M_PER_DEG)  # noqa: E731
    to_ll = lambda x, y: (olat + y / M_PER_DEG, olon + x / (M_PER_DEG * cos0))             # noqa: E731
    print(f"{S['title']}: grid {lidar.shape}, cells {dx:.1f} x {dy:.1f} m, {np.isfinite(lidar).sum()} points")

    R = model(lidar, dx, dy, S["H0"], S["T"], S["direction_from"], S["tide"], wrapped=S["wrapped"], edge_depth=S["edge_depth"])
    n_wet = R["wet"].sum()
    print(f"wet {n_wet}, reachable {R['reachable'].sum()}, drawn {R['drawn'].sum()}, broken {R['broken'].sum()}, "
          f"onset cells {R['first'].sum()}")

    # ---- take-off: published point, or the model's break onset nearest the cited coordinate
    tx, ty = to_xy(S["takeoff"]["lat"], S["takeoff"]["lon"])
    onset_r, onset_c = np.nonzero(R["first"])
    dist_on = np.hypot(X[onset_r, onset_c] - tx, Y[onset_r, onset_c] - ty)
    if S["takeoff"].get("from_model"):
        j = int(np.argmin(dist_on)); kx, ky = X[onset_r[j], onset_c[j]], Y[onset_r[j], onset_c[j]]
    else:
        kx, ky = tx, ty
    rr = int(round((ky - Y[0, 0]) / dy)); cc = int(round((kx - X[0, 0]) / dx))
    ux, uy = R["ux"][rr, cc], R["uy"][rr, cc]
    if not np.isfinite(ux) or not R["wet"][rr, cc]:
        ux, uy = np.sin(np.radians(S["direction_from"] + 180)), np.cos(np.radians(S["direction_from"] + 180))
    travel_deg = (np.degrees(np.arctan2(ux, uy))) % 360
    klat, klon = to_ll(kx, ky)
    print(f"take-off {klat:.6f}, {klon:.6f}  depth(datum) {lidar[rr, cc]:.2f} m, model H {R['H'][rr, cc]:.2f} m, "
          f"broken {bool(R['broken'][rr, cc])}; local wave travel bearing {travel_deg:.0f} deg")

    # ---- profile along the local wave direction through the take-off: from the shoreline out to sea
    sgrid = np.arange(-1500, 800.0, 1.0)                 # metres along travel, + = shoreward of take-off
    pxs, pys = kx + sgrid * ux, ky + sgrid * uy
    bed = -bilinear(lidar, X, Y, dx, dy, pxs, pys)       # height above datum (positive up)
    water = -bed + S["tide"]
    i0 = int(np.argmin(np.abs(sgrid)))
    # shoreline: first sample shoreward of the take-off where the bed rises above the still water
    sh = np.nonzero((sgrid > 0) & (water <= 0))[0]
    i_sh = int(sh[0]) if len(sh) else int(np.nonzero(np.isfinite(bed))[0].max())
    # seaward end: last contiguous valid sample going seaward from the take-off
    bad = np.nonzero(~np.isfinite(bed[:i0]))[0]
    i_sea = int(bad.max()) + 1 if len(bad) else 0
    seg = slice(i_sea, min(i_sh + 40, len(sgrid)))       # keep 40 m of dry bed behind the shoreline for run-up
    dist_from_shore = sgrid[i_sh] - sgrid[seg]           # + = seaward of the shoreline
    plat, plon = to_ll(pxs[seg], pys[seg])
    prof_csv = SPH_DATA / f"{args.spot}_profile.csv"
    with open(prof_csv, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["distance_from_shore_m", "lat", "lon", "bed_above_datum_m", "water_depth_at_tide_m"])
        for a, la, lo, b in zip(dist_from_shore[::-1], plat[::-1], plon[::-1], bed[seg][::-1]):
            if np.isfinite(b):
                w.writerow([f"{a:.1f}", f"{la:.7f}", f"{lo:.7f}", f"{b:.3f}", f"{S['tide'] - b:.3f}"])
    takeoff_from_shore = float(sgrid[i_sh] - 0.0)
    # model onsets along the profile (cells crossed by the line)
    prr = np.round((pys[seg] - Y[0, 0]) / dy).astype(int); pcc = np.round((pxs[seg] - X[0, 0]) / dx).astype(int)
    okp = (prr >= 0) & (prr < lidar.shape[0]) & (pcc >= 0) & (pcc < lidar.shape[1])
    seen = {}
    for a, r_, c_, o in zip(dist_from_shore, prr, pcc, okp):    # one value per onset cell: where the line enters it
        if o and R["first"][r_, c_]:
            seen[(r_, c_)] = max(seen.get((r_, c_), -1e9), float(a))
    on_line = sorted((round(v) for v in seen.values()), reverse=True)
    print(f"profile {prof_csv.name}: {dist_from_shore.max():.0f} m from shore to seaward end "
          f"(water {water[i_sea]:.1f} m there), take-off {takeoff_from_shore:.0f} m from shore; "
          f"model break onsets on the line at {on_line} m from shore")

    # ---- viewer file: same format as swell_sim.json, same order as the points file
    state = np.zeros(lidar.shape, int)
    state[R["drawn"]] = 1; state[R["broken"]] = 2; state[R["wet"] & ~R["reachable"]] = 3
    pick = lambda a: a[ir, ic]  # noqa: E731
    cen_lat, cen_lon = klat, klon
    viewer = dict(
        meta=dict(case=f"{S['title']}: typical winter swell, illustrative, not a forecast",
                  label="illustrative, not a forecast",
                  config=dict(H0_m=S["H0"], T_s=S["T"], direction_from_deg=S["direction_from"], tide_above_datum_m=S["tide"],
                              datum=S["datum"], gamma=GAMMA, omega_rad_s=round(2 * np.pi / S["T"], 5),
                              normal_smooth_m=NORMAL_SMOOTH_M, max_theta0_deg=MAX_THETA0_DEG),
                  mode="WRAPPED" if S["wrapped"] else "STRICT",
                  swell_source=S["swell_source"], tide_note=S.get("tide_note", ""), caveat=S.get("caveat", ""),
                  viewer_note=("Typical winter swell from " + S["swell_source"].split(",")[0] + "; " +
                               S.get("caveat", "") + " Illustrative, not a forecast.").strip(),
                  points_file=Path(S["points"]).name,
                  order=f"same order and count as {Path(S['points']).name}", n_points=int(len(ir)),
                  takeoff=dict(lat=round(klat, 6), lon=round(klon, 6), x_m=round(float(kx), 1), y_m=round(float(ky), 1),
                               how=S["takeoff"]["how"], local_travel_bearing_deg=round(float(travel_deg), 1)),
                  fields=dict(H="wave height (m), -1 where not drawn", broken="1 = broken (height held at gamma x depth)",
                              k="wavenumber (rad/m), 0 where dry", phase="phase (rad), wrapped to 0..2pi",
                              state="0 dry or in the lee of dry land, 1 unbroken, 2 broken, 3 not reachable"),
                  assumptions=["linear waves, one height and one period for the whole sea",
                               "offshore height treated as deep-water height; no losses before the lidar edge",
                               "refraction by Snell's law for straight contours parallel to the local (100 m smoothed) shore",
                               "nothing outside the lidar box (no headland sheltering, no offshore canyon focusing)",
                               "breaking when H >= gamma x depth; held at gamma x depth inside the surf zone",
                               "it does not simulate the shape of a breaking wave"]),
        H=np.round(np.where(R["drawn"], R["H"], -1), 2)[ir, ic].tolist(),
        broken=pick(R["broken"]).astype(int).tolist(),
        k=np.round(np.where(R["wet"], R["k"], 0), 4)[ir, ic].tolist(),
        phase=np.round(np.where(R["drawn"], np.mod(R["phase"], 2 * np.pi), 0), 3)[ir, ic].tolist(),
        state=pick(state).tolist(),
    )
    out_json = VIEW / f"{args.spot}_swell.json"
    out_json.write_text(json.dumps(viewer, separators=(",", ":")))
    print(f"wrote {out_json.name}: {len(ir)} points, {out_json.stat().st_size // 1024} KB")

    summ = dict(spot=args.spot, title=S["title"], H0=S["H0"], T=S["T"], dir=S["direction_from"], tide=S["tide"],
                takeoff=viewer["meta"]["takeoff"], takeoff_depth_datum_m=round(float(lidar[rr, cc]), 2),
                takeoff_model_H_m=None if not np.isfinite(R["H"][rr, cc]) else round(float(R["H"][rr, cc]), 2),
                takeoff_from_shore_m=round(takeoff_from_shore, 1), profile_csv=str(prof_csv.name),
                profile_seaward_end_from_shore_m=round(float(dist_from_shore.max()), 1),
                profile_seaward_end_water_m=round(float(water[i_sea]), 2),
                model_onsets_on_profile_m_from_shore=on_line,
                n_points=int(len(ir)), n_broken=int(R["broken"].sum()), n_unreachable=int((R["wet"] & ~R["reachable"]).sum()))
    (OUT / f"{args.spot}_swell_summary.json").write_text(json.dumps(summ, indent=1))

    # ---- quick map
    fig, ax = plt.subplots(1, 2, figsize=(13, 6))
    Hm = np.where(R["drawn"], R["H"], np.nan)
    im = ax[0].pcolormesh(X, Y, Hm, cmap="viridis", shading="auto")
    ax[0].contour(X, Y, np.where(np.isfinite(lidar), lidar + S["tide"], np.nan), [0], colors="k", linewidths=0.6)
    plt.colorbar(im, ax=ax[0], label="model wave height (m)")
    ax[0].contourf(X, Y, R["broken"].astype(float), [0.5, 1.5], colors="none", hatches=["...."])
    ax[0].plot(pxs[seg], pys[seg], "r-", lw=1); ax[0].plot(kx, ky, "r*", ms=12)
    ax[0].set_aspect("equal"); ax[0].set_title(f"{S['title']}: H0 {S['H0']} m, T {S['T']} s, from {S['direction_from']} deg "
                                               f"(dots = broken). Illustrative, not a forecast", fontsize=9)
    ax[1].fill_between(dist_from_shore, bed[seg], -30, color="0.6"); ax[1].axhline(S["tide"], color="b", lw=0.8)
    ax[1].axvline(takeoff_from_shore, color="r", ls="--", label="take-off")
    for v in on_line: ax[1].axvline(v, color="orange", lw=0.8)
    ax[1].invert_xaxis(); ax[1].set_xlabel("distance from shoreline along the wave path (m)")
    ax[1].set_ylabel(f"height above {S['datum']} (m)"); ax[1].legend(); ax[1].set_ylim(np.nanmin(bed[seg]) - 1, 5)
    ax[1].set_title("profile for the breaking-wave case (orange = model break onsets)", fontsize=9)
    fig.tight_layout(); fig.savefig(OUT / f"{args.spot}_swell.png", dpi=110)
    print(json.dumps(summ))


if __name__ == "__main__":
    main()
