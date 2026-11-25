// Waves for the Oceany globe, with a forecast time bar. Three things drawn, all from one model run:
//   1. the height field: glowing dots a few pixels apart at every zoom, anchored to the globe, each reading the model
//      smoothly at its own place, coloured on a fixed wave-height scale (wave_colours.js; legend in the time bar);
//   2. swell crest lines (b60, Benn: "make the swells act like swell lines like on our reef viewer"): short trains of
//      crests square to the primary swell direction, spaced by the deep-water wavelength (1.56 x period^2 m, stretched
//      so it can be seen), moving the way the swell goes at its energy speed (0.78 x period m/s) sped up by TIMELAPSE.
//      Every dot of a crest is its own ray: over the shelf (GEBCO depth, build_depth.py) it slows down as the water
//      gets shallow and turns toward the shallower side (refraction, Snell's law), so the crests bend to meet the
//      coast the way swell does. A dark edge under each line keeps it readable on top of the height colours;
//   3. wind-sea dots: short, faint dots along the wind-sea direction (GFS only; ECMWF's open data has no split).
// The time bar (forecast_bar.js) picks a valid time between two forecast steps; both steps sit on the GPU and the
// shaders blend them (uMix), so scrubbing and playing are smooth. Data: build_forecast.py (see its header and
// SOURCES.md). If no forecast files are found, the layer falls back to the single snapshot of build_ocean.py.
//
// The parts worth understanding: the GLSL function sea() (how a dot reads the model between grid points and between
// steps), and the walk in CREST_VERT (a crest dot is born on a random swell train and walked along its own ray).
// The rest is plumbing.
//
//   const layer = await createLayer({ THREE, radius, makeDotMaterial, palette });   layer.update(t, camera) every frame
//   layer.label / .details / .status, layer.setDim(k), layer.setPalette(name, palette)

import { onOceanUpdate, getModel, loadWaves, SAFETY, compass, LIMB_GLSL } from './ocean_data.js';
import { mountModelSwitch } from './ocean_model.js';
import { loadForecast, stepFromSnapshot, sampleAt } from './forecast_data.js';
import { timeBar, PLAY_RATE } from './forecast_bar.js';
import { hsLut, HS_MAX } from './wave_colours.js';

const D2R = Math.PI / 180;
const PHONE = typeof matchMedia !== 'undefined' && (matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 500);
const TRAINS = PHONE ? 500 : 1200;            // swell trains seen from far (whole globe)
const NEAR_N = PHONE ? 16 : 24;               // near trains: an N x N window of cells around the point under the camera,
const NEAR_M = 3;                             //   M trains per cell (see nearWindow below)
const NEAR_TRAINS = NEAR_N * NEAR_N * NEAR_M;
const FRONTS = PHONE ? 2 : 3;                 // crests per train, one drawn wavelength apart
const PER_CREST = PHONE ? 9 : 13;             // dots per crest; each draws a bar to its neighbour, so they join into a line
const L_PX = PHONE ? 34 : 40;                 // a 12 s swell's crest spacing on screen, CSS px (scales with period^2)
const CREST_STEPS = PHONE ? 6 : 10;           // ray steps per dot per frame
const EXAG = 2000;                            // whole-globe stretch of the crest spacing (as swell.js); less close in
const D_MAX = 600;                            // m: depth byte 255 (build_depth.py)
const SWELL_N = 0;                            // (the old swell comets are gone; kept 0 so the wind-sea code below stays as it was)
const WIND_N = 0;                             // wind-sea dots: off since Benn's b60 look (no short dashes on the waves)
const TAIL = PHONE ? 5 : 7;                   // dots trailing behind each crest
const ACROSS = 4;                             // extra dots across the head: a short crest square to the direction
const TIMELAPSE = PLAY_RATE / 1000;           // forecast seconds per real second (6 h per s): the dots' clock
const LIFT_FIELD = 0.0012, LIFT_PART = 0.0020;  // radii above the base sphere
const FIELD_OP = PHONE ? 0.95 : 0.9;           // height field: dot cores near full, a faint wash between them (uWash)
const MODE_NAMES = ['Total sea', 'Swell', 'Wind sea'];

const SEA_GLSL = /* glsl */`
  uniform sampler2D uA0, uA1, uB0, uB1, uM0, uM1;
  uniform vec3 uG0, uG1;        // nLon, nLat, step (degrees) of each step's grid; rows from 90 S, columns from 0 E
  uniform float uMix;           // 0: step 0, 1: step 1
  vec2 gridUV(vec3 g, float la, float lo) {
    return vec2(lo / 6.2831853 + 0.5 / g.x, ((la / 0.0174533 + 90.0) / g.z + 0.5) / g.y);
  }
  // the sea at (lat, lon) radians, blended between grid points (bilinear) and between the two steps (uMix):
  //   a = (total height m, swell height m, wind-sea height m, swell period s)
  //   b = (swell going east, north, wind sea going east, north), not unit after blending
  //   returns the sea mask 0..1 (0 on land and sea ice)
  float sea(float la, float lo, out vec4 a, out vec4 b) {
    vec2 u0 = gridUV(uG0, la, lo), u1 = gridUV(uG1, la, lo);
    a = mix(texture2D(uA0, u0), texture2D(uA1, u1), uMix) * 25.5;
    b = mix(texture2D(uB0, u0), texture2D(uB1, u1), uMix) * 2.0 - 1.0;
    return mix(texture2D(uM0, u0).r, texture2D(uM1, u1).r, uMix);
  }
  vec2 latLon(vec3 p) { vec3 n = normalize(p); return vec2(asin(clamp(n.y, -1.0, 1.0)), atan(-n.z, n.x)); }
  vec3 onSphere(float la, float lo) { return vec3(cos(la) * cos(lo), sin(la), -cos(la) * sin(lo)); }`;

// The height field is one sphere just above the sea, drawn per pixel: each pixel reads the model (sea(), smooth) and
// lights up only inside a dot. The dots are anchored to the globe (a jittered 3D grid of cells, one dot per cell,
// projected onto the sphere) and the grid's size follows the zoom (two sizes blended, from the pixel footprint
// fwidth), so the dots stay about uSpace pixels apart at every zoom: no lattice, no blobs, smooth colour.
const FIELD_VERT = /* glsl */`
  varying vec3 vN, vNv, vMv;
  void main() {
    vN = normalize(position); vNv = normalize(normalMatrix * vN);
    vec4 mv = modelViewMatrix * vec4(position, 1.0); vMv = mv.xyz;
    gl_Position = projectionMatrix * mv;
  }`;
const FIELD_FRAG = /* glsl */`
  uniform sampler2D uLut; uniform float uMode, uOpacity, uSpace, uDot, uWash;
  varying vec3 vN, vNv, vMv;
  ${SEA_GLSL}
  vec2 hash2(vec2 c) { vec3 p = fract(vec3(c.xyx) * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yzx + 33.33); return fract((p.xx + p.yz) * p.zy); }
  // the dots live on the six faces of a cube wrapped onto the sphere (a 2D grid per face: even, no gaps); q: this
  // pixel's place on its face, 0..1; face: which face (keeps the dots of different faces apart)
  vec2 jit(vec2 c, float k, float face) { return (c + 0.35 + 0.3 * hash2(c + face * 4099.0)) / k; }
  // dot light at q on the grid of k cells per face side (px: one pixel in face units). The grids are nested: a cell that
  // holds its parent's dot (one size up, and up to 3 sizes) keeps it, so zooming in only adds in-between dots, fading
  // in with fadeNew; the coarser grid draws the inherited ones (with fadeNew < 1 they are skipped here)
  float dotsAt(vec2 q, float face, float k, float px, float fadeNew) {
    vec2 c = floor(q * k);
    vec2 p = jit(floor(c / 8.0), k / 8.0, face); bool inherited = true;
    vec2 c4 = floor(c / 4.0); if (floor(p * k / 4.0) != c4) p = jit(c4, k / 4.0, face);
    vec2 c2 = floor(c / 2.0); if (floor(p * k / 2.0) != c2) p = jit(c2, k / 2.0, face);
    if (floor(p * k) != c) { p = jit(c, k, face); inherited = false; }
    if (inherited && fadeNew < 1.0) return 0.0;
    float d = length(q - p) / px;                            // distance in pixels
    return exp(-d * d / (uDot * uDot)) * (inherited ? 1.0 : fadeNew);
  }
  void main() {
    vec3 n = normalize(vN);
    vec2 ll = vec2(asin(clamp(n.y, -1.0, 1.0)), atan(-n.z, n.x));
    vec4 a, b; float m = sea(ll.x, ll.y, a, b);
    float wet = smoothstep(0.25, 0.75, m);
    float limb = clamp(dot(normalize(-vMv), normalize(vNv)) / 0.6, 0.0, 1.0);
    if (wet * limb < 0.01) discard;
    vec3 an = abs(n); vec2 uv; float face;
    if (an.x >= an.y && an.x >= an.z) { uv = n.yz / an.x; face = n.x > 0.0 ? 0.0 : 1.0; }
    else if (an.y >= an.z) { uv = n.xz / an.y; face = n.y > 0.0 ? 2.0 : 3.0; }
    else { uv = n.xy / an.z; face = n.z > 0.0 ? 4.0 : 5.0; }
    vec2 q = uv * 0.5 + 0.5;
    // one pixel in face units, from the smooth normal (fwidth of q jumps at the cube's edges and drew a dark seam);
    // the face projection stretches by about 1 / (0.5 x major axis) there
    float px = max(length(fwidth(n)) * 0.7071 * 0.5 / max(an.x, max(an.y, an.z)), 1e-7);
    float L = log2(1.0 / (uSpace * px)), f = fract(L), k0 = exp2(floor(L));
    // the grid one size up draws all its dots; the finer grid adds only its new in-between dots, fading in with zoom
    float fn = smoothstep(0.0, 0.4, f);                     // fade in quickly: most of the time every dot is equal
    float lit = dotsAt(q, face, k0, px, 1.0) + (fn > 0.002 ? dotsAt(q, face, 2.0 * k0, px, min(fn, 0.999)) : 0.0);
    float h = uMode < 0.5 ? a.x : uMode < 1.5 ? a.y : a.z;
    float x = sqrt(clamp(h / ${HS_MAX.toFixed(1)}, 0.0, 1.0));
    vec3 col = texture2D(uLut, vec2(x, 0.5)).rgb * (0.7 + 0.4 * smoothstep(0.0, 0.7, x));
    // between the dots a dim tint of the same colour, near opaque, so the globe's blue sea dots underneath do not mix
    // in (red over blue read as purple); on the dots the full colour
    lit = clamp(lit, 0.0, 1.0);
    float al = mix(uWash, 1.0, lit) * wet * limb * uOpacity;
    if (al < 0.004) discard;
    gl_FragColor = vec4(mix(col * 0.45, col * 1.15, lit), al);
  }`;
const DOT_FRAG = /* glsl */`
  uniform float uOpacity; varying vec3 vColor; varying float vA;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0 || vA <= 0.0) discard;
    gl_FragColor = vec4(vColor, exp(-4.5 * r * r) * (1.0 - r) * uOpacity * vA);   // soft (near Gaussian): overlapping dots sum smooth
  }`;

const PART_VERT = /* glsl */`
  #define STEPS 8
  uniform float uTime, uTL, uSize, uScale, uMaxPx, uShowSwell, uShowWind, uTail, uCap, uR;
  attribute float aSeed, aTail, aKind, aAcross;
  varying vec3 vColor; varying float vA;
  ${SEA_GLSL}
  ${LIMB_GLSL}
  float h1(float n) { return fract(sin(n * 12.9898) * 43758.5453); }
  void hide() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vA = 0.0; }
  void main() {
    bool wind = aKind > 0.5;
    if ((wind ? uShowWind : uShowSwell) < 0.5) { hide(); return; }
    float life = (wind ? 2.2 : 4.5) * (0.75 + 0.5 * h1(aSeed * 1.7 + 0.3));
    float tt = uTime / life + h1(aSeed * 3.1 + 0.7), cyc = floor(tt), age = fract(tt);
    // birth: up to 5 tries at a random point; it must be sea with this kind of wave, and big seas get more dots
    float la = 0.0, lo = 0.0, T = 0.0, H = 0.0; vec2 g = vec2(0.0); bool born = false;
    vec4 a, b;
    for (int k = 0; k < 5; k++) {
      if (born) break;
      float s = aSeed * 0.618 + cyc * 7.31 + float(k) * 3.17;
      float lo0 = 6.2831853 * h1(s), la0 = asin(2.0 * h1(s + 0.5) - 1.0);
      float m = sea(la0, lo0, a, b);
      float hh = wind ? a.z : a.y; vec2 d = wind ? b.zw : b.xy;
      if (m < 0.6 || hh < 0.15 || length(d) < 0.5) continue;
      if (h1(s + 0.9) > clamp(0.15 + hh / 3.0, 0.0, 1.0)) continue;
      born = true; la = la0; lo = lo0; H = hh; g = normalize(d);
      // speed: deep-water group speed 0.78 x period. Wind sea has no period in our files: 4.5 x sqrt(height) s,
      // a rough fully developed sea (illustrative, said so in the details).
      T = wind ? clamp(4.5 * sqrt(hh), 2.5, 9.0) : max(a.w, 4.0);
    }
    if (!born) { hide(); return; }
    float speed = 0.78 * T * uTL / 1000.0;                  // km per real second
    float back = aTail * uTail * life;                      // this dot trails the head by 'back' seconds
    float tHead = age * life;
    if (tHead < back) { hide(); return; }
    float dist = (tHead - back) * speed, ds = dist / float(STEPS);
    float wet = 1.0; vec2 dl = g;
    for (int k = 0; k < STEPS; k++) {
      float m = sea(la, lo, a, b);
      vec2 d = wind ? b.zw : b.xy;
      wet = min(wet, smoothstep(0.35, 0.7, m));
      vec2 dn = length(d) > 0.05 ? normalize(d) : g; dl = dn;
      wet = min(wet, smoothstep(0.3, 0.6, dot(dn, g)));  // the wave train turned sharply: another system, end here
      la = clamp(la + dn.y * ds / 6371.0, -1.55, 1.55);
      lo = mod(lo + dn.x * ds / (6371.0 * max(cos(la), 0.15)), 6.2831853);
    }
    // crest dots: the head spread sideways, square to the local direction; groundswell crests are wider
    if (abs(aAcross) > 0.0) {
      float w = aAcross * (wind ? 18.0 : clamp(35.0 + 9.0 * (T - 6.0), 35.0, 140.0));   // km
      la = clamp(la + dl.x * w / 6371.0, -1.55, 1.55);
      lo = mod(lo - dl.y * w / (6371.0 * max(cos(la), 0.15)), 6.2831853);
    }
    float m = sea(la, lo, a, b);
    wet = min(wet, smoothstep(0.35, 0.7, m));
    float here = wind ? a.z : a.y;
    float br = (wind ? 0.35 : 0.65) + 0.55 * sqrt(clamp(here / 4.0, 0.0, 1.0));
    float head = 1.0 - aTail;                                // 1 at the head, toward 0 at the tail end
    vA = wet * br * smoothstep(0.0, 0.12, age) * (1.0 - smoothstep(0.85, 1.0, age)) * pow(head, 1.6) * (1.0 - 0.45 * abs(aAcross));
    if (vA < 0.01) { hide(); return; }
    vec3 p = uR * onSphere(la, lo);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vA *= limbFade(p, mv);
    if (vA < 0.01) { hide(); return; }
    float sz = uSize * (wind ? 0.6 : 0.8 + 0.5 * clamp((T - 8.0) / 8.0, 0.0, 1.0)) * (0.55 + 0.45 * head);
    gl_PointSize = clamp(sz * uScale / -mv.z, 1.8, uCap);
    gl_Position = projectionMatrix * mv;
    // colour by period: short (6 s) cool blue, long groundswell (16 s and up) warm white; wind sea pale grey-teal
    float pk = clamp((T - 6.0) / 10.0, 0.0, 1.0);
    vColor = wind ? vec3(0.55, 0.75, 0.75) : mix(vec3(0.55, 0.8, 1.0), vec3(1.0, 0.97, 0.9), pk) * (1.1 + 0.5 * pk);
  }`;

// ---- swell crest lines (b60, after Benn's look: "anything like the swell on our reef look") ----
// Few, long, continuous crests, like the reef viewer: the lines are drawn per pixel as the lines of equal phase of the
// dominant swell in view. The phase is worked out on the CPU (solvePhase below) on a grid over the view: the travel time
// of a wave front that enters the box as a straight front square to the dominant swell direction and then moves at the
// local phase speed c, which drops over the shelf (GEBCO depth, the swell's period). That is the eikonal equation
// |grad t| = 1 / c, solved by fast sweeping: fronts slow down in shallow water and so bend toward it (refraction, the
// same physics as the reef viewer's Snell's-law march), they can never cross, and they stop at land.
// A crest is drawn where the phase is a whole number; the phase runs forward with time, so all crests move together.
// Spacing is set on screen (about CRESTS_ON_SCREEN across the view), not the real wavelength, so it stays readable.
const CRESTS_ON_SCREEN = PHONE ? 16 : 20;
const PHASE_N = PHONE ? 112 : 176;            // phase grid cells each way over the view
const LINE_VERT = /* glsl */`
  varying vec3 vP;
  void main() { vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const LINE_FRAG = /* glsl */`
  uniform sampler2D uPhase, uDepth; uniform vec4 uBox; uniform float uF, uW, uOpacity, uShow, uK, uDmax; uniform vec2 uDom;
  varying vec3 vP;
  ${SEA_GLSL}
  void main() {
    if (uShow < 0.5 || uK < 0.01) discard;
    vec2 ll = latLon(vP);                                   // radians
    float lat = ll.x / 0.0174533, lon = mod(ll.y / 0.0174533, 360.0);
    vec2 uv = vec2(mod(lon - uBox.y + 540.0, 360.0) - 180.0, lat - uBox.x) / uBox.zw + 0.5;   // box centre (lat, lon), size (deg)
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
    float edge = smoothstep(0.0, 0.06, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
    float dv = texture2D(uDepth, vec2(lon / 360.0, (lat + 90.0) / 180.0)).r * 255.0;
    float wetK = smoothstep(20.0, 45.0, dv);                // 0 on land (cut a little seaward: the grid is ~15 km)
    if (wetK <= 0.0) discard;
    vec4 a, b;
    float m = sea(ll.x, ll.y, a, b);
    // where the model has the sea: fade with swell height, and where another swell system runs across the dominant one;
    // close to the coast (no model cell) the lines carry on at full strength to the shore
    float hk = m > 0.5 ? smoothstep(0.05, 0.3, a.y) : 1.0;   // the dominant swell only: no cut where another system crosses (it made stray ends)
    float f = texture2D(uPhase, uv).r - uF;
    float fw = max(fwidth(f), 1e-5);
    float d = abs(fract(f + 0.5) - 0.5) / fw;               // pixels to the nearest crest
    float w = 0.5 * uW;
    float core = 1.0 - smoothstep(w - 0.6, w + 0.6, d), rim = 1.0 - smoothstep(w + 1.2, w + 2.4, d);
    float dens = 1.0 - smoothstep(0.10, 0.2, fw);          // crests closer than ~6 px (bunched in very shallow water): fade, no white band
    float k = edge * wetK * hk * dens * uK * uOpacity;
    vec3 col = mix(vec3(0.0, 0.02, 0.05), vec3(0.97, 0.99, 1.0), core);
    float al = max(core * 0.95, rim * 0.5) * k;
    if (al < 0.01) discard;
    gl_FragColor = vec4(col, al);
  }`;

export async function createLayer({ THREE, radius = 1, makeDotMaterial }) {
  let uScale = { value: 450 };   // the globe's shared pixels-per-unit uniform, borrowed from a makeDotMaterial probe
  if (makeDotMaterial) { const probe = makeDotMaterial({ size: 0.001 }); if (probe.uniforms?.uScale) uScale = probe.uniforms.uScale; probe.dispose?.(); }
  const dpr = globalThis.devicePixelRatio || 1;
  const blank = new THREE.DataTexture(new Uint8Array(4), 1, 1, THREE.RGBAFormat); blank.needsUpdate = true;
  const seaU = () => ({ uA0: { value: blank }, uA1: { value: blank }, uB0: { value: blank }, uB1: { value: blank }, uM0: { value: blank }, uM1: { value: blank },
    uG0: { value: new THREE.Vector3(1, 1, 1) }, uG1: { value: new THREE.Vector3(1, 1, 1) }, uMix: { value: 0 } });
  const sea = seaU();             // shared by both materials, so one update moves both

  const fieldMat = new THREE.ShaderMaterial({
    uniforms: { ...sea, uLut: { value: hsLut(THREE) }, uMode: { value: 0 }, uOpacity: { value: FIELD_OP },
      uSpace: { value: (PHONE ? 7.0 : 6.0) * dpr }, uDot: { value: (PHONE ? 1.2 : 1.0) * dpr }, uWash: { value: 0.85 } },
    vertexShader: FIELD_VERT, fragmentShader: FIELD_FRAG, transparent: true, depthWrite: false, blending: THREE.NormalBlending, side: THREE.FrontSide,
  });
  const field = new THREE.Mesh(new THREE.SphereGeometry(radius + LIFT_FIELD, PHONE ? 96 : 160, PHONE ? 48 : 80), fieldMat);
  field.visible = false;          // until the first step is in
  field.renderOrder = 5;          // after the globe's own sea dots: drawn before, their blue added onto reds read as purple
  // dot spacing and size in real pixels: follow the renderer's pixel ratio (lite mode on phones renders below the
  // device's), read each frame (cheap)
  const SPACE = PHONE ? 7.0 : 6.0, DOT = PHONE ? 1.2 : 1.0;
  field.onBeforeRender = (renderer) => { const r = renderer.getPixelRatio(); fieldMat.uniforms.uSpace.value = SPACE * r; fieldMat.uniforms.uDot.value = DOT * r; partMat.uniforms.uCap.value = (PHONE ? 5 : 6) * r; };
  field.frustumCulled = false; field.name = 'waves-field';

  const PER = TAIL + ACROSS, nP = (SWELL_N + WIND_N) * PER, seed = new Float32Array(nP), tail = new Float32Array(nP), kind = new Float32Array(nP), across = new Float32Array(nP);
  const AX = [-1, -0.5, 0.5, 1];
  for (let i = 0, q = 0; i < SWELL_N + WIND_N; i++) for (let k = 0; k < PER; k++, q++) {
    seed[q] = i + 1; kind[q] = i >= SWELL_N ? 1 : 0;
    if (k < TAIL) tail[q] = k / TAIL; else across[q] = AX[k - TAIL];
  }
  const partGeo = new THREE.BufferGeometry();
  partGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nP * 3), 3));
  partGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  partGeo.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));
  partGeo.setAttribute('aKind', new THREE.BufferAttribute(kind, 1));
  partGeo.setAttribute('aAcross', new THREE.BufferAttribute(across, 1));
  partGeo.setDrawRange(0, 0);
  const partMat = new THREE.ShaderMaterial({
    uniforms: { ...sea, uTime: { value: 0 }, uTL: { value: TIMELAPSE }, uSize: { value: 0.009 * radius }, uScale, uMaxPx: { value: 6 * dpr },
      uCap: { value: (PHONE ? 5 : 6) * dpr }, uShowSwell: { value: 1 }, uShowWind: { value: 1 }, uTail: { value: PHONE ? 0.1 : 0.085 }, uR: { value: radius + LIFT_PART }, uOpacity: { value: 1 } },
    vertexShader: PART_VERT, fragmentShader: DOT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const parts = new THREE.Points(partGeo, partMat);
  parts.frustumCulled = false; parts.name = 'waves-swell';
  parts.renderOrder = 6;

  // ---- swell crest lines: a sphere drawn per pixel from a phase texture over the view (see LINE_FRAG, solvePhase) ----
  const half = (THREE.DataUtils && THREE.DataUtils.toHalfFloat) ? THREE.DataUtils.toHalfFloat : null;
  const phaseTex = new THREE.DataTexture(half ? new Uint16Array(PHASE_N * PHASE_N) : new Float32Array(PHASE_N * PHASE_N), PHASE_N, PHASE_N,
    THREE.RedFormat, half ? THREE.HalfFloatType : THREE.FloatType);
  phaseTex.magFilter = phaseTex.minFilter = THREE.LinearFilter; phaseTex.generateMipmaps = false; phaseTex.needsUpdate = true;
  const depthTex = new THREE.DataTexture(new Uint8Array([255]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType); depthTex.needsUpdate = true;
  const crestU = { ...sea, uPhase: { value: phaseTex }, uDepth: { value: depthTex }, uBox: { value: new THREE.Vector4(0, 0, 1, 1) }, uF: { value: 0 },
    uW: { value: (PHONE ? 1.8 : 1.6) * dpr }, uOpacity: { value: 1 }, uShow: { value: 1 }, uK: { value: 0 }, uDmax: { value: D_MAX }, uDom: { value: new THREE.Vector2(1, 0) } };
  const lineMat = new THREE.ShaderMaterial({ uniforms: crestU, vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, transparent: true, depthWrite: false,
    blending: THREE.NormalBlending, side: THREE.FrontSide });
  const lines = new THREE.Mesh(new THREE.SphereGeometry(radius + LIFT_PART, PHONE ? 128 : 256, PHONE ? 64 : 128), lineMat);
  lines.frustumCulled = false; lines.name = 'waves-crests'; lines.renderOrder = 10;   // above the field and the wind (9)
  lines.onBeforeRender = (renderer) => { crestU.uW.value = (PHONE ? 1.8 : 1.6) * renderer.getPixelRatio(); };
  let depth = null, depthOk = false;                     // CPU copy of the depth grid for the solver: { b, w, h }
  (async () => {
    try {
      const [w, h] = PHONE ? [1350, 675] : [2700, 1350];
      const r = await fetch(new URL(`./data/depth_${PHONE ? 'lo' : 'hi'}.bin.gz`, import.meta.url));
      if (!r.ok) throw new Error('depth HTTP ' + r.status);
      const b = new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
      if (b.length !== w * h) throw new Error('depth grid size');
      const t = new THREE.DataTexture(b, w, h, THREE.RedFormat, THREE.UnsignedByteType);
      t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping; t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
      crestU.uDepth.value = t; depth = { b, w, h }; depthOk = true; solveKey = ''; text();
    } catch (e) { /* no depth: lines still drawn, straight (no bending), no land cut */ }
  })();
  // depth in metres at (lat, lon) degrees, bilinear; 0 on land
  function depthM(lat, lon) {
    const { b, w, h } = depth;
    const x = ((lon % 360) + 360) % 360 / 360 * w - 0.5, y = (lat + 90) / 180 * h - 0.5;
    const x0 = Math.floor(x), y0 = Math.max(0, Math.min(h - 2, Math.floor(y))), fx = x - x0, fy = Math.max(0, Math.min(1, y - y0));
    const at = (i, j) => { const v = b[i * w + ((j % w) + w) % w]; if (!v) return -50; const q = (v - 1) / 254; return D_MAX * q * q; };
    const v = (at(y0, x0) * (1 - fx) + at(y0, x0 + 1) * fx) * (1 - fy) + (at(y0 + 1, x0) * (1 - fx) + at(y0 + 1, x0 + 1) * fx) * fy;
    return v > 0 ? v : 0;
  }
  const crOf = (d, T) => { if (d <= 0) return 0; const k = 4.0243 * d / (T * T); return Math.tanh(k / Math.sqrt(Math.tanh(k))); };
  // The solve: a box around the point under the camera, the dominant swell from the shown step, travel time by fast sweeping.
  let solveKey = '', solved = null, base = 0, lastSolve = 0;
  const camL = new THREE.Vector3();
  function solvePhase(camera) {
    if (!shown || !camera) return;
    camL.copy(camera.position); lines.worldToLocal(camL);
    const len = camL.length() / radius, alt = len - 1;
    crestU.uK.value = 1 - Math.min(1, Math.max(0, (alt - 0.6) / 0.3));        // the lines are a regional view: gone above ~0.9
    if (crestU.uK.value <= 0) return;
    const lat = Math.asin(Math.max(-1, Math.min(1, camL.y / camL.length()))) * 57.2958, lon = ((Math.atan2(-camL.z, camL.x) * 57.2958) + 360) % 360;
    const halfKm = Math.max(4, Math.min(3200, alt * 6371 * 1.05));            // a little wider than the view
    const cosl = Math.max(0.2, Math.cos(lat / 57.2958));
    const hLat = Math.min(80, halfKm / 111.2), hLon = Math.min(170, halfKm / (111.2 * cosl));
    // re-solve only when the view moved a good part of the box, the zoom changed, or the step changed
    const key = `${shown.i}|${shown.j}|${sea.uMix.value < 0.5 ? 0 : 1}|${depthOk}`;
    const now = performance.now();
    if (solved && key === solveKey && Math.abs(lat - solved.lat) < solved.hLat * 0.25 && Math.abs(((lon - solved.lon + 540) % 360) - 180) < solved.hLon * 0.25
      && Math.abs(Math.log(halfKm / solved.halfKm)) < 0.25) return;
    if (now - lastSolve < 250) return;
    lastSolve = now;
    const st = sea.uMix.value < 0.5 ? shown.s0 : shown.s1;
    // dominant swell in the box: direction weighted by height squared, period weighted the same
    // (at least ~130 km around: close to the coast the model has no cells, so the swell offshore is used)
    const sLat = Math.max(hLat, 1.2), sLon = Math.max(hLon, 1.2 / cosl);
    let ex = 0, ny = 0, tw = 0, tp = 0;
    for (let a = 0; a < 14; a++) for (let c = 0; c < 14; c++) {
      const v = sampleAt(st, lat + (a / 13 - 0.5) * 2 * sLat, lon + (c / 13 - 0.5) * 2 * sLon);
      if (!v || !(v.sH > 0.2)) continue;
      const g = (v.sFrom + 180) / 57.2958, w = v.sH * v.sH;
      ex += Math.sin(g) * w; ny += Math.cos(g) * w; tw += w; tp += v.sT * w;
    }
    if (!tw || Math.hypot(ex, ny) < 0.2 * tw) { crestU.uK.value = 0; return; }   // no swell, or no dominant direction
    const dl = Math.hypot(ex, ny), dx = ex / dl, dy = ny / dl, T = Math.max(5, tp / tw);
    const N = PHASE_N, km = new Float32Array(N), t = new Float32Array(N * N), slow = new Float32Array(N * N);
    const hy = 2 * hLat * 111.2 / (N - 1);
    for (let i = 0; i < N; i++) km[i] = 2 * hLon * 111.2 * Math.max(0.05, Math.cos((lat + (i / (N - 1) - 0.5) * 2 * hLat) / 57.2958)) / (N - 1);
    const lam = 2 * halfKm / 1.05 / CRESTS_ON_SCREEN * Math.max(0.8, Math.min(1.25, T * T / 144));   // drawn spacing, km
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const la = lat + (i / (N - 1) - 0.5) * 2 * hLat, lo = lon + (j / (N - 1) - 0.5) * 2 * hLon;
      const c = depth ? crOf(depthM(la, lo), T) : 1;
      slow[i * N + j] = c > 0 ? 1 / Math.max(c, 0.35) : 6;   // floor at c/c0 0.35: the bending stays, the crests do not pile up
      t[i * N + j] = Infinity;
    }
    // sources: the cells on the up-swell edges of the box, as a straight front square to the swell
    const xkm = (i, j) => (j - (N - 1) / 2) * km[i], ykm = (i) => (i - (N - 1) / 2) * hy;
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
      const up = (j === 0 && dx > 0.05) || (j === N - 1 && dx < -0.05) || (i === 0 && dy > 0.05) || (i === N - 1 && dy < -0.05);
      if (up && slow[i * N + j] < 2) t[i * N + j] = xkm(i, j) * dx + ykm(i) * dy;
    }
    const upd = (i, j) => {
      const k = i * N + j, hx = km[i];
      const a = Math.min(j > 0 ? t[k - 1] : Infinity, j < N - 1 ? t[k + 1] : Infinity);
      const b = Math.min(i > 0 ? t[k - N] : Infinity, i < N - 1 ? t[k + N] : Infinity);
      if (a === Infinity && b === Infinity) return;
      const f = slow[k];
      let v;
      if (a === Infinity) v = b + f * hy; else if (b === Infinity) v = a + f * hx;
      else {
        // (v - a)^2 / hx^2 + (v - b)^2 / hy^2 = f^2
        const A = 1 / (hx * hx) + 1 / (hy * hy), B = -2 * (a / (hx * hx) + b / (hy * hy)), C = a * a / (hx * hx) + b * b / (hy * hy) - f * f;
        const disc = B * B - 4 * A * C;
        v = disc >= 0 ? (-B + Math.sqrt(disc)) / (2 * A) : Math.min(a + f * hx, b + f * hy);
        if (v < Math.max(a, b)) v = Math.min(a + f * hx, b + f * hy);
      }
      if (v < t[k]) t[k] = v;
    };
    for (let it = 0; it < 2; it++) {
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) upd(i, j);
      for (let i = 0; i < N; i++) for (let j = N - 1; j >= 0; j--) upd(i, j);
      for (let i = N - 1; i >= 0; i--) for (let j = 0; j < N; j++) upd(i, j);
      for (let i = N - 1; i >= 0; i--) for (let j = N - 1; j >= 0; j--) upd(i, j);
    }
    // phase in crests; keep the crest under the view centre where it was (no jump on a re-solve), small numbers for half floats
    const ci = (N - 1) >> 1, tc = t[ci * N + ci];
    const ph = (k) => (isFinite(t[k]) ? (t[k] - (isFinite(tc) ? tc : 0)) / lam : 0);
    const out = phaseTex.image.data;
    for (let k = 0; k < N * N; k++) { const v = Math.max(-2000, Math.min(2000, ph(k))); out[k] = half ? half(v) : v; }
    phaseTex.needsUpdate = true;
    // continuity: the old phase at the centre point
    const tNow = partMat.uniforms.uTime.value;
    if (solved) {
      const oldF = solved.phaseAt(lat, lon) - (solved.base + tNow * solved.rate);
      base = 0 - oldF - tNow * rateOf(T);
    } else base = 0;
    const rate = rateOf(T);
    const box = { lat, lon, hLat, hLon, halfKm, base, rate };
    box.phaseAt = (la, lo) => {                            // nearest cell, for the continuity step only
      const i = Math.round(((la - lat) / (2 * hLat) + 0.5) * (N - 1)), j = Math.round(((((lo - lon + 540) % 360) - 180) / (2 * hLon) + 0.5) * (N - 1));
      return i >= 0 && i < N && j >= 0 && j < N ? ph(i * N + j) : 0;
    };
    solved = box; solveKey = key;
    crestU.uBox.value.set(lat, lon, 2 * hLat, 2 * hLon);
    crestU.uDom.value.set(dx, dy);
    lines.userData.solve = { T: +T.toFixed(1), dir: Math.round((Math.atan2(dx, dy) * 57.2958 + 360) % 360), lamKm: +lam.toFixed(1), halfKm: Math.round(halfKm) };
  }
  // the crests move forward one spacing every ~4 s for 12 s swell (faster for longer swell): calm, readable, in step
  const rateOf = (T) => 0.25 * Math.max(0.7, Math.min(1.4, T / 12));

  const layer = new THREE.Group();
  layer.name = 'waves';
  layer.add(field, parts, lines);

  let state = 'waiting', err = '', fc = null, model = null, mode = 0, shown = null, want = 0, camera = null, fallback = false;
  const res = PHONE ? 'lo' : 'hi';

  // ---- time: pick the two steps around the bar's time, load them, blend ----
  function bracket(t) {
    const s = fc.steps;
    if (s.length === 1 || t <= s[0].valid) return [0, Math.min(1, s.length - 1), 0];
    for (let i = 0; i < s.length - 1; i++) if (t < s[i + 1].valid) return [i, i + 1, (t - s[i].valid) / (s[i + 1].valid - s[i].valid)];
    return [s.length - 1, s.length - 1, 0];
  }
  async function onTime(t) {
    if (!fc) return;
    const [i, j, f] = bracket(t), mine = ++want;
    const ready = shown && shown.i === i && shown.j === j;
    if (ready) { sea.uMix.value = f; return; }
    timeBar.setLoading(true);
    try {
      const [s0, s1] = await Promise.all([fc.step(i), fc.step(j)]);
      if (mine !== want && !timeBar.playing) return;      // the viewer moved on while this loaded (playing: show it anyway)
      put(s0, s1, i, j, f);
      if (mine === want) timeBar.setLoading(false);
      // fetch ahead: the next few while playing, a neighbour each side otherwise
      const ahead = timeBar.playing ? [j + 1, j + 2, j + 3] : [i - 1, j + 1];
      for (const k of ahead) if (k >= 0 && k < fc.steps.length) fc.step(k).catch(() => {});
      fc.trim(i);
    } catch (e) { timeBar.setLoading(false); err = e.message || 'network error'; text(); }
  }
  function put(s0, s1, i, j, f) {
    sea.uA0.value = s0.texA; sea.uA1.value = s1.texA; sea.uB0.value = s0.texB; sea.uB1.value = s1.texB;
    sea.uM0.value = s0.mask.tex; sea.uM1.value = s1.mask.tex;
    sea.uG0.value.set(s0.grid.nLon, s0.grid.nLat, s0.grid.step); sea.uG1.value.set(s1.grid.nLon, s1.grid.nLat, s1.grid.step);
    sea.uMix.value = (i === j) ? 0 : f;
    shown = { i, j, s0, s1 };
    field.visible = true; partGeo.setDrawRange(0, nP); solveKey = '';
    text();
  }
  timeBar.onTime((t) => { if (layer.visible) onTime(t); });

  async function load() {
    state = 'loading'; model = getModel(); shown = null; text();
    try {
      fc = await loadForecast(THREE, model, res);
      fallback = false;
      const run = Date.parse(fc.manifest.run), hiTo = fc.steps.filter((s) => s.res === 'hi').pop();
      timeBar.setSteps(fc.steps, { model: label(), run, partitions: fc.manifest.partitions, hiTo: res === 'hi' && hiTo ? hiTo.valid : null }, 'waves');
    } catch (e) {
      // no forecast files (not built or not hosted yet): the single snapshot, as before
      try {
        const w = await loadWaves(model);
        const s = stepFromSnapshot(THREE, w), valid = Date.parse(w.meta.validWaves);
        fc = { manifest: { run: valid, partitions: model === 'gfs', model: w.meta.waves.model, attribution: '' }, steps: [{ fh: 0, valid, res: 'snap' }],
          step: async () => s, trim: () => {} };
        fallback = true;
        timeBar.setSteps(fc.steps, { model: label() + ' (snapshot only)', run: valid, partitions: model === 'gfs' }, 'waves');
      } catch (e2) { err = (e && e.message) || 'network error'; state = 'failed'; text(); return; }
    }
    state = 'ok';
    applyMode();
    if (layer.visible) timeBar.need('waves', true);
    await onTime(timeBar.time);
  }
  const label = () => (model === 'ecmwf' ? 'ECMWF IFS ecWAM' : 'NOAA GFS-Wave (WAVEWATCH III)');

  function applyMode() {
    const part = !fc || fc.manifest.partitions !== false;
    if (!part && mode !== 0) mode = 0;
    fieldMat.uniforms.uMode.value = mode;
    partMat.uniforms.uShowSwell.value = mode !== 2 ? 1 : 0;
    crestU.uShow.value = mode !== 2 ? 1 : 0;
    partMat.uniforms.uShowWind.value = part && mode !== 1 ? 1 : 0;
    syncModes();
  }

  // ---- text for the panel ----
  const fmt = (ms) => { const d = new Date(ms); return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`; };
  function text() {
    const m = fc && fc.manifest, part = !m || m.partitions !== false;
    layer.label = `Waves: ${model === 'ecmwf' ? 'ECMWF' : 'GFS-Wave'}${m && !fallback ? `, run ${fmt(Date.parse(m.run))}` : ''}`;
    layer.details = `${SAFETY} For research and play only. Not a forecast or warning service. Model output, not measurement. ` +
      `Model: ${label()}${m && !fallback ? `, run ${fmt(Date.parse(m.run))}, ${fc.steps.length} steps to +${fc.steps[fc.steps.length - 1].fh} h` : ''}. ` +
      `Colour: significant wave height (roughly the average of the highest third of the waves) of the ${MODE_NAMES[mode].toLowerCase()}, on a fixed scale (legend in the time bar). ` +
      `The dots sit a few pixels apart at every zoom and are display only, not data points; each reads the model between its grid points (${PHONE ? '1 degree, about 110 km' : '0.5 degree, about 55 km, to +5 days; 1 degree after'}), so nothing finer than the model is shown. ` +
      (part ? `White lines (zoomed in to a region): crests of the dominant swell in view, square to the way it is going. They are lines of equal phase, worked out over the view from a straight front that enters square to the swell and moves at the local wave speed, which drops over the shelf (GEBCO 2026 depth${depthOk ? '' : ', still loading'}, and the swell's period): so the crests bend toward shallow water and wrap toward the coast, never cross, and stop at land (refraction, drawn by this page, not by the wave model; the depth grid cannot see sandbars, reefs or harbour walls). ` +
        `They are spaced about ${CRESTS_ON_SCREEN} to a view, not at the real wavelength (12 s swell: 225 m), and move forward together, about one spacing every 4 s: a picture of direction and bending, not single waves. Only the dominant swell in view is drawn; where the swell is very small the lines fade. A dark edge keeps them readable over the colours. ` :
`White lines: crests of the whole sea, by its mean direction and peak period (ECMWF's open data has no swell / wind-sea split), bent over the shelf by the depth as described for GFS. `) +
      `The lines and dots are an illustration of direction and period, not single waves. Between forecast steps the picture is blended in time. Beyond 5 days the forecast is less certain. ` +
      `No colour means no model data: land and sea ice. The model cannot see inside bays or around headlands. ` +
      (m && m.attribution ? `Data: ${m.attribution}` : '');
    let st = '';
    if (state === 'waiting' || state === 'loading') st = 'Loading the wave forecast…';
    else if (state === 'failed') st = `Wave data not available (${err}); nothing drawn. Run pieces/11-ocean/build_forecast.py.`;
    else if (shown) {
      const s = fc.steps[sea.uMix.value < 0.5 ? shown.i : shown.j];
      st = `Shown: ${fmt(timeBar.time)} (blended between forecast steps).` + (s.peak ? ` Highest at the nearest step: ${s.peak.hs.toFixed(1)} m near ${Math.abs(s.peak.lat)}°${s.peak.lat < 0 ? 'S' : 'N'} ${Math.abs(s.peak.lon)}°${s.peak.lon < 0 ? 'W' : 'E'}.` : '') +
        (fallback ? ' Forecast files not found: showing the single snapshot.' : '');
    }
    layer.status = st;
    layer.userData.onChange?.(layer);
  }

  // ---- mode chips under the panel row (Total / Swell / Wind sea), like the model switch ----
  const modeGroups = new Set();
  function syncModes() {
    const part = !fc || fc.manifest.partitions !== false;
    for (const g of modeGroups) {
      g.querySelectorAll('button').forEach((b) => { const on = Number(b.dataset.mode) === mode; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.disabled = !part && b.dataset.mode !== '0'; b.style.opacity = b.disabled ? 0.35 : ''; });
    }
  }
  (function mountModes(tries = 0) {
    if (typeof document === 'undefined') return;
    const row = layer.userData.row;
    if (!row || !row.parentElement) { if (tries < 200) setTimeout(() => mountModes(tries + 1), 100); return; }
    const g = document.createElement('div');
    g.className = 'layer-modes ocean-wavemode'; g.setAttribute('role', 'group'); g.setAttribute('aria-label', 'Show');
    g.style.margin = '0 0 4px 22px';
    const lab = document.createElement('span'); lab.textContent = 'Show'; lab.style.cssText = 'font-size:11px;opacity:.7;align-self:center;margin-right:2px';
    g.appendChild(lab);
    MODE_NAMES.forEach((name, k) => {
      const b = document.createElement('button'); b.type = 'button'; b.dataset.mode = String(k); b.textContent = name;
      b.title = ['All waves together (significant wave height)', 'The primary swell partition: waves from far away', 'Waves raised by the local wind'][k];
      b.onclick = (e) => { e.preventDefault(); e.stopPropagation(); mode = k; applyMode(); text(); };
      g.appendChild(b);
    });
    // under the model switch if it is there (ocean_model.js puts it straight under the row)
    const after = row.nextElementSibling && row.nextElementSibling.classList.contains('ocean-model') ? row.nextElementSibling : row;
    after.after(g); modeGroups.add(g);
    const box = row.querySelector('input[type=checkbox]');
    const show = () => { g.style.display = box && !box.checked ? 'none' : 'flex'; };
    if (box) box.addEventListener('change', show);
    show(); syncModes();
  })();

  // ---- readout: hover (desktop) or the centre of the view (phone) ----
  const tip = typeof document !== 'undefined' ? document.createElement('div') : null;
  if (tip) {
    tip.id = 'wave-tip';
    tip.style.cssText = 'position:fixed;z-index:7;pointer-events:none;padding:5px 8px;border-radius:7px;font:11.5px/1.35 system-ui,sans-serif;color:#e6f6ff;' +
      'background:color-mix(in srgb,#060e16 86%,transparent);border:1px solid rgba(95,242,255,.2);white-space:nowrap;display:none;font-variant-numeric:tabular-nums';
    document.body.appendChild(tip);
  }
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), sph = new THREE.Sphere(), hit = new THREE.Vector3();
  function pick(x, y) {
    if (!camera || !shown) return null;
    const c = layer.parent ? layer.parent.getWorldPosition(new THREE.Vector3()) : new THREE.Vector3();
    sph.set(c, radius);
    ndc.set(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectSphere(sph, hit)) return null;
    const p = layer.worldToLocal(hit.clone()).normalize();
    const lat = Math.asin(p.y) / D2R, lon = Math.atan2(-p.z, p.x) / D2R;
    const s = sea.uMix.value < 0.5 ? shown.s0 : shown.s1;
    const v = sampleAt(s, lat, lon);
    return v && { ...v, lat, lon };
  }
  const part = () => !fc || fc.manifest.partitions !== false;
  function describe(v, short) {
    let s = `${v.hs.toFixed(1)} m`;
    if (part()) {
      if (v.sH >= 0.1) s += ` · swell ${v.sH.toFixed(1)} m ${Math.round(v.sT)} s from ${compass(v.sFrom)}`;
      if (v.wH >= 0.1 && !short) s += ` · wind sea ${v.wH.toFixed(1)} m from ${compass(v.wFrom)}`;
    } else if (v.sT > 0) s += ` · ${Math.round(v.sT)} s from ${compass(v.sFrom)}`;
    return s;
  }
  if (tip && !PHONE) {
    let pend = null;
    addEventListener('pointermove', (e) => {
      if (!layer.visible || state !== 'ok' || e.target.tagName !== 'CANVAS' || e.buttons) { tip.style.display = 'none'; return; }
      pend = [e.clientX, e.clientY];
    });
    setInterval(() => {
      if (!pend) return;
      const [x, y] = pend; pend = null;
      const v = pick(x, y);
      if (!v) { tip.style.display = 'none'; return; }
      tip.innerHTML = `<b>${describe(v)}</b><br><span style="opacity:.65">${Math.abs(v.lat).toFixed(1)}°${v.lat < 0 ? 'S' : 'N'} ${Math.abs(v.lon).toFixed(1)}°${v.lon < 0 ? 'W' : 'E'} · model cell, not a spot forecast</span>`;
      tip.style.left = (x + 14) + 'px'; tip.style.top = (y + 14) + 'px'; tip.style.display = 'block';
    }, 80);
  }
  if (PHONE) setInterval(() => {
    if (!layer.visible || state !== 'ok') return;
    const v = pick(innerWidth / 2, innerHeight / 2);
    timeBar.setReadout(v ? `Centre: ${describe(v, true)}` : 'Centre: land or sea ice (no wave data)');
  }, 500);

  // ---- the globe's hooks ----
  let dim = 1;
  layer.update = (t, cam) => {
    if (cam) camera = cam;
    if (state === 'waiting') load();
    partMat.uniforms.uTime.value = t;
    if (solved) crestU.uF.value = solved.base + t * solved.rate;
    if (state === 'ok' && layer.visible) solvePhase(camera);
  };
  layer.setDim = (k) => { dim = Math.max(0, Math.min(1, k)); fieldMat.uniforms.uOpacity.value = FIELD_OP * dim; partMat.uniforms.uOpacity.value = dim; crestU.uOpacity.value = dim; };
  layer.setPalette = () => {};       // fixed height scale on purpose (wave_colours.js)
  // show / hide the bar with the layer (the globe only flips .visible and stops calling update)
  let wasVisible = null;
  setInterval(() => {
    const v = layer.visible && !!layer.parent;
    if (v === wasVisible) return;
    wasVisible = v;
    if (v && state === 'ok') { timeBar.need('waves', true); onTime(timeBar.time); } else if (!v) { timeBar.need('waves', false); if (tip) tip.style.display = 'none'; }
  }, 300);
  onOceanUpdate(() => { if ((state === 'ok' || state === 'failed') && getModel() !== model) load(); });   // the GFS / ECMWF switch
  mountModelSwitch(layer);
  layer.userData.layer = { get state() { return state; }, load, timeBar, get shown() { return shown; }, setMode: (k) => { mode = k; applyMode(); text(); } };
  text();
  return layer;
}
