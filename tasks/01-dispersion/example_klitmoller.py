# How far away was the storm?
# Worked example: Klitmøller, 12 s swell arrives first, 8 s swell 23 hours later.

# --- What we observed on the beach ---
fast_period = 12   # seconds: the long-period swell that arrived first
slow_period = 8    # seconds: the shorter swell that arrived later
gap_hours = 23     # hours between the two arrivals

# --- Speed of each swell (rule of thumb: 0.78 x period) ---
fast_speed = 0.78 * fast_period   # metres per second
slow_speed = 0.78 * slow_period   # metres per second

# --- How many seconds each swell needs to cover ONE metre ---
fast_seconds_per_metre = 1 / fast_speed
slow_seconds_per_metre = 1 / slow_speed

# --- How much further behind the slow swell falls, every metre ---
lag_per_metre = slow_seconds_per_metre - fast_seconds_per_metre

# --- The total gap, in seconds (3600 seconds in an hour) ---
gap_seconds = gap_hours * 3600

# --- How many metres it takes to build up that gap ---
distance_metres = gap_seconds / lag_per_metre
distance_km = distance_metres / 1000

print("Fast swell speed:", round(fast_speed, 1), "m/s")
print("Slow swell speed:", round(slow_speed, 1), "m/s")
print("Storm distance:", round(distance_km), "km")
