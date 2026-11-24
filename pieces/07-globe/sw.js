// Oceany globe service worker: OFF by default. Registered only by opening the globe with ?offline=1 (globe.js);
// ?offline=0 unregisters it and clears its caches.
// - Same-origin files (the page, scripts, three.js, dot files, layer modules and their data): network first, so a
//   normal reload always gets fresh code and data; the copy is kept and used when the network is gone.
//   Offline, a URL is also matched without its ?v= tag (globe.js adds a Last-Modified tag it cannot read offline).
// - Terrain tiles (our own, same origin under tiles-build/tiles/; AWS Terrain Tiles only with ?terrain_src=aws): cache first,
//   at most TILE_MAX kept (oldest dropped). coverage.json goes through the normal same-origin path (network first).
// Scope is this folder: the spot viewers (pieces/01-seafloor/viewer/) are other pages and are NOT made offline by this.
// Tile host, same rule as terrain-source.js: Cloudflare R2 when hosted, tiles-build/tiles/ on this Mac.
const R2_HOST = 'pub-fd042e4c938f43dfacc412e6f073d5ff.r2.dev';
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const TILE_BASE = IS_LOCAL ? './tiles-build/tiles/' : `https://${R2_HOST}/terrain/`;
const SHELL = 'oceany-shell-b57', TILES = 'oceany-tiles-1', TILE_MAX = 600;
const PRECACHE = ['./', './index.html', './globe.js?v=b57', './tour.js?v=b51', './dots.js?v=b43', './terrain.js?v=b57', './terrarium.js?v=2', './terrain-source.js?v=t7', './tilepack.js?v=p2', './terrain-worker.js?v=w1', './data-source.js', TILE_BASE + 'coverage.json',
  './layers.json', './regions.json', './manifest.webmanifest', './assets/earth_dots.json', './assets/earth_dots.bin',
  './assets/stars.bin', './assets/icons/icon-192.png', './assets/icons/icon-512.png',
  '../01-seafloor/viewer/vendor/three.module.js', '../01-seafloor/viewer/vendor/three.core.js'];
const TILE_HOSTS = ['s3.amazonaws.com', 'elevation-tiles-prod.s3.amazonaws.com', R2_HOST];   // R2: tiles and coverage.json, cache first
// Terrain v2 packs (https://tiles.hvid.studio/terrain2/, b52) are cross-origin and not in TILE_HOSTS, so this worker never
// touches them: their Range (206) answers must not be stored cache-first; tilepack.js keeps its own Cache API copy.
const OWN_TILE = /\/tiles-build\/tiles\/\d+\/\d+\/\d+\.png$/;

// b38: the layer modules are cached at install too, under the versioned URL the page imports offline (module?v=<ent.v>,
// see globe.js loadOne), plus the bare URL and each module's own relative imports (e.g. dots_common.js, ocean_data.js).
// Before, a first visit with ?offline=1 never cached them (the SW took control after they had loaded).
async function layerUrls() {
  const out = new Set();
  try {
    const ents = await (await fetch('./layers.json', { cache: 'no-cache' })).json();
    const base = new URL('./layers.json', self.registration.scope);
    await Promise.all(ents.filter(e => e && e.module).map(async e => {
      const u = new URL(e.module, base).href;
      out.add(u); if (e.v) out.add(u + '?v=' + encodeURIComponent(e.v));
      try {
        const txt = await (await fetch(u, { cache: 'no-cache' })).text();
        for (const m of txt.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+\.js)['"]/g)) out.add(new URL(m[1], u).href);
      } catch (err) { /* module not reachable: skipped */ }
    }));
  } catch (err) { /* no layers.json */ }
  return [...out];
}
self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(async c => {
    const all = PRECACHE.concat(await layerUrls());
    await Promise.all(all.map(u => c.add(u).catch(() => {})));
  }).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  // b55: tilepack.js's own caches (oceany-terrain2-*, oceany-bathy2-*: pack tiles keyed by their coverage.json version, trimmed by
  // tilepack) outlive a release; until b54 every new shell wiped them, so each release re-downloaded the 6.7 MB world base.
  const KEEP = k => k === SHELL || k === TILES || /^oceany-(terrain2|bathy2)-/.test(k);
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('oceany-') && !KEEP(k)).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// b38: network state. A failed network fetch marks the network down for NET_HOLD ms; meanwhile same-origin GETs are served
// cache first (no doomed network try per layer script) and same-origin HEADs (globe.js asks a layer module's
// Last-Modified) get an empty 204, so the page falls back to the module's own tag (the URL that was precached) quietly. Pages are told by message
// ({ type: 'oceany-net', offline }) so globe.js can show its offline cue even when navigator.onLine stays true.
// Navigations always try the network, so a reload re-tests it; any success clears the mark.
const NET_HOLD = 20000;
let downUntil = 0, downSent = false, lastDown = false;   // lastDown: the last network try failed (no time limit)
const isDown = () => Date.now() < downUntil;
async function tell(offline) {
  if (downSent === offline) return;
  downSent = offline;
  for (const c of await self.clients.matchAll({ includeUncontrolled: true, type: 'window' })) c.postMessage({ type: 'oceany-net', offline });
}
function netDown() { downUntil = Date.now() + NET_HOLD; lastDown = true; tell(true); }
function netUp() { downUntil = 0; lastDown = false; tell(false); }
self.addEventListener('message', e => {
  if (e.data && e.data.type === 'oceany-net?' && e.source) e.source.postMessage({ type: 'oceany-net', offline: lastDown });
});
const fromCache = async req => (await caches.match(req)) || (await caches.match(req, { ignoreSearch: true }));
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method === 'HEAD' && url.origin === location.origin && isDown()) { e.respondWith(new Response(null, { status: 204 })); return; }
  if (req.method !== 'GET') return;
  if (url.hostname === R2_HOST && url.pathname.startsWith('/data/')) return;   // b56: refreshed layer data and latest.json: never cache first
  if (TILE_HOSTS.includes(url.hostname) || (url.origin === location.origin && OWN_TILE.test(url.pathname))) { e.respondWith(tile(req)); return; }
  if (url.origin !== location.origin) return;
  e.respondWith((async () => {
    if (isDown() && req.mode !== 'navigate') { const hit = await fromCache(req); if (hit) return hit; }
    try {
      const res = await fetch(req);
      netUp();
      if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(SHELL).then(c => c.put(req, copy)); }
      return res;
    } catch (err) {
      netDown();
      return (await fromCache(req)) || Response.error();
    }
  })());
});
async function tile(req) {
  const c = await caches.open(TILES);
  const hit = await c.match(req);
  if (hit) return hit;
  let res;
  try { res = await fetch(req); netUp(); } catch (err) { netDown(); return Response.error(); }
  if (res.ok || res.type === 'opaque') {
    await c.put(req, res.clone());
    const keys = await c.keys();
    for (let i = 0; i < keys.length - TILE_MAX; i++) await c.delete(keys[i]);
  }
  return res;
}
