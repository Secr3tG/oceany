// Shared loader for the three ocean layers (wind.js, waves.js, swell.js): reads what build_ocean.py and build_ecmwf.py write into data/
// and gives each layer the grids plus the shared wording (model, run, valid time, staleness).
// Plumbing: the layers call loadWind()/loadWaves() the first time they are shown; nothing is fetched before that.
// Hosted pages read the newest build from Cloudflare R2 (../07-globe/data-source.js, layer 'ocean', refreshed after each
// GFS run by the refresh-layers workflow); the files in data/ are the fallback and what localhost uses.
// One build holds one run's forecast hours (+3 h to +13 h, ocean.json `steps`). The layers show the hour nearest the
// viewer's clock and move to the next hour by themselves (STEP_CHECK_MS): a small file from R2, nothing asked of NOAA.
// An ocean.json without steps (older builds) is the single snapshot in wind_gfs.bin / waves_ww3.bin, as before.
// Two models (ocean_model.js switches between them; GFS at load):
//   gfs    NOAA GFS wind + GFS-Wave (WAVEWATCH III), build_ocean.py, hourly steps; published as R2 layer 'ocean'
//   ecmwf  ECMWF IFS wind + ecWAM waves, build_ecmwf.py, 3-hourly steps; published as R2 layer 'ecmwf' (CC BY 4.0)
// Each has its own cache, so switching back is instant. The swell fronts always ask for 'gfs' (ECMWF's open data has no
// swell partitions).
import { layerFile, onLayerUpdate, ageNote } from '../07-globe/data-source.js';

export const MODELS = {
  gfs: { layer: 'ocean', meta: 'ocean.json', wind: 'wind_gfs.bin', waves: 'waves_ww3.bin', label: 'GFS' },
  ecmwf: { layer: 'ecmwf', meta: 'ocean_ecmwf.json', wind: 'wind_ifs.bin', waves: 'waves_ifs.bin', label: 'ECMWF' },
};
const local = (file) => new URL('./data/' + file, import.meta.url);
export const STALE_HOURS = 6;     // the shown hour is further than this from now: say how old it is
const STEP_CHECK_MS = 5 * 60 * 1000;

// ?ocean_model=ecmwf picks ECMWF at load (for testing and links); otherwise GFS.
const asked = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('ocean_model') : null;
let model = MODELS[asked] ? asked : 'gfs';
export const getModel = () => model;
const cache = {};                 // model -> { rawP, windP, waveP, stepKey }
const C = (m) => (cache[m] ||= { rawP: null, windP: null, waveP: null, stepKey: null });
let stepTimer = null;
const ok = (r, what) => { if (!r.ok) throw new Error(what + ' HTTP ' + r.status); return r; };
const get = async (m, file, localUrl) => fetch(await layerFile(MODELS[m].layer, file, localUrl), { cache: 'no-cache' });
// Something new while the page is open (a newer build, the clock reached the next step, or the model was switched):
// tell each ocean layer, which reloads through loadWind()/loadWaves().
const updateSubs = new Set();
let subscribed = false;
const notify = () => updateSubs.forEach((f) => { try { f(); } catch (e) { /* a layer's own problem */ } });
export function onOceanUpdate(cb) {
  updateSubs.add(cb);
  if (!subscribed) {
    subscribed = true;
    for (const m of Object.keys(MODELS)) onLayerUpdate(MODELS[m].layer, () => { cache[m] = null; notify(); });
  }
}
// Switch model for the wind and wave-height layers. Returns true when it changed.
export function setModel(m) {
  if (!MODELS[m] || m === model) return false;
  model = m;
  notify();
  return true;
}
const loadRaw = (m) => C(m).rawP ||= get(m, MODELS[m].meta, local(MODELS[m].meta))
  .then((r) => ok(r, MODELS[m].meta).json()).catch((e) => { C(m).rawP = null; throw e; });
// the step nearest the viewer's clock, or null when the build has no steps
function nearestStep(meta) {
  const steps = Array.isArray(meta.steps) ? meta.steps.filter((s) => s && /^[\w.-]+$/.test(s.wind) && /^[\w.-]+$/.test(s.waves)) : [];
  let best = null;
  for (const s of steps) if (!best || Math.abs(Date.parse(s.valid) - Date.now()) < Math.abs(Date.parse(best.valid) - Date.now())) best = s;
  return best;
}
// the meta as the layers read it: the top-level times and spots replaced by the chosen step's
const view = (m, s) => (!s ? m : { ...m, valid: s.valid, validWaves: s.valid, spots: s.spots || m.spots, step: s,
  wind: { ...m.wind, forecastHour: s.forecastHour, source: s.windSource || m.wind.source },
  waves: { ...m.waves, forecastHour: s.forecastHour, source: s.waveSource || m.waves.source } });
function watchSteps() {
  if (stepTimer) return;
  stepTimer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    for (const m of Object.keys(cache)) {
      const c = cache[m];
      if (!c || !c.rawP) continue;
      c.rawP.then((meta) => {
        const s = nearestStep(meta);
        if (s && s.valid !== c.stepKey) { c.stepKey = s.valid; c.windP = c.waveP = null; notify(); }
      }).catch(() => {});
    }
  }, STEP_CHECK_MS);
}
const withModel = (meta, m) => ({ ...meta, modelId: m, modelLabel: MODELS[m].label });
export function loadMeta(m = model) {
  return loadRaw(m).then((meta) => { const s = nearestStep(meta); if (s) { C(m).stepKey = s.valid; watchSteps(); } return withModel(view(meta, s), m); });
}
// One of the chosen step's files, with its meta; if that file cannot be read, the single snapshot file and the
// top-level meta that describes it.
async function stepFile(m, key) {
  const meta = await loadMeta(m);
  if (meta.step) {
    try { const r = await get(m, meta.step[key], local(meta.step[key])); if (r.ok) return [meta, await r.arrayBuffer()]; }
    catch (e) { /* fall through to the single file */ }
  }
  const single = MODELS[m][key];
  const r = ok(await get(m, single, local(single)), single);
  return [withModel(view(await loadRaw(m), null), m), await r.arrayBuffer()];
}
// Wind: { meta, nLat, nLon, lat0, step, u: Float32Array, v: Float32Array } (m/s, rows from the south, columns from 0 E)
export function loadWind(m = model) {
  const c = C(m);
  return c.windP ||= stepFile(m, 'wind')
    .then(([meta, buf]) => {
      const g = meta.wind.grid, n = g.nLat * g.nLon;
      if (buf.byteLength !== 2 * n) throw new Error('wind file size does not match ' + MODELS[m].meta);
      const raw = new Int8Array(buf), u = new Float32Array(n), v = new Float32Array(n);
      for (let i = 0; i < n; i++) { u[i] = raw[i] * 0.5; v[i] = raw[n + i] * 0.5; }
      return { meta, ...g, u, v };
    }).catch((e) => { c.windP = null; throw e; });
}
// Waves: { meta, nLat, nLon, lat0, step, f: { Thgt, Tper, Tdir, ... } as Float32Array with NaN for no data }
// (GFS: 9 fields incl. the swell partition shgt/sper/sdir; ECMWF: Thgt, Tper, Tdir, mper. The fields list is in the meta.)
export function loadWaves(m = model) {
  const c = C(m);
  return c.waveP ||= stepFile(m, 'waves')
    .then(([meta, buf]) => {
      const w = meta.waves, g = w.grid, n = g.nLat * g.nLon;
      if (buf.byteLength !== w.fields.length * n) throw new Error('wave file size does not match ' + MODELS[m].meta);
      const raw = new Uint8Array(buf), f = {};
      w.fields.forEach((name, k) => {
        const a = new Float32Array(n), s = w.scale[name];
        for (let i = 0; i < n; i++) { const q = raw[k * n + i]; a[i] = q === w.noData ? NaN : q * s; }
        f[name] = a;
      });
      return { meta, ...g, f };
    }).catch((e) => { c.waveP = null; throw e; });
}
// The "Data:" credit line for a layer's details, per model. ECMWF's CC BY 4.0 licence asks for this attribution.
export function dataLine(meta, builder) {
  const when = meta && meta.built ? ` on ${fmt(meta.built)}.` : '.';
  if (meta && meta.modelId === 'ecmwf')
    return `Data: ${meta.attribution || '© European Centre for Medium-Range Weather Forecasts (ECMWF). Source: ECMWF open data, IFS. Licence: CC BY 4.0.'} ` +
      `Steps every 3 hours; the one nearest your clock is shown. Not an official ECMWF product. A snapshot built by build_ecmwf.py${when}`;
  return `Data: NOAA NCEP model output from NOMADS (US Government work, public domain); redrawn here, not an official NOAA product. A snapshot built by ${builder || 'build_ocean.py'}${when}`;
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
