// Shared loader for the three ocean layers (wind.js, waves.js, swell.js): reads what build_ocean.py writes into data/
// and gives each layer the grids plus the shared wording (model, run, valid time, staleness).
// Plumbing: the layers call loadWind()/loadWaves() the first time they are shown; nothing is fetched before that.
// Hosted pages read the newest build from Cloudflare R2 (../07-globe/data-source.js, layer 'ocean', refreshed after each
// GFS run by the refresh-layers workflow); the files in data/ are the fallback and what localhost uses.
// One build holds one run's forecast hours (+3 h to +13 h, ocean.json `steps`). The layers show the hour nearest the
// viewer's clock and move to the next hour by themselves (STEP_CHECK_MS): a small file from R2, nothing asked of NOAA.
// An ocean.json without steps (older builds) is the single snapshot in wind_gfs.bin / waves_ww3.bin, as before.
import { layerFile, onLayerUpdate, ageNote } from '../07-globe/data-source.js';

const META_URL = new URL('./data/ocean.json', import.meta.url);
const WIND_URL = new URL('./data/wind_gfs.bin', import.meta.url);
const WAVE_URL = new URL('./data/waves_ww3.bin', import.meta.url);
export const STALE_HOURS = 6;     // the shown hour is further than this from now: say how old it is
const STEP_CHECK_MS = 5 * 60 * 1000;

let rawP = null, windP = null, waveP = null, stepKey = null, stepTimer = null;
const ok = (r, what) => { if (!r.ok) throw new Error(what + ' HTTP ' + r.status); return r; };
const get = async (file, local) => fetch(await layerFile('ocean', file, local), { cache: 'no-cache' });
// Something new while the page is open (a newer build, or the clock reached the next hour): tell each ocean layer.
const updateSubs = new Set();
let subscribed = false;
export function onOceanUpdate(cb) {
  updateSubs.add(cb);
  if (!subscribed) {
    subscribed = true;
    onLayerUpdate('ocean', () => { rawP = windP = waveP = null; updateSubs.forEach((f) => f()); });
  }
}
const loadRaw = () => rawP ||= get('ocean.json', META_URL).then((r) => ok(r, 'ocean.json').json()).catch((e) => { rawP = null; throw e; });
// the step nearest the viewer's clock, or null when the build has no steps
function nearestStep(m) {
  const steps = Array.isArray(m.steps) ? m.steps.filter((s) => s && /^[\w.-]+$/.test(s.wind) && /^[\w.-]+$/.test(s.waves)) : [];
  let best = null;
  for (const s of steps) if (!best || Math.abs(Date.parse(s.valid) - Date.now()) < Math.abs(Date.parse(best.valid) - Date.now())) best = s;
  return best;
}
// ocean.json as the layers read it: the top-level times and spots replaced by the chosen step's
const view = (m, s) => (!s ? m : { ...m, valid: s.valid, validWaves: s.valid, spots: s.spots || m.spots, step: s,
  wind: { ...m.wind, forecastHour: s.forecastHour, source: s.windSource || m.wind.source },
  waves: { ...m.waves, forecastHour: s.forecastHour, source: s.waveSource || m.waves.source } });
function watchSteps() {
  if (stepTimer) return;
  stepTimer = setInterval(() => {
    if (!rawP || typeof document !== 'undefined' && document.hidden) return;
    rawP.then((m) => {
      const s = nearestStep(m);
      if (s && s.valid !== stepKey) { stepKey = s.valid; windP = waveP = null; updateSubs.forEach((f) => f()); }
    }).catch(() => {});
  }, STEP_CHECK_MS);
}
export function loadMeta() {
  return loadRaw().then((m) => { const s = nearestStep(m); if (s) { stepKey = s.valid; watchSteps(); } return view(m, s); });
}
// One of the chosen step's files, with its meta; if that file cannot be read, the single snapshot file and the
// top-level meta that describes it.
async function stepFile(key, single, singleUrl) {
  const meta = await loadMeta();
  if (meta.step) {
    try { const r = await get(meta.step[key], new URL('./data/' + meta.step[key], import.meta.url)); if (r.ok) return [meta, await r.arrayBuffer()]; }
    catch (e) { /* fall through to the single file */ }
  }
  const r = ok(await get(single, singleUrl), single);
  return [view(await loadRaw(), null), await r.arrayBuffer()];
}
// Wind: { meta, nLat, nLon, lat0, step, u: Float32Array, v: Float32Array } (m/s, rows from the south, columns from 0 E)
export function loadWind() {
  return windP ||= stepFile('wind', 'wind_gfs.bin', WIND_URL)
    .then(([meta, buf]) => {
      const g = meta.wind.grid, n = g.nLat * g.nLon;
      if (buf.byteLength !== 2 * n) throw new Error('wind file size does not match ocean.json');
      const raw = new Int8Array(buf), u = new Float32Array(n), v = new Float32Array(n);
      for (let i = 0; i < n; i++) { u[i] = raw[i] * 0.5; v[i] = raw[n + i] * 0.5; }
      return { meta, ...g, u, v };
    }).catch((e) => { windP = null; throw e; });
}
// Waves: { meta, nLat, nLon, lat0, step, f: { Thgt, Tper, Tdir, shgt, ... } as Float32Array with NaN for no data }
export function loadWaves() {
  return waveP ||= stepFile('waves', 'waves_ww3.bin', WAVE_URL)
    .then(([meta, buf]) => {
      const w = meta.waves, g = w.grid, n = g.nLat * g.nLon;
      if (buf.byteLength !== w.fields.length * n) throw new Error('wave file size does not match ocean.json');
      const raw = new Uint8Array(buf), f = {};
      w.fields.forEach((name, k) => {
        const a = new Float32Array(n), s = w.scale[name];
        for (let i = 0; i < n; i++) { const q = raw[k * n + i]; a[i] = q === w.noData ? NaN : q * s; }
        f[name] = a;
      });
      return { meta, ...g, f };
    }).catch((e) => { waveP = null; throw e; });
}

const fmt = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.getUTCDate() + ' ' + d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }) + ' ' + String(d.getUTCHours()).padStart(2, '0') + ':00 UTC';
};
export const fmtTime = fmt;
export const fmtRun = (s) => { const d = new Date(String(s).replace(' UTC', '').replace(' ', 'T') + ':00:00Z'); return isNaN(d) ? s : fmt(d.toISOString()); };
// hours between the snapshot's valid time and now (positive: the snapshot is in the past)
export const ageHours = (iso) => (Date.now() - new Date(iso).getTime()) / 36e5;
export const staleNote = (iso) => {
  const h = ageHours(iso);
  return h < -STALE_HOURS ? ` Valid ${Math.round(-h)} h from now.` : ageNote(iso, STALE_HOURS);
};
export const SAFETY = 'Not an official product. Do not use for safety decisions.';
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];

// Palette ramp shared by the layers: deep -> mid -> shallow -> near white, read from the globe's palette (which the globe
// overwrites in place on a palette switch, so this is read again in setPalette).
export function rampColours(THREE, pal, out) {
  const p = pal || { deep: [0.03, 0.08, 0.45], mid: [0.1, 0.5, 0.95], shallow: [0.35, 1, 0.95] };
  const white = p.shallow.map((v) => v + (1 - v) * 0.7);
  const cols = [p.deep.map((v, i) => v * 0.6 + p.mid[i] * 0.4), p.mid, p.shallow, white];
  cols.forEach((c, i) => { out[i] ||= new THREE.Color(); out[i].setRGB(c[0], c[1], c[2]); });
  return out;
}
// GLSL: colour along that 4-stop ramp for x in 0..1
export const RAMP_GLSL = /* glsl */`
  uniform vec3 uC0, uC1, uC2, uC3;
  vec3 ramp(float x) {
    x = clamp(x, 0.0, 1.0) * 3.0;
    return x < 1.0 ? mix(uC0, uC1, x) : x < 2.0 ? mix(uC1, uC2, x - 1.0) : mix(uC2, uC3, x - 2.0);
  }`;
// GLSL: fade toward the limb, the globe's land rule (dots.js GRAZE_FADE): dots seen edge-on pile up as 1/cos(incidence)
// and, with additive blending, summed to a bright white (wind) or cyan (waves, swell) ring at the globe's edge at
// whole-globe zoom (round 3 #4). Fade by cos(incidence) from 0.6 down, no floor; dots on the far side are dropped (they
// peeked over the occluder just past the limb, lifted above the surface). p: the dot's position (globe centred at 0).
export const LIMB_GLSL = /* glsl */`
  float limbFade(vec3 p, vec4 mv) {
    float c = dot(normalize(-mv.xyz), normalize(normalMatrix * normalize(p)));
    return c <= 0.0 ? 0.0 : clamp(c / 0.6, 0.0, 1.0);
  }`;
