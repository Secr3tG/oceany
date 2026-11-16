# Porto Batel Stage A lookup table

Made by `../sweep_lookup.py` from `../stage_a.py` (same physics as `crest_lines.py` + `height_break_peel.py`, gamma 0.78, nothing tuned). The browser fetches a forecast, converts the tide to LAT, and interpolates this table instead of running Stage A.

Since 2026-11-16 (Part 3) this table is the **fallback** only: hours that come from the published snapshot (`live/porto_batel.json`) carry an exact Stage A run, made by `live-data/build_snapshot.py`. The table serves Open-Meteo hours fetched live by the browser when they differ from the snapshot, and the "Play with the swell" hand-off.

## Axes (4-D grid, v2)
| Axis | Values | Unit |
|---|---|---|
| Tp | 6-18 every 1, then 20 (14) | s, swell period |
| direction | 250-360 every 5 (23) | deg the swell comes FROM, 0 = north |
| tide | 0-4 every 0.125 (33) | m above LAT (the lidar datum) |
| H0 | 0.5-5 every 0.25 (19) | m, wave height at the domain's upwind edge (about 14 m deep) |

201,894 nodes (10,626 phase runs, 7.2 min on 12 cores). v1 (9 H0 x 15 tides x 20 directions, 37,800 nodes) had its largest errors at H0 >= 3 m and low tide, so v2 halves those steps.

**Datum.** tide = Open-Meteo `sea_level_height_msl` + 1.66 m (MSL = LAT + 1.66 m, `notes/forecast-fields.md`), uncertain by about 0.1-0.3 m. Show that band; at low tide 0.25 m moves the break by tens of metres.

**H0 vs forecast Hs.** Stage A starts H0 at the edge of a 2.4 km box, about 14 m deep. Feeding the forecast swell Hs in as H0 is the same assumption milestone 2 made; it is not a deep-water to 14 m transform.

## Files
- `index.json`: axes, profile geometry, byte layout, scales, status codes (`format: v2`).
- `T{Tp}.bin` (one per Tp, 1.62 MB, 22.7 MB in all, little-endian): the browser loads only the two Tp files either side of the forecast Tp, and caches them. Each file holds two uint16 arrays, nodes in `[dir][tide][H0]` order:
  1. `break_s` [node][49]: distance of the seaward-most broken cell along each profile, m x 10.
  2. `scalars` [node][7]: status, break_house (m x 10), breaker_H_house (m x 100), peel_angle_near (deg x 100), peel_speed_near (m/s x 100, median within 250 m of the house), peel_angle_line, peel_speed_line (whole break line). Scales in `index.json` `scalar_scale`.
- `65535` = no break on that profile / no value. Not-breaking nodes are kept, never dropped.
- v1 also stored breaker height and peel angle per profile; the viewer never used them, so v2 drops them to fit the finer grid.
- `shore.json`: water's edge per tide and profile (below). `validate_*`: the checks (below). `test_live_core.mjs`: tests of the panel's logic.

**Status:** 0 breaks on the house line; 1 breaks on the reef but not on the house line; 2 no break anywhere in the domain; 3 no phase (no upwind edge cell deeper than 1 m).

## Profiles = the decimated break line
49 straight profiles, each starting at alongshore offset `o` = -600..600 m every 25 m (direction 326 deg from the house; + is NNW) and running seaward at 236 deg, sampled every 2 m to 698 m. The break-line point for profile `o` at distance `s` is, in metres east/north of the house (39.319506 N, 9.355772 W):

    east  = s sin(236) + o sin(326)
    north = s cos(236) + o cos(326)

Offset 0 is the house line used in RESULTS.md (152 m at Tp 13 s, 325 deg, tide 2.1, H0 1.5).

## Limits
Linear shoaling and refraction plus a breaking ratio; first-arrival eikonal (no caustic second trains); peel angle is an order-of-magnitude number; the 10-50 m gap to the footage take-off is not tuned away. Interpolating across a status change (break / no break) is not meaningful; use the nearest node there.

## Which forecast period goes in as Tp
The table is built for one regular wave of period Tp; the period that sets its wavelength over the reef is the swell's spectral peak. So:
- **Open-Meteo:** `swell_wave_peak_period` where it is given (about the first 3 days), else `swell_wave_period` (the swell mean period, marked "mean" in the viewer).
- **Copernicus IBI:** there is no swell-partition peak. When the primary swell carries more energy than the wind sea (`VHM0_SW1 >= VHM0_WW`), the whole-sea peak `VTPK` sits on the swell and is the closest value; otherwise `VTPK` would be the wind-sea peak, so the swell mean period `VTM01_SW1` is used (marked). A mean period is shorter than the peak, so the modelled wave feels the bottom later.
The rule lives in `live-data/build_snapshot.py` `stage_a_period()` and in the viewer's `live_core.js` `periodFor()`.

## Water's edge (`shore.json`)
Per tide and profile: the distance of the first dry cell (h <= 0.05 m) met walking shoreward from 698 m (bed only). The viewer reports "not breaking on the reef" when the house-line break is within 10 m (one cell) of it. At low tide the first dry cell is often exposed rock out on the reef (152 m at LAT+0), not the beach. Written by `../sweep_lookup.py --shore`.

## Interpolation check (2026-11-16)
`validate_truth.py --n 400 --seed 7 --out validate_truth_400.json` runs `stage_a.run_stage_a` at 400 random off-grid points (18 s on 12 cores); `node validate_interp.mjs validate_truth_400.json --by-axis` interpolates the table with the viewer's own `live_lookup.js` and compares. House-line break error, metres:

| | flag rate | all: median / p95 / max | flagged | unflagged |
|---|---|---|---|---|
| v1 table | 59% | 5.4 / 28.5 / 116.8 | 8.6 / 41.1 / 116.8 | 2.3 / 10.0 / 15.1 |
| v2 table | 20% | 2.3 / 15.1 / 96.2 | 6.5 / 46.9 / 96.2 | 1.5 / 10.4 / 21.0 |

Breaker height error: v1 median 0.05 / p95 0.39 / max 0.92 m; v2 0.03 / 0.28 / 0.62 m. The flag (16 surrounding nodes more than 30 m apart, or some not breaking on the house line) is unchanged; the big remaining errors are real jumps of the break between reef sections, mostly at H0 >= 4 m, and they stay flagged with the nodes' range. 2 of 321 unflagged points still miss by more than 15 m (max 21 m). The older 40-point file (`validate_truth.json`, seed 1) is kept for reference.
