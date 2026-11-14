# Oceany viewer: tour, play and challenges

The viewer (`pieces/01-seafloor/viewer/`) shows the sea floor at two reefs near Peniche, Portugal
(Consolação and Porto Batel, 2011 lidar), and a simple model of a swell crossing it. You can change the
swell yourself and watch where it bends, grows and breaks. Everything is **illustrative, not a forecast**.

## Run it

```
cd pieces/01-seafloor/viewer
python3 -m http.server 8765
```

Open http://localhost:8765. Pick **Reef maps: Consolação and Porto Batel**, then **Porto Batel**.

## The guided tour

On your first visit a card offers a short tour (12 steps, about five minutes). It can be skipped, closed
at any step (×), and reopened with **Guided tour and challenges** at the top of the panel. It remembers
the step you were on and the challenges you solved (in your browser only; nothing is sent anywhere).
The last step has **Restart tour** and **Clear progress**.

What it covers: the sea floor, the swell layer (teal = unbroken, white = broken), refraction, shoaling,
breaking, the breaking-wave zoom-in, and the observer marks (one surfer, 17 Sep 2026).

## Play with the swell

Under the swell layer in the panel: sliders for **height** (0.5-5 m), **period** (5-18 s), **direction**
(from 180-360°) and **tide** (0-3.8 m above LAT), and a **wrapped** switch. Each change re-runs the model
in your browser (about 40-100 ms once warmed up) and redraws the swell. Presets: the 17 Sep total sea
(2.7 m, 7.8 s, 337°, tide 2.1 m), the 17 Sep swell only (1.9 m, 9.7 s, 325°), and **Python file**, which
shows `swell_sim.json` exactly as the Python wrote it.

The readout says how far out from the filming position the outermost break starts (along the line
through the take-off mark), the state of the take-off zone, how much of Porto Batel the swell reaches and
at what share of its offshore height, and the shoaling factor and wavelength in 5 m of water.

**Wrapped vs strict.** A swell from 337° (NNW) runs along this coast. Taken as it is ("strict"), simple
refraction cannot bring it into Porto Batel at all. In reality it bends round the Peniche headland,
which this model cannot compute, so by default ("wrapped") the swell is assumed to reach the edge of the
lidar strip head-on at full offshore height (an upper bound). With wrapped on, the direction slider does
nothing; turn it off to use the direction as it is.

## The five challenges

Each one is checked in code against the model's own numbers.

1. **Shoaling.** Find a period where a wave in 5 m of water is at least 25% taller than in deep water.
   (Long swells grow more on the way in; a 6 s wind swell even shrinks a little at first.)
2. **Where does it break?** For the 17 Sep swell, pick how far out from the filming position the outer
   break starts. (The footage put the take-off about 115 m out; the model breaks further out because it
   uses the full offshore height.)
3. **Push the break out.** From a 1.5 m, 9 s swell, move the outer break at least 40 m further out
   (bigger swell, or lower tide).
4. **Tide pulls it back in.** Keep the 2.7 m swell and bring the outer break within 150 m of the filming
   position (raise the tide).
5. **Which direction gets in?** With wrapped off, find the direction that sends the biggest waves into
   the water off Porto Batel (within 2% of the best; it is about SW, 225-235°).

## The physics, short

For one wave height `H0` and period `T` offshore, at every 11 x 14 m lidar cell:

- **Dispersion:** `omega^2 = g k tanh(k d)` gives the wavenumber `k` (and so the speed) at water depth `d`.
  Solved by Newton's method.
- **Shoaling:** `Ks = sqrt(Cg0 / Cg)`. The energy speed `Cg` drops in shallow water, so the wave grows.
- **Refraction:** Snell's law, `sin(theta) / c` stays the same, with depth contours taken as straight and
  parallel to the local (100 m smoothed) shore. Bending spreads the crest: `Kr = sqrt(cos theta0 / cos theta)`.
- **March shoreward:** cells are visited from far out to the shore; each takes its height from the cell one
  step seaward, scaled by the change in `Ks x Kr`.
- **Breaking:** broken once `H >= 0.78 x d`; inside the surf zone `H` is held at `0.78 x d`; if the water
  deepens again the wave can reform.

What it does not do: no wave shape (that is the separate breaking-wave slice), one height and period for
the whole sea, no headland shadow, nothing beyond the ~600 m lidar strip.

## Run the Python yourself

```
cd pieces/02-reefs
../../.venv/bin/python -I simulate_swell.py
```

Edit the CONFIG block at the top (`H0`, `T`, `DIRECTION_FROM_DEG`, `TIDE_ABOVE_LAT`, `WRAPPED`). It writes
`simulate_swell.png` and `../01-seafloor/viewer/data/swell_sim.json`; reload the viewer and press
**Python file** to see your run.

## Why the browser runs the model itself

The model grid is small (184 x 346 cells, 20,325 with lidar), so a line-for-line JavaScript port
(`viewer/swell_model.js`) runs a case in about 40-50 ms. Precomputing cases in Python would need thousands
of runs to cover four sliders and would still snap them to a few values. The port was checked against the
Python on four cases (wrapped and strict, tides 0.5-2.1 m, 7.8-12 s): wave heights agree to within the
0.01 m rounding of the output, and the break-onset cells are identical.
