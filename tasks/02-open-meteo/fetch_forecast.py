# fetch_forecast.py : download a 3-day wave forecast for Porto Batel and print it as a table.
# Run it with:  .venv/bin/python tasks/02-open-meteo/fetch_forecast.py

# --- Section 1: IMPORTS (new idea: a library is code someone else wrote that you borrow) ---
import json                      # lets us turn the server's text reply into Python data and save it back as text
import os                        # lets us build file paths and make folders
from datetime import datetime    # lets us stamp the saved file with the time we fetched it
import requests                  # the library that talks to websites for us

# --- Section 2: SETTINGS (new idea: a variable is a name stuck on a value, so you change it in one place) ---
SPOT_NAME = "Porto Batel"        # only used for printing and for the file name
LATITUDE = 39.3195               # degrees north of the equator
LONGITUDE = -9.3558              # negative means west of Greenwich (Portugal is west)
FORECAST_DAYS = 3                # how many days ahead we ask for

# --- Section 3: LISTS (new idea: a list holds many values in order, written in square brackets) ---
# These are the exact variable names from the Open-Meteo Marine docs.
# "wave_*" is the whole sea; "swell_wave_*" is only the long-period swell part (what you read on Windguru).
HOURLY_VARIABLES = [
    "wave_height",               # metres
    "wave_period",               # seconds
    "wave_direction",            # degrees, the direction the waves come FROM (0 = north)
    "swell_wave_height",
    "swell_wave_period",
    "swell_wave_direction",
]

# --- Section 4: DICTIONARIES (new idea: a dictionary pairs a label with a value: {label: value}) ---
URL = "https://marine-api.open-meteo.com/v1/marine"   # the address of the Marine API
params = {
    "latitude": LATITUDE,
    "longitude": LONGITUDE,
    "hourly": ",".join(HOURLY_VARIABLES),   # .join glues the list into one text: "wave_height,wave_period,..."
    "forecast_days": FORECAST_DAYS,
    "timezone": "auto",                     # give times in the spot's local time instead of GMT
}

# --- Section 5: A WEB REQUEST (new idea: ask a server a question and get an answer back) ---
response = requests.get(URL, params=params, timeout=30)   # timeout: give up after 30 s instead of waiting forever
response.raise_for_status()   # stop with a clear error if the server said no (e.g. 400 or 500)
data = response.json()        # turn the reply text into Python lists and dictionaries

# --- Section 6: SAVING A FILE (new idea: write data to disk so you keep the raw answer) ---
out_dir = os.path.join(os.path.dirname(__file__), "out")   # an "out" folder next to this script
os.makedirs(out_dir, exist_ok=True)                        # create it if it is missing, no error if it exists
stamp = datetime.now().strftime("%Y%m%d_%H%M")             # e.g. 20261114_1530
out_path = os.path.join(out_dir, f"{SPOT_NAME.replace(' ', '_').lower()}_{stamp}.json")
with open(out_path, "w") as f:                             # "with" closes the file for us when done
    json.dump(data, f, indent=2)                           # indent=2 makes the file readable for humans
print(f"Saved raw JSON to {out_path}")

# --- Section 7: LOOPS (new idea: repeat the same steps for every item in a list) ---
hourly = data["hourly"]          # the block that holds one list per variable
times = hourly["time"]           # list of timestamps, one per hour

def fmt(value):
    # Small function (new idea: a def packages steps under a name). Missing data arrives as None.
    return "  -  " if value is None else f"{value:5.1f}"

print()
print(f"{SPOT_NAME} ({LATITUDE}, {LONGITUDE}) - every 6th hour")
print("time              | wave m  s  dir | swell m  s  dir")
for i in range(0, len(times), 6):    # range(start, stop, step): 0, 6, 12, ... so the table stays short
    print(
        f"{times[i].replace('T', ' ')} | "
        f"{fmt(hourly['wave_height'][i])} {fmt(hourly['wave_period'][i])} {fmt(hourly['wave_direction'][i])} | "
        f"{fmt(hourly['swell_wave_height'][i])} {fmt(hourly['swell_wave_period'][i])} {fmt(hourly['swell_wave_direction'][i])}"
    )

print()
print("Data: Open-Meteo.com Marine Weather API (non-commercial use). Models: see open-meteo.com/en/docs/marine-weather-api")
