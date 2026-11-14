"""Download native-resolution EMODnet boxes (1/16 arc-minute, ~115 m) around the three spots.

Same WCS and coverage as download_wide.py (emodnet__mean, axes Lat and Long, checked against the
current GetCapabilities/DescribeCoverage), but WITHOUT scaleFactor, so we get every cell.
Each box runs 0.22 deg west (~13 km offshore) to 0.05 deg east of the spot, 0.06 deg north and south.
Run: python -I download_spots.py
"""
import urllib.request
from pathlib import Path

OUT = Path(__file__).parent / "data" / "raw" / "spots"
OUT.mkdir(parents=True, exist_ok=True)
SPOTS = {"klitmoller": (57.040, 8.4693), "vorupor": (56.9588, 8.3675), "agger": (56.782, 8.2415)}   # lat, lon
URL = ("https://ows.emodnet-bathymetry.eu/wcs?service=WCS&version=2.0.1&request=GetCoverage"
       "&coverageId=emodnet__mean&format=image/tiff&subset=Lat({a},{b})&subset=Long({c},{d})")
for name, (lat, lon) in SPOTS.items():
    f = OUT / f"emodnet_{name}.tif"
    if not f.exists():
        f.write_bytes(urllib.request.urlopen(URL.format(a=lat - 0.06, b=lat + 0.06, c=lon - 0.22, d=lon + 0.05), timeout=300).read())
    print(f.name, f.stat().st_size // 1024, "KB")
