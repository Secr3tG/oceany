# Pipeline Stage A lookup table

Data credit: Derived from 2013 USACE NCMP Topobathy Lidar DEM (LMSL): Oahu, HI (NOAA OCM dataset 9365), collected by USACE JALBTCX, distributed by NOAA Office for Coastal Management. US Government work, provided as-is, not endorsed by NOAA or USACE.

Made by `../sweep_lookup.py --site pipeline` from `../stage_a.py` with the site `PIPELINE` in `../sites.py`. Same physics and constants as Porto Batel (gamma 0.78, phi smoothing 2 cells, Kr clip 0.3-2.5, 10 m cells), nothing tuned. Same file format as `../lookup/` (v2), read by the same viewer code (`viewer/live_lookup.js`).

The table is the **fallback**: hours in the public snapshot `live/pipeline.json` (`live-data/build_snapshot.py --public --spots pipeline`, Open-Meteo hours only, ~20 s) carry an exact Stage A run.

## Site (details and sources: `../sites.py`, `../../05-pipeline/README.md`)
- Bed: 2013 USACE NCMP topobathy lidar (1 m, LMSL), block-averaged to 10 m by `../../05-pipeline/make_bed_grid.py` -> `../data/bed_grid_pipeline.npz` (201 KB). The grid is turned to the shore: +y = 314 deg (seaward), +x = 44 deg; 241 x 140 cells (2.4 km alongshore, -100..1290 m across).
- Reference line: from 100 m landward of the published take-off (21.66389 N, 158.05389 W, Wikipedia) straight out at 314 deg (the lidar shore normal). `s` = metres from that start. The 0 m LMSL shoreline crosses it at s = 55.7 m (`shore_s_lmsl_m`); the take-off is at s = 100.
- Forecast Hs goes in as H0 at the domain's upwind edges, which are the end of the lidar survey: 14-35 m deep (median 17 m on the seaward edge). Not the 25-30 m hoped for: the survey stops ~1.2 km out.
- Tide: m above LMSL. Open-Meteo `sea_level_height_msl` is used as is (offset 0, not checked).
- Reef bands (`reefs`, used only to name a break): First Reef 0-91 m, Second 91-213 m, Third 213-400 m from the shoreline, then "outside Third Reef". Edges are the midpoints of Tissot's published 61 / 122 / 305 m.

## Axes (4-D grid)
| Axis | Values | Unit |
|---|---|---|
| Tp | 8-18 every 1, then 20, 22 (13) | s |
| direction | 270-390 every 5 (25); 390 = 30 deg | deg FROM; a forecast d < 180 is read as d + 360 |
| tide | -0.3..0.9 every 0.1 (13) | m above LMSL |
| H0 | 0.5-8 every 0.25 (31) | m |

130,975 nodes (4,225 phase runs, 3.5 min on 12 cores). Files `T{Tp}.bin`: 1.13 MB each, 14.7 MB in all; the browser loads only the two either side of the forecast Tp.

## Interpolation check (2026-11-16)
`validate_truth.py --site pipeline --n 400 --seed 7 --out validate_truth_400.json`, then `node validate_interp.mjs --dir ../lookup_pipeline validate_truth_400.json --by-axis` (both in `../lookup/`). Break distance error on the reference line, m:

| flag rate | all: median / p95 / max | flagged | unflagged |
|---|---|---|---|
| 42% | 3.5 / 105 / 289 | 14.9 / 150 / 289 | 1.6 / 8.3 / 70 |

Breaker height error: median 0.04, p95 0.63, max 2.4 m. 4 of 232 unflagged points miss by more than 15 m. The big errors are real jumps: once the wave is big enough to break over the ~9-11 m shelf that runs from ~250 m to ~1 km out, the first break leaps from Second Reef (~150 m) to 400-1100 m. That happens mostly at H0 >= 5 m (flag 67-77% there) and the table cannot interpolate across it; those cases are flagged and show the range. This is why exact runs (the snapshot) matter more here than at Porto Batel.

## Limits
As Porto Batel (`../lookup/README.md`), plus: the lidar is from 2013 and the beach and First Reef sand change by season; the 10 m grid smooths First Reef's ledges; no refraction outside the survey; the shelf break-out at H0 >= 5 m is a model result that the validation (`../../05-pipeline/VALIDATION.md`) could only check for the swells Sentinel-2 caught.
