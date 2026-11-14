"""Cut the Klitmoller box out of Danmarks Dybdemodel 50 m and save data/seafloor_ddm.nc.

Reads only a small window of the big whole-Denmark GeoTIFFs. Run with:
    python prepare_ddm.py
"""
from pathlib import Path
import numpy as np
import rasterio
from rasterio.warp import transform as warp_transform
from rasterio.windows import Window
import xarray as xr

HERE = Path(__file__).parent
RAW = HERE / "data" / "raw" / "danmarks dybdemodel 50m 2024"
LON_MIN, LON_MAX, LAT_MIN, LAT_MAX = 8.30, 8.60, 56.95, 57.15

# 1. Work out where the lon/lat box lies in the raster's own coordinates (EPSG:3034, metres).
#    The box is slightly tilted in this projection, so take the outer edge of its 4 corners.
with rasterio.open(RAW / "ddm_50m.dybde.tiff") as src:
    crs = src.crs
    xs, ys = warp_transform("EPSG:4326", crs, [LON_MIN, LON_MAX, LON_MIN, LON_MAX],
                            [LAT_MIN, LAT_MIN, LAT_MAX, LAT_MAX])
    # 2. Turn those map coordinates into a row/column window and read just that window.
    r0, c0 = src.index(min(xs), max(ys))
    r1, c1 = src.index(max(xs), min(ys))
    win = Window(c0, r0, c1 - c0 + 1, r1 - r0 + 1)
    transform = src.window_transform(win)
    depth = src.read(1, window=win).astype("float32")
    nodata = src.nodata

def read_layer(name):                         # kilde and aar are integer layers on the same grid
    with rasterio.open(RAW / f"ddm_50m.{name}.tiff") as s:
        a = s.read(1, window=win).astype("float32")
        a[a == s.nodata] = np.nan             # nodata -> NaN
        return a

# 3. Clean up: nodata (a huge number) becomes NaN, i.e. "no cell here" (land, outside the model).
depth[depth == nodata] = np.nan
kilde, aar = read_layer("kilde"), read_layer("aar")

# 4. Coordinates of the cell centres: x east, y north, in metres (EPSG:3034), plus 2D lat/lon.
x = transform.c + transform.a * (np.arange(win.width) + 0.5)
y = transform.f + transform.e * (np.arange(win.height) + 0.5)      # decreasing (north -> south)
xx, yy = np.meshgrid(x, y)
lon, lat = warp_transform(crs, "EPSG:4326", xx.ravel().tolist(), yy.ravel().tolist())
lon = np.array(lon).reshape(xx.shape); lat = np.array(lat).reshape(xx.shape)

# 5. Save. The model gives depth positive down; land is simply missing (NaN) in the source.
ds = xr.Dataset(
    {"depth": (("y", "x"), depth), "kilde": (("y", "x"), kilde), "aar": (("y", "x"), aar)},
    coords={"x": x, "y": y, "lat": (("y", "x"), lat), "lon": (("y", "x"), lon)})
ds["depth"].attrs = dict(units="m", long_name="water depth, positive down; NaN where no data (land)")
ds["kilde"].attrs = dict(long_name="source of depth",
    codes="1 DIGI fairsheet, 2 SB singlebeam, 3 MB multibeam, 4 ALB airborne lidar, "
          "5 SDB satellite-derived, 6 CSB crowdsourced, 7 Historical, 8 Interpolated")
ds["aar"].attrs = dict(long_name="year data collection ended (not defined for historical/interpolated)")
ds.attrs = dict(
    title="Denmark's Depth Model (DDM) 50 m, cut to the Klitmoller box",
    source="Geodatastyrelsen (Danish Geodata Agency), Denmark's Depth Model, 50 m resolution; downloaded by the user from dataforsyningen.dk",
    version="2.0 (Aug 2024)", resolution="50 m grid", crs="EPSG:3034 (LCC, ETRS89)",
    vertical_datum="MSL, DKMSL(2022), EPSG:10547",
    licence="Free use incl. commercial; not for navigation; attribution required: "
            "'Contains data from the Danish Geodata Agency, Denmark's Depth Model, 50 m resolution', "
            "date obtained (2026-11-11), 'Model and data are not suitable for navigation'")
ds.to_netcdf(HERE / "data" / "seafloor_ddm.nc")
print(ds.depth.shape, "depth range", float(np.nanmin(depth)), float(np.nanmax(depth)), "NaN cells", int(np.isnan(depth).sum()))
