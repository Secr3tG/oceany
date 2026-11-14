"""Run the Porto Batel tools (calibration, solver, diagnostics, render/slice) on another spot's case file.

    python spot_run.py <spot> calib  --factor 1.0 --dp 0.15 --tend 70 --outdir calib_<spot>
    python spot_run.py <spot> run    --dp 0.15 --outdir <spot>_s1
    python spot_run.py <spot> diag   out/<spot>_s1
    python spot_run.py <spot> render out/<spot>_s1 --out out/<spot>_s1
    python spot_run.py <spot> render out/<spot>_s1 --out out/<spot>_s1 --slice-v1-surface
    python spot_run.py <spot> slice  out/<spot>_s1      (copies + relabels to viewer/data/<spot>_slice.json)

How: case_<spot>.py is registered under the module name `case_porto_batel` before the Porto Batel script is
loaded, so run_porto_batel.py / calib_wavemaker.py / diagnostics_porto_batel.py / render_porto_batel.py run
UNCHANGED on the new profile. Porto Batel literals in the render script (house position, 236 deg bearing,
labels, datum) are replaced in memory with the spot's values; the files on disk are not touched.
Calibration: the tank is lengthened from 85 m to 130 m (sponge 45-130 m) because these swells are ~2x longer.
Long domains (2026-11-14, Hossegor): the render/slice tools window s 60-340 m. When a spot's wavemaker sits beyond
s 360 the window is widened in memory to s 60 to (s_piston - 20) (camera clamps, slice bins, slot count, overhang
search scaled with it), and the slice time cap (78 s = t_end - 7 for the 85 s runs) follows t_end. For spots with
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
VIEW = HERE.parent / "01-seafloor" / "viewer" / "data"
M_PER_DEG = 111195.0
POINTS = {"pipeline": "pipeline.json", "supertubos": "reefs_wide.json", "basque": "basque.json", "guethary": "guethary.json",
          "hossegor": "hossegor.json"}
TITLE = {"pipeline": "Pipeline, Oahu", "supertubos": "Supertubos, Peniche", "basque": "Basque coast", "guethary": "Guethary / Parlementia, France",
         "hossegor": "Hossegor / La Graviere, France"}
IGN69 = ("basque", "guethary", "hossegor")


def window(spot):
    """s window of the render/slice tools for this spot: (s_hi, t_end). s_hi = 340 (the Porto Batel window)
    unless the wavemaker sits beyond s 360, then s_piston - 20."""
    cfg = importlib.import_module(f"case_{spot}").CFG
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
    datum = "LMSL" if spot == "pipeline" else ("IGN69" if spot in IGN69 else "LAT")
    return dict(hlat=hlat, hlon=hlon, hx=hx, hy=hy, bearing=bearing, olat=olat, olon=olon, datum=datum,
                ux=ex, uy=ny)


def patched_render_source(spot):
    G = geometry(spot)
    src = (HERE / "render_porto_batel.py").read_text()
    b = f"{G['bearing']:.0f}"
    reps = [
        ("Porto Batel reef, regular swell on the 236 deg line (illustrative 2D slice)",
         f"{TITLE[spot]}, regular swell on the {b} deg line (illustrative, not a forecast; 2D slice)"),
        ("Porto Batel reef, 236 deg line", f"{TITLE[spot]}, {b} deg line (illustrative, not a forecast)"),
        ("from the house along 236 deg", f"from the profile origin (60 m behind the shoreline) along {b} deg"),
        ("sat here (user)", "take-off (approx.)"),
        ("above LAT", f"above {G['datum']}"),
        ("39.322, -9.3625, 111195.0", f"{G['olat']}, {G['olon']}, 111195.0"),
        ("-9.355772", f"{G['hlon']:.6f}"), ("39.319506", f"{G['hlat']:.6f}"),
        ("math.radians(236)", f"math.radians({G['bearing']:.3f})"),
        ("bearing_deg=236.0", f"bearing_deg={G['bearing']:.1f}"),
        ("39.322 N, -9.3625 E (M_PER_DEG 111195), as reefs.json",
         f"{G['olat']} N, {G['olon']} E (M_PER_DEG 111195), as {POINTS[spot]}"),
        ('vertical_datum="LAT"', f'vertical_datum="{G["datum"]}"'),
        ('"porto_batel.mp4"', f'"{spot}.mp4"'),
    ]
    s_hi, t_end = window(spot)
    if s_hi != 340.0:                     # long domain: widen the s 60-340 window (only literals that set it)
        hi = f"{s_hi:.1f}"
        reps += [
            ("(s0 > 60) & (s0 < 340)", f"(s0 > 60) & (s0 < {hi})"),
            ("np.arange(60.0, 340.0 + 1e-9, 1.0)", f"np.arange(60.0, {hi} + 1e-9, 1.0)"),
            ("surface_s_m=dict(start=60, stop=340, step=1)", f"surface_s_m=dict(start=60, stop={int(s_hi)}, step=1)"),
            ("s_lo=100.0, s_hi=320.0", f"s_lo=100.0, s_hi={s_hi - 20.0:.1f}"),
            ("c = min(300.0, track_s[k] - 12.0)", f"c = min({s_hi - 40.0:.1f}, track_s[k] - 12.0)"),
            ("min(300.0, s_b + 80)", f"min({s_hi - 40.0:.1f}, s_b + 80)"),
            ("s_lo=60.0, s_hi=340.0):", f"s_lo=60.0, s_hi={hi}):"),
            ("n_part=2400,", f"n_part={int(round(2400 * (s_hi - 60.0) / 280.0))},"),   # same slots per 1 m bin
        ]
    if t_end != 85.0:
        reps.append(("t1 = min(78.0, kt", f"t1 = min({t_end - 7.0:.1f}, kt"))
    for a, c in reps:
        n = src.count(a)
        if n == 0:
            raise SystemExit(f"render patch: literal not found: {a!r}")
        src = src.replace(a, c)
    return src


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
        sys.argv = ["render_porto_batel.py"] + rest
        code = compile(patched_render_source(spot), str(HERE / "render_porto_batel.py"), "exec")
        g = {"__name__": "__main__", "__file__": str(HERE / "render_porto_batel.py")}
        exec(code, g)
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
