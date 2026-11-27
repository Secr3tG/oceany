"""case_porto_batel: regular swell breaking on the real Porto Batel reef profile (2D slice).

ILLUSTRATIVE: one straight 2D line through the 2011 lidar (11 x 14 m grid, bilinear between
cell centres), so refraction, alongshore variation, the paddle-out channel through the shelf and
anything smaller than about one grid cell are not in it.

Coordinates inside the solver: x = metres from the wavemaker toward the house
(x = S_PISTON - distance_from_house), z = metres above the still water level (the tide).
Height above LAT = z + TIDE_ABOVE_LAT.

This file holds Porto Batel's settings (CFG) and its bed profile; the functions that turn them into particles and a
wavemaker are in slice_case.py, shared with the other spots (spot_case.py).
"""
from pathlib import Path

import numpy as np

from slice_case import G, SliceCase, dispersion_k, piston_stroke  # noqa: F401 (tools import these from here)

HERE = Path(__file__).resolve().parent

CFG = dict(
    name="porto_batel",
    tide_above_lat=2.10,     # m above LAT
    H=2.7,                   # target incident wave height (m)
    T=7.8,                   # wave period (s)
    s_piston=390.0,          # wavemaker position, distance from the house (m); a local low in the
                             # lidar (6.0 m below LAT, 8.1 m of water at this tide)
    stroke_factor=0.958,     # 2026-11-14 (session 7, h_over_dp 1.7 / n_layers 4, out/calib_s7/): H = 2.72 m,
                             # waves 2-4, gauges 10-25 m. Was 0.983 (session 6 numerics, below):
                             # wavemaker stroke / linear-theory stroke. Calibrated 2026-11-13
                             # (session 6, calib_wavemaker.py, out/calib_s6/): H = 2.68 m, waves
                             # 2-4, gauges 10-25 m from the paddle. Was 1.12 (over-corrected for
                             # damping; gave 3.08 m at the same gauges) until 2026-11-13, session 6.
    s_shore=40.0,            # shoreward end of the model, distance from the house (m): the drain
                             # line (particle sink) when shore_outflow is on, else a closed wall
    shore_outflow=1.0,       # 1: no end wall; bed continues to s_bed_end and water crossing s_shore
                             # is removed (session 6, 2026-11-13). 0: old closed wall at s_shore.
    s_bed_end=34.0,          # with the outflow: the lidar bed continues to here (m from the house)
    n_ramp_up=1.0,           # wavemaker ramp-up (periods)
    n_full=3.0,              # full-stroke periods
    n_ramp_down=1.0,         # ramp-down (periods)
    sat_here_m=115.0,        # where the owner sat (label only)
    rho0=1000.0,
    c0_factor=10.0,          # c0 = c0_factor * sqrt(g (h_gen + H))
    h_over_dp=1.7,           # was 1.3 until 2026-11-14 (session 7): too few neighbours for the
                             # Wendland kernel, ~30-35 % wave energy lost over 200 m (energy_s6/FINDINGS.md)
    alpha=0.01,
    delta=0.1,
    cfl=0.2,
    n_layers=4,              # was 3 until 2026-11-14 (session 7): kernel reach 2h = 3.4 dp needs 4 wall layers
    t_end=78.0,
    dt_out=0.1,
    t_settle=4.0,
    settle_tau=0.3,
    h0=None,                 # filled in (depth at the wavemaker)
)


def _load_profile():
    """The bed along the 236 deg line: distance from the house (m) and bed height above LAT (m)."""
    d = np.genfromtxt(HERE / "data" / "porto_batel_profile_236.csv", delimiter=",", names=True)
    return d["distance_from_house_m"].astype(float), d["bed_above_LAT_m"].astype(float)


# The case functions (profile, bed_z, build, the wavemaker) are shared with every spot: slice_case.py.
_case = SliceCase(CFG, _load_profile)
profile, s_of_x, bed_z = _case.profile, _case.s_of_x, _case.bed_z
piston_motion_factory, build = _case.piston_motion_factory, _case.build
