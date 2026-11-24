# Sources and licences: globe front page

| File | What | Source | Licence |
|---|---|---|---|
| `assets/earth_dots.bin` + `earth_dots.json` (0.9 MB) | 301,343 dots on rings 0.37° apart. Each dot stores its elevation (m) and a shore flag. Built by `build_dots.py`. | ETOPO1 1 arc-minute global relief, Ice Surface version (NOAA NGDC, now NCEI; Amante & Eakins 2009, doi:10.7289/V5C8276M). Fetched as every 6th cell (0.1°) from NOAA CoastWatch ERDDAP, dataset `etopo180`: `https://coastwatch.pfeg.noaa.gov/erddap/griddap/etopo180.nc?altitude[(-90.0):6:(90.0)][(-180.0):6:(180.0)]` | US Government work, public domain. ERDDAP's terms: free to use and redistribute, no warranty, not for legal use. Credit: NOAA NCEI ETOPO1. |
| `regions.json` | Spot names and coordinates | Copied from `pieces/01-seafloor/viewer/live_core.js` `LIVE_SPOTS` | Project data |
| three.js 0.187.0 | Rendering | Not copied: imported from `../01-seafloor/viewer/vendor/` | MIT |

How the data is used:
- Each dot takes the value of the nearest 0.1° ETOPO1 cell. No averaging is done.
- Ocean dots are coloured by depth with the seafloor viewer's ramp: shallow at 0 m, mid at 3000 m, deep at 6000 m and deeper.
- Land is drawn dim.
- A dot is a shore dot if land and sea meet within 0.2° of it. Shore dots are drawn brighter, so the coastlines read.
- The dots are 0.37° apart, about 40 km at the equator. Nothing finer than that is shown on the globe.

## Terrain detail (`terrain.js`, source chosen in `terrain-source.js`; comes on when you zoom past the base grid)

**Source (default, since 2026-11-23): Oceany's own terrarium tiles**, built by `tiles-build/build_tiles.py` and served
from the same origin (`tiles-build/tiles/{z}/{x}/{y}.png`, 39,041 tiles, 1.34 GB; not committed, to be hosted, see
`tiles-build/HANDOFF.md`). Same format as before: 256 px terrarium PNGs, web-mercator XYZ, elevation = R×256 + G + B/256 − 32768 m,
rounded to 1 m. Every download, licence quote and date is in `tiles-build/SOURCES.md`.
- **GEBCO_2026 Grid** (15 arc-second, ~463 m at the equator; public domain, commercial use allowed with acknowledgement):
  the seabed at every zoom and land at z0-z8.
- **Copernicus DEM GLO-90 and GLO-30** (Full, Free & Open licence, no purpose restriction): land at z9-z10 (GLO-90) and
  z11-z13 (GLO-30) inside the boxes round the spots. A surface model: trees and roofs are included.
- **Coverage:** z0-z7 cover the globe (z7 ≈ 2.4 km per dot at the equator after the 2 × 2 mean); finer levels exist only in
  boxes round every spot in `regions.json` and `research/wanted-spots.json` (`tiles/coverage.json`). Where they stop, the
  globe stops the zoom at the height where the finest built dots sit ~8 px apart and says "Detail ends here: finer
  terrain is built only around the spots."
- **Seabed honesty:** at sea the dots are interpolated from the 463 m GEBCO grid; the readout says "Seabed from GEBCO_2026,
  measured about every 460 m" and warns when dots are closer than that.
- **Survey sea floor (b55, 2026-11-24), `bathy2/` overlay** (`terrain-source.js`; build and rules in
  `tiles-build/bathy2/PLAN.md` and `tiles-build/SOURCES.md` section 6): where its coverage index lists a tile, its sea dots
  come from a survey instead of GEBCO; land is unchanged. **EMODnet DTM 2024** (~115 m, CC BY 4.0) at z9-z11 (z10 above
  ~60 N) for Ireland, Cornwall, the North Sea, the Baltic to 61.8 N, Biscay, Iberia, the Mediterranean, the Levant,
  Morocco, the Canaries, Madeira and the Azores. **NOAA NCEI CUDEM** (~10 m, US Government work, public domain,
  doi:10.25921/ds9v-ky35) at z9-z13 for the main Hawaiian Islands and Sonoma to Big Sur. No tile is built finer than its
  survey's cell (zoom rule in PLAN.md); the readout names the survey and its cell. Credited in both credit blocks below.

**Credit shown** under View › Terrain credits whenever terrain is on, and in About › Credits (from `tiles-build/SOURCES.md`):

> Terrain: GEBCO Compilation Group (2026) GEBCO 2026 Grid (doi:10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa); produced using Copernicus WorldDEM-30 and WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved. Modified by Oceany (resampled, merged, rounded to 1 m). Not for navigation.

plus the Copernicus licence's liability sentence ("The organisations in charge of the Copernicus programme by law or by
delegation do not incur any liability for any use of the Copernicus WorldDEM-30 or WorldDEM-90") and "Not endorsed by
GEBCO, the IHO or the IOC" (GEBCO terms: no implied official status).

**Use here:** tiles up to z13, each dot the mean of 2 × 2 tile pixels (~30 m per dot at 39°N, the Copernicus GLO-30 grid).
Relief exaggerated ×20 from a whole-globe view, easing to ×1.2 close in; the sea floor by 1 + (exag − 1) × 0.35. Hillshade
is computed from the same elevations and adds no data.

### Old source, kept only behind `?terrain_src=aws` (off by default, not for the public build)

Terrain Tiles on AWS Open Data (Mapzen / Tilezen "joerd"), `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`.
Land SRTM / GMTED2010 / EU-DEM / USGS 3DEP and national sets incl. ArcticDEM; ocean ETOPO1 (~1.85 km) at every zoom. Replaced
because its licence mix (ArcticDEM, EU-DEM wording) is unclear for a commercial or public app and the hosting is
unmaintained (`research/licences-for-app.md` row 2). With the switch on, the page shows its joerd credit instead of ours:

> Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration; United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey; Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers; ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736; Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017; Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich; Canada terrain data contains information licensed under the Open Government Licence – Canada; Mexico terrain data source: INEGI, Continental relief, 2016; New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Government (All rights reserved); Norway terrain data © Kartverket; United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved.

Layer modules listed in `layers.json` (`../08-storms/*.js`) keep their own sources files.

## Also used by the seafloor viewer (reef-map surroundings)

`terrarium.js` fetches and decodes one raw tile through the same `terrain-source.js` (own tiles by default, AWS only with
`?terrain_src=aws` on the viewer's URL). The seafloor viewer (`pieces/01-seafloor/viewer/surround.js`) draws a few km of
coast and sea floor around each lidar patch from it: zoom 12 on land (Copernicus GLO-30, ~30 m per dot), zoom 10 at sea
(GEBCO_2026 underneath, ~463 m). All five unlocked spots sit inside the z12 boxes; checked 2026-11-23: no AWS request.
The viewer's own caption and credit line (`main.js`, `index.html` there) still name AWS Terrain Tiles and ETOPO1: the
viewer's owner should switch them to the credit above.

## Stars (`assets/stars.bin`, built by `build_stars.py`)
HYG database v4.4 (Hipparcos-Yale-Gliese, 119,614 stars) by astronexus, file `hyg_v44.csv.gz` from
https://codeberg.org/astronexus/hyg (`data/hyg/CURRENT/`, a git-lfs file, fetched via the `/media/` path), downloaded
2026-11-23, saved git-ignored in `raw/` (sha256 00b34989...82197d). Licence: CC BY-SA 4.0
(http://creativecommons.org/licenses/by-sa/4.0/); licence file saved as `raw/LICENSE`.
Attribution text: "Star data: HYG v4.4 (Hipparcos-Yale-Gliese) by astronexus, CC BY-SA 4.0,
https://codeberg.org/astronexus/hyg . Filtered to magnitude 6.5; the filtered file is released under the same licence."
**`assets/stars.bin` is a CC BY-SA 4.0 derivative and must stay open (share-alike) in any build, with this credit.**
Residual question: the upstream Hipparcos (ESA) terms are not settled for the compilation; risk low, not zero (see
`research/licences-for-app.md`). It replaces the Yale Bright Star Catalogue (unclear terms); the old file is kept as
`assets/stars.bin.yale.bak` for comparison only and must not ship.
8,920 stars to magnitude 6.5 (HYG `ra` is in hours, converted to degrees; Sol skipped): J2000 right ascension and
declination, magnitude (dot size and brightness, a gentle curve, capped so stars stay fainter than the Earth's dots)
and B−V colour index `ci` (a subtle tint; 0.6 where missing). One static buffer, one draw call, no zoom-dependent detail.
The sky is rotated for the real date and time: stars are placed in the equatorial frame (a star at RA α, Dec δ as if
at latitude δ, longitude α) and the star sphere is turned about the globe's polar axis by −GMST, Greenwich mean
sidereal time from the current UTC (GMST° = 280.46061837 + 360.98564736629 × days since J2000.0), re-read once a
second. A star then sits over longitude α − GMST, so the star overhead a place on the globe is the one overhead there
now. Checked: at 2026-11-22 22:10 UTC the sky turned by GMST 34.6°, which puts the Sun (RA ≈ 238°) over longitude
≈ −157°, matching the Sun's longitude at that time from the equation of time. Polaris stays over the north pole.
Precession since J2000 (~0.3°) and nutation are ignored at this scale. The stars sit at infinity (no parallax).
