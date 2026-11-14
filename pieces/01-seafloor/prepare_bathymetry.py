"""Turn the raw EMODnet WCS GeoTIFF into data/seafloor.nc.

depth is metres, POSITIVE DOWN (sea ~ +, land ~ -). Vertical datum: LAT.
"""
from pathlib import Path
import numpy as np
import rasterio
import xarray as xr

HERE = Path(__file__).parent
raw = HERE / "data" / "raw" / "emodnet__mean.tif"
out = HERE / "data" / "seafloor.nc"

with rasterio.open(raw) as src:
    elev = src.read(1).astype("float32")        # EMODnet: metres, negative below datum
    lon = np.array([src.xy(0, c)[0] for c in range(src.width)])
    lat = np.array([src.xy(r, 0)[1] for r in range(src.height)])  # north -> south

depth = -elev                                    # positive down
ds = xr.Dataset({"depth": (("lat", "lon"), depth)}, coords={"lat": lat, "lon": lon})
ds = ds.sortby("lat")                            # south -> north, ascending
ds["depth"].attrs = dict(units="m", long_name="water depth, positive down (land is negative)",
                         positive="down")
ds.attrs = dict(
    title="Sea-floor depth around Klitmoller, Denmark",
    source="EMODnet Bathymetry DTM, WCS coverage emodnet__mean (https://ows.emodnet-bathymetry.eu/wcs)",
    release="EMODnet DTM 2024 (metadata record dated 2024-12-31; WCS coverage 'emodnet__mean' is the current release - release year taken from catalogue, not from the service)",
    vertical_datum="LAT (Lowest Astronomical Tide)",
    horizontal_crs="EPSG:4326",
    resolution="1/16 arc-minute (~0.001042 deg; ~115 m N-S, ~65 m E-W at 57N)",
    licence="EMODnet open data, free of charge, no registration (WCS reports Fees=NONE, AccessConstraints=NONE); cite EMODnet Bathymetry Consortium",
    not_for_navigation="yes",
)
ds.to_netcdf(out)
print(ds, "\nsaved", out)
