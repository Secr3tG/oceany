"""Export both bathymetry datasets as small JSON files for the browser viewer.

Run:  python export_points.py
Writes viewer/data/seafloor.json (EMODnet) and viewer/data/seafloor_ddm.json (Danish model).
"""
import json
from pathlib import Path

import numpy as np
import xarray as xr
from scipy import ndimage as ndi

HERE = Path(__file__).parent

# 1. The origin (0, 0) is the shoreline at Klitmoller; the village is a little inland.
ORIGIN_LAT, ORIGIN_LON = 57.040, 8.4693
VILLAGE_LAT, VILLAGE_LON = 57.040, 8.4985
LON_MIN, LON_MAX, LAT_MIN, LAT_MAX = 8.30, 8.60, 56.95, 57.15     # the box

# 2. Flat-earth conversion from degrees to metres.
#    One degree of latitude is about 111,195 m everywhere.
#    One degree of longitude is shorter the further north you go: multiply
#    by cos(latitude). At 57 N that is about 0.54, so ~60,500 m per degree.
#    Fine for an 18 km box; it would be wrong across a continent.
M_PER_DEG = 111195.0
def to_metres(lon, lat):
    return ((lon - ORIGIN_LON) * M_PER_DEG * np.cos(np.radians(ORIGIN_LAT)),   # east
            (lat - ORIGIN_LAT) * M_PER_DEG)                                    # north

# For the 1000 km wide map the flat-earth shortcut is too crude (meridians converge), so that layer
# uses an "azimuthal equidistant" map instead: every point is placed at its true distance and
# compass bearing from Klitmoller. Close to Klitmoller it gives the same numbers as the formula above.
def to_metres_wide(lon, lat):
    la, lo, la0 = np.radians(lat), np.radians(lon - ORIGIN_LON), np.radians(ORIGIN_LAT)
    c = np.arccos(np.clip(np.sin(la0) * np.sin(la) + np.cos(la0) * np.cos(la) * np.cos(lo), -1, 1))  # angle from Klitmoller
    k = np.where(c < 1e-9, 1.0, c / np.maximum(np.sin(c), 1e-12)) * 6371000.0
    return (k * np.cos(la) * np.sin(lo), k * (np.cos(la0) * np.sin(la) - np.sin(la0) * np.cos(la) * np.cos(lo)))

def write(name, lon2d, lat2d, depth, meta, extra=None, project=to_metres, box=(LON_MIN, LON_MAX, LAT_MIN, LAT_MAX), lines=None):
    """Keep the cells that have data and lie inside the box; write compact JSON."""
    x, y = project(lon2d, lat2d)
    inside = (lon2d >= box[0]) & (lon2d <= box[1]) & (lat2d >= box[2]) & (lat2d <= box[3])
    keep = inside & ~np.isnan(depth)
    # A "shore" cell is a sea cell (depth > 0) with a land or empty cell next to it.
    sea = np.nan_to_num(depth, nan=-1) > 0
    near_land = ndi.binary_dilation(~sea, structure=np.array([[0, 1, 0], [1, 1, 1], [0, 1, 0]]))
    shore = sea & near_land
    meta = dict(meta, n_points=int(keep.sum()),
                origin={"lat": ORIGIN_LAT, "lon": ORIGIN_LON, "note": "Klitmoller shoreline, x=y=0"},
                village={"lat": VILLAGE_LAT, "lon": VILLAGE_LON,
                         "x_m": round(float(to_metres(VILLAGE_LON, VILLAGE_LAT)[0]), 1),
                         "y_m": round(float(to_metres(VILLAGE_LON, VILLAGE_LAT)[1]), 1)},
                depth_sign="positive down, land negative where present")
    out = {"meta": meta,
           "x_m": np.round(x[keep], 1).tolist(), "y_m": np.round(y[keep], 1).tolist(),
           "depth_m": np.round(depth[keep], 2).tolist(), "shore": shore[keep].astype(int).tolist()}
    if lines:
        out["lines"] = {b: [np.round(v, 0).tolist() for v in project(np.array(p["lon"]), np.array(p["lat"]))]
                        for b, p in lines.items()}
    for key, arr in (extra or {}).items():
        out[key] = np.nan_to_num(arr[keep], nan=0).astype(int).tolist()
    dest = HERE / "viewer" / "data" / name
    dest.write_text(json.dumps(out, separators=(",", ":")))
    print("wrote", dest.name, dest.stat().st_size // 1024, "KB,", int(keep.sum()), "points")

# 3. EMODnet: a regular lon/lat grid, so build the 2D lon/lat arrays first.
e = xr.open_dataset(HERE / "data" / "seafloor.nc")
lon2d, lat2d = np.meshgrid(e.lon.values, e.lat.values)
write("seafloor.json", lon2d, lat2d, e.depth.values.astype(float), dict(
    layer="EMODnet ~115 m", source="EMODnet Bathymetry DTM (WCS emodnet__mean)", release="DTM 2024",
    datum="LAT", resolution="~115 m N-S x ~63 m E-W",
    reef_note="The Klitmøller reef is not resolved at this resolution.",
    attribution="EMODnet Bathymetry Consortium. Not for navigation."))

# 4. Danish depth model: the file already holds 2D lon/lat, depth, kilde (source) and aar (year).
d = xr.open_dataset(HERE / "data" / "seafloor_ddm.nc")
write("seafloor_ddm.json", d.lon.values, d.lat.values, d.depth.values.astype(float), dict(
    layer="Danish model 50 m", source="Danmarks Dybdemodel v2.0", release="Aug 2024",
    datum="MSL", resolution="50 m",
    reef_note="The Klitmøller reef is still not resolved: nearshore depths there are mostly satellite-derived or interpolated, with a few singlebeam lines from 2008.",
    attribution="Contains data from the Danish Geodata Agency, Denmark's Depth Model, 50 m resolution. Obtained 2026-11-11. Model and data are not suitable for navigation.",
    kilde_codes={"1": "digitised fairsheet", "2": "singlebeam", "3": "multibeam", "4": "airborne lidar",
                 "5": "satellite-derived", "6": "crowdsourced", "7": "historical", "8": "interpolated"}),
    extra={"kilde": d.kilde.values, "aar": d.aar.values})

# 5. Wide North Sea map (EMODnet, 1 arc-minute). Keep every 2nd cell in each direction (~130k points),
#    include land, and add the three profile lines made by profile_wide.py.
w = xr.open_dataset(HERE / "data" / "seafloor_wide.nc").isel(lat=slice(None, None, 2), lon=slice(None, None, 2))
lon2d, lat2d = np.meshgrid(w.lon.values, w.lat.values)
write("seafloor_wide.json", lon2d, lat2d, w.depth.values.astype(float), dict(
    layer="North Sea (zoomed out)", source="EMODnet Bathymetry DTM (WCS emodnet__mean, scaled)", release="DTM 2024",
    datum="LAT", resolution="1 arc-minute (~1-2 km), thinned to every 2nd cell (~2-4 km)",
    reef_note="Land is drawn at most 100 m high. Far too coarse to show any reef.",
    attribution="EMODnet Bathymetry Consortium. Not for navigation."),
    project=to_metres_wide, box=(-6.1, 10.1, 49.9, 63.1),
    # profile_lines.json (270/300/330, from profile_wide.py) plus the swell lines SW 235 and N 315 (from profile_bearings.py)
    lines={**{b: v for b, v in json.loads((HERE / "data" / "profile_lines.json").read_text()).items() if b != "330"},   # 330 dropped: it hits Norway at 124 km, not a swell path
           **json.loads((HERE / "data" / "profile_lines_swell.json").read_text())})
