"""Build the hurricane layer data from IBTrACS v04r01 (since 1980, all basins).

Run:  python3 -I build_hurricanes.py
Reads raw/ibtracs.since1980.list.v04r01.csv (untrusted data, only parsed).
Writes data/tracks.bin, data/tracks.json, data/density_points.bin.
"""
import csv, json, math, os, sys, struct, datetime, urllib.request
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw", "ibtracs.since1980.list.v04r01.csv")
OUT = os.path.join(HERE, "data")
URL = ("https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-"
       "ibtracs/v04r01/access/csv/ibtracs.since1980.list.v04r01.csv")
EPOCH = datetime.datetime(1980, 1, 1)
MIN_WIND = 34          # keep storms that reach tropical-storm strength
RADIUS_KM = 150.0      # "hit" = storm centre within this distance of the cell centre
GRID_W, GRID_H = 360, 180   # 1 degree cells
MIN_HITS = 3                # density dots only where at least this many storms passed (keeps the sea readable)

if not os.path.exists(RAW):
    os.makedirs(os.path.dirname(RAW), exist_ok=True)
    print("downloading", URL)
    urllib.request.urlretrieve(URL, RAW)

def num(s):
    s = s.strip()
    if not s: return None
    try: return float(s)
    except ValueError: return None

def category(w):  # Saffir-Simpson on 1-min wind in knots; 0 = tropical storm
    if w >= 137: return 5
    if w >= 113: return 4
    if w >= 96: return 3
    if w >= 83: return 2
    if w >= 64: return 1
    return 0

storms = {}
order = []
with open(RAW, newline="", encoding="utf-8") as f:
    rd = csv.reader(f)
    hdr = next(rd)
    ix = {k: i for i, k in enumerate(hdr)}
    next(rd)  # units row
    for r in rd:
        if r[ix["TRACK_TYPE"]] == "spur": continue
        t = r[ix["ISO_TIME"]]
        if not t[11:13] in ("00", "06", "12", "18") or t[14:16] != "00": continue
        lat, lon = num(r[ix["LAT"]]), num(r[ix["LON"]])
        if lat is None or lon is None: continue
        w = num(r[ix["USA_WIND"]])
        if w is None or w < 0: w = num(r[ix["WMO_WIND"]])
        if w is None or w < 0: w = 0
        sid = r[ix["SID"]]
        if sid not in storms:
            nm = r[ix["NAME"]].strip()
            storms[sid] = dict(name="" if nm in ("NOT_NAMED", "UNNAMED") else nm.title(),
                               year=int(r[ix["SEASON"]]), basin=r[ix["BASIN"]], pts=[])
            order.append(sid)
        dt = datetime.datetime.strptime(t, "%Y-%m-%d %H:%M:%S")
        hrs = int((dt - EPOCH).total_seconds() // 3600)
        storms[sid]["pts"].append((hrs, lat, lon, w))

kept = []
for sid in order:
    s = storms[sid]
    s["pts"].sort()
    if not s["pts"] or max(p[3] for p in s["pts"]) < MIN_WIND: continue
    s["sid"] = sid
    kept.append(s)
kept.sort(key=lambda s: s["pts"][0][0])

# binary layout (little endian), struct of arrays, N points total:
#   int16 lat*100 [N], int16 lon*100 [N], uint16 hours since storm start [N], uint8 wind kt [N]
lat_a, lon_a, dt_a, wind_a, index = [], [], [], [], []
off = 0
for s in kept:
    p = s["pts"]; t0 = p[0][0]
    for h, la, lo, w in p:
        lat_a.append(round(la * 100)); lon_a.append(round(lo * 100))
        dt_a.append(min(h - t0, 65535)); wind_a.append(min(int(w), 255))
    mx = max(q[3] for q in p)
    index.append(dict(name=s["name"], year=s["year"], basin=s["basin"], cat=category(mx),
                      maxWind=int(mx), t0=t0, offset=off, count=len(p), id=s["sid"]))
    off += len(p)
N = off
os.makedirs(OUT, exist_ok=True)
with open(os.path.join(OUT, "tracks.bin"), "wb") as f:
    f.write(np.array(lat_a, "<i2").tobytes()); f.write(np.array(lon_a, "<i2").tobytes())
    f.write(np.array(dt_a, "<u2").tobytes()); f.write(np.array(wind_a, "u1").tobytes())

# density: unique storms whose (densified) track passes within RADIUS_KM of each cell centre
cnt = np.zeros((GRID_H, GRID_W), np.float32)
clat = 90 - (np.arange(GRID_H) + 0.5) * 180 / GRID_H
clon = -180 + (np.arange(GRID_W) + 0.5) * 360 / GRID_W
cell = 180 / GRID_H
for s in kept:
    p = s["pts"]
    samples = []
    for i, (_, la, lo, _) in enumerate(p):
        samples.append((la, lo))
        if i + 1 < len(p):
            la2, lo2 = p[i + 1][1], p[i + 1][2]
            dlo = (lo2 - lo + 180) % 360 - 180
            n = int(max(abs(la2 - la), abs(dlo)) / 0.25)
            for k in range(1, n):
                f = k / n
                samples.append((la + (la2 - la) * f, (lo + dlo * f + 180) % 360 - 180))
    hit = np.zeros((GRID_H, GRID_W), bool)
    for la, lo in samples:
        dlat = RADIUS_KM / 111.2
        r0 = max(0, int((90 - la - dlat) / cell)); r1 = min(GRID_H, int((90 - la + dlat) / cell) + 1)
        cosl = max(math.cos(math.radians(la)), 0.05)
        dlon = min(180.0, RADIUS_KM / (111.2 * cosl))
        cols = np.arange(math.floor((lo - dlon + 180) / cell), math.floor((lo + dlon + 180) / cell) + 1) % GRID_W
        la_c = clat[r0:r1, None]; lo_c = clon[cols][None, :]
        a = np.sin(np.radians(la_c - la) / 2) ** 2 + math.cos(math.radians(la)) * np.cos(np.radians(la_c)) * np.sin(np.radians((lo_c - lo + 180) % 360 - 180) / 2) ** 2
        d = 2 * 6371 * np.arcsin(np.sqrt(a))
        sub = hit[r0:r1]
        sub[:, cols] |= d <= RADIUS_KM
    cnt += hit

mx = float(cnt.max())
# density as dots: one dot per 1 degree cell with at least MIN_HITS storms; value 1..255 = log scale of storms per cell
ys, xs = np.nonzero(cnt >= MIN_HITS)
val = np.clip(np.round(255 * np.log1p(cnt[ys, xs]) / math.log1p(mx)), 1, 255).astype("u1")
dlat = np.round((90 - (ys + 0.5) * cell) * 100).astype("<i2")
dlon = np.round((-180 + (xs + 0.5) * cell) * 100).astype("<i2")
with open(os.path.join(OUT, "density_points.bin"), "wb") as f:
    f.write(dlat.tobytes()); f.write(dlon.tobytes()); f.write(val.tobytes())
DENS_N = len(val)

meta = dict(
    source="NOAA IBTrACS v04r01 (since1980)", accessed="2026-11-22", epoch="1980-01-01T00:00:00Z",
    points=N, storms=len(index), minWindKt=MIN_WIND, densityRadiusKm=RADIUS_KM,
    densityPoints=DENS_N, densityCellDeg=cell, densityMinHits=MIN_HITS, densityMaxStorms=int(mx),
    densityLayout="int16 lat*100[M], int16 lon*100[M], uint8 value[M] (log scale of storms per cell, 1..255)",
    layout="int16 lat*100[N], int16 lon*100[N], uint16 hoursSinceStormStart[N], uint8 windKt[N]",
    categories="0 = tropical storm (34-63 kt), 1-5 = Saffir-Simpson on max wind",
)
with open(os.path.join(OUT, "tracks.json"), "w") as f:
    json.dump(dict(meta=meta, storms=index), f, separators=(",", ":"))
for n in ("tracks.bin", "tracks.json", "density_points.bin"):
    print(n, os.path.getsize(os.path.join(OUT, n)), "bytes")
bas = {}
for s in index: bas[s["basin"]] = bas.get(s["basin"], 0) + 1
print("storms", len(index), "points", N, "density max", int(mx), "by basin", bas)
