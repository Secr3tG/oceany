// Where the refreshing data layers come from (wind, waves, swell, snow, hurricanes, tornadoes, earthquake history).
// Same pattern as terrain-source.js. Hosted pages read data/latest.json from Cloudflare R2 (bucket oceany-layers), which
// the refresh-layers GitHub workflow rewrites after every build; it names each layer's run-stamped folder and files.
// On this Mac (localhost) the layers read the files beside their own module (pieces/NN-name/data/) unless ?data_src=r2
// asks for the hosted copy; ?data_src=local does the reverse on a hosted page.
// If latest.json cannot be read (offline, R2 down) or does not list a layer, the files bundled with the page are used.
// While the page is open latest.json is read again every RECHECK_MS (only while the tab is visible); a layer that
// subscribed with onLayerUpdate() is told when its folder changed, and reloads.
// Plumbing: the layer modules use layerFile(), onLayerUpdate() and ageNote(); nothing here draws anything.

const R2_ROOT = 'https://pub-fd042e4c938f43dfacc412e6f073d5ff.r2.dev/';
const LATEST = R2_ROOT + 'data/latest.json';
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const PARAM = new URLSearchParams(location.search).get('data_src');
export const USE_R2 = PARAM === 'r2' || (!IS_LOCAL && PARAM !== 'local');
export const RECHECK_MS = 10 * 60 * 1000;
// a layer's folder must look like data/<layer>/<stamp>/ and its files like plain names: nothing else is followed
const BASE_OK = /^data\/[a-z0-9-]+\/[A-Za-z0-9_-]+\/$/, FILE_OK = /^[A-Za-z0-9_.-]+$/;

let latest = null, latestP = null, lastCheck = 0, timer = null;
const listeners = new Map();                     // layer name -> Set of callbacks

async function fetchLatest() {
  // The ?t= bucket keeps a cache-first service worker (sw.js sends every R2 request to its tile cache) from serving an
  // old copy forever; R2 itself sends latest.json with a short max-age.
  const r = await fetch(LATEST + '?t=' + Math.floor(Date.now() / RECHECK_MS), { cache: 'no-cache' });
  if (!r.ok) throw new Error('latest.json HTTP ' + r.status);
  const j = await r.json();
  if (!j || typeof j.layers !== 'object') throw new Error('latest.json has no layers');
  return j;
}

// The parsed latest.json, or null (local mode, offline, not there yet). Never throws.
export function getLatest() {
  if (!USE_R2) return Promise.resolve(null);
  return latestP ||= fetchLatest().then((j) => { latest = j; lastCheck = Date.now(); return j; })
    .catch(() => { latestP = null; lastCheck = Date.now(); return null; });
}

function entry(j, layer) {
  const L = j && j.layers && j.layers[layer];
  return L && typeof L.base === 'string' && BASE_OK.test(L.base) && Array.isArray(L.files) ? L : null;
}

// URL of one file of a layer: the hosted run-stamped copy when latest.json lists it, else `local` (the bundled file,
// new URL('./data/<file>', import.meta.url) in the layer module).
export async function layerFile(layer, file, local) {
  const L = entry(await getLatest(), layer);
  return L && FILE_OK.test(file) && L.files.includes(file) ? new URL(file, R2_ROOT + L.base) : local;
}

// What latest.json says about a layer ({ dataTime, modelRun, builtAt, ... }), or null when the bundled files are in use.
export const layerInfo = (layer) => entry(latest, layer);

// Call cb(info) whenever the layer's hosted folder changes while the page is open. Returns an unsubscribe function.
export function onLayerUpdate(layer, cb) {
  if (!USE_R2) return () => {};
  if (!listeners.has(layer)) listeners.set(layer, new Set());
  listeners.get(layer).add(cb);
  if (!timer) {
    timer = setInterval(check, RECHECK_MS);
    document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastCheck > RECHECK_MS) check(); });
  }
  return () => listeners.get(layer).delete(cb);
}

async function check() {
  if (document.hidden) return;
  lastCheck = Date.now();
  let j;
  try { j = await fetchLatest(); } catch (e) { return; }      // keep what is drawn; try again next time
  const old = latest; latest = j; latestP = Promise.resolve(j);
  for (const [layer, cbs] of listeners) {
    const a = entry(old, layer), b = entry(j, layer);
    if (b && (!a || a.base !== b.base)) cbs.forEach((cb) => { try { cb(b); } catch (e) { /* a layer's own problem */ } });
  }
}

// A calm age line for a layer's status: '' while the data is younger than `staleHours`, else " Data is N h old." or
// " Data is N days old.". `iso` is the data's own time (model valid time, analysis day, last record).
export function ageNote(iso, staleHours) {
  const h = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (!(h > staleHours)) return '';
  return h < 48 ? ` Data is ${Math.round(h)} h old.` : ` Data is ${Math.round(h / 24)} days old.`;
}
