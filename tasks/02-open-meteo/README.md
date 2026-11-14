# 02 - Open-Meteo wave forecast

`fetch_forecast.py` downloads the next 3 days of hourly wave and swell data for Porto Batel from the Open-Meteo Marine API (no key needed), prints a short table and saves the raw JSON in `out/`.

Run from the Oceany folder:

    python tasks/02-open-meteo/fetch_forecast.py

Read it top to bottom: each section introduces one Python idea in its comment.

Units: height in metres, period in seconds, direction in degrees the waves come FROM (0 = north), same as Windguru.

## Attribution and licence
Open-Meteo's free API is for non-commercial use and requires attribution: name Open-Meteo and the model providers (e.g. Copernicus, ECMWF, NOAA NCEP, DWD, ERA5-Ocean). Any plot or post using this data needs that credit. Commercial use needs a paid key. The data is not for navigation.

## Your turn
1. Change the spot to Hilton Beach, Tel Aviv (32.0857, 34.7700). What changes in the table?
2. Add a column for `wind_wave_height` (look up the name in the docs) and print it.
3. Find the hour with the biggest swell height and print its time, height and period.
