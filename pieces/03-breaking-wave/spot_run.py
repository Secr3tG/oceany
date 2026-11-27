"""Run the Porto Batel tools (calibration, solver, diagnostics, render/slice) on another spot's case file.

    python spot_run.py <spot> calib  --factor 1.0 --dp 0.15 --tend 70 --outdir calib_<spot>
    python spot_run.py <spot> run    --dp 0.15 --outdir <spot>_s1
    python spot_run.py <spot> diag   out/<spot>_s1
    python spot_run.py <spot> render out/<spot>_s1 --out out/<spot>_s1
    python spot_run.py <spot> render out/<spot>_s1 --out out/<spot>_s1 --slice-v1-surface
    python spot_run.py <spot> slice  out/<spot>_s1      (copies + relabels to viewer/data/<spot>_slice.json)

How: case_<spot>.py (built by spot_case.py from spots.json) is registered under the module name `case_porto_batel`
before a Porto Batel tool is loaded, so run_porto_batel.py / calib_wavemaker.py / diagnostics_porto_batel.py run
unchanged on the new profile. render_porto_batel.py takes the spot's labels, datum, house position, bearing and s
window as a PLACE dict (place() below); until 2026-11-27 it was text-patched in memory instead.
Calibration: the tank is lengthened from 85 m to 130 m (sponge 45-130 m) because these swells are ~2x longer.
Long domains (2026-11-14, Hossegor): the render/slice tools window s 60-340 m. When a spot's wavemaker sits beyond
s 360 the window is widened to s 60 to (s_piston - 20) (camera clamps, slice bins, slot count, overhang search
scaled with it), and the slice time cap (78 s = t_end - 7 for the 85 s runs) follows t_end. For spots with
s_piston <= 360 and t_end 85 (Porto Batel tools' own case, Pipeline, Supertubos, Guethary) nothing changes.
"""
import csv
import importlib
import json
import math
import runpy
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import spot_case  # noqa: E402
VIEW = HERE.parent / "01-seafloor" / "viewer" / "data"
M_PER_DEG = 111195.0
REGISTRY = json.loads((HERE.parent.parent / "spots.json").read_text())     # the spot registry
POINTS = {k: r["viewer_points"] for k, r in REGISTRY.items() if "viewer_points" in r}
TITLE = {k: r["title"] for k, r in REGISTRY.items() if "title" in r}


def window(spot):
    """s window of the render/slice tools for this spot: (s_hi, t_end). s_hi = 340 (the Porto Batel window)
    unless the wavemaker sits beyond s 360, then s_piston - 20."""
    cfg = spot_case.cfg_for(spot)
    sp = float(cfg["s_piston"])
    return (340.0 if sp <= 360.0 else float(round(sp - 20.0))), float(cfg["t_end"])


def geometry(spot):
    """Profile origin (60 m landward of the shoreline), seaward bearing and the viewer frame of the points file."""
    rows = list(csv.DictReader(open(HERE / "data" / f"{spot}_profile.csv")))
    r0 = min(rows, key=lambda r: abs(float(r["distance_from_shore_m"])))           # shoreline sample
    r1 = max(rows, key=lambda r: float(r["distance_from_shore_m"]))                # seaward end
    la0, lo0, la1, lo1 = (float(r0["lat"]), float(r0["lon"]), float(r1["lat"]), float(r1["lon"]))
    cosl = math.cos(math.radians(la0))
    ex, ny = (lo1 - lo0) * M_PER_DEG * cosl, (la1 - la0) * M_PER_DEG
    n = math.hypot(ex, ny); ex, ny = ex / n, ny / n                                 # seaward unit vector
    s0 = float(r0["distance_from_shore_m"])
    back = 60.0 + s0                                                                # metres landward of r0
    hlat = la0 - back * ny / M_PER_DEG
    hlon = lo0 - back * ex / (M_PER_DEG * cosl)
    meta = json.loads((VIEW / POINTS[spot]).read_text())["meta"]
    olat, olon = meta["origin"]["lat"], meta["origin"]["lon"]
    hx = (hlon - olon) * M_PER_DEG * math.cos(math.radians(olat))
    hy = (hlat - olat) * M_PER_DEG
    bearing = math.degrees(math.atan2(ex, ny)) % 360
    datum = REGISTRY[spot]["datum"]
    return dict(hlat=hlat, hlon=hlon, hx=hx, hy=hy, bearing=bearing, olat=olat, olon=olon, datum=datum,
                ux=ex, uy=ny)


def place(spot):
    """The spot's PLACE for render_porto_batel.py: labels, datum, viewer frame, bearing and the s window.
    House position and bearings are rounded as the slice files have always stored them (6 / 1 / 3 decimals)."""
    G = geometry(spot)
    b = f"{G['bearing']:.0f}"
    s_hi, t_end = window(spot)
    return dict(
        case_text=f"{TITLE[spot]}, regular swell on the {b} deg line (illustrative, not a forecast; 2D slice)",
        video_title=f"{TITLE[spot]}, {b} deg line (illustrative, not a forecast)",
        along=f"from the profile origin (60 m behind the shoreline) along {b} deg",
        marker="take-off (approx.)",
        datum=G["datum"],
        origin_lat=G["olat"], origin_lon=G["olon"], points_file=POINTS[spot],
        house_lat=round(G["hlat"], 6), house_lon=round(G["hlon"], 6),
        bearing_deg=round(G["bearing"], 1), direction_deg=round(G["bearing"], 3),
        mp4=f"{spot}.mp4",
        s_hi=s_hi,
        slice_t_cap=78.0 if t_end == 85.0 else t_end - 7.0,   # 78 s = t_end - 7 for the 85 s runs
    )


def main():
    spot, tool, rest = sys.argv[1], sys.argv[2], sys.argv[3:]
    sys.modules["case_porto_batel"] = importlib.import_module(f"case_{spot}")
    if tool == "run":
        sys.argv = ["run_porto_batel.py"] + rest
        runpy.run_path(str(HERE / "run_porto_batel.py"), run_name="__main__")
    elif tool == "calib":
        import calib_wavemaker as C
        C.X_END = 130.0
        C.SPONGE = (45.0, 130.0)
        C.EXTRA_X = [50.0, 70.0, 90.0, 110.0]
        C.ALL_X = C.GAUGES_X + C.EXTRA_X
        sys.argv = ["calib_wavemaker.py"] + rest
        C.main()
    elif tool == "diag":
        sys.argv = ["diagnostics_porto_batel.py"] + rest
        runpy.run_path(str(HERE / "diagnostics_porto_batel.py"), run_name="__main__")
    elif tool == "render":
        import render_porto_batel as R          # imported after the case swap above, so it renders this spot
        R.cli(rest, place=place(spot))
    elif tool == "slice":
        run = Path(rest[0])
        src = run / "porto_batel_slice_surface.json"
        d = json.loads(src.read_text())
        G = geometry(spot)
        m = d["meta"]
        m["label"] = "illustrative, not a forecast (2D slice)"
        m["spot"] = TITLE[spot]
        m["tide_above_datum_m"] = m.get("tide_above_lat_m")
        m["profile_origin_note"] = ("'house' = profile origin, 60 m landward of the shoreline on the line (no house "
                                    "at this spot); s = 60 m is the shoreline at this tide")
        m["sat_here_note"] = "sat_here_user_s_m = approximate take-off (not a user mark at this spot)"
        caveat = {"supertubos": "Sand beach break: this is the 2011 seabed, the bars have moved since.",
                  "hossegor": ("Sand beach break: Litto3D lidar 2020-2022 (4 m cells); the bars move with every storm. "
                               "Two 8 m lidar holes 305-324 m from shore bridged linearly."),
                  "pipeline": "2013 lidar, 8 m cells; the reef's fine structure is not resolved."}.get(spot)
        if caveat:
            m["notes"] = [caveat] + m.get("notes", [])
        m["notes"] = [n.replace("2011 lidar (11 x 14 m grid", "lidar (grid").replace(
            "; the paddle-out channel is missing", "") for n in m["notes"]]
        out = VIEW / f"{spot}_slice.json"
        out.write_text(json.dumps(d, separators=(",", ":")))
        print(f"wrote {out} ({out.stat().st_size // 1024} KB), house {G['hx']:.1f},{G['hy']:.1f} bearing {G['bearing']:.1f}")
    else:
        raise SystemExit(f"unknown tool {tool}")


if __name__ == "__main__":
    main()
