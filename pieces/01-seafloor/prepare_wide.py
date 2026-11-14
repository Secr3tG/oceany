"""Stitch the 24 down-scaled EMODnet tiles into data/seafloor_wide.nc.

depth is metres, POSITIVE DOWN (land negative). Run: python prepare_wide.py
"""
import glob
from pathlib import Path
import numpy as np
import rasterio
from rasterio.merge import merge
import xarray as xr

HERE = Path(__file__).parent
# 1. Open all tiles and let rasterio place them side by side (they line up exactly).
tiles = [rasterio.open(f) for f in sorted(glob.glob(str(HERE / "data/raw/wide/tile_*.tif")))]
mosaic, tf = merge(tiles)
elev = mosaic[0].astype("float32")                 # EMODnet: elevation, negative below datum
# 2. Cell-centre coordinates (rows run north -> south).
lon = tf.c + tf.a * (np.arange(elev.shape[1]) + 0.5)
lat = tf.f + tf.e * (np.arange(elev.shape[0]) + 0.5)
# 3. Flip to depth positive down, south -> north, and save.
ds = xr.Dataset({"depth": (("lat", "lon"), -elev)}, coords={"lat": lat, "lon": lon}).sortby("lat")
ds["depth"].attrs = dict(units="m", long_name="depth, positive down (land negative)")
ds.attrs = dict(
    title="North Sea and approaches, coarse sea-floor depth",
    source="EMODnet Bathymetry DTM (WCS emodnet__mean, https://ows.emodnet-bathymetry.eu/wcs), "
           "24 tiles requested with scaleFactor=0.0625",
    release="DTM 2024 (inferred from catalogue)", vertical_datum="LAT",
    resolution="1 arc-minute (~1.85 km N-S, ~1.0 km E-W at 57 N); the server subsamples the 1/16 arc-minute grid (every 16th cell, not an average)",
    licence="EMODnet open data; not for navigation")
ds.to_netcdf(HERE / "data" / "seafloor_wide.nc")
print(dict(ds.sizes), "depth", float(ds.depth.min()), float(ds.depth.max()),
      "lon", float(ds.lon.min()), float(ds.lon.max()), "lat", float(ds.lat.min()), float(ds.lat.max()))
