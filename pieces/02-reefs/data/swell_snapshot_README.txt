NOTE 2026-11-23: swell_snapshot_peniche_2026-09.json and _2026-11.json were REBUILT from NOAA NCEP GFS-Wave (WAVEWATCH III, public domain)
by pieces/11-ocean/build_typical_swell.py: 3-hourly (forecast hours 0 and 3 of each 6-hourly run) at the nearest 0.25 degree sea point to 39.375 N 9.458 W,
from the NOAA archive on AWS (noaa-gfs-bdp-pds). The Open-Meteo originals (non-commercial licence) are replaced; the text below describes those originals and is
kept only as a record of the tide notes (the IH tide section is still valid). The NOAA files have no sea_level_height_msl field.

Request URL: https://marine-api.open-meteo.com/v1/marine?latitude=39.33&longitude=-9.45&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_peak_period,swell_wave_direction,wind_wave_height,wind_wave_period,wind_wave_direction&timezone=GMT&start_date=2026-11-10&end_date=2026-11-13
Retrieved (UTC): 2026-11-11T22:52:42Z (sandbox clock; the task date was 2026-11-12, so treat this as the local-clock time of the pull)
Grid point returned: latitude 39.291664, longitude -9.458328 (requested 39.33, -9.45; about 4 km offset); elevation 0 m
Model: the Open-Meteo Marine docs and response do not name the model (no model field returned); docs list MeteoFrance MFWAM and DWD EWAM among the marine sources
Units: wave heights in m, periods in s, directions in degrees (direction waves come FROM); times in GMT (utc_offset_seconds 0)
Note: this is numerical model output from Open-Meteo, not a buoy or in-situ measurement; no official buoy values were confirmed (IH buoy data was reported unavailable on the IH homepage)

--- Addendum: Porto Batel footage day, 16-18 Sep 2026 (file swell_snapshot_peniche_2026-09.json) ---
Request URL: https://marine-api.open-meteo.com/v1/marine?latitude=39.33&longitude=-9.45&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_peak_period,swell_wave_direction,wind_wave_height,wind_wave_period,wind_wave_direction,sea_level_height_msl&timezone=GMT&start_date=2026-09-16&end_date=2026-09-18
Fetched: 2026-11-12. Same grid point as the November file (39.291664 N, 9.458328 W). Past dates work with start_date/end_date on the same endpoint (docs list past_days 0-92 and ERA5-Ocean back to 1940; no separate archive host documented).
Extra variable vs November file: sea_level_height_msl (m), reference = global mean sea level (not LAT, not Zero Hidrografico). Docs warn accuracy is limited near coasts and it is not suitable for coastal navigation; ~8 km resolution.
Model output, not buoy. Times GMT. Local time on 17 Sep 2026 is WEST (UTC+1): 15:20-18:02 local = 14:20-17:02 UTC.
Tide: no official Peniche value for 17 Sep was obtained (IH Tabela de Mares I 2026 PDF too large to read via fetch and not downloaded). ZH is 2.00 m below Cascais 1938 mean level (IH); ZH sits below LAT (IH), exact Peniche LAT offset not found.

--- Tide for 17 Sep 2026, official (added 2026-11-12) ---
Source: Instituto Hidrografico, Tabela de Mares 2026 Vol. I, Porto de Peniche (secao 201.5, pp. 2-41/2-42; PDF page 67 for Sep). Saved untrusted copy: raw/tide-ih-2026/TabelaMare_I_2026_signed.pdf (text extracted only).
Times UTC ("Horas do Fuso: 0 (TU)"; local summer time = +1 h). Heights above Zero Hidrografico (ZH), predictions truncated to 0.1 m.
Notes p. 2-41: mean level (NM) 2.00 m above ZH; ZH is 2.00 m below the Cascais 1938 mean level. Port summary table (PDF p. 197): Peniche BMmin (lowest astronomical tide predicted for 2026) = 0.34 m above ZH, i.e. LAT(2026) ~ ZH+0.34; the table gives no multi-year LAT value. IH sec. 103 (PDF p. 13): actual water levels expected ~0.1 m above the table because of sea-level rise; weather deviations often exceed 0.1 m.
16 Sep: H 05:24 3.0, L 11:29 1.0, H 17:44 2.8, L 23:44 1.1.
17 Sep: H 06:03 2.8, L 12:11 1.2, H 18:25 2.6 (UTC). 18 Sep: L 00:25 1.3, H 06:52 2.6, L 13:08 1.4, H 19:23 2.4.
Cosine interpolation between L 12:11 and H 18:25 UTC, height above ZH (m): 15:20 local 1.57; 16:00 1.79; 17:00 2.14; 18:02 2.44.
Model sea_level_height_msl + 2.00 was 0.17-0.29 m lower than the table (-0.17, -0.17, -0.20, -0.29); model timing agrees with table.
