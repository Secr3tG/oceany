# Klitmoller sea-floor viewer

Static page, no build step. Serve and open:

    cd pieces/01-seafloor/viewer && python -m http.server 8765   # then http://localhost:8765

Data: `data/seafloor.json`, made by `../export_points.py` from `../data/seafloor.nc`.

three.js **0.187.0** (npm package `three`, via jsdelivr), vendored for offline use:
- `vendor/three.module.js` and `vendor/three.core.js` (from `build/`; the first imports the second)
- `vendor/addons/controls/OrbitControls.js` (from `examples/jsm/controls/`)

Loaded with an import map in `index.html` (`three` -> `./vendor/three.module.js`,
`three/addons/` -> `./vendor/addons/`). To upgrade, re-download those three files at the new version.
