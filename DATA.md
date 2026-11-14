# Raw data: where to get it

The repository holds the small derived files the viewer needs (`pieces/01-seafloor/viewer/data/`,
the `.nc` grids in `pieces/01-seafloor/data/`). The raw downloads below are too large to include
and are only needed to rebuild those files. Credits and licences: `DATA-LICENSES.md`.
Paths are relative to the repository root. Create the `raw/` folders if they do not exist.

## 1. EMODnet Bathymetry DTM (scripted)

- Source: EMODnet Bathymetry WCS, coverage `emodnet__mean`, https://ows.emodnet-bathymetry.eu/wcs
  (licence CC BY 4.0).
- `pieces/01-seafloor/download_wide.py` writes `tile_lat*_lon*.tif` to `pieces/01-seafloor/data/raw/wide/`.
- `pieces/01-seafloor/download_spots.py` writes `emodnet_klitmoller.tif`, `emodnet_vorupor.tif`,
  `emodnet_agger.tif` to `pieces/01-seafloor/data/raw/spots/`.
- `pieces/01-seafloor/data/raw/emodnet__mean.tif` (read by `prepare_bathymetry.py`) is the same
  WCS call for a box around Klitmoller at native resolution: same URL pattern as in
  `download_spots.py` without `scaleFactor`, roughly lat 56.98 to 57.10, lon 8.25 to 8.52.
  Save the response as that file name. There is no script for this one.

## 2. Denmark's Depth Model 50 m (manual)

- Source: Danish Geodata Agency, Danmarks Dybdemodel 50 m, https://dataforsyningen.dk/data/4817
  (dataset "The 50 meter model", version 2.0). Model page:
  https://eng.gst.dk/danish-hydrographic-office/denmark-depth-model
- Download and extract it so the folder is `pieces/01-seafloor/data/raw/danmarks dybdemodel 50m 2024/`.
  `prepare_ddm.py` expects `ddm_50m.dybde.tiff` (depth) and its companion files
  (`ddm_50m.aar.tiff`, `ddm_50m.kilde.tiff`) in it. The viewer file was built from the copy
  obtained on 2026-11-11.
- Terms: free use, also commercial, not for navigation, no implied endorsement; pass the terms
  on (link above). No script, because the download needs a manual step on the site.

## 3. Peniche lidar, EMODnet HR patch 590_HR_Lidar_Centro (manual)

- Source: EMODnet Bathymetry high-resolution patch `590_HR_Lidar_Centro` (2011 topo-bathymetric
  lidar, DGT / APA, distributed via Instituto Hidrografico). Catalogue record:
  https://emodnet.ec.europa.eu/geonetwork/srv/api/records/SDN_CPRD_590_HR_Lidar_Centro
  (licence CC BY 4.0 in the record's metadata; "do not use for navigation").
  Download link: from the record, or from https://emodnet.ec.europa.eu/en/bathymetry.
- Put the NetCDF file at `pieces/02-reefs/data/raw/590_HR_Lidar_Centro.nc`. Read by
  `reef_check.py`, `simulate_swell.py`, `export_reefs.py`, `profile_porto_batel.py`.
- No download script. Grid in metres, depths relative to LAT.

## 4. Pipeline, Oahu: NOAA/USACE 2013 NCMP topobathy (scripted by URL, no script)

- Source: NOAA dataset ID 9365, "2013 USACE NCMP Topobathy DEM (LMSL) Oahu".
  Index: https://noaa-nos-coastal-lidar-pds.s3.us-east-1.amazonaws.com/dem/USACE_Oahu_HI_LMSL_DEM_2013_9365/index.html
- Tiles (20 GeoTIFFs, about 47 MB): https://noaa-nos-coastal-lidar-pds.s3.amazonaws.com/dem/USACE_Oahu_HI_LMSL_DEM_2013_9365/
  named `2013_NCMP_HI_Oahu_4QEJ<nnnn>_BareEarth_1mGrid.tif` for nnnn in
  9593-9595, 9693-9696, 9793-9797, 9894-9898, 9996-9998.
- Target folder: `pieces/05-pipeline/data/raw/`. Read by `export_pipeline.py`.
- Licence: believed public domain; written confirmation requested from NOAA, 2026-11-14.

## 5. Open-Meteo marine snapshot (included)

- `pieces/02-reefs/data/swell_snapshot_*` already hold the pulled data. Request URL and
  retrieval time are in `swell_snapshot_README.txt`. CC BY 4.0, credit Open-Meteo.com.

## 6. Basque coast, Litto3D (only if present)

- Source: Shom, Litto3D Nouvelle-Aquitaine 2020-2022, https://diffusion.shom.fr (free account and
  cart needed), DOI https://doi.org/10.17183/LITTO3D_NAQ_2020_2022. Tiles: 1 km ASC at 1 m,
  EPSG:2154, `LITTO3D_FRA_XXXX_YYYY_MNT_1M_<date>_LAMB93_IGN69.asc`.

Footage and field photos used by the author are not part of the repository.
