# Oceany

Oceany is an ocean data project. It turns open bathymetry and lidar into a 3D viewer in
the browser and adds two small wave models on top: a swell refraction model over the
reef (waves bend, grow and break as the bottom shallows), and a 2D particle solver that
shows one wave breaking along a line through the lidar.

## Spots

Reef-scale (lidar seabed, swell layer, and a breaking-wave slice where marked):

| Spot | Swell layer | Breaking-wave slice |
|---|---|---|
| Porto Batel, Peniche, Portugal | yes | yes (typical 1.5 m and upper bound 2.7 m) |
| Consolação, Peniche, Portugal | yes | no |
| Supertubos, Peniche, Portugal | yes (2011 seabed) | yes |
| Pipeline, Oahu, Hawaii | yes | yes |
| Guéthary / Parlementia, France | yes | yes |
| Hossegor / La Gravière, France | yes | no |

Model scale only (sea-floor maps, no wave models): Klitmøller and the Danish North Sea coast.

Spot positions are approximate published positions and the take-off points are derived
from the bathymetry, not surveyed. At the Basque spots the lidar reaches only about
17-29 m depth, so deeper refraction is not modelled, and Belharra is not covered.

**Illustrative, not a forecast.** The wave layers show how waves could behave over the
bottom shapes. They are not predictions. Nothing here is for navigation.

Live viewer: https://secr3tg.github.io/oceany/

## Play and tutorial

On the Porto Batel layer you can change the swell height, period, direction and tide with
sliders and the model re-runs in your browser. A guided tour and small challenges walk
through refraction, shoaling and breaking. See [TUTORIAL.md](TUTORIAL.md). The spot buttons open
a beach view (you stand on the shore at eye height and watch the swell come in; an offshore
view is one click away), and there are two storm presets (6 m, 16 s): one from
300 degrees that reaches Porto Batel and one from 315 degrees that the Peniche headland mostly blocks.

## How well does the breaking-wave model match? (Porto Batel)

Honest headline: the typical-swell run (s8, 1.5 m) first breaks about 142 m from the
reference point (individual waves 139-153 m), in about 2.0 m of water. That is 10 to 50 m
further out than the 90-130 m estimated from video footage of the same spot. The tide is
ruled out: the runs use the 18:00 tide, matching the 17:46-18:02 clips. The likely causes
that remain are a lidar profile line that is off by one cell, the keyhole channel's depth
missing from the lidar, and typical waves nearer 1.3 m than 1.45 m. An error in the
distance read from the footage, or the solver, are not excluded. Break positions are not converged with resolution,
and the model is 2D with a regular wave. Treat it as a picture of the mechanism, not a
measurement. The upper-bound run (s7, 2.7 m) breaks 194-225 m out.
The footage is not part of this repository.

## What is in it

| Folder | What |
|---|---|
| `pieces/01-seafloor/` | Bathymetry prep scripts and the three.js viewer (`viewer/`) |
| `pieces/02-reefs/` | Swell refraction model over the Peniche lidar (`simulate_swell.py`) and per spot (`simulate_swell_spot.py`) |
| `pieces/03-breaking-wave/` | 2D particle (SPH) solver for a breaking wave: flume test, Porto Batel, and Pipeline, Supertubos, Guéthary cases |
| `pieces/04-basque/` | Export of the Guéthary and Hossegor reef maps from Litto3D |
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

Other spots: `python make_spot_cases.py` writes `case_<spot>.py`; run one with `python spot_run.py <spot>`
(see the docstrings). Swell layers for other spots: `python simulate_swell_spot.py --spot <spot>` in `pieces/02-reefs/`.

**04 Basque** (`pieces/04-basque/`, needs the Litto3D tiles, see `DATA.md`)

    python export_basque.py                                  # writes guethary.json and hossegor.json

**05 Pipeline** (`pieces/05-pipeline/`)

    python export_pipeline.py                                # writes viewer/data/pipeline.json

## Contact

benn@hvid.studio

## The observer marks

The pins on the Porto Batel layer are observer marks (one surfer, 17 Sep 2026). They
are one person's reading of where things happen, not survey data.

## Licences

- Code: Apache-2.0, see `LICENSE` and `NOTICE`.
- The author's own text and plots: CC BY 4.0, see `CONTENT-LICENSE.md`.
- Data: each dataset keeps its own licence and credit. See `DATA-LICENSES.md`.
- three.js (MIT) is included in `pieces/01-seafloor/viewer/vendor/`.

Copyright 2026 Benn Hvidbjerg Asaraf.
