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

## Which viewer file uses which source

| File | Source |
|---|---|
| `seafloor.json`, `seafloor_wide.json` | EMODnet Bathymetry DTM |
| `seafloor_ddm.json` | Denmark's Depth Model 50 m (DDM50 v2.0) |
| `reefs.json` | DGT/APA 2011 lidar via EMODnet patch 590_HR_Lidar_Centro |
| `swell_sim.json` | Own simple swell model over `reefs.json` (derived from the lidar) |
| `porto_batel_slice.json` | Own wave solver output on a lidar bed profile (derived from the lidar) |

The surf-zone marks in `pieces/02-reefs/data/surf_zones.json` are one surfer's
own marks, not survey data.

## Software

- three.js, MIT licence, Copyright 2010-2026 three.js authors, https://threejs.org
