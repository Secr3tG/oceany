// 10 m wind for the Oceany globe, over sea and land, as dots that drift along the flow (a flow visualisation: the dots
// are tracers, not objects). Data: NOAA NCEP GFS or ECMWF IFS. Since b60 the wind follows the forecast time bar
// (forecast_bar.js), the same 7-day clock as the wave layer: build_forecast.py packs 10 m wind per step into the wave
// forecast's folder (whi_/wlo_ files, manifest.wind), and the shader blends the two steps around the bar's time (uMix),
// as waves.js does. With no forecast files it falls back to the single snapshot from build_ocean.py (see SOURCES.md).
//
//   const layer = await createLayer({ THREE, radius, makeDotMaterial, palette });   layer.update(t) every frame
//   layer.label / .details / .status, layer.setDim(k), layer.setPalette(name, palette)
//
// How it moves (all on the GPU, static buffers): the wind grid is a texture. Each tracer has a fixed random seed. Its life
// is split into cycles; each cycle it is born at a new random place (seed x cycle number, so the pattern never repeats),
// and the vertex shader walks it from there along the wind for its current age (Euler steps, sampling the texture each
// step). Each tracer is a head dot and TAIL-1 fainter, smaller tail dots a little younger, so it draws a fine streak. Speed on screen = the wind speed with time
// sped up (1 s on screen = TIME_SCALE s of wind). The field itself is frozen at the valid time, so the tracks are the
// streamlines of that moment, not the real paths air takes over the hours shown.
//
// Look, kept apart from the swell layer within the one dot style: wind is fine, fast, neutral streaks (the palette's ink
// colour, desaturated; brightness by speed only), swell is broad, slow fronts in the palette's sea colours. In Mono, where
// hue cannot help, they differ by size, shape, direction (streaks run along the motion, fronts across it) and brightness.
// Regional zoom: a second set of NEAR_TRACERS is drawn only around the point under the camera when it is close (as swell's
// near trains: birth places do not depend on the camera, so nothing slides when the view moves).

import { loadWind, dataLine, onOceanUpdate, fmtTime, fmtRun, staleNote, SAFETY, rampColours, RAMP_GLSL, LIMB_GLSL, getModel } from './ocean_data.js';
import { mountModelSwitch } from './ocean_model.js';
import { loadForecast } from './forecast_data.js';
import { timeBar } from './forecast_bar.js';

const PHONE = typeof matchMedia !== 'undefined' && (matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 500);

const TRACERS = 12000;         // tracers on the whole globe (each is TAIL dots)
const NEAR_TRACERS = 60000;    // extra tracers drawn only near the view centre when the camera is close (regional zoom)
const TAIL = 10;
const TIME_SCALE = 21600;      // 1 s on screen = 6 h of wind: 10 m/s moves about 2 degrees a second
const LIFE = 3.0;              // mean life on screen, seconds (each tracer 0.6-1.4 x this)
const STEPS = 12;              // integration steps per frame per dot
const LIFT = 0.0025;           // radii above the base sphere (10 m wind sits on the surface; mountains are exaggerated, so see details)
const V_TOP = 25;              // m/s at the top of the colour ramp
const EARTH_M = 6371000;

const VERT = /* glsl */`
  uniform sampler2D uWind, uWind1; uniform vec3 uG0, uG1; uniform float uMix, uWithWaves; uniform float uTime, uLife, uSpeed, uSize, uScale, uMaxPx, uR, uVTop, uCapK; uniform vec3 uInk;
  attribute float aSeed; attribute float aTail; attribute float aNear;
  varying vec3 vColor; varying float vA;
  ${RAMP_GLSL}
  ${LIMB_GLSL}
  float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
  // grid g = (nLon, nLat, step degrees); rows from 90 S, columns from 0 E (as the wave grids)
  vec2 gridUV(vec3 g, float la, float lo) { return vec2(lo / 6.2831853 + 0.5 / g.x, ((la / 0.0174533 + 90.0) / g.z + 0.5) / g.y); }
  vec2 windAt(float la, float lo) {           // m/s (east, north) at latitude, longitude in radians, blended between steps
    vec2 e = mix(texture2D(uWind, gridUV(uG0, la, lo)).rg, texture2D(uWind1, gridUV(uG1, la, lo)).rg, uMix) * 255.0;
    return (e - 128.0) * 0.5;
  }
  void main() {
    float life = uLife * (0.6 + 0.8 * h1(aSeed * 1.7 + 0.3));
    float tt = uTime / life + h1(aSeed * 3.1 + 0.7);
    float cyc = floor(tt), age = fract(tt) - aTail * (aNear > 0.5 ? 0.016 : 0.035);   // far streaks longer, so they read as flow from afar
    vA = 0.0;
    if (age <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }   // tail not born yet this cycle: clipped
    float s = aSeed * 0.618 + cyc * 7.31;
    float lo = 6.2831853 * h1(s), la = asin(2.0 * h1(s + 0.5) - 1.0);       // born anywhere, evenly per area
    float nearK = 1.0;
    vec3 cam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
    float alt = length(cam) - 1.0;
    float farG = aNear > 0.5 ? 0.0 : smoothstep(0.6, 2.0, alt);   // round 4: whole-globe lift of the far set (0 at regional zoom)
    if (aNear > 0.5) {                          // near set: only when close, only those born around the view centre
      nearK = 1.0 - smoothstep(0.6, 1.2, alt);
      float cap = min(acos(1.0 / length(cam)), uCapK * alt + 0.06);
      vec3 b = vec3(cos(la) * cos(lo), sin(la), -cos(la) * sin(lo));
      if (nearK < 0.01 || dot(b, normalize(cam)) < cos(cap)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    }
    float dt = age * life / ${STEPS}.0;
    vec2 w = vec2(0.0);
    for (int k = 0; k < ${STEPS}; k++) {
      w = windAt(la, lo);
      la = clamp(la + w.y * dt * uSpeed, -1.55, 1.55);
      lo = mod(lo + w.x * dt * uSpeed / max(cos(la), 0.15), 6.2831853);
    }
    float sp = length(windAt(la, lo));
    vec3 p = (uR) * vec3(cos(la) * cos(lo), sin(la), -cos(la) * sin(lo));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // b58 (Benn's phone: streaks too thick close in, land and sea hidden): from ~950 km down to ~65 km the streaks thin to
    // 1 px and fade to 35 %, so the ground reads through them; whole-globe and mid zooms are unchanged
    float closeK = smoothstep(0.01, 0.15, alt);
    gl_PointSize = (1.0 + 0.35 * uWithWaves) * clamp(uSize * (1.0 + 0.25 * farG) * (1.0 - 0.05 * aTail) * uScale / -mv.z, mix(1.0, 1.5, closeK), uMaxPx * mix(0.45, 1.0, closeK));   // a scale, not a higher floor: a floor grows only the far (limb) dots and brought the edge back
    gl_Position = projectionMatrix * mv;
    float x = sqrt(clamp(sp / uVTop, 0.0, 1.0));
    float lum = dot(uInk, vec3(0.3, 0.5, 0.2));
    vColor = mix(mix(uInk, vec3(lum), 0.6) * (1.0 + 1.0 * farG), vec3(0.5, 0.85, 1.0) * 1.6, uWithWaves) * (0.3 + 0.7 * x);   // with the wave layer on: pale blue, dimmer, so the white swell crests stand apart   // neutral: the palette's ink, mostly grey; brighter = faster
    vA = 2.2 * nearK * sin(3.1415927 * clamp(age, 0.0, 1.0)) * (1.0 - 0.075 * aTail);    // fade in at birth, out at death
    vA *= limbFade(p, mv) * mix(0.35, 1.0, closeK);
    if (uWithWaves > 0.5) vA *= 2.4;   // with waves: fewer, fainter tracers                                              // no bright ring at the limb (ocean_data.js)
    if (vA <= 0.0) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  }`;
const FRAG = /* glsl */`
  uniform float uOpacity; varying vec3 vColor; varying float vA;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0 || vA <= 0.0) discard;
    gl_FragColor = vec4(vColor, pow(1.0 - r, 2.0) * 0.85 * uOpacity * vA);   // the globe's dot falloff (dots.js)
  }`;

export async function createLayer({ THREE, radius = 1, makeDotMaterial, palette }) {
  let uScale = { value: 450 };   // the globe's shared pixels-per-unit uniform, borrowed from a makeDotMaterial probe
  if (makeDotMaterial) { const probe = makeDotMaterial({ size: 0.001 }); if (probe.uniforms?.uScale) uScale = probe.uniforms.uScale; probe.dispose?.(); }
  const ramp = [];
  const tex = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uWind: { value: tex }, uWind1: { value: tex }, uG0: { value: new THREE.Vector3(1, 1, 1) }, uG1: { value: new THREE.Vector3(1, 1, 1) }, uMix: { value: 0 }, uWithWaves: { value: 0 }, uTime: { value: 0 }, uLife: { value: LIFE }, uSpeed: { value: TIME_SCALE / EARTH_M },
      uSize: { value: 0.0032 * radius }, uScale, uMaxPx: { value: 2.5 * (globalThis.devicePixelRatio || 1) }, uR: { value: radius + LIFT },
      uVTop: { value: V_TOP }, uOpacity: { value: 1 }, uCapK: { value: 0.8 }, uInk: { value: new THREE.Color(0.8, 0.85, 0.9) }, uC0: { value: new THREE.Color() }, uC1: { value: new THREE.Color() },
      uC2: { value: new THREE.Color() }, uC3: { value: new THREE.Color() } },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const setPalette = (name, p) => {
    rampColours(THREE, p || palette, ramp);
    ['uC0', 'uC1', 'uC2', 'uC3'].forEach((k, i) => mat.uniforms[k].value.copy(ramp[i]));
    const ink = (p || palette)?.ink;
    if (ink) mat.uniforms.uInk.value.setRGB(ink[0], ink[1], ink[2]);
  };
  setPalette('Ocean', palette);

  // static buffers: a seed and a tail index per dot; positions are worked out in the shader
  const nT = TRACERS + NEAR_TRACERS, n = nT * TAIL, seed = new Float32Array(n), tail = new Float32Array(n), near = new Float32Array(n);
  for (let i = 0; i < nT; i++) for (let k = 0; k < TAIL; k++) { seed[i * TAIL + k] = i + 1; tail[i * TAIL + k] = k; near[i * TAIL + k] = i >= TRACERS ? 1 : 0; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));   // unused (shader computes it)
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));
  geo.setAttribute('aNear', new THREE.BufferAttribute(near, 1));
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.name = 'wind';
  pts.renderOrder = 9;                                    // after the wave layer's height field (renderOrder 5), which would wash the streaks out
  geo.setDrawRange(0, 0);                                 // draws nothing until the data is in (a failed layer stays empty)
  let state = 'waiting', err = '', meta = null, peak = null;

  function build(w) {
    const { nLat, nLon, u, v } = w, data = new Uint8Array(nLat * nLon * 4);
    for (let i = 0; i < nLat * nLon; i++) {
      data[i * 4] = Math.max(1, Math.min(255, Math.round(u[i] * 2 + 128)));
      data[i * 4 + 1] = Math.max(1, Math.min(255, Math.round(v[i] * 2 + 128)));
      data[i * 4 + 3] = 255;
      const s = Math.hypot(u[i], v[i]);
      if (!peak || s > peak.s) peak = { s, lat: w.lat0 + Math.floor(i / nLon) * w.step, lon: (((i % nLon) * w.step + 180) % 360) - 180 };
    }
    const t = new THREE.DataTexture(data, nLon, nLat, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
    const old = mat.uniforms.uWind.value; mat.uniforms.uWind.value = mat.uniforms.uWind1.value = t; if (old !== tex) old.dispose();
    mat.uniforms.uG0.value.set(nLon, nLat, w.step); mat.uniforms.uG1.value.set(nLon, nLat, w.step); mat.uniforms.uMix.value = 0;
  }

  // ---- forecast: the two steps around the time bar's time, blended (as waves.js) ----
  let fc = null, shown = null, want = 0, model = null;
  const res = PHONE ? 'lo' : 'hi';
  const label = () => (model === 'ecmwf' ? 'ECMWF IFS wind' : 'NOAA GFS wind');
  function bracket(t) {
    const s = fc.steps;
    if (s.length === 1 || t <= s[0].valid) return [0, Math.min(1, s.length - 1), 0];
    for (let i = 0; i < s.length - 1; i++) if (t < s[i + 1].valid) return [i, i + 1, (t - s[i].valid) / (s[i + 1].valid - s[i].valid)];
    return [s.length - 1, s.length - 1, 0];
  }
  async function onTime(t) {
    if (!fc) return;
    const [i, j, f] = bracket(t), mine = ++want;
    if (shown && shown.i === i && shown.j === j) { mat.uniforms.uMix.value = i === j ? 0 : f; return; }
    try {
      const [s0, s1] = await Promise.all([fc.wind(i), fc.wind(j)]);
      if (mine !== want && !timeBar.playing) return;
      const u = mat.uniforms;
      u.uWind.value = s0.tex; u.uWind1.value = s1.tex;
      u.uG0.value.set(s0.grid.nLon, s0.grid.nLat, s0.grid.step); u.uG1.value.set(s1.grid.nLon, s1.grid.nLat, s1.grid.step);
      u.uMix.value = i === j ? 0 : f;
      shown = { i, j, s0, s1 }; peak = (f < 0.5 ? s0 : s1).peak;
      if (state === 'ok') geo.setDrawRange(0, n);
      const ahead = timeBar.playing ? [j + 1, j + 2, j + 3] : [i - 1, j + 1];
      for (const k of ahead) if (k >= 0 && k < fc.steps.length) fc.wind(k).catch(() => {});
      fc.wtrim(i);
      text();
    } catch (e) { err = e.message || 'network error'; text(); }
  }
  timeBar.onTime((t) => { if (pts.visible && fc) onTime(t); });

  async function load() {
    state = 'loading'; model = getModel(); shown = null; fc = null; text();
    try {                                                 // the forecast first (same files as the wave layer's)
      const f = await loadForecast(THREE, model, res);
      if (!f.hasWind) throw new Error('no wind in the forecast files');
      fc = f;
      const run = Date.parse(fc.manifest.run), hiTo = fc.steps.filter((s) => s.res === 'hi').pop();
      timeBar.setSteps(fc.steps, { model: label(), run, partitions: fc.manifest.partitions, hiTo: res === 'hi' && hiTo ? hiTo.valid : null }, 'wind');
      state = 'ok';
      if (pts.visible) timeBar.need('wind', true);
      await onTime(timeBar.time);
      return;
    } catch (e) { fc = null; }
    try { const w = await loadWind(); meta = w.meta; build(w); state = 'ok'; geo.setDrawRange(0, n); }   // fallback: the snapshot
    catch (e) { err = (e && e.message) || 'network error'; state = 'failed'; }
    text();
  }

  function text() {
    if (fc) return textForecast();
    const m = meta && meta.wind;
    pts.label = m ? `Wind at 10 m: ${meta.modelLabel || 'GFS'}, valid ${fmtTime(meta.valid)}` : 'Wind at 10 m (model)';
    pts.details = `${SAFETY} Model output, not measurement. ` +
      (m ? `Model: ${m.model}. Run: ${fmtRun(m.run)}. Valid: ${fmtTime(meta.valid)}. ` : 'Model: NOAA NCEP GFS. ') +
      `Wind 10 m above the ground or sea, on a 0.5 degree grid (every 2nd point of the model's 0.25 degree grid, about 55 km), smoothly interpolated between grid points. ` +
      `The moving dots are tracers, not objects: a flow picture. Each is born at a random place, drifts with the wind for a few seconds and fades. ` +
      `Speed on screen is the real wind speed with time sped up ${TIME_SCALE.toLocaleString('en-GB')} times (1 s = 6 h of wind). ` +
      `The field is frozen at the valid time, so a track shows the wind of that moment, not where the air really went. ` +
      `Drawn as fine neutral streaks (brighter = faster, up to ${V_TOP} m/s and above), so they stay apart from the swell layer's broad coloured fronts. More tracers are drawn as you zoom in. ` +
      `Dots sit just above the base sphere; over high ground they may sit inside the exaggerated mountains. ` +
      dataLine(meta);
    let st = '';
    if (state === 'waiting' || state === 'loading') st = 'Loading the wind snapshot…';
    else if (state === 'failed') st = `Wind snapshot not available (${err}); nothing drawn. Run pieces/11-ocean/${meta && meta.modelId === 'ecmwf' ? 'build_ecmwf.py' : 'build_ocean.py'}.`;
    else st = `Strongest: ${peak.s.toFixed(0)} m/s (${(peak.s * 3.6).toFixed(0)} km/h) near ${Math.abs(peak.lat).toFixed(1)}°${peak.lat < 0 ? 'S' : 'N'} ${Math.abs(peak.lon).toFixed(1)}°${peak.lon < 0 ? 'W' : 'E'}.` + staleNote(meta.valid);
    pts.status = st;
    pts.userData.onChange?.(pts);
  }

  function textForecast() {
    const fmt = (ms) => fmtTime(new Date(ms).toISOString());
    const src = model === 'ecmwf' ? 'ECMWF IFS (open data, CC BY 4.0), 10 m u and v' : 'NOAA NCEP GFS (public domain), 10 m u and v';
    pts.label = `Wind at 10 m: ${label().replace(' wind', '')} forecast, ${fmt(timeBar.time)}`;
    pts.details = `${SAFETY} Model output, not measurement. ` +
      `Model: ${src}. Run: ${fmtTime(fc.manifest.run)}. The wind follows the time bar at the bottom, the same clock as the wave layer, so both can be on together. ` +
      `Steps are 3- to 6-hourly to +7 days and blended in between; a 0.5 degree grid to +5 days on a computer, 1 degree beyond that and on phones. ` +
      `The moving dots are tracers, not objects: a flow picture. Each is born at a random place, drifts with the wind for a few seconds and fades. ` +
      `Speed on screen is the real wind speed with time sped up ${TIME_SCALE.toLocaleString('en-GB')} times (1 s = 6 h of wind). ` +
      `A track shows the wind of the time shown, not where the air really went. ` +
      `Drawn as fine neutral grey streaks along the flow (brighter = faster, up to ${V_TOP} m/s and above), so they stay apart from the swell layer's crest lines, which run across the swell. ` +
      `Dots sit just above the base sphere; over high ground they may sit inside the exaggerated mountains.`;
    let st = '';
    if (state === 'loading' || !shown) st = 'Loading the wind forecast…';
    else st = `Shown: ${fmt(timeBar.time)}.` + (peak ? ` Strongest at the nearest step: ${peak.s.toFixed(0)} m/s (${(peak.s * 3.6).toFixed(0)} km/h) near ${Math.abs(peak.lat).toFixed(1)}°${peak.lat < 0 ? 'S' : 'N'} ${Math.abs(peak.lon).toFixed(1)}°${peak.lon < 0 ? 'W' : 'E'}.` : '') + (err ? ` (${err})` : '');
    pts.status = st;
    pts.userData.onChange?.(pts);
  }

  // show / hide the time bar with the layer (the globe only flips .visible and stops calling update); the wonders tour
  // turns the layer off through its checkbox, so this also hides the bar for the tour and brings it back after
  let wasVisible = null;
  setInterval(() => {
    const v = pts.visible && !!pts.parent;
    if (v === wasVisible) return;
    wasVisible = v;
    if (v && fc && state === 'ok') { timeBar.need('wind', true); onTime(timeBar.time); } else if (!v) timeBar.need('wind', false);
  }, 300);

  pts.update = (t) => {
    if (!pts.visible) return;                             // hidden: nothing fetched, nothing computed (the globe skips us too)
    if (state === 'waiting') load();
    mat.uniforms.uTime.value = t;
    mat.uniforms.uWithWaves.value = timeBar.owners.includes('waves') ? 1 : 0;
  };
  pts.setDim = (k) => { mat.uniforms.uOpacity.value = Math.max(0, Math.min(1, k)); };
  pts.setPalette = setPalette;
  onOceanUpdate(() => { if ((state === 'ok' || state === 'failed') && (getModel() !== model || !fc)) load(); });   // newer build while open (hosted only), or the GFS / ECMWF switch
  mountModelSwitch(pts);
  pts.userData.layer = { get state() { return state; }, load, mat, get forecast() { return !!fc; }, get shown() { return shown; } };
  text();
  return pts;
}
