"""The breaking-wave case for the spots other than Porto Batel (Pipeline, Supertubos, Guethary, Hossegor).

ILLUSTRATIVE, NOT A FORECAST. Same solver set-up and numerics as case_porto_batel.py (h_over_dp 1.7, n_layers 4,
shoreward outflow; the shared code is slice_case.py); only the profile, the swell and the tide differ. One straight 2D
line through the lidar along the local wave direction at the take-off (pieces/02-reefs/simulate_swell_spot.py writes
the profile, data/<spot>_profile.csv), so refraction, alongshore variation and anything smaller than a grid cell are
not in it.

Coordinates: s = distance along the line from a "profile origin" 60 m landward of the shoreline (so the Porto Batel
tools, which work in s = 60-340 m, apply unchanged); s = 60 is the shoreline at this tide. Solver x = s_piston - s,
z = metres above still water. Height above the spot's datum = z + tide_above_lat (the key keeps its Porto Batel name;
here it is the tide above the spot's datum).

Where the numbers live:
  spots.json (Oceany folder)  title, datum, typical swell H and T, tide        (shared with the swell model and the live panel)
  SPOT_CASES below            wavemaker position, take-off marker, run length, calibrated stroke factor, and why
Replaces make_spot_cases.py (2026-11-27), which wrote case_<spot>.py by cutting and pasting case_porto_batel.py's
text. case_<spot>.py are now three-line files that call case_names() here.

Recalibrating a spot's wavemaker: run `spot_run.py <spot> calib --factor F ...` for a few F (calib_wavemaker.py),
then put the chosen F in that spot's stroke_factor below.
"""
import json
from pathlib import Path

import numpy as np

from slice_case import SliceCase

HERE = Path(__file__).resolve().parent
REGISTRY = json.loads((HERE.parent.parent / "spots.json").read_text())
S_OFFSET = 60.0              # profile origin is this far landward of the shoreline

# per spot: the case settings that are not in spots.json, each with its reason (the *_c text)
SPOT_CASES = {
    "pipeline": dict(
        tide_c="m above LMSL (the lidar datum; mean sea level, Haleiwa spring range ~0.6 m)",
        sp=310.0, sp_c="wavemaker 250 m seaward of the shoreline (s = 60 + 250); 9.2 m of water on the 10 m sand plateau",
        sat=105.0, sat_c="published Pipeline position (approx.), 45 m from the shoreline", t_end=85.0,
        stroke_factor=0.903,
        src_c="NOAA NDBC 51201 Waimea, Nov-Mar 2024-25, NW long-period median (2.11 m, 14.3 s, 320 deg)"),
    "supertubos": dict(
        tide_c="m above LAT (~ Peniche mean level)",
        sp=280.0, sp_c="wavemaker 220 m seaward of the shoreline (s = 60 + 220); 8.9 m of water at this tide",
        sat=99.0, sat_c="model break onset (simulate_swell_spot.py), 39 m from the shoreline; approx.", t_end=85.0,
        stroke_factor=1.009,
        src_c="NOAA NCEP GFS-Wave (WAVEWATCH III) 0.25 deg analysis (f000), 39.375 N 9.458 W, Nov-Mar 2024-25 + 2025-26, 193 samples, median primary swell (1.82 m, 12.2 s, 295 deg; pieces/11-ocean/data/typical_swell.json). Rerun 2026-11-25 as s2 (out/supertubos_s2); the s1 run used the earlier Open-Meteo median (2.22 m, 13.5 s)"),
    "guethary": dict(
        tide_c="m above IGN69 (~ mean sea level on this coast, within ~0.2 m)",
        sp=340.0, sp_c="wavemaker 280 m seaward of the shoreline (s = 60 + 280); ~5.4 m of water (9 m water is ~420 m out, beyond the s 60-340 tool window)",
        sat=235.0, sat_c="published Parlementia position (approx.), 175 m from the shoreline", t_end=85.0,
        stroke_factor=0.998,
        src_c="NOAA NCEP GFS-Wave (WAVEWATCH III) 0.25 deg analysis (f000), 43.45 N 1.70 W, Nov-Mar 2024-25 + 2025-26, 189 samples, median primary swell (1.31 m, 12.4 s, 303 deg; pieces/11-ocean/data/typical_swell.json). Rerun 2026-11-25 as s2 (out/guethary_s2); the s1 run used the earlier Open-Meteo median (1.58 m, 13.5 s)"),
    "hossegor": dict(
        tide_c="m above IGN69 (~ mean sea level on this coast, within ~0.2 m)",
        sp=535.0, sp_c="wavemaker 475 m seaward of the shoreline (s = 60 + 475); 8.1 m of water, seaward of the outer bar (crest ~6.0 m at 350-360 m out). Long domain: render_porto_batel.py widens its window to s 60-515 (spot_run.py place())",
        sat=159.0, sat_c="published La Graviere position (approx.), 99 m from the shoreline", t_end=100.0,
        stroke_factor=1.002,
        src_c="NOAA NCEP GFS-Wave (WAVEWATCH III) 0.25 deg analysis (f000), 43.45 N 1.70 W, Nov-Mar 2024-25 + 2025-26, 189 samples, median primary swell (1.31 m, 12.4 s, 303 deg; pieces/11-ocean/data/typical_swell.json). Rerun 2026-11-25 as s2 (out/hossegor_s2); the s1 run used the earlier Open-Meteo median (1.58 m, 13.5 s)"),
}


def cfg_for(spot):
    """The spot's CFG: the same keys, order and values as case_porto_batel.CFG has for Porto Batel."""
    r, S = REGISTRY[spot], SPOT_CASES[spot]
    return dict(
        name=spot,
        tide_above_lat=r["typical_swell"]["tide"],   # tide above the spot's datum (spots.json)
        H=r["typical_swell"]["H0"],                  # target incident wave height (m), the spot's typical winter swell
        T=r["typical_swell"]["T"],                   # wave period (s)
        s_piston=S["sp"],                            # wavemaker position (s, m)
        stroke_factor=S["stroke_factor"],            # wavemaker stroke / linear-theory stroke (calibrated: out/calib_<spot>/)
        s_shore=50.0,            # drain line (particle sink), 10 m landward of the shoreline
        shore_outflow=1.0,
        s_bed_end=44.0,          # the lidar bed continues to here
        n_ramp_up=1.0,
        n_full=3.0,
        n_ramp_down=1.0,
        sat_here_m=S["sat"],     # take-off marker (label only)
        rho0=1000.0,
        c0_factor=10.0,
        h_over_dp=1.7,           # corrected numerics (session 7)
        alpha=0.01,
        delta=0.1,
        cfl=0.2,
        n_layers=4,              # corrected numerics (session 7)
        t_end=S["t_end"],
        dt_out=0.1,
        t_settle=4.0,
        settle_tau=0.3,
        h0=None,
    )


def load_profile(spot):
    """data/<spot>_profile.csv as (s, bed height above datum), s = distance from the shoreline + S_OFFSET, ascending."""
    d = np.genfromtxt(HERE / "data" / f"{spot}_profile.csv", delimiter=",", names=True)
    s = d["distance_from_shore_m"].astype(float) + S_OFFSET
    o = np.argsort(s)
    return s[o], d["bed_above_datum_m"].astype(float)[o]


def case_names(spot):
    """Everything a case module offers the tools, for case_<spot>.py: CFG, profile, bed_z, build, ..."""
    names = SliceCase(cfg_for(spot), lambda: load_profile(spot)).names()
    names["S_OFFSET"] = S_OFFSET
    return names


def describe(spot):
    """The provenance text the old generated case files carried in their docstring."""
    r, S = REGISTRY[spot], SPOT_CASES[spot]
    return (f"case_{spot}: regular swell breaking on the {r['title']} profile (2D slice). ILLUSTRATIVE, NOT A FORECAST.\n"
            f"Swell: {S['src_c']}.\nTide: {r['typical_swell']['tide']} {S['tide_c']}.\n"
            f"Wavemaker: {S['sp_c']}.\nTake-off marker: {S['sat_c']}.")
