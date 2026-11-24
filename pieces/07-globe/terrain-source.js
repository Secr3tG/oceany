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
// The globe (terrain.js) starts the packs through startPacks(); since b57 (2026-11-25) the reef viewer's surroundings
// (terrarium.js) read the same packs through startPacks({ packsOnly: true }): same Cache API stores, so a visitor coming from
// the globe already holds most tiles. packsOnly never falls back to the PNG tiles (no request to terrain/ from the viewer;
// ?terrain=v1 does not apply there): where the packs cannot be read the viewer simply draws no surroundings.
export const V2_ASKED = !USE_AWS && new URLSearchParams(location.search).get('terrain') !== 'v1';
const V2_BASE = (IS_LOCAL && SRC_Q === 'local') ? new URL('./tiles-build/v2/out/', import.meta.url).href : 'https://tiles.hvid.studio/terrain2/';
let pack = null, packP = null, b2 = null, b2Wait = null;
// bathy2 (b55, 2026-11-24): a sparse overlay of survey sea floor in the same pack format, https://tiles.hvid.studio/bathy2/
// (built by tiles-build/bathy2/build_bathy.py; rules in tiles-build/bathy2/PLAN.md). A tile its coverage.json lists replaces
// terrain2's tile at the same z/x/y: same land, survey sea floor (EMODnet DTM 2024 ~115 m to z11 in European seas, NOAA CUDEM
// ~10 m to z13 for Hawaii and Sonoma-Big Sur). No tile is built finer than its survey cell, so nothing here draws more detail
// than was measured. Its coverage.json (~10 KB gzipped) is the index: no bathy2 pack is asked for outside its rects, and a
// tile it lists but cannot deliver falls back to terrain2. ?bathy=0 turns it off (test switch).
const B2_ASKED = new URLSearchParams(location.search).get('bathy') !== '0';
const B2_BASE = 'https://tiles.hvid.studio/bathy2/';
const B2_WAIT_MS = 2500;          // first visit: how long a z9+ tile waits for bathy2's index before going to terrain2 (base levels never wait)
const b2Has = (z, x, y) => !!(b2 && b2.coverage && z >= 9 && b2.covered(z, x, y));
function overlay(t2, ov) {
  const pick = (z, x, y) => (b2Has(z, x, y) ? ov : t2);
  const settle = (z) => (z >= 9 && b2Wait ? b2Wait : null);   // until bathy2's index is in (or its wait ran out)
  return Object.assign({}, t2, {
    covered: (z, x, y) => t2.covered(z, x, y) || b2Has(z, x, y),
    async getTile(z, x, y, o) {
      const w = settle(z); if (w) await w;
      if (!b2Has(z, x, y)) return t2.getTile(z, x, y, o);
      let t = null;
      try { t = await ov.getTile(z, x, y, o); } catch (e) { if (e && e.name === 'AbortError') throw e; }
      return t || t2.getTile(z, x, y, o);       // listed but absent or failed: terrain2's tile (no hole)
    },
    async prefetch(z, x, y, o) { const w = settle(z); if (w) await w; return pick(z, x, y).prefetch(z, x, y, o); },
    dropTile: (z, x, y) => pick(z, x, y).dropTile(z, x, y),
    inCache: (z, x, y) => pick(z, x, y).inCache(z, x, y),
    stats() { const a = t2.stats(), b = ov.stats(); return Object.assign({}, a, { requests: a.requests + b.requests, bytes: a.bytes + b.bytes, bathy2: b }); },
    get coverage() { return t2.coverage; },
  });
}
// resolves to the pack source once its coverage is in, or null (v1 asked, unsupported, failed): then PNG tiles and their coverage
export function startPacks({ packsOnly = false } = {}) {
  if (packP) return packP;
  if (packsOnly && USE_AWS) return (packP = Promise.resolve(null));
  if (!V2_ASKED && !packsOnly) return (packP = (USE_AWS ? Promise.resolve() : pngCoverage()).then(() => null));
  return (packP = import('./tilepack.js?v=p2')
    .then(async m => {
      if (!m.supported) { console.warn('terrain v2: no DecompressionStream deflate-raw here, using the PNG tiles'); return null; }
      const ps = m.createPackSource(V2_BASE, { cacheName: 'oceany-terrain2-v1', maxInflight: 8 });   // 8: ranges are capped at 192 KB now, so more of them run side by side
      // bathy2 starts at the same time (its index comes from the Cache API on a repeat visit); its own cache, smaller cap
      const ob = (B2_ASKED && !(IS_LOCAL && SRC_Q === 'local')) ? m.createPackSource(B2_BASE, { cacheName: 'oceany-bathy2-v1', maxInflight: 6, cacheMaxBytes: 60e6 }) : null;
      const bReady = ob ? ob.ready.then(j => (j && j.overlay ? j : null)).catch(() => null) : Promise.resolve(null);
      const j = await ps.ready;
      if (!j) { console.warn('terrain v2: no coverage.json at ' + V2_BASE + ', using the PNG tiles'); return null; }
      cov = j; pack = ps;
      if (!ob) return ps;
      // The overlay starts at once; only z9+ tiles (where bathy2 can have data) wait for its index, at most B2_WAIT_MS, so
      // the base levels never queue behind a slow coverage.json. After the wait the index joins whenever it arrives.
      b2 = ob;
      b2Wait = Promise.race([bReady, new Promise(r => setTimeout(r, B2_WAIT_MS))]).then(() => { b2Wait = null; });
      bReady.then(v => { if (!v) b2 = null; });                          // no bathy2 (failed, not an overlay): terrain2 alone
      return (pack = overlay(ps, ob));
    })
    .catch(e => { console.warn('terrain v2 unavailable, using the PNG tiles:', e && e.message || e); return null; })
    .then(ps => (ps || (packsOnly ? null : pngCoverage().then(() => null)))));
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
  if (b2Has(z, x, y) && b2.coverage.seabed) for (const sb of b2.coverage.seabed) {   // bathy2's surveys first (b55)
    const rs = sb.rects[z]; if (rs) for (const r of rs) if (x >= r[0] && x <= r[1] && y >= r[2] && y <= r[3]) return sb;
  }
  if (!USE_AWS && cov && cov.seabed) for (const sb of cov.seabed) {
    const rs = sb.rects[z]; if (rs) for (const r of rs) if (x >= r[0] && x <= r[1] && y >= r[2] && y <= r[3]) return sb;
  }
  return SEABED;
}
export const SEABED = USE_AWS ? { name: 'ETOPO1', m: 1852, label: '1.85 km' } : { name: 'GEBCO_2026', m: 463, label: '460 m' };
export const MAX_SOURCE_Z = USE_AWS ? 15 : 13;
