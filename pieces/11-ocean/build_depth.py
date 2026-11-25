"""Sea depth grid for the swell lines in waves.js: where the sea gets shallow, swell slows down and its crests bend
toward the shallower water (refraction). The wave layer's crest lines need the depth to do that.

Source: GEBCO 2026 grid (15 arc-second), already averaged down to coarser levels by the globe's terrain build
(pieces/07-globe/tiles-build/raw/derived/gebco_L5.f32 = 2700 x 1350 cells, 0.133 degree; gebco_L6.f32 = 1350 x 675,
0.267 degree). Float32 metres, rows from 90 N southward, columns from 180 W eastward, cell centred.
GEBCO terms: free to use with credit ("GEBCO Compilation Group (2026) GEBCO 2026 Grid"); see SOURCES.md.

Output (gzip, uint8, one byte per cell, rows from 90 S northward, columns from 0 E eastward, cell centred, so the
shader can read it at (lon / 360, (lat + 90) / 180) with no offsets):
  data/depth_hi.bin.gz  2700 x 1350 (desktop)
  data/depth_lo.bin.gz  1350 x 675  (phone)
  byte 0 = land (or above sea level); 1..255 = sea, depth d = 600 m x ((byte - 1) / 254)^2, so the shallow shelf, where
  the bending happens, gets most of the 254 steps (1 m steps near 0 m, about 9 m near 600 m). 600 m and deeper = 255:
  swell up to 20 s period does not feel the bottom there.

Run: python3 pieces/11-ocean/build_depth.py   (a few seconds; only needs numpy)
"""
import gzip, os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, '..', '07-globe', 'tiles-build', 'raw', 'derived')
D_MAX = 600.0

for name, src, nlon, nlat in [('hi', 'gebco_L5.f32', 2700, 1350), ('lo', 'gebco_L6.f32', 1350, 675)]:
    z = np.fromfile(os.path.join(SRC, src), dtype='<f4').reshape(nlat, nlon)   # elevation m, + up
    z = z[::-1]                                     # rows from 90 S
    z = np.roll(z, -nlon // 2, axis=1)              # columns from 0 E
    depth = np.clip(-z, 0, D_MAX)
    b = np.where(z >= 0, 0, 1 + np.round(254 * np.sqrt(depth / D_MAX))).astype(np.uint8)
    out = os.path.join(HERE, 'data', f'depth_{name}.bin.gz')
    with open(out, 'wb') as f:
        f.write(gzip.compress(b.tobytes(), 9, mtime=0))
    print(f'{out}: {nlon} x {nlat}, {os.path.getsize(out) / 1e6:.2f} MB gzip, sea {np.mean(b > 0) * 100:.0f} %, shelf (<200 m) {np.mean((b > 0) & (depth < 200)) * 100:.1f} %')
