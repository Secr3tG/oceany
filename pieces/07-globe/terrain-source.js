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
// ?terrain_src=cdn (local testing only): the same bucket through the custom domain tiles.hvid.studio (Cloudflare edge).
const CDN_BASE = 'https://tiles.hvid.studio/terrain/';
const SRC_Q = new URLSearchParams(location.search).get('terrain_src');
const OWN_BASE = (IS_LOCAL && SRC_Q === 'cdn') ? CDN_BASE
  : (!IS_LOCAL || SRC_Q === 'r2') ? R2_BASE : new URL('./tiles-build/tiles/', import.meta.url).href;
const AWS_HOSTS = ['https://s3.amazonaws.com/elevation-tiles-prod', 'https://elevation-tiles-prod.s3.amazonaws.com'];
export const tileUrl = (z, x, y) => USE_AWS ? `${AWS_HOSTS[(x + y) & 1]}/terrarium/${z}/${x}/${y}.png`
                                            : `${OWN_BASE}${z}/${x}/${y}.png`;
// Which tiles exist: z0-z8 everywhere (coverage.json globalMaxZoom), finer only inside the spot boxes listed there.
let cov = null, pngP = null;
const pngCoverage = () => pngP || (pngP = fetch(OWN_BASE + 'coverage.json').then(r => (r.ok ? r.json() : null))
  .then(j => { if (!pack) cov = j; return j; }).catch(() => null));
// Terrain v2 (default on the globe since 2026-11-24 b52; was ?terrain=v2): the terrain2 format (tiles-build/v2, research notes
// terrain2/DESIGN.md): 128 × 128 heights per tile in range-read packs, decoded by tilepack.js, from
// https://tiles.hvid.studio/terrain2/ (bucket CORS allows the Pages origin and http://127.0.0.1:8765 for local tests).
// ?terrain=v1 keeps the old PNG tiles (fallback switch). On this Mac ?terrain_src=local reads tiles-build/v2/out/ (serve it
// with tiles-build/v2/serve.py: Range support). Where the browser cannot decode it (no DecompressionStream deflate-raw), the
// pack source fails to start or its coverage.json does not load, the page uses the PNG tiles above.
// Only the globe (terrain.js) starts the packs, through startPacks(); other pages (the reef viewer's terrarium.js) stay on
// the PNG tiles and their coverage, unchanged.
export const V2_ASKED = !USE_AWS && new URLSearchParams(location.search).get('terrain') !== 'v1';
const V2_BASE = (IS_LOCAL && SRC_Q === 'local') ? new URL('./tiles-build/v2/out/', import.meta.url).href : 'https://tiles.hvid.studio/terrain2/';
let pack = null, packP = null;
// resolves to the pack source once its coverage is in, or null (v1 asked, unsupported, failed): then PNG tiles and their coverage
export function startPacks() {
  if (packP) return packP;
  if (!V2_ASKED) return (packP = (USE_AWS ? Promise.resolve() : pngCoverage()).then(() => null));
  return (packP = import('./tilepack.js?v=p1')
    .then(async m => {
      if (!m.supported) { console.warn('terrain v2: no DecompressionStream deflate-raw here, using the PNG tiles'); return null; }
      const ps = m.createPackSource(V2_BASE, { cacheName: 'oceany-terrain2-v1', maxInflight: 8 });   // 8: ranges are capped at 192 KB now, so more of them run side by side
      const j = await ps.ready;
      if (!j) { console.warn('terrain v2: no coverage.json at ' + V2_BASE + ', using the PNG tiles'); return null; }
      cov = j; pack = ps; return ps;
    })
    .catch(e => { console.warn('terrain v2 unavailable, using the PNG tiles:', e && e.message || e); return null; })
    .then(ps => (ps || pngCoverage().then(() => null))));
}
export const terrainFormat = () => (pack ? 'v2' : 'png');
// For pages that read PNG tiles directly (terrarium.js): resolves once the coverage covered() answers from is in. Lazy (a
// thenable), so the globe does not fetch the PNG coverage.json when it runs on the packs.
export const coverageReady = { then(res, rej) { return (USE_AWS ? Promise.resolve(null) : packP ? packP.then(ps => (ps ? cov : pngCoverage())) : pngCoverage()).then(res, rej); } };
// true once we know where the finer levels are (always true for AWS); until then covered() answers the global levels only
export const coverageKnown = () => USE_AWS || !!cov;
export function covered(z, x, y) {
  if (USE_AWS) return z <= 15;
  if (pack) return pack.covered(z, x, y);          // ?terrain=v2: the packs' own coverage (set together with cov)
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
