"""Build the US tornado layer data from the NOAA SPC tornado database (1950-2025).

Run (from outside raw/):  python3 pieces/08-storms/build_tornadoes.py
Reads raw/spc/1950-2025_actual_tornadoes.csv (untrusted data, only parsed; downloaded if missing).
Writes data/tornado_tracks.bin, data/tornado_tracks.json, data/tornado_density_points.bin.
"""
import csv, json, math, os, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw", "spc", "1950-2025_actual_tornadoes.csv")
OUT = os.path.join(HERE, "data")
URL = "https://www.spc.noaa.gov/wcm/data/1950-2025_actual_tornadoes.csv"

# density: contiguous US box, 0.25 degree cells, only 1991-2024 (full years, better reporting)
D_YEARS = (1991, 2024)
LON0, LON1, LAT0, LAT1, CELL = -125.0, -66.0, 24.0, 50.0, 0.25
GW, GH = int((LON1 - LON0) / CELL), int((LAT1 - LAT0) / CELL)
if not os.path.exists(RAW):
    os.makedirs(os.path.dirname(RAW), exist_ok=True)
    urllib.request.urlretrieve(URL, RAW)

rows = []
n_bad_start = n_no_end = n_unknown = 0
with open(RAW, newline="", encoding="utf-8") as f:
    for r in csv.DictReader(f):
        try:
            yr = int(r["yr"]); mag = int(r["mag"])
            slat, slon, elat, elon = float(r["slat"]), float(r["slon"]), float(r["elat"]), float(r["elon"])
            key = (yr, int(r["mo"]), int(r["dy"]))
        except (ValueError, KeyError):
            n_bad_start += 1; continue
        if slat == 0 or slon == 0 or not (-180 <= slon <= 180):
            n_bad_start += 1; continue
        if elat == 0 or elon == 0:      # SPC: 0.0 = end point not recorded -> draw as a point
            elat, elon = slat, slon; n_no_end += 1
        if mag < 0 or mag > 5:          # SPC: -9 = rating unknown
            mag = 6; n_unknown += 1
        rows.append((key, yr, mag, slat, slon, elat, elon))
rows.sort(key=lambda x: x[0])
N = len(rows)

a = lambda i, dt: np.array([r[i] for r in rows])
slat = np.round(a(3, float) * 100).astype("<i2"); slon = np.round(a(4, float) * 100).astype("<i2")
elat = np.round(a(5, float) * 100).astype("<i2"); elon = np.round(a(6, float) * 100).astype("<i2")
yr = a(1, int); year_b = (yr - 1950).astype("u1"); mag = a(2, int).astype("u1")
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "tornado_tracks.bin"), "wb") as f:
    for arr in (slat, slon, elat, elon, year_b, mag):
        f.write(arr.tobytes())
y0, y1 = int(yr.min()), int(yr.max())
year_offsets = [int(np.searchsorted(yr, y)) for y in range(y0, y1 + 2)]   # index of first tornado of each year
by_mag = {str(m): int((mag == m).sum()) for m in range(7)}
by_year = {int(y): int((yr == y).sum()) for y in range(y0, y1 + 1)}

# density: tornadoes whose path touches each cell, 1991-2024, log scaled
cnt = np.zeros((GH, GW), np.float32)
for k in range(N):
    if not (D_YEARS[0] <= yr[k] <= D_YEARS[1]): continue
    la1, lo1, la2, lo2 = rows[k][3:7]
    n = max(1, int(max(abs(la2 - la1), abs(lo2 - lo1)) / (CELL / 2)))
    t = np.linspace(0, 1, n + 1)
    ix = np.floor((lo1 + (lo2 - lo1) * t - LON0) / CELL).astype(int)
    iy = np.floor((LAT1 - (la1 + (la2 - la1) * t)) / CELL).astype(int)
    ok = (ix >= 0) & (ix < GW) & (iy >= 0) & (iy < GH)
    for c in set(zip(iy[ok].tolist(), ix[ok].tolist())): cnt[c] += 1

mx = float(cnt.max())
ys, xs = np.nonzero(cnt)       # only cells with at least one tornado get a dot: no dot = no claim about zero
val = np.clip(np.round(255 * np.log1p(cnt[ys, xs]) / math.log1p(mx)), 1, 255).astype("u1")
dlat = np.round((LAT1 - (ys + 0.5) * CELL) * 100).astype("<i2")
dlon = np.round((LON0 + (xs + 0.5) * CELL) * 100).astype("<i2")
with open(os.path.join(OUT, "tornado_density_points.bin"), "wb") as f:
    f.write(dlat.tobytes()); f.write(dlon.tobytes()); f.write(val.tobytes())
DENS_N = len(val)

meta = dict(
    source="NOAA/NWS Storm Prediction Center severe weather database, 1950-2025_actual_tornadoes.csv",
    accessed="2026-11-22", fileLastModified="2026-04-24", tornadoes=N, yearFrom=y0, yearTo=y1,
    note2025="2025 file ends 2025-09-09 (partial year)",
    missingEnd=n_no_end, unknownRating=n_unknown, droppedBadStart=n_bad_start,
    ratingCounts=by_mag, ratingKey="0-5 = F/EF0-5, 6 = unknown (-9 in source)",
    layout="int16 slat*100[N], slon*100[N], elat*100[N], elon*100[N]; uint8 year-1950[N], rating[N]",
    yearOffsets=year_offsets, perYear=by_year,
    density=dict(points=DENS_N, years=list(D_YEARS), cellDeg=CELL, maxPerCell=int(mx),
                 layout="int16 lat*100[M], int16 lon*100[M], uint8 value[M] (log scale of tornado paths per cell, 1..255)",
                 note="one dot per 0.25 degree cell with at least one tornado path; cells without hits have no dot"),
)
with open(os.path.join(OUT, "tornado_tracks.json"), "w") as f:
    json.dump(meta, f, separators=(",", ":"))
tot = 0
for n in ("tornado_tracks.bin", "tornado_tracks.json", "tornado_density_points.bin"):
    s = os.path.getsize(os.path.join(OUT, n)); tot += s; print(n, s, "bytes")
print("total", tot, "tornadoes", N, "years", y0, y1, "missing end", n_no_end, "unknown rating", n_unknown,
      "dropped", n_bad_start, "density max", int(mx))
iy, ix = np.unravel_index(np.argsort(cnt, axis=None)[-5:], cnt.shape)
print("densest cells (lat, lon):", [(round(LAT1 - (i + .5) * CELL, 2), round(LON0 + (j + .5) * CELL, 2)) for i, j in zip(iy, ix)])

# ---- replay: one documented outbreak (27 April 2011, "Super Outbreak"), recorded paths with times (SPC time zone code 3 = CST)
# Carries path width (yards, as recorded) and rating; where either is missing the outbreak median is used and counted.
REPLAY_DATE = "2011-04-27"
rep, est_end, no_end = [], 0, 0
with open(RAW, newline="", encoding="utf-8") as f:
    for r in csv.DictReader(f):
        if r["date"] != REPLAY_DATE: continue
        def mins(t):
            h, m = t.split(":")[:2]; return int(h) * 60 + int(m)
        t0 = mins(r["time"])
        la1, lo1, la2, lo2 = float(r["slat"]), float(r["slon"]), float(r["elat"]), float(r["elon"])
        if la2 == 0 or lo2 == 0: la2, lo2 = la1, lo1; no_end += 1
        t1 = None
        if r["edat"] == REPLAY_DATE and r["etime"]:
            t1 = mins(r["etime"])
        if t1 is None or t1 <= t0:                # no recorded end time: estimate from length at about 50 mph
            t1 = t0 + max(2, round(float(r["len"]) / 50 * 60)); est_end += 1
        wid = float(r["wid"]); mag = int(r["mag"])
        rep.append([round(la1, 3), round(lo1, 3), round(la2, 3), round(lo2, 3), t0, t1, mag if 0 <= mag <= 5 else -9, r["st"],
                    wid if wid > 0 else None, float(r["len"])])
rep.sort(key=lambda x: x[4])
known_w = sorted(x[8] for x in rep if x[8]); known_m = sorted(x[6] for x in rep if x[6] >= 0)
med_w = known_w[len(known_w) // 2]; med_m = known_m[len(known_m) // 2]
n_w = sum(1 for x in rep if x[8] is None); n_m = sum(1 for x in rep if x[6] < 0)
for x in rep:
    x.append(x[8] if x[8] else med_w)          # [10] width used (yards) ... see fields
    x.append(x[6] if x[6] >= 0 else med_m)     # [11] rating used
rep2 = [[x[0], x[1], x[2], x[3], x[4], x[5], x[6], x[7], x[10], x[9], x[11]] for x in rep]
with open(os.path.join(OUT, "replay_outbreak.json"), "w") as f:
    json.dump(dict(date=REPLAY_DATE, name="27 April 2011 outbreak", timeZone="CST (SPC code 3), minutes after 00:00",
                   source="NOAA/NWS SPC tornado database", count=len(rep2), endTimeEstimated=est_end, noEndPoint=no_end,
                   widthYd=dict(min=known_w[0], median=med_w, max=known_w[-1], medianUsed=n_w),
                   rating=dict(min=known_m[0], median=med_m, max=known_m[-1], medianUsed=n_m),
                   fields=["slat", "slon", "elat", "elon", "startMin", "endMin", "ratingRecorded(-9 unknown)", "state",
                           "widthYdUsed", "lengthMi", "ratingUsed"], tornadoes=rep2),
              f, separators=(",", ":"))
print("replay", REPLAY_DATE, len(rep2), "tornadoes; width yd", known_w[0], med_w, known_w[-1], "median used", n_w,
      "; rating", known_m[0], med_m, known_m[-1], "median used", n_m, "; est end", est_end,
      os.path.getsize(os.path.join(OUT, "replay_outbreak.json")), "bytes")
