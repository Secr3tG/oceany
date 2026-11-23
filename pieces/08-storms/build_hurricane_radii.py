"""Recorded storm size per track point, aligned with data/tracks.bin (run build_hurricanes.py first).

Run:  python3 -I build_hurricane_radii.py
Reads raw/ibtracs.since1980.list.v04r01.csv (untrusted data, only parsed) and data/tracks.json + tracks.bin.
Writes data/track_radii.bin: uint16 r34Km[N], uint16 rmwKm[N]  (0 = not recorded at that point).

r34 = mean of the four quadrant radii of 34 kt (gale-force) wind, over the quadrants that were recorded;
rmw = radius of maximum wind. Agency order: USA (NHC / CPHC / JTWC), then BoM, then Météo-France La Réunion.
IBTrACS gives these in nautical miles; stored in km. Most records are 2004 onward; earlier points mostly have none.
"""
import csv, json, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "raw", "ibtracs.since1980.list.v04r01.csv")
OUT = os.path.join(HERE, "data")
NMI = 1.852

def num(s):
    s = s.strip()
    if not s: return None
    try: v = float(s)
    except ValueError: return None
    return v if v > 0 else None

meta = json.load(open(os.path.join(OUT, "tracks.json")))
N = meta["meta"]["points"]
buf = open(os.path.join(OUT, "tracks.bin"), "rb").read()
tlat = np.frombuffer(buf, "<i2", N, 0); tlon = np.frombuffer(buf, "<i2", N, 2 * N); tdt = np.frombuffer(buf, "<u2", N, 4 * N)
slot = {}  # (sid, hours since storm start) -> point index
for s in meta["storms"]:
    for i in range(s["offset"], s["offset"] + s["count"]):
        slot[(s["id"], int(tdt[i]))] = i
t0 = {s["id"]: s["t0"] for s in meta["storms"]}

import datetime
EPOCH = datetime.datetime(1980, 1, 1)
r34 = np.zeros(N, "<u2"); rmw = np.zeros(N, "<u2")
hit = 0
with open(RAW, newline="", encoding="utf-8") as f:
    rd = csv.reader(f); hdr = next(rd); ix = {k: i for i, k in enumerate(hdr)}; next(rd)
    for r in rd:
        sid = r[ix["SID"]]
        if sid not in t0 or r[ix["TRACK_TYPE"]] == "spur": continue
        t = r[ix["ISO_TIME"]]
        if not t[11:13] in ("00", "06", "12", "18") or t[14:16] != "00": continue
        hrs = int((datetime.datetime.strptime(t, "%Y-%m-%d %H:%M:%S") - EPOCH).total_seconds() // 3600)
        i = slot.get((sid, hrs - t0[sid]))
        if i is None: continue
        la, lo = num(r[ix["LAT"]]), num(r[ix["LON"]])
        if la is not None and abs(round(la * 100) - tlat[i]) > 1: continue   # alignment check
        for ag in ("USA", "BOM", "REUNION"):
            q = [num(r[ix[f"{ag}_R34_{d}"]]) for d in ("NE", "SE", "SW", "NW")]
            q = [x for x in q if x is not None]
            if q and not r34[i]: r34[i] = min(65535, round(sum(q) / len(q) * NMI))
            m = num(r[ix[f"{ag}_RMW"]])
            if m is not None and not rmw[i]: rmw[i] = min(65535, round(m * NMI))
        if r34[i] or rmw[i]: hit += 1

with open(os.path.join(OUT, "track_radii.bin"), "wb") as f:
    f.write(r34.tobytes()); f.write(rmw.tobytes())
print(f"{N} points, {hit} with a recorded radius; r34 on {int((r34 > 0).sum())}, rmw on {int((rmw > 0).sum())}")
print("r34 km median", int(np.median(r34[r34 > 0])), "rmw km median", int(np.median(rmw[rmw > 0])))
