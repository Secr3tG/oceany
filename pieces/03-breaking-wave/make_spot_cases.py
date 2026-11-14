import re, sys
from pathlib import Path
D = Path(__file__).resolve().parent
src = (D / "case_porto_batel.py").read_text()
i0 = src.index("CFG = dict(")
i1 = src.index("_prof = None")
j0 = src.index("def profile():")
j1 = src.index("def s_of_x(")
SPOTS = {
 "pipeline": dict(title="Pipeline, Oahu", datum="LMSL", tide=0.0, tide_c="m above LMSL (the lidar datum; mean sea level, Haleiwa spring range ~0.6 m)",
     H=2.1, T=14.3, sp=310.0, sp_c="wavemaker 250 m seaward of the shoreline (s = 60 + 250); 9.2 m of water on the 10 m sand plateau",
     sat=105.0, sat_c="published Pipeline position (approx.), 45 m from the shoreline", t_end=85.0,
     src_c="NOAA NDBC 51201 Waimea, Nov-Mar 2024-25, NW long-period median (2.11 m, 14.3 s, 320 deg)"),
 "supertubos": dict(title="Supertubos, Peniche", datum="LAT", tide=1.7, tide_c="m above LAT (~ Peniche mean level)",
     H=2.2, T=13.5, sp=280.0, sp_c="wavemaker 220 m seaward of the shoreline (s = 60 + 220); 8.9 m of water at this tide",
     sat=99.0, sat_c="model break onset (simulate_swell_spot.py), 39 m from the shoreline; approx.", t_end=85.0,
     src_c="Open-Meteo Marine hindcast, Nov-Mar 2024-26 median swell (2.22 m, 13.5 s, 304 deg)"),
 "guethary": dict(title="Guethary / Parlementia, France", datum="IGN69", tide=0.0, tide_c="m above IGN69 (~ mean sea level on this coast, within ~0.2 m)",
     H=1.6, T=13.5, sp=340.0, sp_c="wavemaker 280 m seaward of the shoreline (s = 60 + 280); ~5.4 m of water (9 m water is ~420 m out, beyond the s 60-340 tool window)",
     sat=235.0, sat_c="published Parlementia position (approx.), 175 m from the shoreline", t_end=85.0,
     src_c="Open-Meteo Marine hindcast, 43.45 N 1.70 W, Nov-Mar 2024-26 median swell (1.58 m, 13.5 s, 305 deg)"),
}
def make(spot, S, factor=1.0):
    doc = f'''"""case_{spot}: regular swell breaking on the {S["title"]} profile (2D slice). ILLUSTRATIVE, NOT A FORECAST.

Built from case_porto_batel.py (same solver set-up and numerics: h_over_dp 1.7, n_layers 4, shoreward
outflow); only the profile, the swell and the tide differ. One straight 2D line through the lidar along
the local wave direction at the take-off (pieces/02-reefs/simulate_swell_spot.py writes the profile), so
refraction, alongshore variation and anything smaller than a grid cell are not in it.
Swell: {S["src_c"]}.
Coordinates: s = distance along the line from a "profile origin" 60 m landward of the shoreline (so the
Porto Batel tools, which work in s = 60-340 m, apply unchanged); s = 60 is the shoreline at this tide.
Solver x = S_PISTON - s, z = metres above still water. Height above {S["datum"]} = z + tide_above_lat (the key
keeps its Porto Batel name; here it is the tide above {S["datum"]}).
"""
'''
    head = src[:i0]
    head = head[head.index("import math"):]
    cfg = f'''CFG = dict(
    name="{spot}",
    tide_above_lat={S["tide"]},       # {S["tide_c"]}
    H={S["H"]},                   # target incident wave height (m), the spot's typical winter swell
    T={S["T"]},                  # wave period (s)
    s_piston={S["sp"]},           # {S["sp_c"]}
    stroke_factor={factor},       # wavemaker stroke / linear-theory stroke (calibrated: see out/calib_{spot}/)
    s_shore=50.0,            # drain line (particle sink), 10 m landward of the shoreline
    shore_outflow=1.0,
    s_bed_end=44.0,          # the lidar bed continues to here
    n_ramp_up=1.0,
    n_full=3.0,
    n_ramp_down=1.0,
    sat_here_m={S["sat"]},         # take-off marker (label only): {S["sat_c"]}
    rho0=1000.0,
    c0_factor=10.0,
    h_over_dp=1.7,           # corrected numerics (session 7)
    alpha=0.01,
    delta=0.1,
    cfl=0.2,
    n_layers=4,              # corrected numerics (session 7)
    t_end={S["t_end"]},
    dt_out=0.1,
    t_settle=4.0,
    settle_tau=0.3,
    h0=None,
)
S_OFFSET = 60.0              # profile origin is this far landward of the shoreline


'''
    prof = f'''def profile():
    global _prof
    if _prof is None:
        d = np.genfromtxt(HERE / "data" / "{spot}_profile.csv", delimiter=",", names=True)
        s = d["distance_from_shore_m"].astype(float) + S_OFFSET
        o = np.argsort(s)
        _prof = (s[o], d["bed_above_datum_m"].astype(float)[o])
    return _prof


'''
    body = src[i1:j0] + prof + src[j1:]
    (D / f"case_{spot}.py").write_text(doc + head + cfg + body)
if __name__ == "__main__":
    spot = sys.argv[1]; f = float(sys.argv[2]) if len(sys.argv) > 2 else 1.0
    make(spot, SPOTS[spot], f)
