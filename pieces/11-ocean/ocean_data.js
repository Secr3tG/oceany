// Shared loader for the three ocean layers (wind.js, waves.js, swell.js): reads the snapshot that build_ocean.py writes
// into data/ once, and gives each layer the grids plus the shared wording (model, run, valid time, staleness).
// Plumbing: the layers call loadOcean() the first time they are shown; nothing is fetched before that.

const META_URL = new URL('./data/ocean.json', import.meta.url);
const WIND_URL = new URL('./data/wind_gfs.bin', import.meta.url);
const WAVE_URL = new URL('./data/waves_ww3.bin', import.meta.url);
export const STALE_HOURS = 6;     // the snapshot shows one moment; further than this from now, say it is stale

let metaP = null, windP = null, waveP = null;
const ok = (r, what) => { if (!r.ok) throw new Error(what + ' HTTP ' + r.status); return r; };
export function loadMeta() {
  return metaP ||= fetch(META_URL, { cache: 'no-cache' }).then((r) => ok(r, 'ocean.json').json()).catch((e) => { metaP = null; throw e; });
}
// Wind: { meta, nLat, nLon, lat0, step, u: Float32Array, v: Float32Array } (m/s, rows from the south, columns from 0 E)
export function loadWind() {
  return windP ||= Promise.all([loadMeta(), fetch(WIND_URL, { cache: 'no-cache' }).then((r) => ok(r, 'wind_gfs.bin').arrayBuffer())])
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
  return waveP ||= Promise.all([loadMeta(), fetch(WAVE_URL, { cache: 'no-cache' }).then((r) => ok(r, 'waves_ww3.bin').arrayBuffer())])
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
  if (Math.abs(h) <= STALE_HOURS) return '';
  return h > 0 ? ` Stale: valid ${Math.round(h)} h ago; re-run pieces/11-ocean/build_ocean.py.` : ` Valid ${Math.round(-h)} h from now.`;
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
