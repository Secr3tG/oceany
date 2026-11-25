// One terrain tile as a 256 x 256 height grid, without the globe's renderer code, so pages outside the globe can use it.
// Used by the seafloor viewer's surroundings (pieces/01-seafloor/viewer/surround.js).
//   fetchTerrarium(z, x, y) -> { elev: Float32Array(256 × 256) metres, row-major, north row first; sources: [land source names];
//                                seabed: [4 seabed entries { name, m, label }, quadrants NW, NE, SW, SE] }
// b57 (2026-11-25): read from the terrain2 packs (terrain-source.js startPacks, the globe's own source: terrain2 with the
// bathy2 survey overlay, Cache API stores oceany-terrain2-v1 / oceany-bathy2-v1), no longer from the v1 PNG tiles on R2
// terrain/. A terrain2 dot at zoom z+1 covers the same ground as one v1 PNG pixel at zoom z (both ~30 m at z12), so the
// four children of z/x/y (128 x 128 dots each) are stitched into the same 256 x 256 grid; no resampling, no averaging.
// A child that is absent leaves its quadrant NaN (the caller skips non-finite values). Throws when the packs cannot be read
// or no child exists (the caller treats a throw as a missing tile).
// ?terrain_src=aws (test switch) keeps the AWS Terrain Tiles PNG path: elevation = R × 256 + G + B / 256 − 32768 m.
import { tileUrl, tileSources, seabedOf, startPacks, USE_AWS } from './terrain-source.js?v=t8';
export async function fetchTerrarium(z, x, y) {
  if (USE_AWS) return fetchPng(z, x, y);
  const ps = await startPacks({ packsOnly: true });
  if (!ps) throw new Error('terrain packs not available');
  const Z = z + 1, elev = new Float32Array(256 * 256).fill(NaN), seabed = [];
  const kids = await Promise.all([0, 1, 2, 3].map(q => ps.getTile(Z, 2 * x + (q & 1), 2 * y + (q >> 1)).catch(() => null)));
  if (!kids.some(Boolean)) throw new Error('no terrain tile');
  kids.forEach((t, q) => {
    const cx = 2 * x + (q & 1), cy = 2 * y + (q >> 1);
    seabed.push(seabedOf(Z, cx, cy));
    if (!t) return;
    const ox = (q & 1) * 128, oy = (q >> 1) * 128;
    for (let j = 0; j < 128; j++) elev.set(t.elev.subarray(j * 128, j * 128 + 128), (oy + j) * 256 + ox);
  });
  return { elev, sources: tileSources(Z, null), seabed };
}
async function fetchPng(z, x, y) {
  const r = await fetch(tileUrl(z, x, y), { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const sources = tileSources(z, r.headers);
  const bmp = await createImageBitmap(await r.blob());
  const cv = new OffscreenCanvas(256, 256), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0); bmp.close();
  const px = cx.getImageData(0, 0, 256, 256).data, elev = new Float32Array(256 * 256);
  for (let k = 0; k < elev.length; k++) elev[k] = px[4 * k] * 256 + px[4 * k + 1] + px[4 * k + 2] / 256 - 32768;
  const sb = seabedOf(z, x, y);
  return { elev, sources, seabed: [sb, sb, sb, sb] };
}
