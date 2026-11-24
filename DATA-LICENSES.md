# Data licences and attribution

The code in this repository is Apache-2.0 (see LICENSE). The data shown in the
viewer comes from the sources below. Each keeps its own terms.

Wave layers are illustrative models, not forecasts or predictions. Nothing here
is for navigation.

## Bathymetry data

- North Sea and Klitmøller grid (about 115 m and 2-4 km): EMODnet Bathymetry DTM.
  This data product was created by EMODnet and is owned by the EU, licensed under
  the Creative Commons Attribution 4.0 International licence (CC BY 4.0).
  EMODnet Bathymetry Consortium, https://emodnet.ec.europa.eu/en/bathymetry.
  Downsampled and re-gridded for this viewer. Not for navigation.
  Terms: https://emodnet.ec.europa.eu/en/terms-use-emodnet-online-services-data-and-data-products
- Globe terrain tiles, European seas at the closer zooms (z9-z10: North Sea, Danish waters,
  Bay of Biscay, Iberia): EMODnet Bathymetry Consortium (2024). EMODnet Digital Bathymetry
  (DTM 2024). https://doi.org/10.12770/cf51df64-56f9-4a99-b1aa-36b8d7b743a1. CC BY 4.0.
  Resampled and merged with GEBCO_2026 and Copernicus DEM. Not for navigation.
  Details: `pieces/07-globe/tiles-build/SOURCES.md` section 3.
- Danish waters (50 m): Contains data from the Danish Geodata Agency, Denmark's
  Depth Model, 50 m resolution. Obtained 2026-11-11. Terms:
  https://eng.gst.dk/danish-hydrographic-office/denmark-depth-model
  Not for navigation. The Danish Geodata Agency does not endorse this project.
- Peniche and Porto Batel reef maps: Topo-bathymetric lidar 2011, Direção-Geral do
  Território (DGT) and Agência Portuguesa do Ambiente (APA), via the EMODnet
  Bathymetry high-resolution patch 590_HR_Lidar_Centro, CC BY 4.0.
  Resampled; depths relative to LAT. Not for navigation.
  The EMODnet metadata for this patch states CC BY 4.0 and "do not use for
  navigation". Originators per that metadata: APA and IGEO (now DGT).

- Pipeline, Oahu reef map, reef-model bed grid, lookup table and live snapshot: 2013 USACE NCMP
  topobathy DEM (LMSL), 1 m, NOAA dataset ID 9365. Derived from 2013 USACE NCMP Topobathy Lidar DEM (LMSL): Oahu, HI (NOAA OCM dataset 9365), collected by USACE JALBTCX, distributed by NOAA Office for Coastal Management. US Government work, provided as-is, not endorsed by NOAA or USACE.
  Basis: the dataset's official metadata, NOAA InPort record 65476 (access constraints
  "None"; collected and processed by USACE). An e-mail confirmation requested from NOAA on
  2026-11-14 is still pending. Resampled to 8 m (map) and 10 m (reef model) cells; gaps are
  left as gaps. Not for navigation.
- Basque coast, Guéthary and Hossegor reef maps (Litto3D Nouvelle-Aquitaine 2020-2022):
  Shom - IGN, 2025. https://doi.org/10.17183/LITTO3D_NAQ_2020_2022. Not for navigation.
  Open licence, Etalab 2.0. Vertical datum IGN69 (not LAT). Block-averaged to 4 m cells,
  land cropped 250 m inland, gaps left as gaps.
- Supertubos map: same DGT/APA 2011 lidar as Peniche (above), wider patch.
- Porto Batel reef-model bed grid (`pieces/06-live-wave/data/bed_grid_porto_batel.npz`) and lookup
  table (`pieces/06-live-wave/lookup/`): derived from the same DGT/APA 2011 lidar (EMODnet patch
  590_HR_Lidar_Centro, CC BY 4.0), resampled to a 10 m grid.

## Other data

- Peniche reference snapshots in `pieces/02-reefs/data/swell_snapshot_*`: NOAA NCEP GFS-Wave
  (WAVEWATCH III) analysis and forecast hours 0 and 3, 0.25 degree, from the NOAA archive on AWS
  (US Government work, public domain). Reference values only; the swell inputs in `simulate_swell.py`
  are typed constants for one case.
- Typical swells for the spot layers: Pipeline uses the Nov-Mar 2024-25 median at NDBC buoy
  51201 (NOAA National Data Buoy Center, public data); Supertubos, Guéthary and Hossegor use the
  Nov-Mar 2024-25 and 2025-26 median of NOAA NCEP GFS-Wave primary swell (public domain; method in
  `pieces/11-ocean/build_typical_swell.py`). Typical values, not forecasts.
- Observer marks (`pieces/02-reefs/data/surf_zones.json` and the pins in the viewer): observer
  marks (one surfer, 17 Sep 2026). The author's own marks, not survey data.

- Surroundings of the reef maps (the dimmer dots around each lidar patch in the viewer,
  `pieces/01-seafloor/viewer/surround.js`): Terrain Tiles on AWS Open Data (Mapzen/Tilezen
  terrarium tiles, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`),
  fetched live by the browser, nothing stored. Land: zoom 12, one dot per tile pixel (~30 m at
  Peniche and the Basque coast, ~36 m at Oahu), from EU-DEM, SRTM, GMTED and USGS 3DEP (NED).
  Sea: one dot per zoom-10 pixel (~120-140 m apart); the depths are ETOPO1 (a ~1.85 km grid) in
  most places, oversampled by the tiles, so the offshore sea floor there is coarse and approximate.
  Heights are shifted by +2.0 m (MSL above LAT at Peniche) to sit on the Portuguese lidar's LAT
  datum. Attribution required: see the full Terrain Tiles credit in `pieces/07-globe/SOURCES.md`
  (ETOPO1: NOAA; SRTM, GMTED2010, 3DEP: USGS; EU-DEM: produced using Copernicus data and
  information funded by the European Union).

## Live forecast snapshots (`live/*.json`, refreshed by a scheduled job)

- Open-Meteo is no longer a live source (removed 2026-11-23: its free tier is non-commercial). No
  visitor's browser calls it or any other forecast host; the viewer reads only `live/<spot>.json`
  from its own origin.
- NOAA/NCEP GFS-Wave (WAVEWATCH III), global 0.25 deg, via NOMADS (waves and the GFS 10 m wind):
  US Government work, public domain (https://www.weather.gov/disclaimer, "may be used without
  charge for any lawful purpose"). Credit: "NOAA/NCEP GFS-Wave, processed by Oceany. Not an
  official NOAA product." Do not present modified data as official.
- NOAA NOS CO-OPS tide predictions (Honolulu 1612340, used for Pipeline): public domain
  (https://tidesandcurrents.noaa.gov/disclaimers.html, "may be used freely by the public");
  attribution requested. Not an official NOAA product.
- E.U. Copernicus Marine Service, sea level (tide and surge, `zos`): IBI
  https://doi.org/10.48670/moi-00027, NWS https://doi.org/10.48670/moi-00054, MED
  https://doi.org/10.48670/mds-00359. Same Copernicus licence as the wave products below.
- All of it: for research and play only. Not a forecast or warning service. Not an official
  product. Do not use for safety decisions. Details: `live-data/SOURCES.md`.
- E.U. Copernicus Marine Service: generated using E.U. Copernicus Marine Service Information;
  IBI https://doi.org/10.48670/moi-00025, NWS https://doi.org/10.48670/moi-00055,
  MED https://doi.org/10.48670/mds-00373, in-situ https://doi.org/10.48670/moi-00036 (data provider
  named in each file).
- DMI (Danish Meteorological Institute) open data, CC BY 4.0: "Kilde: DMI" for values as
  published; "Baseret på data fra DMI og efterfølgende bearbejdet" for derived values
  (model-minus-buoy bias).
- Not in the public files: kyst.dk buoys (no published terms), NDBC 51201 / CDIP values (CDIP
  asks that data are not altered; used only in the Pipeline validation write-up, with
  attribution).

## Which viewer file uses which source

| File | Source |
|---|---|
| `seafloor.json`, `seafloor_wide.json` | EMODnet Bathymetry DTM |
| `seafloor_ddm.json` | Denmark's Depth Model 50 m (DDM50 v2.0) |
| `reefs.json` | DGT/APA 2011 lidar via EMODnet patch 590_HR_Lidar_Centro |
| `swell_sim.json` | Own simple swell model over `reefs.json` (derived from the lidar) |
| `porto_batel_slice.json` (s7) | Own wave solver output on a lidar bed profile (derived from the lidar) |
| `reefs_wide.json` | DGT/APA 2011 lidar, wider Peniche patch (Supertubos) |
| `supertubos_swell.json`, `pipeline_swell.json`, `guethary_swell.json`, `hossegor_swell.json` | Own swell model over the matching map file (derived), typical swells above |
| `porto_batel_slice_s8.json`, `pipeline_slice.json`, `supertubos_slice.json`, `guethary_slice.json` | Own wave solver output on a bed profile through the matching map (derived) |
| `guethary.json`, `hossegor.json` | Shom - IGN Litto3D 2020-2022 (derived 4 m grid) |
| `pipeline.json` | NOAA/USACE 2013 NCMP topobathy, Oahu (see above; derived grid) |
| `porto_batel_funwave.json` | Own FUNWAVE-TVD 2DH model output over `reefs.json` (derived from the lidar) |

## Software

- three.js, MIT licence, Copyright 2010-2026 three.js authors, https://threejs.org
