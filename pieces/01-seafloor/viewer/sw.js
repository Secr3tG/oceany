// Oceany reef viewer service worker: OFF by default. Registered only by opening the viewer with ?offline=1 (offline.js);
// ?offline=0 unregisters it and deletes its caches. Offline covers the five unlocked spots only (Porto Batel, Pipeline,
// Supertubos, Guéthary, Hossegor).
// SCOPE AND NAMES (shared with the globe worker, pieces/07-globe/sw.js):
//  - scopes differ and do not nest: this one is pieces/01-seafloor/viewer/, the globe's is pieces/07-globe/. Neither page
//    controls the other. The globe worker stores its own copy of the three.js files; this one keeps its own.
//  - the globe worker's activate step DELETES every cache named 'oceany-*' that is not its own. So this worker must never
//    use that prefix. All names here start 'reefviewer-'; this worker deletes only 'reefviewer-*' caches.
//  - ?offline=0 here unregisters only the registration whose scope ends '/01-seafloor/viewer/' (the globe's likewise).
// What is kept:
//  - shell, the five spots' data files, their slices (json), swell files, lookup index files, live/<spot>.json snapshots,
//    and the terrain tiles for each spot's surroundings (zoom 12 land, zoom 10 sea, the same tiles surround.js asks for,
//    computed here from each data file's extent with the same maths).
//  - everything else same-origin the viewer fetches (big lookup T*.bin files, 14 MB slice .bin files) is kept the first
//    time it is fetched online, so a spot works offline for the parts that were used.
//  - same-origin: network first (a normal reload is fresh), cached copy when the network is gone; tiles: cache first.
const SHELL = 'reefviewer-shell-3', TILES = 'reefviewer-tiles-3', META = 'reefviewer-meta-1';
// Oceany's own tiles, same rule as terrain-source.js OWN_BASE: Cloudflare R2 when hosted, tiles-build/tiles/ on this Mac.
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const OWN_TILES = IS_LOCAL ? new URL('../../07-globe/tiles-build/tiles/', self.location.href).href
                           : 'https://pub-fd042e4c938f43dfacc412e6f073d5ff.r2.dev/terrain/';
const tileUrl = (z, x, y) => `${OWN_TILES}${z}/${x}/${y}.png`;
const LIVE = ['porto_batel', 'pipeline', 'supertubos', 'guethary', 'hossegor'];
const SHELL_FILES = ['./', './index.html', './style.css?v=z6', './main.js?v=z7', './play.js?v=c5c', './live.js?v=n2', './tutorial.js?v=c3e',
  './offline.js?v=o1', './live_core.js?v=n2', './live_lookup.js?v=l4', './swell_model.js?v=c3', './surround.js?v=s5',
  './vendor/three.module.js', './vendor/three.core.js', './vendor/addons/controls/OrbitControls.js',
  '../../07-globe/terrarium.js?v=1', '../../07-globe/terrain-source.js?v=t2', OWN_TILES + 'coverage.json', './data/slices.json',
  '../../06-live-wave/lookup/index.json', '../../06-live-wave/lookup/shore.json',
  '../../06-live-wave/lookup_pipeline/index.json', '../../06-live-wave/lookup_pipeline/shore.json'];
const LIVE_FILES = LIVE.map(k => `../../../live/${k}.json`);
const SMALL_DATA = ['swell_sim', 'pipeline_swell', 'supertubos_swell', 'guethary_swell', 'hossegor_swell', 'porto_batel_slice', 'porto_batel_slice_s8',
  'porto_batel_funwave', 'pipeline_slice', 'supertubos_slice', 'guethary_slice', 'hossegor_slice', 'porto_batel_slice_v2'].map(n => `./data/${n}.json`);
const MAP_DATA = ['reefs', 'reefs_wide', 'pipeline', 'guethary', 'hossegor'].map(n => `./data/${n}.json`);
const M_PER_DEG = 111195.0, EARTH_C = 40075016.7, RANGE_M = 5000;

self.addEventListener('install', e => { e.waitUntil(precache().then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('reefviewer-') && ![SHELL, TILES, META].includes(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function stamp() { const m = await caches.open(META); await m.put('./saved', new Response(JSON.stringify({ t: Date.now() }), { headers: { 'content-type': 'application/json' } })); }
async function precache() {
  const c = await caches.open(SHELL);
  await Promise.all([...SHELL_FILES, ...LIVE_FILES, ...SMALL_DATA].map(u => c.add(u).catch(() => {})));
  const tiles = new Map();
  for (const u of MAP_DATA) {
    try {
      const res = await fetch(u); if (!res.ok) continue;
      await c.put(u, res.clone());
      const d = await res.json(); tilesFor(d, tiles);
    } catch (err) { /* that spot's map stays online-only */ }
  }
  const tc = await caches.open(TILES);
  await Promise.all([...tiles.values()].map(async u => { if (await tc.match(u)) return; try { const r = await fetch(u, { mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' }); if (r.ok) await tc.put(u, r); } catch (err) { /* later, at runtime */ } }));
  await stamp();
}
// same tile maths as surround.js: z12 tiles over the lidar box plus RANGE_M, z10 parents of those
function tilesFor(d, out) {
  const o = d.meta && d.meta.origin; if (!o || !d.x_m || !d.y_m) return;
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (let i = 0; i < d.x_m.length; i++) { const x = d.x_m[i], z = -d.y_m[i]; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z; }
  const Z = 12, cosO = Math.cos(o.lat * Math.PI / 180), P = 256 * 2 ** Z;
  const latOfZ = z => o.lat + (-z) / M_PER_DEG, lonOfX = x => o.lon + x / (M_PER_DEG * cosO);
  const gx = lon => (lon + 180) / 360 * P;
  const gy = lat => { const la = lat * Math.PI / 180; return (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * P; };
  const px0 = Math.floor(gx(lonOfX(bx0 - RANGE_M))), px1 = Math.ceil(gx(lonOfX(bx1 + RANGE_M)));
  const py0 = Math.floor(gy(latOfZ(bz0 - RANGE_M))), py1 = Math.ceil(gy(latOfZ(bz1 + RANGE_M)));
  for (let ty = Math.floor(py0 / 256); ty <= Math.floor(py1 / 256); ty++)
    for (let tx = Math.floor(px0 / 256); tx <= Math.floor(px1 / 256); tx++) { out.set(`12/${tx}/${ty}`, tileUrl(12, tx, ty)); out.set(`10/${tx >> 2}/${ty >> 2}`, tileUrl(10, tx >> 2, ty >> 2)); }
}

async function tellOffline() { for (const c of await self.clients.matchAll()) c.postMessage({ type: 'reefviewer-offline' }); }
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.href.startsWith(OWN_TILES) && url.pathname.endsWith('.png')) { e.respondWith(tile(req)); return; }
  if (url.origin !== location.origin) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === 'basic') {
      const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy));
      if (req.mode === 'navigate') stamp();
    }
    return res;
  }).catch(async () => {
    const hit = (await caches.match(req)) || (await caches.match(req, { ignoreSearch: true }));
    tellOffline();
    return hit || Response.error();
  }));
});
async function tile(req) {
  const c = await caches.open(TILES);
  const hit = await c.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await c.put(req, res.clone());
  return res;
}
