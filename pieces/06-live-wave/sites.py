"""Site definitions for Stage A (stage_a.py). A site is geometry and datum only: no physics, no parameter.

Every site carries:
  origin_lat, origin_lon  the grid origin (x = y = 0) and the reference point the break distance is measured from
  half, dx                the square model domain (metres either side of the origin) and the cell size
  line_deg, along_deg     the reference line from the origin toward the sea, and the direction of alongshore offsets
  profile_offsets         alongshore offsets (m) of the parallel break-line profiles; offset 0 is the reference line
  bed                     how to get the bed grid: ("porto_batel_lidar",) builds it from the raw Portuguese lidar,
                          else the saved npz below
  bed_npz                 the saved grid (x, y, bed above datum, filled mask)
  datum                   the bed's vertical datum and what the tide argument means

PORTO_BATEL reproduces the constants stage_a.py had before sites existed, value for value (checked by stage_a.py's
regression: 204 / 152 / 134 m on the house line).
"""
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent

PORTO_BATEL = dict(
    key="porto_batel", name="Porto Batel (Peniche)",
    origin_lat=39.319506, origin_lon=-9.355772, origin_name="the house (filming position)",
    half=1200.0, dx=10.0, grid_deg=0.0, line_deg=236.0, along_deg=326.0, s_max=700.0,
    profile_offsets=np.arange(-600.0, 600.0 + 1, 25.0),
    bed=("porto_batel_lidar",), bed_npz=str(HERE / "data" / "bed_grid_porto_batel.npz"),
    datum="LAT", tide_words="m above LAT (lowest astronomical tide; MSL = LAT + 1.66 m)",
    edge_depth_note="about 14 m deep at the domain's upwind edge",
)

# ------------------------------------------------------------------------------------------------ Pipeline, Oahu
# Coordinates are published positions; none was moved to fit the model or the footage. Sources (retrieved 2026-11-16):
#  Pipeline take-off  21 deg 39' 50" N, 158 deg 03' 14" W = 21.66389, -158.05389
#                     https://en.wikipedia.org/wiki/Banzai_Pipeline (the same point pieces/05-pipeline/export_pipeline.py uses).
#                     The 2013 lidar puts it in 3.1 m of water (LMSL), ~40 m off the 0 m contour: consistent with First Reef.
#  Ehukai Beach Park  NOT used: published points disagree by ~500 m (topozone/GNIS 21.66861, -158.05444 is in 12 m of water
#                     in the lidar; hawaii-guide.com 21.66491, -158.05092 is on land 7.7 m above LMSL). The park is the
#                     beach strip landward of the take-off; the model's beach end comes from the lidar instead.
#  Reef distances     First Reef ~200 ft (61 m), Second ~400 ft (122 m), Third ~1,000 ft (305 m) offshore; depths 2-8 ft,
#                     15-20 ft, 30-40 ft: B. Tissot, https://briantissot.com/2020/04/13/surfing-the-reef-at-banzai-pipeline/
#                     (used ONLY to name the reef a modelled break falls on; band edges are the midpoints, fixed in advance).
# Reference line: from the take-off straight out to sea along the local shore normal. The normal is fitted from the 2013 lidar:
# principal axis of the cells within +-0.4 m of 0 m LMSL and within 450 m of the take-off -> shoreline strike 44.2 deg, so the
# seaward normal is 314 deg (300 m and 600 m windows give 41.4 and 45.4 deg: +-3 deg). The line starts 100 m landward of the
# take-off (on the beach, ~2 m above LMSL) so the whole beach is on it; s is measured from that start.
# The grid is rotated to the shore (+y = seaward, 314 deg; +x = alongshore toward Backdoor/Ehukai, 44 deg) because the lidar is a
# ~1.3 km strip along the shore: an axis-aligned box would have its upwind corner in no-data. Seaward the lidar ends ~1.2-1.3 km
# from the take-off, in 14-25 m of water straight off Pipeline (25-41 m only 0.8-1.6 km to the WSW): the domain's offshore
# edge is the end of the survey, so forecast Hs goes in at about 15-25 m, not the 25-30 m first hoped for.
TAKEOFF = (21.66389, -158.05389)
SHORE_NORMAL_DEG = 314.0
LINE_BACK = 100.0      # m landward of the take-off where the reference line (s = 0) starts
_c = np.cos(np.radians(TAKEOFF[0]))
_o_lat = TAKEOFF[0] + LINE_BACK * np.cos(np.radians(SHORE_NORMAL_DEG + 180)) / 111195.0
_o_lon = TAKEOFF[1] + LINE_BACK * np.sin(np.radians(SHORE_NORMAL_DEG + 180)) / (111195.0 * _c)
PIPELINE = dict(
    key="pipeline", name="Pipeline (Oahu)",
    origin_lat=float(_o_lat), origin_lon=float(_o_lon),
    origin_name="the start of the reference line, 100 m landward of the published Pipeline take-off along the 314 deg shore normal",
    takeoff=dict(lat=TAKEOFF[0], lon=TAKEOFF[1], s=LINE_BACK),
    x_range=(-1200.0, 1200.0), y_range=(-100.0, 1290.0), dx=10.0,
    grid_deg=SHORE_NORMAL_DEG, line_deg=SHORE_NORMAL_DEG, along_deg=(SHORE_NORMAL_DEG + 90.0) % 360.0, s_max=1290.0,
    profile_offsets=np.arange(-600.0, 600.0 + 1, 25.0),
    bed=("npz",), bed_npz=str(HERE / "data" / "bed_grid_pipeline.npz"),
    datum="LMSL", tide_words="m above LMSL (local mean sea level, the lidar datum)",
    # reef bands along the reference line, metres from the 0 m LMSL shoreline on the line: midpoints of Tissot's 61 / 122 / 305 m
    reefs=[("First Reef", 0.0, 91.0), ("Second Reef", 91.0, 213.0), ("Third Reef", 213.0, 400.0), ("outside Third Reef", 400.0, 1e9)],
    points={
        "Pipeline take-off (Wikipedia)": (21.66389, -158.05389, "https://en.wikipedia.org/wiki/Banzai_Pipeline"),
        "Ehukai Beach Park (GNIS/topozone)": (21.6686111, -158.0544444, "https://www.topozone.com/hawaii/honolulu-hi/park/ehukai-beach-park/"),
        "Ehukai Beach Park (hawaii-guide)": (21.66491002, -158.0509203, "https://www.hawaii-guide.com/oahu/beaches/ehukai-beach-park"),
        "Backdoor (surfertoday, approx.)": (21.666971, -158.051569, "https://www.surfertoday.com/surfing/the-mechanics-of-backdoor"),
    },
)


SITES = {s["key"]: s for s in (PORTO_BATEL, PIPELINE)}
