# Sources and licence: hurricane layer

> A new data source goes in only with a recorded licence that allows commercial use.

## Commercial-readiness summary (2026-11-23 night, from `research/licences-for-app.md`)

| Source | Exact attribution | Licence | Link | Commercial-ready |
|---|---|---|---|---|
| NOAA IBTrACS v04r01 | "Tropical cyclone tracks: NOAA IBTrACS v04r01 (Gahtan et al., 2024, doi:10.25921/82ty-9e16; Knapp et al., 2010, BAMS, doi:10.1175/2009BAMS2755.1). Thinned and re-classified by Oceany; not official." | NCEI open access (WDC policy); data.gov says CC0 | https://www.ncei.noaa.gov/products/international-best-track-archive | Yes (credit, labelled modified; WMO Res. 40 asks agencies be credited and not misrepresented) |
| NOAA/NWS SPC tornado database | "Tornado data: NOAA/NWS Storm Prediction Center severe weather database (tornadoes 1950-2025). Reformatted and thinned by Oceany; not official NOAA/NWS data and not endorsed by NOAA/NWS." | NWS disclaimer, public domain with no-endorsement conditions | https://www.spc.noaa.gov/gis/svrgis/ | Yes |
| NOAA NHC active storms (`hurricanes_live.js`) | "Active storms: NOAA National Hurricane Center (nhc.noaa.gov), CurrentStorms.json and GIS advisories. Redrawn by Oceany; not official and not endorsed by NOAA/NWS." | NWS disclaimer, public domain with no-endorsement conditions | https://www.weather.gov/disclaimer | Yes (credit; never presented as official; safety lines on every card) |
| NOAA IBTrACS ACTIVE (other basins, `hurricanes_live.js`) | as IBTrACS v04r01 above, plus "provisional, days behind real time" | as IBTrACS v04r01 | https://www.ncei.noaa.gov/products/international-best-track-archive | Yes (same terms as the archive file) |
| NWS alerts API (live tornado warnings, `tornado_live.js`) | "Warnings: NOAA/NWS (api.weather.gov). Not an official product; see weather.gov for warnings." | NWS disclaimer | https://www.weather.gov/disclaimer | **Free web build only.** Out of any paid, App Store or ad-supported build. User-Agent question still open. No push alerts, ever. |



## IBTrACS v04r01

- **Dataset:** International Best Track Archive for Climate Stewardship (IBTrACS), version 4r01 (release June 2024, updated weekly), NOAA National Centers for Environmental Information (NCEI). DOI 10.25921/82ty-9e16.
- **File used:** `ibtracs.since1980.list.v04r01.csv` (145,397,410 bytes, server-modified 2026-11-20), from
  https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/
- **Accessed:** 2026-11-22. The raw CSV sits in `raw/` and is not part of the public export.
- **Product page:** https://www.ncei.noaa.gov/products/international-best-track-archive

### Terms (read 2026-11-22)

- NCEI's product page has no licence or "use constraints" field. It says IBTrACS follows World Data Center policy, "which provides full and open access to the data", and points to WMO Resolution 40 for commercial use. It asks (optionally) for a user registration form.
- The data.gov catalog record for the dataset states licence CC0 1.0 (https://creativecommons.org/publicdomain/zero/1.0/). The same record also lists "rights: otherRestrictions" and access level "non-public", which contradicts open access and looks like template metadata; the NCEI ISO metadata record (C00834) returned HTTP 503 and was not read. Treat CC0 as a catalog statement, not NCEI's own wording.
- Conclusion: derived tracks and a density map may be redistributed with attribution. It is NOAA open data, not a restrictive licence. Not legal advice. Optional: ask NCEI (ncei.orders@noaa.gov / the IBTrACS Q&A group) for a written statement, as for the Pipeline lidar.
- The underlying best tracks come from agencies (NHC, JTWC, JMA, CMA, IMD, Météo-France, BoM, etc.). WMO Resolution 40 asks that data from those centres are credited and not misrepresented.

### Required attribution (use in README and viewer)

> Tropical cyclone tracks: NOAA IBTrACS v04r01 (Gahtan et al., 2024, doi:10.25921/82ty-9e16; Knapp et al., 2010, BAMS, doi:10.1175/2009BAMS2755.1), accessed 2026-11-22. Thinned to 6-hourly points, 1980 onward, storms reaching tropical-storm strength; categories are our own Saffir-Simpson classification of the 1-minute-wind values.

### What we changed

6-hourly points only, 1980 onward, storms with max wind of 34 kt or more, positions rounded to 0.01 degree, wind to whole knots. Wind is the US agency (1-minute) wind where present, else the WMO-agency wind (agency averaging periods differ, so categories outside the Atlantic and East Pacific are approximate). The density dots (one per 0.5 degree cell ever hit, value = log of storms per cell) are our own calculation.

### Storm radii (build_hurricane_radii.py)

Per 6-hourly point, from the same CSV: gale radius = mean of the non-empty quadrant columns `USA_R34_NE`, `USA_R34_SE`, `USA_R34_SW`, `USA_R34_NW` (nautical miles, radius of 34 kt wind), falling back to `BOM_R34_*` then `REUNION_R34_*`; radius of maximum wind = `USA_RMW`, falling back to `BOM_RMW` then `REUNION_RMW` (nautical miles). Converted to km (x1.852) into `data/track_radii.bin`. Points without either use the storm's own nearest recorded value, else a typical value for the wind (stated in the layer's details as "estimated"). Other agencies' radii (e.g. `TOKYO_R30_*`, 30 kt) are not used.

### Line to add to the repo-level licence files (not edited here)

| Dataset | Used for | Licence | Republish derived data? | Required attribution | Link |
|---|---|---|---|---|---|
| NOAA IBTrACS v04r01 | `pieces/08-storms/data/` (tracks, density) | NOAA NCEI, "full and open access" (WDC policy); data.gov catalog says CC0 (contradicted by an "otherRestrictions" field) | Yes, with attribution | See above | https://www.ncei.noaa.gov/products/international-best-track-archive |

## NOAA/NWS Storm Prediction Center tornado database

- **Dataset:** SPC severe weather database, tornadoes 1950-2025, `1950-2025_actual_tornadoes.csv` (9,023,445 bytes, server-modified 2026-04-24; 73,458 rows; the 2025 data ends 2025-09-09, a partial year). Page: https://www.spc.noaa.gov/gis/svrgis/ (updated 23 April 2026); column description: https://www.spc.noaa.gov/wcm/data/SPC_severe_database_description.pdf (not read).
- **File URL:** https://www.spc.noaa.gov/wcm/data/1950-2025_actual_tornadoes.csv, downloaded 2026-11-22 into `raw/spc/`.
- **Terms (read 2026-11-22):** the SPC page's own "Disclaimer" link goes to the NWS disclaimer (https://www.weather.gov/disclaimer): NWS information is "in the public domain, unless specifically noted otherwise" and may be used without charge for any lawful purpose provided you do not (1) claim it is your own, (2) imply endorsement or affiliation with NOAA/NWS, or (3) modify it and present it as official government material. The SVRGIS page carries no separate licence or citation request. (spc.noaa.gov/misc/disclaimer.html is a 404; the fetch tool got 403 on the SPC pages, so they were read in a normal browser.) Not legal advice.
- **Conclusion:** derived tracks and a density map may be redistributed. Our version is modified, so it must be labelled as ours and not as official data.
- **Attribution to use:** "Tornado data: NOAA/NWS Storm Prediction Center severe weather database (tornadoes 1950-2025), accessed 2026-11-22. Reformatted and thinned by Oceany; not official NOAA/NWS data and not endorsed by NOAA/NWS."
- **What we changed:** positions rounded to 0.01 degree; ratings 0-5 kept (F before 2007, EF from 2007), -9 stored as "unknown" (6); end coordinates of 0.0 treated as "no end recorded" and drawn as a point, not a path. Density dots are our own calculation: one dot per 0.25 degree cell touched by at least one tornado path, 1991-2024; cells without a tornado have no dot, so nothing is implied outside coverage.
- **Known bias:** reporting rose over time (1950s counts are low; weak F0/EF0 are over-represented after 1990), so the density uses 1991-2024 only and is a map of reports, not of true tornado climatology.
- **Line for the repo-level licence files (not edited here):** | NOAA/NWS SPC tornado database 1950-2025 | `pieces/08-storms/data/tornado_*` | US government work, NWS public domain with no-endorsement conditions | Yes, labelled as modified | See above | https://www.spc.noaa.gov/gis/svrgis/ |

## Live tornado warnings (tornado_live.js)

- **Source:** NWS alerts API, `https://api.weather.gov/alerts/active?event=Tornado%20Warning`, fetched in the visitor's browser (CORS `*`, GeoJSON, 5 s cache). US government data; same NWS disclaimer as above applies (public domain, do not imply endorsement). No User-Agent or contact details are sent (browser defaults only); the NWS asks API users to identify themselves and its rate limit is not public, so the layer polls once every 3 minutes, backs off to 15 minutes after errors, and pauses while the tab is hidden.
- **Probed 2026-11-22:** HTTP 200, `access-control-allow-origin: *`, `application/geo+json`, 0 features (quiet season). The code reads `features[].geometry` (Polygon or MultiPolygon; null geometry is counted but not drawn), `properties.event` and `properties.parameters.tornadoDetection`; that payload shape is from the API documentation, not yet seen live.
- **Replay:** `data/replay_outbreak.json`, 210 tornadoes of 27 April 2011 from the SPC database (times in CST, SPC code 3), built by `build_tornadoes.py`.
- **Not included:** SPC same-day reports and radar (TVS) points; they would each add a feed and a parser.

## Hurricanes live (build_hurricanes_live.py, hurricanes_live.js), added 2026-11-24

Every surface of this layer (cards, status, details) carries: "For research and play only. Not a forecast or warning service." and "Not an official product. Do not use for safety decisions."

### NOAA National Hurricane Center (Atlantic, East and Central Pacific)
- **Feed:** https://www.nhc.noaa.gov/CurrentStorms.json, one entry per active storm in `activeStorms[]`. Fields used: `id`, `name`, `classification`, `intensity` (kt), `pressure` (mb), `latitudeNumeric`, `longitudeNumeric`, `movementDir`, `movementSpeed`, `lastUpdate`, `publicAdvisory.advNum/issuance/url`, `forecastTrack.zipFile` (the advisory's 5-day shapefile zip), `bestTrackGIS.zipFile`. Field names read from NHC's sample file https://www.nhc.noaa.gov/productexamples/NHC_JSON_Sample.json on 2026-11-23 (no separate field documentation was found). Live file on 2026-11-23: `{"activeStorms": []}`, with ETag and Last-Modified headers (`cache-control: max-age=300`).
- **GIS zips:** `https://www.nhc.noaa.gov/gis/forecast/archive/{id}_5day_{adv}.zip` (shapefiles `_5day_pts` forecast points with `TAU`, `MAXWIND`, `MSLP`, `LAT`, `LON`, `VALIDTIME`, `ADVDATE`, `SSNUM`; `_5day_pgn` the cone; `_5day_lin`; `_ww_wwlin` watches and warnings, not drawn) and `https://www.nhc.noaa.gov/gis/best_track/{id}_best_track.zip` (`_pts`: `DTG`, `INTENSITY`, `MSLP`, `LAT`, `LON`). Read with our own `shapefile_lite.py` (standard library). Format checked by downloading Milton advisory 12 (al142024_5day_012.zip, 42,885 bytes) on 2026-11-23.
- **Timing:** routine advisories at 03, 09, 15 and 21 UTC; intermediate public advisories every 3 hours while coastal watches or warnings are in effect; special advisories at any time (https://www.nhc.noaa.gov/aboutnhcprod.shtml, read 2026-11-23). The workflow checks at :12 past each hour, but asks NHC only at the four advisory hours unless a storm is active; each check is one conditional GET (If-None-Match), which returns 304 with no body when nothing changed.
- **Terms:** NWS disclaimer (https://www.weather.gov/disclaimer, read 2026-11-23): NWS information is in the public domain unless noted otherwise; do not claim it as your own, imply endorsement, or present modified material as official. It also asks automated clients to know the data's refresh frequency and request only what they need. `nhc.noaa.gov/robots.txt` allows all. NHC's own disclaimer page returned 403 to the fetch tool and was not read.
- **What we changed:** cone outline thinned to points ~0.12 degree apart; positions rounded to 0.01 degree; drawn as dots. The cone is NHC's: the probable track of the centre (sized from NHC's past 5-year forecast errors, about two thirds inside), not the storm's size; the card says so.
- **Attribution on the card:** "Source: NOAA National Hurricane Center; other basins NOAA IBTrACS. Redrawn by Oceany; not official, not endorsed by NOAA/NWS." Each NHC card links to that storm's public advisory.

### Other basins: NOAA IBTrACS ACTIVE (not JTWC)
- **File:** https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.ACTIVE.list.v04r01.csv (storms active in the last 7 days, about 40 KB; NCEI says updated three times a week; provisional). Same terms and attribution as the IBTrACS archive above.
- **Rule:** NHC's basins are skipped (they come from NHC). A storm is shown only when its last record is within 12 h of the file's newest record, and nothing is shown when that newest record is older than 96 h. Shown as "Recent track, not live", dimmer, without forecast or cone, with its last record time.
- **JTWC not used:** JTWC (US Navy/Air Force) warning pages returned 403 to scripts on 2026-11-23 (robots.txt not readable); its RSS (https://www.metoc.navy.mil/jtwc/rss/jtwc.rss) is fetchable but only says whether warnings exist. No explicit reuse licence was found, and a secondary source describes the site as intended for US government use. Not commercial-OK on the record we have, so it stays out. NOAA's ATCF b-decks (https://ftp.nhc.noaa.gov/atcf/btk/) hold only NHC basins.

### Line for the repo-level licence files (not edited here)
| NOAA NHC CurrentStorms.json + GIS advisories | `pieces/08-storms/data/live_storms*.json` (R2: `data/hurricanes-live/`) | US government work, NWS public domain with no-endorsement conditions | Yes, labelled as redrawn, not official | See above | https://www.nhc.noaa.gov/gis/ |
