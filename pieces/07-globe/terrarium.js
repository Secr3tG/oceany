// One raw terrarium tile, decoded, without the globe's renderer code, so pages outside the globe can use it.
// Source: terrain-source.js (Oceany's own tiles, GEBCO_2026 + Copernicus DEM, same origin; AWS only with ?terrain_src=aws).
// Used by the seafloor viewer's surroundings (pieces/01-seafloor/viewer/surround.js).
//   fetchTerrarium(z, x, y) -> { elev: Float32Array(256 × 256) metres, row-major, north row first; sources: [names] }
// elevation = R × 256 + G + B / 256 − 32768 m; no averaging. Throws on a network or HTTP error, and for a tile outside
// the built coverage (the caller treats a throw as a missing tile).
import { tileUrl, covered, tileSources, coverageReady } from './terrain-source.js?v=t2';
export const TILE_URL = tileUrl;
export async function fetchTerrarium(z, x, y) {
  await coverageReady;                                           // covered() knows the spot boxes only once coverage.json is in
  if (!covered(z, x, y)) throw new Error('outside coverage');
  const r = await fetch(tileUrl(z, x, y), { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const sources = tileSources(z, r.headers);
  const bmp = await createImageBitmap(await r.blob());
  const cv = new OffscreenCanvas(256, 256), cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(bmp, 0, 0); bmp.close();
  const px = cx.getImageData(0, 0, 256, 256).data, elev = new Float32Array(256 * 256);
  for (let k = 0; k < elev.length; k++) elev[k] = px[4 * k] * 256 + px[4 * k + 1] + px[4 * k + 2] / 256 - 32768;
  return { elev, sources };
}
