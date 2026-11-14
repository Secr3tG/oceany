# Oceany

Oceany is an ocean data project. It turns open bathymetry into a 3D viewer in the
browser and adds two small wave models on top: a simple swell model over the reef at
Porto Batel (Peniche, Portugal), and a 2D particle solver that shows one wave breaking
there. The viewer also has sea-floor maps of the Danish North Sea coast and a reef
map of Pipeline, Oahu.

**Illustrative, not a forecast.** The wave layers show how waves could behave over the
bottom shapes. They are not predictions. Nothing here is for navigation.

Live viewer: https://secr3tg.github.io/oceany/ (available once the site is published)

## What is in it

| Folder | What |
|---|---|
| `pieces/01-seafloor/` | Bathymetry prep scripts and the three.js viewer (`viewer/`) |
| `pieces/02-reefs/` | Linear swell model over the Peniche lidar (`simulate_swell.py`) |
| `pieces/03-breaking-wave/` | 2D particle (SPH) solver for a breaking wave, flume test and Porto Batel case |
| `pieces/05-pipeline/` | Reef map of Pipeline, Oahu, from NOAA/USACE topobathy |
| `tasks/`, `live-data/` | Small side experiments (wave dispersion, Open-Meteo fetch, Copernicus buoys) |

## Run the viewer

The viewer is a static page. No build step. The data it needs is already in
`pieces/01-seafloor/viewer/data/`.

    python -m http.server 8765

Run that in the repository root and open http://localhost:8765 (the root page opens
the viewer). Or run it inside `pieces/01-seafloor/viewer/`.

## Run the Python

Python 3.9 or newer.

    python -m venv .venv
    .venv/bin/pip install -r requirements.txt

Each command below is run from the folder named. Raw data is not in the repository:
see `DATA.md` for what to download and where to put it.

**01 Sea floor** (`pieces/01-seafloor/`)

    python download_wide.py && python download_spots.py      # EMODnet, needs internet
    python prepare_bathymetry.py && python prepare_wide.py && python prepare_ddm.py
    python export_points.py                                  # writes viewer/data/seafloor*.json

**02 Reefs** (`pieces/02-reefs/`, needs the Peniche lidar, see `DATA.md`)

    python reef_check.py
    python simulate_swell.py
    python export_reefs.py                                   # writes viewer/data/reefs.json and swell_sim.json

**03 Breaking wave** (`pieces/03-breaking-wave/`, needs numba)

    python run.py flume --res 20                             # about 1 minute; --res 40 about 6 minutes
    python diagnostics.py out/flume_r40 && python render.py out/flume_r40
    python profile_porto_batel.py                            # reads the lidar, writes the bed profile
    python run_porto_batel.py --dp 0.1                       # about 145,000 particles, 50 to 84 minutes
    python diagnostics_porto_batel.py out/porto_batel_dp0.1
    python render_porto_batel.py out/porto_batel_dp0.1

`render_porto_batel.py` writes `porto_batel_slice.json` into the run folder. Copy it to
`pieces/01-seafloor/viewer/data/` to show it in the viewer. See
`pieces/03-breaking-wave/README.md` for the method and its limits.

**05 Pipeline** (`pieces/05-pipeline/`)

    python export_pipeline.py                                # writes viewer/data/pipeline.json

## The observer marks

The pins on the Porto Batel layer are observer marks (one surfer, 17 Sep 2026). They
are one person's reading of where things happen, not survey data.

## Licences

- Code: Apache-2.0, see `LICENSE` and `NOTICE`.
- The author's own text and plots: CC BY 4.0, see `CONTENT-LICENSE.md`.
- Data: each dataset keeps its own licence and credit. See `DATA-LICENSES.md`.
- three.js (MIT) is included in `pieces/01-seafloor/viewer/vendor/`.

Copyright 2026 Benn Hvidbjerg Asaraf.
