# Sources and licence: sky layers (aurora, snow)

> A new data source goes in only with a recorded licence that allows commercial use.

## Commercial-readiness summary (2026-11-23 night, from `research/licences-for-app.md`)

| Source | Exact attribution | Licence | Link | Commercial-ready |
|---|---|---|---|---|
| NOAA SWPC OVATION aurora forecast and estimated Kp (`aurora.js`) | "Aurora forecast: NOAA Space Weather Prediction Center, OVATION Prime model (Newell et al.; real-time version NOAA NCEI/SWPC). Kp: NOAA SWPC estimated planetary K index. Visual by Oceany, not an official NOAA product." | No SWPC-specific terms; NWS disclaimer (public domain, no endorsement, do not present altered data as official) | https://www.spaceweather.gov/content/data-access , https://www.weather.gov/disclaimer | **Unclear, low risk.** Optional email to SWPC before a paid release (draft in research file, section B). Keep 5 minute polling, back off on failure. Aurora is the only layer allowed an opt-in alert. |
| NOAA/NIC IMS snow and ice, NSIDC G02156 v1 (`snow.js`) | "U.S. National Ice Center. (2008). IMS Daily Northern Hemisphere Snow and Ice Analysis at 1 km, 4 km, and 24 km Resolutions, Version 1 (G02156). Boulder, Colorado USA. NSIDC: National Snow and Ice Data Center. https://doi.org/10.7265/N52R3PMC" | Free with citation (NSIDC) | https://nsidc.org/data/g02156/versions/1 | **Unclear for redistribution.** Use is free with citation; NSIDC redistribution and commercial terms not confirmed, and NSIDC says its servers should not support operational use. Ask NSIDC before a paid build. |
| Stars: HYG v4.4 (not yet used by any file in this folder; for the globe star layer) | "Star data: HYG v4.4 (Hipparcos-Yale-Gliese) by astronexus, CC BY-SA 4.0, https://codeberg.org/astronexus/hyg . Filtered to magnitude 6.5; the filtered file is shared under CC BY-SA 4.0." | CC BY-SA 4.0 | https://codeberg.org/astronexus/hyg | **Yes, with conditions.** The derived star file must carry CC BY-SA 4.0, credit, a change note, and be published. Upstream Hipparcos (ESA CC BY-NC) question open, low risk. Yale BSC5, Hipparcos, Tycho and Gaia must not be used. |



Checked 2026-11-22/23 (UTC 22 Nov ~22:00). Endpoints and fields were read from the live files and the current docs, not from memory.

## Aurora: NOAA SWPC OVATION Prime, 30-minute forecast

- **Feed:** https://services.swpc.noaa.gov/json/ovation_aurora_latest.json (about 920 KB). Keys `Observation Time`, `Forecast Time`,
  `Data Format` = `[Longitude, Latitude, Aurora]`, `coordinates`: 65,160 rows = 360 longitudes (0..359) × 181 latitudes (−90..90), 1-degree grid.
- **Product page:** https://www.swpc.noaa.gov/products/aurora-30-minute-forecast (swpc.noaa.gov now redirects to www.spaceweather.gov).
- **What the value is:** forecast aurora intensity, 0 to about 100. The page does not give units; it says the chance of seeing aurora
  can be taken as roughly proportional to it. The forecast is for `Forecast Time`, about 30-90 minutes after `Observation Time`
  (solar wind travel time from the L1 monitor). If the solar wind input is missing, the model falls back to Kp and has no lead time.
- **Cadence:** not stated in the docs. Measured: `Last-Modified` a few minutes old, `Cache-Control: max-age=60`. The layer refreshes every 5 minutes while visible, and waits 2 minutes after a failure (NWS asks for at least one minute between retries).
- **CORS:** `access-control-allow-origin: *` (checked with curl and in the browser), so the layer fetches the live file. No snapshot script is needed.
- **Height:** https://www.swpc.noaa.gov/phenomena/aurora says aurora typically forms 80 to 500 km up. The layer draws 100-300 km at true height.
- **Model refs:** Newell et al. 2009, doi:10.1029/2009JA014326; Machol et al. 2012, doi:10.1029/2011SW000746. Real-time version by NOAA NCEI and SWPC.
- **Limits stated by SWPC:** aurora is not visible in daylight (their map shades the day side). The layer dims the sunlit side using a Sun position it computes itself.

## Kp: NOAA SWPC estimated planetary K index, 1-minute

- **Feed:** https://services.swpc.noaa.gov/json/planetary_k_index_1m.json, an array of `{time_tag (UTC, no Z), kp_index (int), estimated_kp (float), kp (string)}`, one row per minute. The layer shows the last row's `estimated_kp`. This value is provisional.
- The 3-hourly product https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json (`time_tag, Kp, a_running, station_count`) also works. Its latest row is the bin still in progress.
- Product page: https://www.swpc.noaa.gov/products/planetary-k-index. CORS `*`.

### Terms (SWPC / NWS)

- No licence is given on the SWPC pages. The NWS disclaimer (https://www.weather.gov/disclaimer, linked from the SWPC footer) says the content is public domain unless noted. It also asks users not to imply NOAA endorsement, not to present altered data as official, and to match their requests to the refresh schedule.
- **Credit line:** "Aurora forecast: NOAA Space Weather Prediction Center, OVATION Prime model (Newell et al.; real-time version NOAA NCEI/SWPC). Kp: NOAA SWPC estimated planetary K index. Visual by Oceany, not an official NOAA product."

## Snow and sea ice: IMS Daily Northern Hemisphere Snow and Ice Analysis (NSIDC G02156 v1)

- **Files:** https://noaadata.apps.nsidc.org/NOAA/G02156/24km/{YYYY}/ims{YYYY}{DDD}_00UTC_24km_v1.3.asc.gz (about 28 KB). The layer uses the 24 km grid. 4 km and 1 km grids also exist.
- **Docs:** https://nsidc.org/data/g02156/versions/1. Grid: polar stereographic on WGS84, true scale at 60 N, central meridian 80 W, 1024 × 1024 cells of 24 km.
- **Codes:** 0 outside the hemisphere, 1 open water, 2 land without snow, 3 sea or lake ice, 4 snow-covered land.
- **Row order:** the first data row is the bottom of the map (the header says "(1,1) starts at lower left"). Checked: as read, Greenland comes out as snow, the mid-Atlantic and North Pacific as water, and southern Siberia (50 N 90 E) as snow. With the rows flipped, all of these were wrong.
- **Date:** the file name gives the day the analysis is valid for (00 UTC). The header's "Julian day" is the day before, the day whose data went in. Example: `ims2026326` (valid 22 Nov 2026) has data day 2026325 and was processed Sat 21 Nov 22:01. The layer label shows the valid day.
- **Latency:** about one day. NSIDC does not guarantee delivery times.
- **CORS:** none, so the browser cannot read the file directly. `build_snow.py` downloads the newest file once a day and writes `data/snow_ims24.bin` and `data/snow_ims24.json`.
- **Citation:** "U.S. National Ice Center. (2008). IMS Daily Northern Hemisphere Snow and Ice Analysis at 1 km, 4 km, and 24 km Resolutions, Version 1 (G02156). Boulder, Colorado USA. NSIDC: National Snow and Ice Data Center. https://doi.org/10.7265/N52R3PMC." The data is free to use with this citation.

### Why IMS and not the others (compared 2026-11-22)

| Candidate | Resolution | Coverage | Latency | Browser / script | Falling snow | Verdict |
|---|---|---|---|---|---|---|
| **IMS (NSIDC G02156)** | 24 / 4 / 1 km | Northern Hemisphere | ~1 day | No CORS; stdlib + numpy script | No | **Chosen.** Analyst-made, observation-based, cloud-free, sea ice in the same file. |
| NASA GIBS MODIS/VIIRS NDSI snow | ~500 m | Global | same day | CORS on tiles, but tiles are colour-mapped images, not values | No | Cloud gaps and polar night make "no data" look like "no snow". |
| GFS 0.25° (NOMADS / AWS) SNOD, WEASD, CSNOW | 0.25° | Global | ~3.5 h | GRIB2 complex packing needs wgrib2/eccodes; no CORS | Yes (model CSNOW) | Model, not observed; heavier tooling. A possible future source for falling snow. |
| Open-Meteo `snow_depth`, `snowfall` | point API | Global | 15 min | CORS, but one call per point (10k/day) | Yes (model) | A global grid is not feasible; models disagree. |

- 24 km and not 4 km: the 4 km grid has about 2.5 million snow and ice cells, more dots than the whole globe has. 24 km gives about 73k dots (58k snow, 15k ice on 22 Nov), which is about as dense as the globe's base dots.
- **Falling snow:** IMS reports snow cover only, so the layer draws no falling snow. GFS categorical snow (CSNOW) could supply it later as a separate, clearly labelled model layer.

## Line to add to the repo-level licence files (not edited here)

| Dataset | Used for | Licence | Republish derived data? | Attribution | Link |
|---|---|---|---|---|---|
| NOAA SWPC OVATION aurora forecast, estimated Kp | `pieces/10-sky/aurora.js` (fetched live, not stored) | US government, public domain unless noted (NWS disclaimer) | Not stored | See above | https://www.swpc.noaa.gov/products/aurora-30-minute-forecast |
| IMS snow and ice, NSIDC G02156 v1 | `pieces/10-sky/data/snow_ims24.*` | Free with citation (NSIDC) | Yes, with citation | See above | https://nsidc.org/data/g02156/versions/1 |

## Freshness check, 2026-11-23 03:45 UTC (overnight worker)

- Docs page https://nsidc.org/data/g02156/versions/1 reachable (HTTP 200), still "Version 1", 24 km grid listed; no account needed for the HTTPS archive.
- Archive listing https://noaadata.apps.nsidc.org/NOAA/G02156/24km/2026/ : newest file `ims2026326_00UTC_24km_v1.3.asc.gz` (valid 22 Nov, 27,782 bytes, Last-Modified Sun 22 Nov 2026 14:10:16 GMT). `ims2026327` (valid 23 Nov) returned 404: not published yet. Still no CORS header.
- The snapshot in `data/` was built from that same file at 22 Nov 22:10 UTC, after its Last-Modified, so `build_snow.py` was **not** re-run (it would write the same data). The layer is 1 day old; its stale warning starts past 3 days.
