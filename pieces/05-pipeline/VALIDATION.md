# Pipeline reef model vs reality (2026-11-16)

**Question.** Where does the Stage A model (`../06-live-wave/stage_a.py`, site `PIPELINE`) say the wave first breaks straight out from the Pipeline take-off, and does that match where it really breaks? Nothing in the model, the take-off point or the reference line was changed after looking at any observation.

**All distances** are metres from the 0 m LMSL shoreline on the reference line (314 deg from the take-off; the take-off itself is 44 m from the shoreline). "Model" = the median over the 5 central profiles (-100..+100 m alongshore) of the first break for one regular wave of height Hs.

## 1. Sentinel-2 whitewater on dated days (the main check)
Method (`validate_s2.py`, numbers in `validation/s2_whitewater.json` and `s2_summary.json`; no image is stored):
- 522 Sentinel-2 L2A scenes, Jan 2022 - Nov 2026 (277 dates, overpass 21:16-21:26 UTC = 11:16-11:26 HST), read from the public cloud-optimised files ([Element 84 Earth Search](https://earth-search.aws.element84.com/v1), scene IDs below). In the 10 m near-infrared band, water is black and foam bright, so the seaward end of the whitewater is a sharp step.
- Swell: NDBC 51201 Waimea Bay record nearest the overpass (within 35 min), WVHT / DPD / MWD. Data courtesy of CDIP (Scripps) / PacIOOS via NOAA NDBC; used here for validation only. Tide: NOAA CO-OPS 1612340 Honolulu, MSL datum (no North Shore gauge; +-0.1 m).
- Scored: 94 scenes clear of cloud (SWIR test), minus 15 with whitecaps far offshore, minus trade-wind days (period under 10 s or direction 20-280 deg), leaving **55 groundswell days**, 47 with whitewater seaward of the beach.
- Cloud test note: the L2A scene classification (SCL) marks surf foam as cloud. A first run with it threw away exactly the big-surf days, so it was replaced by a shortwave-infrared test (clouds bright, foam dark).

**What the satellite measures and its bias.** A snapshot shows the seaward edge of the youngest whitewater, which has already travelled shoreward from where it broke by 0 to c x T (about 0-70 m for a 13 s wave in 3 m of water). So a correct model should sit **0-70 m seaward** of the observed edge, not on it. Other uncertainty per day: Sentinel-2 geolocation and 10 m pixels (+-12 m), buoy 5 km west of Pipeline and in deep water (Hs +-20%), tide +-0.1 m.

| Hs at buoy | days | scored | median model - observed | IQR | observed further out than model by > 15 m |
|---|---|---|---|---|---|
| < 1.5 m | 13 | 8 | -1 m | -190 .. +7 | 3 (all three far-out foam, likely whitecaps) |
| 1.5-2 m | 17 | 16 | +17 m | -11 .. +27 | 2 |
| 2-2.5 m | 13 | 11 | +29 m | +14 .. +37 | 1 |
| 2.5-3 m | 8 | 8 | +30 m | +23 .. +40 | 0 |
| 3-4.1 m | 4 | 4 | +17 m | +9 .. +30 | 0 |

The largest days, one by one (scene ID = Earth Search item, e.g. `https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/S2A_4QEJ_20240202_0_L2A`):

| Date | Scene | Buoy UTC | Hs m / Tp s / dir | Tide m MSL | Observed edge | Model | Model - obs |
|---|---|---|---|---|---|---|---|
| 2024-02-02 | S2A_4QEJ_20240202_0_L2A | 21:16 | 4.12 / 18.2 / 13 | -0.02 | 119 | 128 | +9 |
| 2023-01-23 | S2B_4QEJ_20230123_0_L2A | 21:26 | 3.64 / 16.7 / 319 | -0.17 | 89 | 138 | +49 |
| 2023-12-29 | S2B_4QEK_20231229_0_L2A | 21:16 | 3.43 / 13.3 / 339 | -0.08 | 119 | 128 | +9 |
| 2024-12-23 | S2B_4QEJ_20241223_0_L2A | 21:16 | 3.34 / 14.3 / 311 | +0.23 | 104 | 128 | +24 |
| 2025-11-03 | S2C_4QEK_20251103_0_L2A | 21:26 | 2.88 / 11.8 / 341 | +0.09 | 64 | 108 | +44 |
| 2023-01-13 | S2B_4QEK_20230113_0_L2A | 21:26 | 2.85 / 14.3 / 355 | +0.05 | 59 | 98 | +39 |
| 2025-01-17 | S2A_4QEK_20250117_0_L2A | 21:16 | 2.78 / 18.2 / 307 | -0.04 | 99 | 118 | +19 |
| 2023-12-09 | S2B_4QEJ_20231209_0_L2A | 21:16 | 2.72 / 12.5 / 320 | +0.07 | 84 | 108 | +24 |
| 2024-01-18 | S2B_4QEK_20240118_0_L2A | 21:16 | 2.62 / 14.3 / 324 | +0.14 | 84 | 98 | +14 |
| 2022-03-24 | S2A_4QEK_20220324_0_L2A | 21:26 | 2.61 / 12.5 / 333 | -0.15 | 74 | 108 | +34 |
| 2022-10-10 | S2A_4QEJ_20221010_0_L2A | 21:26 | 2.55 / 13.3 / 4 | -0.06 | 42 | 68 | +26 |
| 2026-11-08 | S2C_4QEJ_20261108_0_L2A | 21:26 | 2.50 / 13.0 / 323 | -0.03 | 34 | 98 | +64 |
| 2024-10-14 | S2B_4QEK_20241014_0_L2A | 21:16 | 2.44 / 14.3 / 334 | +0.34 | 49 | 68 | +19 |
| 2024-03-03 | S2A_4QEK_20240303_0_L2A | 21:16 | 2.38 / 14.3 / 359 | -0.11 | 39 | 68 | +29 |

Uncertainty of each observed edge: +-12 m position, plus the 0-70 m shoreward snapshot lag.

## 2. Other evidence
| Observation | Source | Swell (how known) | Observed | Model | Difference | Uncertainty |
|---|---|---|---|---|---|---|
| Contest day, 2024 Vans Pipe Masters day 3, 13 Dec 2024 (surfed at Pipe and Backdoor, First Reef) | [Stab live blog](https://stabmag.com/news/2024-vans-pipe-masters-day-three-live-updates-commentary-and-conjectures/) quotes the Waimea buoy "5.6 ft at 15 seconds from 315" | NDBC 51201 18:16-23:46 UTC: 1.6-1.9 m, 12.5-15.4 s, 306-321 deg; CO-OPS tide -0.06..+0.07 m | Take-off on First Reef: the published take-off, 44 m from shore | 38-48 m (1.75 m / 14.3 s / 315: 38 m; 1.9 / 15.4 / 310: 48 m) | ~0 | +-40 m (the take-off coordinate is approximate; the blog does not locate waves) |
| First / Second / Third Reef distances | [B. Tissot](https://briantissot.com/2020/04/13/surfing-the-reef-at-banzai-pipeline/): ~200 / 400 / 1,000 ft offshore, 2-8 / 15-20 / 30-40 ft deep | geometry | 61 / 122 / 305 m | Lidar on the line: 3.1 m at 44 m (take-off), 6.3 m at 144 m, 8.9 m at 244-344 m | depths agree within the quoted ranges | "about" distances: +-30 m |
| Size at which Second Reef starts breaking | Tissot: 15-18 ft (Second), 10-15 ft (First), 25+ ft (Third), scale not stated; Surfertoday (403 to automated fetch, quoted in search results): "over 12 ft usually" | Hawaiian-scale feet taken as roughly buoy Hs in feet (+-50%): Second Reef from ~3.5-4.5 m Hs, Third ~7.5 m | Second Reef from Hs ~3.5 m | Second Reef (91 m+) from Hs 1.5 m (16 s, 305 deg), 2.25-2.75 m (12-18 s, 315-330 deg); Third Reef from 5.75-6 m (NW), 2.5 m (16 s, 305 deg) | model ~1-2 m of Hs early for NW, ~2-3 m early for long-period WNW | the feet-to-Hs conversion is the weak link |

## 3. Where the model is right, and where it is wrong
- **Right (within what the satellite can tell): NW-N groundswell of 1.5-4 m.** On the 39 scored days of 1.5-4.1 m the model's first break lies a median 24 m (inter-quartile range 9-34 m) seaward of the whitewater edge, never more than 64 m; 31 of 39 (79%) fall in the 0-70 m band a correct model should show, and 8 have whitewater further out than the model (by up to 61 m). On days of 2.5 m and up the satellite never saw whitewater more than 15 m beyond the model's break (0 of 12). The contest-day check agrees: First Reef at the published take-off.
- **Possibly too far out by up to ~40 m.** The model sits at the outer end of that band on several 2.5-3 m days (+34 to +64 m). With a 0-70 m lag, a single snapshot cannot tell "right" from "a few tens of metres too far out". Porto Batel showed the same sign (10-50 m further out than the footage).
- **Wrong on reef naming at 2-3 m.** The model puts the first break on Second Reef (91 m+) from about Hs 2.25-2.75 m. The satellite saw whitewater beyond 91 m on 4 of 12 days of 2.5 m and up, all at Hs 2.8 m or more, and the published lore puts Second Reef at roughly 3.5 m. The readout's reef name is therefore biased one reef outward at 2-3 m.
- **Wrong (or at least unsupported): long-period WNW.** For 16-20 s swells from 300-305 deg the model jumps to Third Reef at Hs 2.5 m and to 600+ m ("outside Third Reef") at 3 m. Nothing in the evidence supports Pipeline breaking 600 m out on a 3 m west swell. The cause is focusing over the 9-11 m shelf plus the Kr clip at 2.5; the shelf break-out at Hs 5-6 m for NW swell is likewise unchecked. The only satellite day near it (2025-03-23, 2.37 m, 18.2 s, 314 deg) shows whitewater 179 m out, against a model 118 m: the model was inside there, not outside.
- **Small days (< 1.5 m): inconclusive.** 5 of 13 days show no whitewater seaward of the beach while the model breaks 20-50 m out; the others are near the shore in both.

## 4. What could not be checked
- **Live cams:** none was used. At the time of this work it was night in Hawaii (01:00 HST), and the public free streams give no camera position to measure from.
- **Swells above 4.1 m:** no clear Sentinel-2 overpass on such a day (big swells come with weather). Third Reef and the shelf break-out (the model's 400-1,100 m breaks) are untested.
- **Video of contest days:** not used for measurement (no frames copied, no download). Contest write-ups give swell but never a measured break position.
- **Academic bathymetry or breaking studies of Pipeline:** none with numbers found in public text (Mead and Black's surf-break work is cited secondhand only).
- **Datum:** Open-Meteo MSL vs lidar LMSL, and Honolulu vs North Shore tide: both taken as equal (+-0.1 m).
- **Sets vs Hs:** the model runs one regular wave of height Hs; sets are 1.5-2 x Hs and break further out. Not modelled.

## 5. Decisions for Benn
- The reef naming at 2-3 m and the long-period WNW break-out are model results that disagree with the evidence. They are reported, not tuned. Whether the panel should show the reef name at all, or only distances, is your call.
- The lidar licence: published on the dataset's official metadata (NOAA InPort 65476, dataset 9365: access constraints "None", US Government work; Benn, 2026-11-16). The e-mail confirmation from NOAA is still pending (`README.md`).
- NDBC 51201 values appear in this validation (with attribution) and in `validation/*.json`; they are not in any public snapshot. Decided 2026-11-16: `validation/` (the per-scene JSON with buoy values) stays out of the public export; this write-up goes public.
