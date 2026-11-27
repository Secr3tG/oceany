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
//  - at install: shell, Porto Batel (the default spot) data, lookup index files, live/<spot>.json snapshots; every other spot's data is kept the first time it is opened.
//  - the terrain for each spot's surroundings (b57: terrain2 packs on tiles.hvid.studio, no longer the v1 PNGs on R2 terrain/):
//    this worker only works out which tiles surround.js asks for (zoom 12 over the lidar box plus RANGE_M, zoom 10 parents,
//    same maths) and stores that list as ./surround-tiles in its META cache; offline.js then loads them through terrarium.js,
//    so tilepack.js keeps them in its own Cache API stores (oceany-terrain2-v1 / oceany-bathy2-v1). The packs are cross-origin
//    Range requests: this worker never touches them.
//  - everything else same-origin the viewer fetches (big lookup T*.bin files, 14 MB slice .bin files) is kept the first
//    time it is fetched online, so a spot works offline for the parts that were used.
//  - same-origin: network first (a normal reload is fresh), cached copy when the network is gone.
const SHELL = 'reefviewer-shell-21', META = 'reefviewer-meta-1';   // 17: packed .bin.gz data, minified three.js, swell worker   // b57: reefviewer-tiles-3 (v1 PNGs) is deleted on activate
const LIVE = ['porto_batel', 'pipeline', 'supertubos', 'guethary', 'hossegor'];
const SHELL_FILES = ['./', './index.html', './style.css?v=z10', './main.js?v=z23', './play.js?v=c5e', './live.js?v=n4', './tutorial.js?v=c3o',
  './offline.js?v=o3', './live_core.js?v=n2', './live_lookup.js?v=l4', './swell_model.js?v=c4', './swell_client.js?v=w2', './swell_worker.js?v=w2',
  './packed.js?v=p1', './surround.js?v=s7',
  './vendor/three.module.min.js', './vendor/three.core.min.js', './vendor/addons/controls/OrbitControls.js',
  '../../07-globe/terrarium.js?v=3', '../../07-globe/tour.js?v=b51', '../../07-globe/terrain-source.js?v=t8', '../../07-globe/tilepack.js?v=p2', './data/slices.json',
  '../../06-live-wave/lookup/index.json', '../../06-live-wave/lookup/shore.json',
  '../../06-live-wave/lookup_pipeline/index.json', '../../06-live-wave/lookup_pipeline/shore.json'];
const LIVE_FILES = LIVE.map(k => `../../../live/${k}.json`);
// Data URLs carry main.js's DATA_VERSION tag (?v=s13), exactly as the viewer asks for them, so the cached copies match.
const DV = '?v=s13';
// Install precaches only the shell and the default spot (Porto Batel, the layer the viewer opens on): about 24 MB for all five spots is too much
// for a phone's first visit and again on every shell bump. Every other spot's files are kept the first time it is opened (fetch handler below).
const SMALL_DATA = [...['swell_sim'].map(n => `./data/${n}.json${DV}`),
  ...['porto_batel_slice', 'porto_batel_slice_s8', 'porto_batel_funwave'].map(n => `./data/${n}.bin.gz${DV}`)];
const MAP_DATA = ['reefs'].map(n => `./data/${n}.bin.gz${DV}`);
const M_PER_DEG = 111195.0, EARTH_C = 40075016.7, RANGE_M = 5000;

self.addEventListener('install', e => { e.waitUntil(precache().then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('reefviewer-') && ![SHELL, META].includes(k)).map(k => caches.delete(k))))
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
      const d = await unpack(res); tilesFor(d, tiles);
    } catch (err) { /* that spot's map stays online-only */ }
  }
  const m = await caches.open(META);
  await m.put('./surround-tiles', new Response(JSON.stringify([...tiles.values()]), { headers: { 'content-type': 'application/json' } }));
  await stamp();
}
// The packed points files (tools/pack_data.py, read in the page by packed.js): only x_m and y_m are needed here.
async function unpack(res) {
  const buf = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(), dv = new DataView(buf);
  const hlen = dv.getUint32(4, true), head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen))), base = (8 + hlen + 7) & ~7;
  const T = { i1: Int8Array, i2: Int16Array, i4: Int32Array, f8: Float64Array };
  const arr = r => { const a = head.arrays[r.$a], raw = new T[a.t](buf, base + a.o, a.n), f = 10 ** a.s; return Float64Array.from(raw, q => q / f); };
  const root = head.root; return { meta: root.meta, x_m: arr(root.x_m), y_m: arr(root.y_m) };
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
    for (let tx = Math.floor(px0 / 256); tx <= Math.floor(px1 / 256); tx++) { out.set(`12/${tx}/${ty}`, [12, tx, ty]); out.set(`10/${tx >> 2}/${ty >> 2}`, [10, tx >> 2, ty >> 2]); }
}

async function tellOffline() { for (const c of await self.clients.matchAll()) c.postMessage({ type: 'reefviewer-offline' }); }
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
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
