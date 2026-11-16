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

- Open-Meteo Marine API snapshots in `pieces/02-reefs/data/swell_snapshot_*`: weather data by
  Open-Meteo.com (https://open-meteo.com), CC BY 4.0, which in turn credits the underlying
  wave models (for example Meteo-France MFWAM, DWD EWAM). Used only as reference values; the
  swell inputs in `simulate_swell.py` are typed constants for one case.
- Typical swells for the spot layers: Pipeline uses the Nov-Mar 2024-25 median at NDBC buoy
  51201 (NOAA National Data Buoy Center, public data); Supertubos, Guéthary and Hossegor use the
  Open-Meteo hindcast winter median (Open-Meteo.com, CC BY 4.0). Typical values, not forecasts.
- Observer marks (`pieces/02-reefs/data/surf_zones.json` and the pins in the viewer): observer
  marks (one surfer, 17 Sep 2026). The author's own marks, not survey data.

## Live forecast snapshots (`live/*.json`, refreshed by a scheduled job)

- Open-Meteo Marine and Weather API: weather data by Open-Meteo.com, CC BY 4.0
  (https://open-meteo.com/en/licence).
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
