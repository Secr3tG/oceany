# swell_arrival.py : when does swell from a storm reach my spots?
# Run it with:  python3 tasks/swell_arrival.py
# Change the STORM settings below and run it again. Standard library only, nothing to install.
#
# The ONE new idea in this script: adding a timedelta to a datetime.
#   A datetime is a moment ("20 Nov 2026, 00:00 UTC").
#   A timedelta is a length of time ("52.5 hours").
#   moment + length = a new moment. Python handles midnight, month ends and leap years for you.
# Everything else (variables, a dictionary, a def, a loop) you have met in tasks/02-open-meteo.
# The maths is explained step by step in notes/swell-travel.md.

import math                                      # sin, cos, square root: calculator buttons, nothing more
from datetime import datetime, timedelta, timezone   # moments, lengths of time, and "this is UTC"

# --- SETTINGS: change these ---
STORM_LAT = 58.0          # degrees north. 58 N, 25 W is open Atlantic south of Iceland
STORM_LON = -25.0         # negative = west of Greenwich
PERIOD = 16               # seconds, the swell period you care about
START = datetime(2026, 11, 20, 0, 0, tzinfo=timezone.utc)   # when the storm sends the swell off: year, month, day, hour, minute

# --- Spots (coordinates copied from pieces/07-globe/regions.json) ---
# A dictionary: name -> (latitude, longitude). The round brackets hold two numbers together (a "tuple").
SPOTS = {
    "Peniche (Supertubos)": (39.3398, -9.3619),
    "Klitmoller": (57.04, 8.49),
    "Pipeline": (21.665, -158.053),
    "Tel Aviv": (32.08, 34.76),
}

EARTH_RADIUS_KM = 6371.0  # average radius of the Earth


def great_circle_km(lat1, lon1, lat2, lon2):
    # The haversine recipe: shortest distance over the globe between two points.
    p1 = math.radians(lat1)                      # the calculator buttons want radians, not degrees
    p2 = math.radians(lat2)                      # (radians = degrees x 3.14159 / 180)
    dlat = math.radians(lat2 - lat1)             # how far apart north-south
    dlon = math.radians(lon2 - lon1)             # how far apart east-west
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlon / 2) ** 2   # a number between 0 and 1
    angle = 2 * math.asin(math.sqrt(a))          # the angle between the two points, seen from the Earth's centre
    return EARTH_RADIUS_KM * angle               # angle x radius = distance along the surface


group_speed = 0.78 * PERIOD                      # metres per second: deep-water swell energy speed
print(f"Storm at {STORM_LAT}, {STORM_LON}. Period {PERIOD} s, travels at {group_speed:.1f} m/s "
      f"({group_speed * 3.6:.1f} km/h). Leaves {START:%Y-%m-%d %H:%M} UTC.")
print()

for name, (lat, lon) in SPOTS.items():           # loop over the dictionary: name, and its two numbers
    km = great_circle_km(STORM_LAT, STORM_LON, lat, lon)
    hours = km * 1000 / group_speed / 3600       # km -> metres, divide by speed -> seconds, -> hours
    arrival = START + timedelta(hours=hours)     # THE NEW IDEA: a moment plus a length of time
    print(f"{name:22s} {km:7.0f} km   {hours:6.1f} h   arrives {arrival:%a %d %b %H:%M} UTC")

print()
print("Straight-line numbers over a smooth globe. They ignore land in the way:")
print("from the Atlantic, Klitmoller is behind Scotland, and Tel Aviv is behind all of Europe.")
