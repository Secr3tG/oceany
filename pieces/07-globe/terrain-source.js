// Where terrain tiles come from (used by terrain.js on the globe and terrarium.js for the reef viewer's surroundings).
// Default: Oceany's own terrarium tiles, same origin: GEBCO_2026 (seabed everywhere, land at z0-z8) and Copernicus DEM
// GLO-90 / GLO-30 (land at z9-z13 near the spots), built by tiles-build/build_tiles.py; credits in tiles-build/SOURCES.md.
// AWS Terrain Tiles stay behind a switch, off by default: add ?terrain_src=aws to the URL (their licence mix is unclear
// for a public app, see research/licences-for-app.md row 2). Nothing else in the public build names AWS.
export const USE_AWS = new URLSearchParams(location.search).get('terrain_src') === 'aws';
// The one place that names the host. Hosted pages read the tiles from Cloudflare R2 (bucket oceany-layers, prefix terrain/);
// on this Mac (localhost) they come from tiles-build/tiles/ unless ?terrain_src=r2 asks for the hosted copy.
const R2_BASE = 'https://pub-fd042e4c938f43dfacc412e6f073d5ff.r2.dev/terrain/';
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const OWN_BASE = (!IS_LOCAL || new URLSearchParams(location.search).get('terrain_src') === 'r2')
  ? R2_BASE : new URL('./tiles-build/tiles/', import.meta.url).href;
const AWS_HOSTS = ['https://s3.amazonaws.com/elevation-tiles-prod', 'https://elevation-tiles-prod.s3.amazonaws.com'];
export const tileUrl = (z, x, y) => USE_AWS ? `${AWS_HOSTS[(x + y) & 1]}/terrarium/${z}/${x}/${y}.png`
                                            : `${OWN_BASE}${z}/${x}/${y}.png`;
// Which tiles exist: z0-z8 everywhere (coverage.json globalMaxZoom), finer only inside the spot boxes listed there.
let cov = null;
export const coverageReady = USE_AWS ? Promise.resolve(null)
  : fetch(OWN_BASE + 'coverage.json').then(r => (r.ok ? r.json() : null)).then(j => (cov = j)).catch(() => null);
// true once we know where the finer levels are (always true for AWS); until then covered() answers the global levels only
export const coverageKnown = () => USE_AWS || !!cov;
export function covered(z, x, y) {
  if (USE_AWS) return z <= 15;
  if (!cov) return z <= 7;                       // before coverage.json arrives (or if it fails): global levels only
  if (z <= cov.globalMaxZoom) return true;
  const rs = cov.rects[z]; if (!rs) return false;
  for (const r of rs) if (x >= r[0] && x <= r[1] && y >= r[2] && y <= r[3]) return true;
  return false;
}
// Source names for the readout. AWS sends them in a header; ours are fixed by zoom (GEBCO to z8, Copernicus on land from z9).
export function tileSources(z, headers) {
  if (USE_AWS) return (headers.get('x-amz-meta-x-imagery-sources') || '').split(',').map(s => s.trim().split('/')[0]).filter(Boolean);
  return z <= 8 ? ['gebco'] : ['copernicus'];   // land only: the seabed (GEBCO at every zoom) has its own readout line
}
// Seabed source of one tile: GEBCO_2026 everywhere, EMODnet DTM 2024 (~115 m) where coverage.json's `seabed` rects list
// the tile (European seas at z9-z10, added 2026-11-23). Used by the readout's seabed line.
export function seabedOf(z, x, y) {
  if (!USE_AWS && cov && cov.seabed) for (const sb of cov.seabed) {
    const rs = sb.rects[z]; if (rs) for (const r of rs) if (x >= r[0] && x <= r[1] && y >= r[2] && y <= r[3]) return sb;
  }
  return SEABED;
}
export const SEABED = USE_AWS ? { name: 'ETOPO1', m: 1852, label: '1.85 km' } : { name: 'GEBCO_2026', m: 463, label: '460 m' };
export const MAX_SOURCE_Z = USE_AWS ? 15 : 13;
