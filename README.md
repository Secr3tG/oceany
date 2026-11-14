> **DRAFT. Not published. Wording and licence status may change.**

# Oceany

Oceany is an ocean data project. It turns public bathymetry into a 3D browser
viewer of the sea floor off Denmark and Portugal. It also holds a reef-scale
wave model for Porto Batel, Peniche, and a 2D particle solver that shows a wave
breaking.

The wave layers are illustrative models. They are not forecasts. Nothing here is
for navigation.

Code is Apache-2.0. Data has its own licences: see `DATA-LICENSES.md`.

## Run the viewer

The viewer is a static page with no build step. Python 3.9 is enough to serve it.

    cd pieces/01-seafloor/viewer
    python -m http.server 8765

Open http://localhost:8765. The data files are already in `viewer/data/`.

## Set up Python

Python 3.9.

    python3.9 -m venv .venv
    .venv/bin/pip install -r requirements.txt

The viewer data is included. You only need Python to reproduce it.

## Manual downloads

Two datasets cannot be fetched by script. Download them and put the files in
`raw/` folders next to the code, creating the folders if needed.

1. Denmark's Depth Model 50 m (DDM50), from https://dataforsyningen.dk/data/4817.
   Put the extracted folder in `pieces/01-seafloor/data/raw/`. It must be named
   `danmarks dybdemodel 50m 2024` (the name `prepare_ddm.py` expects).
2. Portuguese coastal lidar, patch `590_HR_Lidar_Centro`, from EMODnet Bathymetry
   high-resolution patches (https://emodnet.ec.europa.eu/en/bathymetry).
   Put `590_HR_Lidar_Centro.nc` in `pieces/02-reefs/data/raw/`.

The EMODnet DTM tiles are fetched by script (step 1 below).

## Reproduce each piece

Run each command from the folder named.

**01 Sea floor** (`pieces/01-seafloor/`)

1. `python download_wide.py` and `python download_spots.py` (EMODnet, needs internet)
2. `python prepare_bathymetry.py`, `python prepare_wide.py`, `python prepare_ddm.py`
   (the last one needs the DDM50 download)
3. `python export_points.py` writes `viewer/data/seafloor*.json`

**02 Reefs** (`pieces/02-reefs/`, needs the lidar download)

1. `python reef_check.py`
2. `python simulate_swell.py`
3. `python export_reefs.py` writes `viewer/data/reefs.json` and `swell_sim.json`

**03 Breaking wave** (`pieces/03-breaking-wave/`, needs numba)

1. `python run.py flume --res 20` (about 1 minute) or `--res 40` (about 6 minutes)
2. `python diagnostics.py out/flume_r40`, then `python render.py out/flume_r40`
3. `python profile_porto_batel.py` (reads the lidar, writes the bed profile)
4. `python run_porto_batel.py --dp 0.1` (about 145,000 particles, 50 to 84 minutes)
5. `python diagnostics_porto_batel.py out/porto_batel_dp0.1`
6. `python render_porto_batel.py out/porto_batel_dp0.1`

See `pieces/03-breaking-wave/README.md` for the method and its limits.

## From solver output to the viewer

`render_porto_batel.py` writes `porto_batel_slice.json` into the run folder you
pass it (for example `out/porto_batel_dp0.1/`). Copy that file to
`pieces/01-seafloor/viewer/data/porto_batel_slice.json`. There is no script for
the copy step.

## Other folders

- `tasks/`: small side experiments (wave dispersion, an Open-Meteo forecast fetch).
- `live-data/`: test scripts for Copernicus Marine buoy data. These need
  `copernicusmarine` and a free account.

## Licence

Code: Apache-2.0, Copyright 2026 Benn Hvidbjerg Asaraf. Data: see
`DATA-LICENSES.md`. three.js (MIT) is vendored in `pieces/01-seafloor/viewer/vendor/`.
