# Pipeline, Oahu North Shore: data and reef model site

## Data
- **Lidar**: 2013 USACE NCMP topobathy DEM (CZMIL), 1 m, vertical datum LMSL (local mean sea level), NOAA Digital Coast dataset 9365. 20 tiles in `data/raw/` (git-ignored; tile list and URLs in `data/raw/SOURCE.txt`, retrieved 2026-11-14).
- **Licence: published on the dataset's official metadata (Benn's decision, 2026-11-16).** NOAA InPort record 65476 (dataset ID 9365): access constraints "None"; collected and processed by USACE; a US Government work. Everything below is derived from it: the viewer reef map (`viewer/data/pipeline.json`, 8 m), the Stage A bed grid (`../06-live-wave/data/bed_grid_pipeline.npz`, 10 m), the lookup table (`../06-live-wave/lookup_pipeline/`) and the public snapshot (`live/pipeline.json`). The e-mail confirmation requested from NOAA on 2026-11-14 is still pending. Not for navigation.
- **Credit** (use this line wherever the Pipeline data appear): Derived from 2013 USACE NCMP Topobathy Lidar DEM (LMSL): Oahu, HI (NOAA OCM dataset 9365), collected by USACE JALBTCX, distributed by NOAA Office for Coastal Management. US Government work, provided as-is, not endorsed by NOAA or USACE.
- **NDBC 51201** (Waimea Bay; owned by PacIOOS, data from CDIP/Scripps): yearly and monthly standard-met files in `data/raw/ndbc_51201/` (git-ignored). Used for the validation only, with attribution. Kept out of every public snapshot until its terms are settled (CDIP asks that data are "not altered").

## Scripts
- `export_pipeline.py`: the 8 m viewer reef map.
- `make_bed_grid.py`: the 10 m Stage A bed grid (block mean of the 1 m pixels; why 10 m and why a block mean are in its docstring). `--probe` prints the lidar elevation at each published point.
- `validate_s2.py`: Sentinel-2 whitewater vs the model (writes `validation/s2_whitewater.json`, numbers only). Results: `VALIDATION.md`.

## Site definition (Stage A, `../06-live-wave/sites.py` PIPELINE)
| Item | Value | Source |
|---|---|---|
| Take-off | 21.66389 N, 158.05389 W | Wikipedia "Banzai Pipeline" coordinates. The lidar puts it in 3.1 m of water, ~45 m off the 0 m contour, consistent with First Reef. |
| Shore normal / reference line | 314 deg (strike 44.2 deg; +-3 deg for 300-600 m fitting windows) | Principal axis of lidar cells within +-0.4 m of 0 m LMSL, within 450 m of the take-off |
| Line start (s = 0) | 100 m landward of the take-off along 134 deg (21.66327 N, 158.05319 W, on the beach) | Chosen so the beach is on the line; the take-off is at s = 100, the 0 m LMSL shoreline at s = 55.7 |
| Domain | 2.4 km alongshore x 1.39 km across (y = -100..1290 m), 10 m cells, grid turned to 314 deg | The lidar is a ~1.3 km strip along the shore; an axis-aligned box would put its upwind corner in no-data |
| Offshore edge (where forecast Hs goes in) | end of the survey, ~1.2 km out: 14-35 m deep, median 17 m on the seaward edge | The lidar stops there. Not the 25-30 m the assessment hoped for |
| Tide datum | m above LMSL; Open-Meteo MSL used as LMSL (offset 0, not checked). Range ~0.6 m | Lidar datum; spots.py |
| Reef bands (naming only) | First 0-91 m, Second 91-213 m, Third 213-400 m from the shoreline | Midpoints of 61 / 122 / 305 m (200 / 400 / 1,000 ft): B. Tissot, [Surfing the reef at Banzai Pipeline](https://briantissot.com/2020/04/13/surfing-the-reef-at-banzai-pipeline/) |
| Not used | Ehukai Beach Park points (topozone/GNIS 21.66861, -158.05444 lies in 12 m of water; hawaii-guide 21.66491, -158.05092 is on land): they disagree by ~500 m | |

Physics and parameters are Porto Batel's, unchanged (H = 0.78 x depth, smoothing, Kr clip, 10 m cells).
