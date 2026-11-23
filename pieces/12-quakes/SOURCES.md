# Sources and licence: earthquake layers (live, history)

> A new data source goes in only with a recorded licence that allows commercial use.

Checked 2026-11-23 (about 13:30 UTC). Endpoints were read from the live services, not from memory.

## Summary

| Source | Exact attribution | Licence | Link | Commercial-ready |
|---|---|---|---|---|
| USGS real-time earthquake feeds, GeoJSON summary (`quakes_live.js`) | "Earthquake data: U.S. Geological Survey, Earthquake Hazards Program. Visual by Oceany." | U.S. public domain (USGS-authored data) | https://earthquake.usgs.gov/earthquakes/feed/v1.0/geojson.php | Yes |
| USGS ComCat catalogue via the FDSN event service (`quakes_history.js`, `build_history.py`) | "Earthquake catalogue: U.S. Geological Survey, ANSS Comprehensive Catalog (ComCat). Visual by Oceany." | U.S. public domain (USGS-authored data) | https://earthquake.usgs.gov/fdsnws/event/1/ | Yes |
| Plate boundaries, Bird (2003) PB2002 | not used | no licence stated by the author | https://peterbird.name/publications/2003_PB2002/2003_PB2002.htm | **No: left out** |

Licence basis: the USGS "Copyrights and Credits" page says USGS-authored or produced data and information are considered
to be in the U.S. public domain, and asks for a credit such as "Credit: U.S. Geological Survey".
https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits
The page puts no limit on commercial use of data (its only commercial caveat is about multimedia showing USGS staff).
ComCat merges solutions from contributing ANSS networks; USGS distributes the merged catalogue as its product, and we
credit USGS as it asks.

## Live: USGS GeoJSON summary feeds

- **Feeds:** `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.geojson` (about 45 quakes today) and
  `.../2.5_week.geojson` (about 340). Both answered 200 with `Access-Control-Allow-Origin: *` and `Cache-Control: max-age=60`;
  `metadata.api` = 2.8.2. The docs say each feed is updated every minute; no usage limit is stated.
- **Fields used:** `id`, `properties.mag`, `.place`, `.time` (ms since 1970, UTC), `.type` (only `earthquake`; quarry blasts
  and explosions are skipped), `geometry.coordinates` = [lon, lat, depth km].
- **Cadence in the layer:** day feed every 5 minutes, week feed every 30 minutes, only while the layer is on and the tab is
  visible; 2 minutes after a failure. Nothing is fetched while the layer is off.
- **Limits stated in the layer:** outside the US the feed is complete from about M4.5 only; magnitudes and locations are first
  estimates and are revised.

## History: USGS ComCat, M5.0+, 1970 to now

- **Service:** `https://earthquake.usgs.gov/fdsnws/event/1/query?format=csv&eventtype=earthquake&minmagnitude=5&starttime=YYYY-01-01&endtime=YYYY+1-01-01&orderby=time-asc`,
  one request per year (the service refuses a query matching more than 20,000 events; all M5+ since 1970 is 92,622 of all
  types). 57 requests, one second apart.
- **Raw:** `raw/comcat_m5_YYYY.csv` (15 MB, not shipped). **Built:** `data/quakes_m5.bin` (737 KB) + `data/quakes_m5.json`,
  92,122 earthquakes, 4,326 at 300 km or deeper. Layout in `build_history.py` and the .json.
- **Precision kept:** 0.01 degree position, 0.1 km depth, 0.1 magnitude. Events with no magnitude or position are skipped.
- **Known limits:** less complete before the global network grew (1970s); poorly known depths are often fixed at 10 or 33 km.

## Plate boundaries: left out

Bird (2003), "An updated digital model of plate boundaries", G3, is the standard set (PB2002). The author's site offers the
files with no licence. A widely used GeoJSON conversion on GitHub (fraxen/tectonicplates) labels itself ODC-BY, but that
labels the conversion; it does not show that the original data was released for commercial use. Under the rule above it
stays out. The M5+ history dots outline the plate edges without it. To add it later: a written licence from the author, or
another boundary set with a stated commercial-friendly licence.
