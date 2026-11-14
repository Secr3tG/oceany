"""Download the wide North Sea box from the EMODnet WCS as small, down-scaled tiles.

The service refuses big requests (it failed above ~8 square degrees), so we ask for
2 x 3 degree tiles. scaleFactor=0.0625 (the WCS 2.0 scaling extension) makes the server
return every 16th cell: 1/16 of the native 1/16 arc-minute = 1 arc-minute grid
(~1.85 km north-south, ~1.0 km east-west at 57 N).
Run: python download_wide.py
"""
import time
import urllib.request
from pathlib import Path

OUT = Path(__file__).parent / "data" / "raw" / "wide"
OUT.mkdir(parents=True, exist_ok=True)
URL = ("https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage"
       "&coverageId=emodnet__mean&format=image/tiff&subset=Lat({a},{b})&subset=Long({c},{d})"
       "&scaleFactor=0.0625")

for lat in range(48, 63, 3):             # 48-51 and 51-54 added later (Dover Strait); then 54-57, 57-60, 60-63
    for lon in range(-6, 10, 2):         # -6..-4, ..., 8..10
        name = OUT / f"tile_lat{lat}_lon{lon}.tif"
        if name.exists():
            continue
        data = urllib.request.urlopen(URL.format(a=lat, b=lat + 3, c=lon, d=lon + 2), timeout=300).read()
        name.write_bytes(data)
        print(name.name, len(data) // 1024, "KB")
        time.sleep(0.5)                   # be gentle with the server
