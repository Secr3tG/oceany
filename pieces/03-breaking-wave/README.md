# 03 Breaking wave (2D particle simulation)

A physically based 2D simulation of a wave that overturns (plunges), built in two cases:

- `case_flume`: a solitary wave breaking on a 1:15 plane beach in a lab-scale flume. This is
  the solver validation, checked against published wave physics.
- `case_porto_batel`: regular swell (H 2.7 m, T 7.8 s, tide 2.1 m above LAT) on the real
  Porto Batel reef profile from the 2011 lidar, at full scale. **Illustrative 2D slice**, not a
  prediction of a particular wave.

## How to run

From this folder, with the packages in the top-level requirements.txt:

    python -I run.py flume --res 20        # development, ~1 min
    python -I run.py flume --res 40        # final, ~38k particles, ~6 min
    python -I diagnostics.py out/flume_r40 # table + out/flume_r40/diagnostics.json
    python -I render.py out/flume_r40      # out/flume/breaking_wave.mp4, out/flume/frames/
    python -I profile_porto_batel.py       # lidar profile CSV + plot
    python -I run_porto_batel.py --dp 0.1  # reef run, ~145k particles, ~50 min
    python -I diagnostics_porto_batel.py out/porto_batel_dp0.1
    python -I render_porto_batel.py out/porto_batel_dp0.1   # mp4, frames, viewer slice

Snapshots (`out/*/snap_*.npz`) are large and can be deleted after rendering.

## Method (flume case)

Weakly compressible SPH (`sim.py`): water is a set of particles; each carries mass, velocity
and density, and feels pressure from its neighbours within 2.6 particle spacings.

- Wendland C2 kernel, smoothing length h = 1.3 dp.
- Tait equation of state (gamma = 7) with speed of sound c0 = 12 sqrt(g(h0+H)) = 24.8 m/s,
  so density changes stay around 1 %.
- Density from the continuity equation plus delta-SPH diffusion (delta = 0.1) with the
  hydrostatic part removed; Monaghan artificial viscosity alpha = 0.01.
- Walls (bed, slope, end walls): three layers of fixed particles whose pressure is
  extrapolated from the water (Adami, Hu & Adams 2012), free-slip.
- Leapfrog time stepping with adaptive dt (sound speed and acceleration limits).
- Start: still water is settled for 2 s, then the solitary wave (Rayleigh/Boussinesq profile,
  c = sqrt(g(h0+H)), depth-uniform u = c eta/(h0+eta), w from continuity) is put on by
  stretching each water column and scaling particle masses to match.

Set-up: h0 = 0.30 m, H/h0 = 0.45, slope 1:15, Grilli slope parameter S0 = 0.151 (plunging
expected). The flat is 5 m, not the planned 3 m: a solitary wave this high is long (it only
drops below 1 % of its height 1.9 m either side of the crest), and on a 3 m flat it was cut by
the end wall and already on the slope, which gave a wrong start.

## Results

See `out/flume/diagnostics.json` and the table printed by `diagnostics.py`.

Final run dp = h0/40: 38,380 water particles, 7,260 wall particles, 75,691 steps, 4.5 min
(plus 1.5 min settling) on this Mac. Compared with the dp = h0/20 run to see what is
resolution-dependent.

| Quantity | dp = h0/40 | dp = h0/20 | Expected / reference |
|---|---|---|---|
| Slope parameter S0 | 0.151 | | plunging for 0.025 < S0 < 0.30 (Grilli et al. 1997) |
| Speed on flat | 2.10 m/s (+1.6 %) | 2.17 (+5.2 %) | sqrt(g(h0+H)) = 2.066 m/s |
| Height at toe | 0.139 m (+3 % vs nominal 0.135) | 0.130 | no decay expected; the first-order profile grows a little as it adjusts, so damping is not measurable here |
| Vertical front | t = 2.92 s, x_b = 8.58 m (3.58 m up the slope) | 8.95 m | no verified number |
| h_b, H_b (crest above still water) | 0.061 m, 0.157 m | 0.037, 0.146 | |
| H_b/h_b | 2.55 | 3.96 | Grilli 1997, 1:35 slope: 1.38-1.40; larger on steeper slopes; no verified 1:15 value. Far above 0.78 (flat-bed rule) |
| Energy change to vertical front | -15.6 % of wave energy (-8.2 % by the toe) | -23.5 % | 0 % ideal; still water alone drifts about -1 % per second |
| Overturning | yes, t = 3.01 s | yes, 3.18 s | yes |
| Vertical front to jet touchdown | 0.26 s (touchdown at x about 9.3 m) | not detected | no verified number |
| Max runup | >= 0.40 m (R/h0 1.34), still rising at 5.5 s | 0.25 | uncertain; frictionless walls overestimate |
| Particles through walls | 0 | 0 | 0 |
| Density range | 974-1027 kg/m3 | | about +-3 % |

What it looks like (key frames): the front steepens and goes vertical, a jet leaves the crest,
curls over and lands on the very thin water just short of the still shoreline (x = 9.5 m),
trapping an air pocket, then a splash-up rises from the landing point and a bore runs up the
slope. That is a plunging breaker. The jet is only 3-5 particles thick.

Resolution matters: the breaking point moves 0.37 m and H_b/h_b changes from 4.0 to 2.6
between the two resolutions, because h_b is small (a few centimetres) on this gentle slope.
These numbers are not converged; a dp = h0/80 run (about 150k particles, roughly 1 hour)
would show how far they still move.

## Known limitations

- 2D only, single phase: no air, so the trapped air pocket under the jet has no pressure and
  splash-up is not physically right after touchdown.
- The jet is a few particles thick at dp = h0/40; its shape is resolution-limited.
- Free-slip walls: no bottom friction, so swash runs up further than in a real flume.
- Energy is not conserved as well as wave height: see the energy line in the results. Tests at
  dp = h0/20 with artificial viscosity off, delta-SPH off, or half the time step all lose about
  the same energy, so the loss is not from those terms; my best guess (not proven) is the wall
  treatment, which is not energy-conserving for flow sliding along the wall.
- The initial wave is the first-order (Boussinesq/Rayleigh) solitary wave, not an exact one;
  it adjusts slightly in the first metres.
- Literature numbers: the plunging range of S0 is from Grilli, Svendsen & Subramanya (1997).
  Their breaking-index values I could only check for a 1:35 slope (H_b/h_b about 1.38-1.40,
  as tabulated in arXiv:1601.06822); I have no verified 1:15 value, so H_b/h_b and x_b are
  reported, not validated.

## Porto Batel profile

`profile_porto_batel.py` samples the lidar (`../02-reefs/data/raw/590_HR_Lidar_Centro.nc`,
height above LAT, cell centres, WGS84, same flat-earth conversion as `simulate_swell.py`) on a
line from the house (39.319506 N, 9.355772 W) on bearing 236 deg. The grid is about 11 x 14 m,
so the profile rests on about 76 real samples (65 beyond 100 m from the house); everything
between them, including the exact shape of the shelf step, is interpolation, not data.
Output: `data/porto_batel_profile_236.csv`, `data/porto_batel_profile_236_meta.json`,
`out/porto_batel/profile_236.png`.

Sanity check against the session-4 handoff numbers (tide 2.1 m above LAT): the shelf matches
(median 2.11 m above LAT at 55-120 m), but the water off the shelf edge is deeper than the
handoff says at every check point: 1.71 m at 132 m (handoff 1.0), 2.29 m at 154 m (2.0), 4.30 m
at 209 m (3.5), 5.11 m at 231 m (4.8). Put the other way, each depth is reached 9-12 m closer
to the house (1 m at 123 m, 2 m at 141 m, 3.5 m at 199 m, 4.8 m at 220 m), about one grid cell.
Nearest-cell sampling gives the same picture, and an independent nearest-cell lookup by the
coordinator agrees with this profile, so the session-4 figures are the ones about one cell off.
The bed is used as extracted; the position of every bed feature along the line is uncertain by
about one grid cell (9-12 m).

Known missing features: the paddle-out channel through the shelf is not in the lidar (too
narrow for an 11 x 14 m grid), and so is not in the simulation. The owner sat about 115 m from
the house (39.318870, -9.356829, about 8 m off this line), where the lidar gives about 1.6 m of
water at this tide, just outside the shelf edge; it is marked "sat here (user)" on the plots
and the video. The shelf itself is real and walkable at mid tide.

## Porto Batel run (illustrative 2D slice)

Set-up: same solver as the flume. Particle spacing dp = 0.10 m (143,419 water particles, 61 min
on this Mac). Still water at tide 2.1 m above LAT. A piston wavemaker sits at 390 m from the
house, at a local low in the lidar with 8.1 m of water. That is shallower than ideal for a 2.7 m
wave (H/h 0.33, Ursell number 20, so the waves are strongly non-linear). It makes 5 periods of
motion (1 ramp-up, 3 full, 1 ramp-down). The domain ends in a closed wall at 40 m from the house.

Calibration: in a test at dp = 0.15 m the waves lost about 15 % of their height between the
paddle and 250 m. This is numerical damping, which also showed in the flume. So the stroke was
set to 1.12 x the linear-theory value. Arriving heights in the final run: 2.88 m at 250 m and
2.85-3.14 m at 200 m for the three full waves. That is about 7 % above the 2.7 m target at 250 m
(the damping at dp = 0.10 m is less than in the test, and shoaling adds a little).

Results, three full-height waves (A, B, C):

| | first vertical front (m from house) | still depth h_b | H_b | H_b/h_b | type | later |
|---|---|---|---|---|---|---|
| A | 181 | 3.44 m | 3.13 m | 0.91 | plunging | plunges again at 161 m and 147 m, and at the shelf edge 132 m |
| B | 189 | 3.37 m | 3.11 m | 0.92 | plunging | plunges again at the shelf edge 132 m |
| C | 194 | 3.29 m | 2.99 m | 0.91 | plunging | bore reaches the shelf edge with no new vertical front |

- 0.78 rule: the waves break at H_b/h_b = 0.91-0.92. That is a little later (shallower) than the
  rule, which would put the break in 3.8-4.0 m of water, near 205-212 m from the house.
- Linear model (session 4): first break at 200-204 m, second at 164-176 m. Here the first break
  is 6-23 m further in (181-194 m). Wave A shows a second plunge at 161 m.
- Shelf: every broken wave runs as a bore across the whole shelf, up to 0.48 m deep at 100 m.
  The bore then hits the closed end wall at 40 m. The splash there is a model artefact.

How far to trust the break position: about +-15-20 m. The reasons:
- the profile position is uncertain by one lidar cell (9-12 m);
- the three full waves already differ by 13 m;
- the arriving waves are 7 % higher than the target;
- the breaking point is not converged with resolution (the flume moved 0.37 m between two
  resolutions, about 2.5 cm of depth).

The breaker type (plunging) and the sequence (break near 180-195 m, re-break or bore at the shelf
edge, bore across the shelf) are more robust than the exact metres.

Other limitations: 2D, so no refraction and no alongshore variation (on the real reef the wave
peels along the reef). No air phase. Free-slip bed, with no friction on the shelf. The wavemaker
does not absorb reflected waves. 1-3 particles leaked through the bed on the shelf late in the
run (after about 65 s).

Outputs:
- `out/porto_batel.mp4` (2.5x real speed);
- `out/porto_batel/frames/`;
- `out/porto_batel/diagnostics.json`, whose `interpretation` block groups the crest tracks into
  waves by hand;
- `out/porto_batel_slice.json` (for the viewer, see its `meta`).

