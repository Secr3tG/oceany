// Primary swell for the Oceany globe: trains of dot wave fronts travelling the way the swell is going. Data: the primary
// swell partition of NOAA NCEP GFS-Wave (WAVEWATCH III, forced by GFS winds), from NOMADS, 0.5 degree,
// snapshot built by build_ocean.py (see SOURCES.md).
//
//   const layer = await createLayer({ THREE, radius, makeDotMaterial, palette });   layer.update(t) every frame
//   layer.label / .details / .status, layer.setDim(k), layer.setPalette(name, palette), await layer.checkActivity()
//
// What is model output and what is illustrative:
//   model output: per 0.5 degree cell, the swell's height, peak period and direction (where it is going = 'from' + 180).
//   illustrative: the fronts. Real crests are a few hundred metres apart, far below a pixel, so the drawn spacing is the
//   deep-water wavelength L = 1.56 x T^2 metres stretched EXAG times (12 s: 225 m real, 450 km drawn). No front is a real
//   wave; a train only shows which way, how long-period and how big the swell is where it passes.
//
// How it moves (all on the GPU, static buffers; the swell grid is a texture): each train has a fixed random seed. Every
// cycle it is born somewhere new in the ocean (seed x cycle, so it never loops), reads the period there, and lays out
// FRONTS fronts one drawn wavelength apart, each a short line of dots square to the swell direction. Every dot is then
// walked along the local swell direction for the train's age (Euler steps, sampling the texture each step), so fronts
// bend as the swell turns. A dot that reaches land or the edge of the data goes dark. Longer swells make fewer, wider
// trains (births thin out as 1/L^1.5), so groundswell does not smear into a carpet.
//
// (An earlier version solved one global crest pattern by least squares; on real data its fronts were off the model
// direction by a median 23 degrees, a quarter by over 47, because swell turns and changes period. Trains are born square
// to the local direction, so they are right by construction.)

import { loadWaves, loadMeta, onOceanUpdate, fmtTime, fmtRun, staleNote, ageHours, STALE_HOURS, SAFETY, rampColours, RAMP_GLSL, LIMB_GLSL, compass } from './ocean_data.js';

const EXAG = 2000;            // horizontal exaggeration of the front spacing
const FREQ = 0.15;            // a train moves one front spacing every ~7 s on screen (slow, against the fast wind streaks)
const TRAINS = 2500;           // trains seen from far (whole globe): few, so single trains stay readable
const NEAR_TRAINS = 14000;     // extra trains drawn only near the view centre when the camera is close (regional zoom)
const FRONTS = 3;             // fronts per train
const PER_FRONT = 21;         // dots per front (dense, so a front reads as a line, not a cloud)
const LIFE = 12.0;            // mean train life on screen, s (long: the drift should outweigh the fade in and out)
const STEPS = 10;
const LIFT = 0.0018;          // radii above the base sphere (just above the wave-height field)
const L_MIN = 200;            // km: drawn wavelength of an 8 s swell; births thin out above it
const ACT_H = 1.5, ACT_T = 13; // checkActivity: report a swell of at least this height (m) and period (s) at an unlocked spot

const VERT = /* glsl */`
  #define GAIN 2.2
  uniform sampler2D uSwell; uniform float uTime, uCapK, uLife, uFreq, uExag, uLmin, uSize, uScale, uMaxPx, uR, uLat0, uNLat, uStep;
  attribute float aSeed, aFront, aAlong, aNear;
  varying vec3 vColor; varying float vA;
  ${RAMP_GLSL}
  ${LIMB_GLSL}
  float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
  // swell at (lat, lon) in radians: xy = direction going (east, north; not unit after blending), z = period s, w = height m
  vec4 swellAt(float la, float lo) {
    vec2 uv = vec2(lo / 6.2831853 + 0.5 / 720.0, ((la / 0.0174533 - uLat0) / uStep + 0.5) / uNLat);   // grid from ocean.json
    vec4 e = texture2D(uSwell, uv);
    return vec4(e.xy * 2.0 - 1.0, e.z * 25.0, e.w * 10.0);
  }
  void main() {
    vA = 0.0;
    float life = uLife * (0.7 + 0.6 * h1(aSeed * 1.7 + 0.3));
    float tt = uTime / life + h1(aSeed * 3.1 + 0.7), cyc = floor(tt), age = fract(tt);
    // birth: up to 4 tries at a random ocean point; long-period swell is born less often (it covers more)
    float la = 0.0, lo = 0.0, L = 0.0, T = 0.0; vec2 g = vec2(0.0); bool born = false;
    for (int k = 0; k < 4; k++) {
      float s = aSeed * 0.618 + cyc * 7.31 + float(k) * 3.17;
      float lo0 = 6.2831853 * h1(s), la0 = asin(2.0 * h1(s + 0.5) - 1.0);
      vec4 w = swellAt(la0, lo0);
      if (born || w.w < 0.05 || w.z < 1.0 || length(w.xy) < 0.5) continue;
      float Lk = uExag * 1.56 * w.z * w.z / 1000.0;   // drawn wavelength, km
      if (h1(s + 0.9) > pow(uLmin / max(Lk, uLmin), 1.5)) continue;
      born = true; la = la0; lo = lo0; L = Lk; T = w.z; g = normalize(w.xy);
    }
    if (!born) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    // near trains: only when the camera is close, and only those born around the view centre (the rest skip all work).
    // Their birth places do not depend on the camera, so nothing slides when the view moves; they just come into view.
    float nearK = 1.0;
    if (aNear > 0.5) {
      vec3 cam = (inverse(modelMatrix) * vec4(cameraPosition, 1.0)).xyz;
      float alt = length(cam) - 1.0;
      nearK = 1.0 - smoothstep(0.6, 1.2, alt);
      float cap = min(acos(1.0 / length(cam)), uCapK * alt + 0.06);   // angular radius around the point under the camera
      vec3 b = vec3(cos(la) * cos(lo), sin(la), -cos(la) * sin(lo));
      if (nearK < 0.01 || dot(b, normalize(cam)) < cos(cap)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    }
    // lay out this dot: aFront wavelengths behind the leading front, aAlong across (half width 0.7 L: broad fronts)
    vec2 off = vec2(-g.y, g.x) * aAlong * 0.7 * L - g * aFront * L;      // km east, north
    la += off.y / 6371.0; lo += off.x / (6371.0 * max(cos(la), 0.15));
    // walk along the local swell direction for the train's age
    float ds = age * life * uFreq * L / ${STEPS}.0;     // km per step
    float wet = 1.0; vec4 w;
    for (int k = 0; k < ${STEPS}; k++) {
      w = swellAt(la, lo);
      // dark at land and the data edge (height and period both fall to 0 there between grid points) and where the swell
      // turns more than about 60 degrees from the train's own direction (a different swell system: the front ends there)
      wet = min(wet, smoothstep(0.02, 0.15, w.w) * smoothstep(0.55, 0.85, w.z / T));
      vec2 d = length(w.xy) > 0.05 ? normalize(w.xy) : g;
      wet = min(wet, smoothstep(0.3, 0.6, dot(d, g)));
      la = clamp(la + d.y * ds / 6371.0, -1.55, 1.55);
      lo = mod(lo + d.x * ds / (6371.0 * max(cos(la), 0.15)), 6.2831853);
    }
    w = swellAt(la, lo);
    wet = min(wet, smoothstep(0.02, 0.15, w.w) * smoothstep(0.55, 0.85, w.z / T));
    float br = 0.2 + 0.8 * sqrt(clamp(w.w / 5.0, 0.0, 1.0));             // brightness by swell height here
    // short fades (8 % of life in, 12 % out) and a bright leading front with dimmer ones behind it, so the motion reads
    float lead = aFront < 0.5 ? 1.0 : aFront < 1.5 ? 0.5 : 0.28;
    vA = GAIN * nearK * wet * br * smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.88, 1.0, age)) * (1.0 - aAlong * aAlong * 0.7) * lead;
    if (vA < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vec3 p = uR * vec3(cos(la) * cos(lo), sin(la), -cos(la) * sin(lo));
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = clamp(uSize * uScale / -mv.z, 1.5, uMaxPx);
    gl_Position = projectionMatrix * mv;
    vA *= limbFade(p, mv);                                               // no bright ring at the limb (ocean_data.js)
    if (vA < 0.01) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
    vColor = ramp(0.4 + 0.6 * clamp((T - 6.0) / 12.0, 0.0, 1.0)) * (0.55 + 0.45 * br);  // the palette's sea colours by period: 6 s mid, 18 s and up near white
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
  const tex0 = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uSwell: { value: tex0 }, uTime: { value: 0 }, uLife: { value: LIFE }, uFreq: { value: FREQ }, uExag: { value: EXAG }, uLmin: { value: L_MIN }, uCapK: { value: 0.8 },
      uSize: { value: 0.0075 * radius }, uScale, uMaxPx: { value: 5 * (globalThis.devicePixelRatio || 1) }, uR: { value: radius + LIFT }, uOpacity: { value: 1 },
      uLat0: { value: -90 }, uNLat: { value: 361 }, uStep: { value: 0.5 },
      uC0: { value: new THREE.Color() }, uC1: { value: new THREE.Color() }, uC2: { value: new THREE.Color() }, uC3: { value: new THREE.Color() } },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const ramp = [];
  const setPalette = (name, p) => { rampColours(THREE, p || palette, ramp); ['uC0', 'uC1', 'uC2', 'uC3'].forEach((k, i) => mat.uniforms[k].value.copy(ramp[i])); };
  setPalette('Ocean', palette);

  // static buffers: train seed, front number, place across the front
  const nT = TRAINS + NEAR_TRAINS, n = nT * FRONTS * PER_FRONT, seed = new Float32Array(n), front = new Float32Array(n), along = new Float32Array(n), near = new Float32Array(n);
  let q = 0;
  for (let i = 0; i < nT; i++) for (let f = 0; f < FRONTS; f++) for (let a = 0; a < PER_FRONT; a++, q++) {
    seed[q] = i + 1; front[q] = f; along[q] = (a / (PER_FRONT - 1)) * 2 - 1; near[q] = i >= TRAINS ? 1 : 0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));   // unused (shader computes it)
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aFront', new THREE.BufferAttribute(front, 1));
  geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
  geo.setAttribute('aNear', new THREE.BufferAttribute(near, 1));
  geo.setDrawRange(0, 0);                                 // draws nothing until the data is in (a failed layer stays empty)
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.name = 'swell';
  let state = 'waiting', err = '', meta = null, stats = null;

  function build(w) {
    const { nLat, nLon, f } = w, H = f.shgt, T = f.sper, D = f.sdir, data = new Uint8Array(nLat * nLon * 4);
    let cells = 0, ground = 0;
    for (let i = 0; i < nLat * nLon; i++) {
      if (!(H[i] >= 0 && T[i] > 0 && D[i] >= 0)) continue;   // no data: all zero (height 0 = dry)
      const b = (D[i] + 180) * Math.PI / 180;           // direction going (the model gives 'coming from')
      data[i * 4] = Math.round((Math.sin(b) * 0.5 + 0.5) * 255);
      data[i * 4 + 1] = Math.round((Math.cos(b) * 0.5 + 0.5) * 255);
      data[i * 4 + 2] = Math.min(255, Math.round(T[i] / 25 * 255));
      data[i * 4 + 3] = Math.max(2, Math.min(255, Math.round(H[i] / 10 * 255)));
      cells++; if (T[i] >= 13) ground++;
    }
    const t = new THREE.DataTexture(data, nLon, nLat, THREE.RGBAFormat);
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
    const old = mat.uniforms.uSwell.value; mat.uniforms.uSwell.value = t; old.dispose();
    mat.uniforms.uLat0.value = w.lat0; mat.uniforms.uNLat.value = nLat; mat.uniforms.uStep.value = w.step;
    stats = { cells, groundShare: ground / Math.max(1, cells) };
  }

  async function load() {
    state = 'loading'; text();
    try { const w = await loadWaves(); meta = w.meta; build(w); state = 'ok'; geo.setDrawRange(0, n); }
    catch (e) { err = (e && e.message) || 'network error'; state = 'failed'; }
    text();
  }

  const lenAt = (T) => Math.round(1.56 * T * T);
  function text() {
    const m = meta && meta.waves;
    pts.label = m ? `Swell fronts (illustrative): WAVEWATCH III, valid ${fmtTime(meta.validWaves)}` : 'Swell fronts (illustrative): WAVEWATCH III';
    pts.details = `${SAFETY} Model output drawn as an illustration. ` +
      (m ? `Model: ${m.model}, primary swell partition. Run: ${fmtRun(m.run)}. Valid: ${fmtTime(meta.validWaves)}. ` : 'Model: NOAA NCEP GFS-Wave (WAVEWATCH III), forced by GFS winds, primary swell partition. ') +
      `Model output: the swell's height, peak period and direction in each 0.5 degree cell (about 55 km), smoothly interpolated between cells. Illustrative: the fronts; no front is a real wave. ` +
      `Trains of ${FRONTS} fronts travel the way the swell is going and bend with it; a front ends where the swell turns sharply (another swell system takes over). More trains are drawn as you zoom in. Their spacing is the deep-water wavelength L = 1.56 x period² metres, stretched ${EXAG.toLocaleString('en-GB')} times so it can be seen ` +
      `(8 s: ${lenAt(8)} m real, ${Math.round(lenAt(8) * EXAG / 1000)} km drawn; 12 s: ${lenAt(12)} m, ${Math.round(lenAt(12) * EXAG / 1000)} km; 16 s: ${lenAt(16)} m, ${Math.round(lenAt(16) * EXAG / 1000)} km). ` +
      `So groundswell draws as wide, widely spaced fronts and short-period swell as small tight ones. A train moves one spacing every ${Math.round(1 / FREQ)} s, ` +
      `so on screen its speed grows with period squared; the real crest speed grows with period (1.56 x period m/s; the energy travels at half that). Time is not to scale. ` +
      `Broad, slow fronts in the palette's sea colours (the wind layer is fine neutral streaks); the leading front of each train is the brightest. Brightness rises with swell height where the front is (5 m and up: full); colour with period (6 s mid, 18 s and up near white). ` +
      `Only the primary swell partition is drawn: a second swell or the wind sea at the same place is not shown (the wave-height layer shows the whole sea). ` +
      `Fronts go dark at land and sea ice, where the model has no data; the model cannot see inside bays or around headlands. ` +
      `Data: NOAA NCEP model output from NOMADS (US Government work, public domain); redrawn here, not an official NOAA product. A snapshot built by build_ocean.py` + (meta ? ` on ${fmtTime(meta.built)}.` : '.');
    let st = '';
    if (state === 'waiting' || state === 'loading') st = 'Loading the swell snapshot…';
    else if (state === 'failed') st = `Swell snapshot not available (${err}); nothing drawn. Run pieces/11-ocean/build_ocean.py.`;
    else st = `${stats.cells.toLocaleString('en-GB')} model cells with a swell; ${Math.round(stats.groundShare * 100)}% of the ocean has a primary swell of 13 s or longer.` + staleNote(meta.validWaves);
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
  // A report, not an alert: is a long-period swell of some size reaching an unlocked spot in this snapshot?
  // Reads only the small ocean.json (the swell offshore of each unlocked spot, worked out by build_ocean.py). Never throws.
  pts.checkActivity = async () => {
    try {
      const m = await loadMeta();
      if (Math.abs(ageHours(m.validWaves)) > STALE_HOURS) return { active: false, where: null, note: '' };
      const hits = (m.spots || []).filter((s) => s.swellHeight >= ACT_H && s.swellPeriod >= ACT_T).sort((a, b) => b.swellHeight * b.swellPeriod - a.swellHeight * a.swellPeriod);
      if (!hits.length) return { active: false, where: null, note: '' };
      const s = hits[0];
      return { active: true, where: { lat: s.lat, lon: s.lon },
        note: `Model swell at ${s.name}: ${s.swellHeight.toFixed(1)} m at ${Math.round(s.swellPeriod)} s from the ${compass(s.swellFrom)} (WAVEWATCH III, valid ${fmtTime(m.validWaves)}, nearest offshore grid point). Model output, not an observation.` +
          (hits.length > 1 ? ` Also ${hits.slice(1).map((h) => h.name).join(', ')}.` : '') };
    } catch (e) { return { active: false, where: null, note: '' }; }
  };
  onOceanUpdate(() => { if (state === 'ok' || state === 'failed') load(); });   // newer build while open (hosted only)
  pts.userData.layer = { get state() { return state; }, get stats() { return stats; }, load, mat };
  text();
  return pts;
}
