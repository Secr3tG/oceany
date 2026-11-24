// 10 m wind for the Oceany globe, over sea and land, as dots that drift along the flow (a flow visualisation: the dots
// are tracers, not objects). Data: NOAA NCEP GFS (0.25 degree file, every 2nd point), from NOMADS, snapshot built by build_ocean.py (see SOURCES.md).
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

import { loadWind, dataLine, onOceanUpdate, fmtTime, fmtRun, staleNote, SAFETY, rampColours, RAMP_GLSL, LIMB_GLSL } from './ocean_data.js';
import { mountModelSwitch } from './ocean_model.js';

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
  uniform sampler2D uWind; uniform float uTime, uLife, uSpeed, uSize, uScale, uMaxPx, uR, uVTop, uCapK; uniform vec3 uInk;
  attribute float aSeed; attribute float aTail; attribute float aNear;
  varying vec3 vColor; varying float vA;
  ${RAMP_GLSL}
  ${LIMB_GLSL}
  float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
  vec2 windAt(float la, float lo) {           // m/s (east, north) at latitude, longitude in radians
    vec2 uv = vec2(lo / 6.2831853 + 0.5 / 720.0, (la / 3.1415927 + 0.5) * (360.0 / 361.0) + 0.5 / 361.0);
    vec2 e = texture2D(uWind, uv).rg * 255.0;
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
    gl_PointSize = clamp(uSize * (1.0 + 0.25 * farG) * (1.0 - 0.05 * aTail) * uScale / -mv.z, 1.5, uMaxPx);   // a scale, not a higher floor: a floor grows only the far (limb) dots and brought the edge back
    gl_Position = projectionMatrix * mv;
    float x = sqrt(clamp(sp / uVTop, 0.0, 1.0));
    float lum = dot(uInk, vec3(0.3, 0.5, 0.2));
    vColor = mix(uInk, vec3(lum), 0.6) * (0.3 + 0.7 * x) * (1.0 + 1.0 * farG);   // neutral: the palette's ink, mostly grey; brighter = faster
    vA = 2.2 * nearK * sin(3.1415927 * clamp(age, 0.0, 1.0)) * (1.0 - 0.075 * aTail);    // fade in at birth, out at death
    vA *= limbFade(p, mv);                                              // no bright ring at the limb (ocean_data.js)
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
    uniforms: { uWind: { value: tex }, uTime: { value: 0 }, uLife: { value: LIFE }, uSpeed: { value: TIME_SCALE / EARTH_M },
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
    const old = mat.uniforms.uWind.value; mat.uniforms.uWind.value = t; old.dispose();
  }

  async function load() {
    state = 'loading'; text();
    try { const w = await loadWind(); meta = w.meta; build(w); state = 'ok'; geo.setDrawRange(0, n); }
    catch (e) { err = (e && e.message) || 'network error'; state = 'failed'; }
    text();
  }

  function text() {
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

  pts.update = (t) => {
    if (!pts.visible) return;                             // hidden: nothing fetched, nothing computed (the globe skips us too)
    if (state === 'waiting') load();
    mat.uniforms.uTime.value = t;
  };
  pts.setDim = (k) => { mat.uniforms.uOpacity.value = Math.max(0, Math.min(1, k)); };
  pts.setPalette = setPalette;
  onOceanUpdate(() => { if (state === 'ok' || state === 'failed') load(); });   // newer build while open (hosted only), or the GFS / ECMWF switch
  mountModelSwitch(pts);
  pts.userData.layer = { get state() { return state; }, load, mat };
  text();
  return pts;
}
