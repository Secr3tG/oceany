# 11-ocean: sources, licences and why these (checked 2026-11-22/23)

> A new data source goes in only with a recorded licence that allows commercial use.

## Commercial-readiness summary (2026-11-23 night, from `research/licences-for-app.md`)

| Source | Exact attribution | Licence | Link | Commercial-ready |
|---|---|---|---|---|
| NOAA NCEP GFS 10 m wind (`wind.js`) | "Wind: NOAA NCEP GFS. Redrawn by Oceany; not an official NOAA product. Do not use for safety decisions." | US Government work, public domain (NWS disclaimer) | https://www.weather.gov/disclaimer | **Yes** |
| NOAA NCEP GFS-Wave / WAVEWATCH III: total sea and primary swell (`waves.js`, `swell.js`) | "Waves and swell: NOAA NCEP GFS-Wave (WAVEWATCH III). Redrawn by Oceany; not an official NOAA product. Do not use for safety decisions." | Same | https://nomads.ncep.noaa.gov/ | **Yes.** Cache our snapshot; never send visitors to NOMADS. Period labels say "peak"; partition peak-period naming still UNCONFIRMED. |
| PacIOOS ERDDAP WW3 and GFS (`build_ocean_pacioos.py`, fallback, not used now) | "Wave model: WAVEWATCH III run by University of Hawaii PacIOOS (K. F. Cheung), forced by NOAA GFS." | "may be used and redistributed for free but is not intended for legal use"; silent on commercial | https://pae-paha.pacioos.hawaii.edu/erddap/info/ww3_global/index.html | **Unclear.** Not in any build while NOMADS is used. Ask PacIOOS before ever using it in a paid build. |
| ECMWF IFS 10 m wind and ecWAM total sea (`wind.js`, `waves.js` when the Model switch is on ECMWF; `build_ecmwf.py`) | "© 2026 European Centre for Medium-Range Weather Forecasts (ECMWF). Source: ECMWF open data, IFS. Licence: CC BY 4.0. ECMWF does not accept any liability whatsoever for any error or omission in the data, their availability, or for any loss or damage arising from their use. Regridded and rounded by Oceany." | CC BY 4.0 under the ECMWF Terms of Use (attribution required, commercial use allowed) | https://www.ecmwf.int/en/forecasts/datasets/open-data ; https://apps.ecmwf.int/datasets/licences/general/ | **Yes**, with the attribution shown in the layer's details and the globe's About text. Services built on it should also say "This service is based on data and products of the European Centre for Medium-Range Weather Forecasts (ECMWF)." |
| Open-Meteo | Not used by this folder. | Free tier non-commercial | https://open-meteo.com/en/pricing | **No** (not used here) |



All three layers show **model output**, not measurements. Every layer's `details` starts with "Not an official product. Do not use for safety decisions." and names the model, the run and the valid time.

## What is used (since 2026-11-23 night: NOAA's own servers only)

| Field | Layer | File on NOMADS | Model | Grid | GRIB2 fields |
|---|---|---|---|---|---|
| 10 m wind | `wind.js` | `gfs.YYYYMMDD/HH/atmos/gfs.tHHz.pgrb2.0p50.fFFF` | NOAA NCEP GFS | 0.5°, 361 x 720, 3-hourly | `UGRD`, `VGRD` at "10 m above ground" |
| Total sea | `waves.js` | `gfs.YYYYMMDD/HH/wave/gridded/gfswave.tHHz.global.0p25.fFFF.grib2` | NOAA NCEP GFS-Wave (WAVEWATCH III), forced by the same GFS run | 0.25°, 721 x 1440, hourly to 120 h; we keep every 2nd point (0.5°, true values, no averaging) | `HTSGW`, `PERPW`, `DIRPW` |
| Primary swell | `swell.js` | same | same | same | `SWELL`, `SWPER`, `SWDIR` "1 in sequence" (partitions 2 and 3 exist, not used) |
| Wind sea | stored, not drawn | same | same | same | `WVHGT`, `WVPER`, `WVDIR` |

- Base URL: https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/ . Runs at 00, 06, 12, 18 UTC; a run appears about 4 h later. The script picks the newest run that already has the file for the valid time (now, rounded down to 3 h).
- How it fetches: each file has a `.idx` text list (field number, start byte, name, level). The script downloads the `.idx`, then asks for only the byte ranges of the fields it needs (HTTP `Range`), as NCEP's "fast downloading" page describes (https://www.cpc.ncep.noaa.gov/products/wesley/fast_downloading_grib.html). One build: 2 HEAD, 2 idx and 11 ranged GETs (about 4.5 MB), with a 0.5 s pause after each.
- Packing seen 2026-11-23 (decoded by `build_ocean.py`'s own small reader, numpy + Pillow): the wave file uses JPEG 2000 (template 5.40) with a land bitmap; the GFS wind uses complex packing with second-order spatial differencing (template 5.3). Anything else stops the script with an error. (The `filter_gfswave.pl` CGI repacks subregions as simple packing; `live-data/grib2_simple.py` reads that. Two readers now exist; see handoff.)
- **Rate limits:** no current per-minute number is published on the NOMADS pages read (https://nomads.ncep.noaa.gov/info.php?page=help links help pages only). NCEP announced rate limiting on NOMADS in 2021 (SCN 21-32, https://www.weather.gov/media/notification/pdf2/scn21-32nomad_changes.pdf); an NCEP partner webinar proposed 60 hits a minute (https://www.weather.gov/media/wrn/calendar/NWS-PartnerWebinar_NCEP-Web-Services.pdf; not confirmed as final); a 2021 third-party report said 120 a minute. 15 requests spread over ~10 s stay well under any of these. Questions: ncep.pmb.dataflow@noaa.gov.
- curl note: NOMADS's HTTP/2 answer has a malformed `content-length` header that curl rejects; use `--http1.1`. Python's urllib is HTTP/1.1 and is fine.

**Snapshot in `data/` now:** valid **23 Nov 2026 00:00 UTC**. GFS and GFS-Wave run **22 Nov 18 UTC**, forecast hour 6. Built 23 Nov 2026 ~02:08 UTC (04:08 local).

## Licence and terms
NOAA NCEP model output is a US Government work, public domain. NWS disclaimer (https://www.weather.gov/disclaimer): information on NWS pages is public domain unless noted and "may be used without charge for any lawful purpose" as long as you do not claim it as your own, imply NOAA/NWS endorsement, or alter it and present it as official. This covers commercial use (ads, paid apps). Attribution to give: "Wind: NOAA NCEP GFS. Waves and swell: NOAA NCEP GFS-Wave (WAVEWATCH III). Redrawn by Oceany; not an official NOAA product." Plus the not-for-safety line. NOMADS has no service-level promise for apps: cache our own snapshot (as here), never send visitors to NOMADS.

Open point (period labels): the GRIB2 table names `PERPW` "primary wave mean period" and `SWPER`/`WVPER` "mean period", but NCEP's WAVEWATCH III writes the peak period into `PERPW` (and, as far as I can tell, the partition peak period into `SWPER`). UNCONFIRMED for the partitions; the layers say "peak period". Check the GFS-Wave product description before quoting it as peak in a finished piece.

## ECMWF open data (second model, since 2026-11-24; `build_ecmwf.py`)
Checked 2026-11-23/24 against https://www.ecmwf.int/en/forecasts/datasets/open-data , the open-data Confluence pages
(https://confluence.ecmwf.int/display/DAC/ECMWF+open+data%3A+real-time+forecasts+from+IFS+and+AIFS , file naming
https://confluence.ecmwf.int/spaces/DAC/pages/738041084 , dissemination schedule https://confluence.ecmwf.int/display/DAC/Dissemination+schedule)
and the files themselves.

| Field | Stream / param | Grid | Steps kept |
|---|---|---|---|
| 10 m wind | `oper` `10u`, `10v` | 0.25° (721 x 1440, columns from 180° E; rolled to start at 0° E like GFS), every 2nd point kept | +6 to +18 h, every 3 h |
| Total sea | `wave` `swh` (height), `pp1d` (peak period), `mwp` (mean period), `mwd` (mean direction, coming from) | same | same |

- Files: `{root}/YYYYMMDD/HHz/ifs/0p25/{oper|wave}/YYYYMMDDHH0000-{step}h-{stream}-fc.grib2` with a `.index` beside it
  (one JSON line per field: `param`, `_offset`, `_length`). Root: Google Cloud mirror
  `https://storage.googleapis.com/ecmwf-open-data/` (byte ranges work, ~2 min behind ECMWF), fallback
  `https://data.ecmwf.int/forecasts/` (500-2000 simultaneous connections allowed, variable). The AWS mirror
  (`ecmwf-forecasts` bucket) answered "SlowDown" (HTTP 503) to plain requests on 2026-11-23, so it is not used.
  A 0.1° IFS (`ifs/0p1/`) also exists since Oct 2026, about 2 h later; not used (0.25° is already finer than we draw).
- Packing: CCSDS (GRIB2 template 5.42); `grib2.py` decodes it with `imagecodecs` (libaec). Checked: values in range
  (swh 0-11.8 m, pp1d 1-29 s, 10u -22..+26 m/s), land and sea ice as missing in the wave fields (36% of points).
- Release (Last-Modified on data.ecmwf.int, 22-23 Nov 2026; every step of a run appears at once): 00 UTC run 07:34,
  06 UTC 12:27, 12 UTC 19:34, 18 UTC 00:27 UTC next day. The workflow runs 6 min after the mirror copy is due.
- No swell partitions in the open set (`wave` has swh, mwd, mwp, pp1d, mp2, cdww, h1012..h2530, wmb), so the swell
  fronts stay on GFS-Wave. Since Cycle 50r1 (May 2026) the 06/18 runs are in `oper`/`wave` too (scda/scwv retired).
- Compared with GFS-Wave: `Tper` is the peak period in both (GFS `PERPW`, ECMWF `pp1d`). Direction differs:
  ECMWF gives the mean direction (`mwd`), GFS-Wave the peak/primary direction (`DIRPW`). In a mixed sea these can be
  tens of degrees apart, so a direction difference between the models is partly a definition difference.

## Earlier source (kept as fallback, not used now)
`build_ocean_pacioos.py` reads PacIOOS ERDDAP: `ww3_global` (WAVEWATCH III run by the University of Hawaii, forced by GFS; licence line "may be used and redistributed for free but is not intended for legal use", silent on commercial use) and `ncep_global` (GFS). Replaced because the research (`research/licences-for-app.md`, "Commercial readiness") asks for an official NOAA source, and because the PacIOOS WW3 run lagged about a day (run 21 Nov 00 UTC used for 22 Nov 21 UTC). **Bug found in that version:** its wind grid was stored north-first while `ocean.json` and `wind.js` read it south-first, so the old wind layer was drawn upside down (checked 23 Nov: zonal-mean u at 50° S was +2.3 m/s in the old file and +7.8 m/s in the NOMADS one; the decoded NOMADS 00 UTC +21 h field matches the old file flipped, correlation 0.987). The old wave file was the right way up.

## Candidates compared
- **NOAA NOMADS (chosen):** public domain, NCEP's own runs, wind and waves from the same run, 4 runs a day, Arctic included, several swell partitions. Cost: GRIB2 decoding (done in the script, ~100 lines) and no OpenDAP (retired, SCN 25-81).
- **PacIOOS ERDDAP:** plain CSV, CORS open, but the WW3 is a university run with terms silent on commercial use, one run a day, a day behind, no Arctic, slow (about 50 s per request).
- **Open-Meteo marine and weather APIs:** free API is non-commercial only; per-point; repackages other models. Not used.
- **Copernicus Marine (MFWAM 1/12°, regional IBI/NWS):** commercial use allowed with attribution, finer, but needs an account and its toolbox. The better feed for the Portuguese and Danish coasts; later.

## Live fetch or snapshot
Snapshot. NOMADS sends no CORS headers for browsers to rely on, files are GRIB2, and every page load would hit a government server. `build_ocean.py` (numpy + Pillow) writes 2.3 MB (`waves_ww3.bin`, uint8, 9 x 361 x 720) + 0.5 MB (`wind_gfs.bin`, int8) + `ocean.json`. Quantisation: 0.25 m/s wind, 5 cm height, 0.05 s period, 1° direction (less than the models' own error).

## Spot numbers (`ocean.json` `spots`)
For each unlocked spot in `07-globe/regions.json`, the nearest **0.25° grid point** with wave data within 1.5° (the full GFS-Wave grid, not the thinned 0.5° one): primary swell height, period, direction from, and total Hs. This is offshore swell at about 28 km spacing; it cannot see inside a bay or behind a headland.

## Downloads (all under 1 GB)
- 2026-11-23 ~02:00-02:10 UTC: NOMADS byte ranges for the checks and builds above, about 25 MB in total (GFS 0.5° 00z f018/f021/f024 and 18z f006 wind; GFS-Wave 18z f003 and f006 fields). Only the snapshot in `data/` is kept; test copies live in the session scratchpad.
- NDBC realtime text files 62144, 62145, 62146, 62121 and the active-stations list (a few KB, check only, not shipped).

## Typical swells and Peniche reference snapshots (2026-11-23)
| Used for | Source | Licence | Where |
|---|---|---|---|
| Typical winter swell at Supertubos, Guéthary, Hossegor (and the Peniche reference snapshots in `pieces/02-reefs/data`) | NOAA NCEP GFS-Wave (WAVEWATCH III) 0.25°, from the NOAA archive on AWS: https://noaa-gfs-bdp-pds.s3.amazonaws.com/ (`gfs.YYYYMMDD/CC/wave/gridded/`) | US Government work, public domain | `build_typical_swell.py`, `data/typical_swell.json` |

Replaces Open-Meteo (non-commercial free tier). Period labels: same open point as above (peak vs mean).

## Wave forecast for the time bar (build_forecast.py, 25 Nov 2026)
- **GFS-Wave (WAVEWATCH III)**, NOAA NCEP, US Government work, public domain. Read from NOAA Open Data Dissemination
  on AWS: `https://noaa-gfs-bdp-pds.s3.amazonaws.com/gfs.YYYYMMDD/HH/wave/gridded/gfswave.tHHz.global.0p25.fFFF.grib2`
  (+ `.idx` for byte ranges); NOMADS as fallback. Checked 25 Nov 2026: hourly files to f120, 3-hourly to f384.
  Fields used: HTSGW, WVHGT, SWELL/SWPER/SWDIR partition 1, WVDIR.
- **ECMWF IFS ecWAM open data**, © ECMWF, CC BY 4.0, from `https://storage.googleapis.com/ecmwf-open-data/` (mirror of
  data.ecmwf.int). Checked 25 Nov 2026: 00z run wave stream to 240 h; params include swh, mwd, pp1d, mwp, mp2 and
  period-band heights h1012 … h2530; no swell/wind-sea split. Fields used: swh, pp1d, mwd.
- Kept: 0 to +120 h every 3 h, +126 to +168 h every 6 h (49 steps). 0.5 degree to +120 h (desktop), 1 degree for every
  step (phones, and desktop after +120 h). Six uint8 planes per step, gzip. Measured 25 Nov: GFS 25.0 MB per run
  (hi ~450 KB/step, lo ~150 KB/step), ECMWF 20.1 MB.

## Sea depth for the swell lines' refraction (waves.js, b60)
- `data/depth_hi.bin.gz` (0.133 degree) and `data/depth_lo.bin.gz` (0.267 degree, phones), built by `build_depth.py`
  from the GEBCO 2026 Grid, averaged down by the globe's terrain build. Credit: GEBCO Compilation Group (2026) GEBCO
  2026 Grid. Free to use and copy with this credit (GEBCO terms of use).
- Used only to bend the drawn swell crests over the shelf (refraction, drawn by the page, not by the wave model).
