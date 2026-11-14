# Where the wave energy goes before breaking (session 6, 2026-11-13)

Work done in a copy (`energy_s6/`). The live solver and `case_porto_batel.py` are unchanged.

## In plain words

The swell loses energy on its way in mainly because each particle "sees" too few
neighbours. The smoothing length is h = 1.3 dp. With the Wendland kernel that puts only about
20 particles inside a particle's reach, so the forces are rough and particle-scale noise eats
the wave. Widening the reach to h = 1.7 dp (and adding one more wall layer so the walls still
fill that reach) takes the loss over 200 m from about 40-50 % down to about zero. The run time
stays about the same, because a wider reach also allows a longer time step.

The artificial viscosity is the second, smaller cause. Density diffusion (delta-SPH), the time
step and the second-harmonic beat do not cause the loss. The beat only confuses height
measurements.

![decay](decay.png)

## How it was measured

- **Periodic box** (`sim_p.py`, `run_box.py`). This is a copy of `sim.py` that wraps around in
  x. The box is one wavelength long (62.8 m), 8 m deep (the paddle depth), with H 2.7 m and
  T 7.8 s. A linear wave is put on settled still water and goes round and round. There is no
  paddle, no sponge and no reflection, so any loss is the solver's own. Distance travelled is
  time x group speed (6.75 m/s).
- **Wave energy** = kinetic energy + 1/2 rho g Lx var(eta), averaged over each period
  (`wave_energy.py`). This measure is blind to the beat (energy only moves between harmonics).
  It is also blind to the water column slowly settling. That settling is real but is not wave
  loss: the mean level sinks 2-3.5 cm in every run, worth about 0.3 x the wave energy in
  potential energy. That is why a plain total-energy budget makes even good runs look lossy.
  The still-water control runs `c03_still_*` show the same kind of drift.
- **Screening** used the kinetic energy alone (`box/b*.json`), at coarse dp to see trends.
- **Flume check** used `run_flume.py` (a copy of `run.py`) plus `diagnostics.py`, with
  `--set h_over_dp=1.7 n_layers=4`.

## Numbers

Loss of wave energy over 200 m of travel in the periodic box (KE + surface PE):

| dp (H/dp) | h = 1.3 dp (now) | h = 1.7 dp |
|---|---|---|
| 0.30 m (9) | 53 % | 11 % |
| 0.15 m (18) | 42 % | -2 % (no loss within noise) |

Screening at dp 0.30 m, kinetic-energy proxy, one change from the live settings each time:

| change | loss / 200 m | verdict |
|---|---|---|
| none (alpha 0.01, delta 0.1, h 1.3 dp, CFL 0.2, c0 10x) | 53 % | |
| h = 1.5 dp | 9 % | **main cause** |
| h = 1.7 dp (4 wall layers) | 6 % | |
| h = 2.0 dp (4 wall layers) | about 0 % (2 % surface mode) | slight energy gain at dp 0.2, so not chosen |
| alpha = 0 (no artificial viscosity) | 37 % | second cause |
| c0 doubled (20x) | 61 % | worse (the viscosity scales with c0); keep 10x |
| delta-SPH off | 49 % (surface mode) | not a cause; pressure noise blows up the KE |
| alpha = 0 and delta off | unstable (time step collapsed, killed) | both are needed |
| CFL 0.1 (half the time step) | 53 % | not a cause |

Resolution at h = 1.3 dp (KE proxy): 56, 53, 44 and 40 % at dp 0.4, 0.3, 0.2 and 0.15 m. The
loss falls only slowly with finer dp. Extrapolated to the production dp 0.10 m it is **about
30-35 % over 200 m (inferred, not run)**. The full Porto Batel run's own record agrees in
size. There, the linear energy flux cg x integral(eta^2) dt over the incident packet
(`analyse_full_run.py`, `full_run_decay.json`) falls to 0.72 of its paddle value by 100 m and
0.55 by 150 m. That measure is approximate for such non-linear waves (the second harmonic
holds 5-20 % of the variance) and includes shoaling, so take it as "large", not as a number.
Either way the Porto Batel loss is larger than the flume's 15.6 %.

Flume (solitary wave, 1:15 slope), the same check through breaking:

| | r20, h 1.3 | r20, h 1.7 | r40, h 1.3 (README) | r40, h 1.7 |
|---|---|---|---|---|
| energy drift to toe | -12.1 % | -6.6 % | -8.2 % | -5.1 % |
| energy drift to vertical front | -23.6 % | -11.9 % | -15.6 % | -7.7 % |
| H at toe vs nominal | -3.4 % | +0.3 % | +3.1 % | +3.0 % |
| x_b (m) | 8.95 | 7.62 | 8.58 | 8.16 |
| H_b/h_b | 3.96 | 1.23 | 2.55 | 1.89 |
| overturns / leaked / density range | yes / 1 / 630-1202 | yes / 0 / 961-1048 | yes / 0 / 974-1027 | yes / 1 / 915-1071 |

The flume energy drift still includes the still-water settling drift (about 1 % of E_wave per
second, per the README). So the true wave loss with h 1.7 is smaller than the -7.7 % shown.
The run stays stable through overturning and touchdown.

## Breaking index 2.55 vs about 1.4

- The about-1.4 reference is for a **1:35** slope. The flume is 1:15, and the index grows with
  slope, so 1.4 is not the right yardstick. Grilli, Svendsen & Subramanya (1997) give a fit
  of the index against the slope parameter S0. As I remember it, it is
  H_b/h_b = 0.841 exp(6.421 S0), which gives **about 2.2 at S0 = 0.151**. **Not verified:** the
  preprint PDF returned 403. Check the coefficients in the paper
  (doi 10.1061/(ASCE)0733-950X(1997)123:3(102)) before quoting it.
- The measurement is consistent with Grilli's definitions: breaking point = vertical tangent
  on the front face; H_b = crest height above still water (for a solitary wave this is the
  height); h_b = still depth under the crest.
- **The index is ill-conditioned on this slope.** h_b = (distance to the shoreline)/15, so a
  0.4 m shift in x_b changes h_b by 0.027 m out of 0.06-0.09 m, which is ±30-40 % in the index.
  Across four runs it went 3.96, 2.55, 1.23 and 1.89. It is not converged and should not be
  quoted as validated. The vertical-front test triggers on the first snapshot in which any
  smoothed 1-dp bin pair has dx/dz >= 0. Particle noise can trigger it early (probably the
  1.23 at r20). Suggested, untested: require the vertical tangent over at least 3 bins or in
  2 consecutive snapshots. Report x_b and h_b/h0 alongside the index.

## Recommendation (one change set)

In `case_porto_batel.py` (and `case_flume.py`), make these changes and nothing else:
- `h_over_dp: 1.3 -> 1.7`
- `n_layers: 3 -> 4` (the kernel reach 2h = 3.4 dp must be covered by wall particles)

Keep alpha 0.01, delta 0.1, CFL 0.2 and c0 = 10x.

Then re-run `calib_wavemaker.py` once (dp 0.1, about 20 min). The stroke factor 0.983 was
calibrated with h 1.3 dp, and the paddle near field will change a little.

**Expected effect:** pre-breaking loss over the 200 m to the break goes from about 30-35 %
(inferred at dp 0.10 m) to under 5 %. Measured: -2 % at dp 0.15 m; dp 0.10 m is finer still.
The waves will arrive taller than in the last full run, so the break will move seaward.

**Cost:** the full Porto Batel run was 61 min at h 1.3 dp. At h 1.7 dp each step does about
1.7x the neighbour work, but the time step is 1.3x longer. The measured wall-time ratio in
the box and flume tests was 0.8-1.1x on matched load. **Expect about 60-80 min** on a free
machine. That is inferred: the full case was not run at 1.7 dp.

## Optional, separate: second-order wavemaker

A first-order piston also sends out a free second harmonic, which makes the ±6 % beat (about
86 m long). The standard fix is to add a 2-omega term to the paddle motion (Madsen 1971;
Schäffer 1996 for the full transfer function). A cheap way to do it is to add
X2(t) = 0.5 S2 env(t) sin(2 omega t + phi) to `piston_motion_factory`. Then pick S2 and phi
with two or three short `calib_wavemaker.py` runs that minimise the spread of H across gauges
10-80 m apart (most of a beat length). That costs about 20 min per try. Not tested here. It
only cleans up the measurements and the look of the wave; it does not affect the energy loss.

## Verified vs inferred

- Verified (runs in `box/` and `out/`): h/dp is the dominant cause in the periodic box at
  dp 0.3, 0.2 and 0.15 m. AV is a smaller cause. Delta-SPH and the time step are not causes.
  h 1.7 dp loses about 0 % per 200 m at dp 0.15 m. h 1.7 dp is stable through breaking in the
  flume (r20, r40) and halves the flume energy drift.
- Inferred: the loss in the current dp 0.10 m Porto Batel run (about 30-35 % over 200 m);
  the full-case wall time at 1.7 dp; stability of the full Porto Batel case at 1.7 dp (only
  the flume breaking was tested); the Grilli 1:15 reference value.
- Not tested: AV off together with h 1.7 dp; other kernels (quintic, Wendland C4); a
  deep-water box to isolate the bed; the second-order paddle.

## Files

`sim_p.py` (periodic solver), `run_box.py`, `wave_energy.py`, `plot_decay.py`,
`analyse_full_run.py`, `run_flume.py`, copies of `case_*.py`, `diagnostics*.py` and
`geometry.py`; results are in `box/`, `out/flume_r20_r13`, `out/flume_r20_r17` and
`out/flume_r40_r17` (the snapshots there can be deleted), and the logs are `batch*.log`.
