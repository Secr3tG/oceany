// Oceany globe front page. Plain ES module, three.js 0.187.0 from the seafloor viewer's vendor folder (import map in index.html).
// Everything is drawn as glowing dots in the seafloor viewer's style (dots.js), so later layers can move in 3D.
//
// Layer plug-in contract (other pieces meet this; see layers.json):
//   globe radius 1.0, centred at the origin; lat/lon in degrees ->
//   x = cos(lat)·cos(lon), y = sin(lat), z = −cos(lat)·sin(lon)
//   a layer module exports
//     async function createLayer({ THREE, radius, makeDotMaterial, palette, latLonToVector3 })
//   returning a THREE.Object3D (THREE.Points in the house style is preferred). If it has .update(timeSeconds),
//   that is called every frame. The layer's checkbox toggles its .visible. A module that fails to load is skipped.
//   Optional layer methods the globe uses when present (all degrade quietly when absent):
//     .label / .status (strings), .setMode(m), .update(t, camera),
//     .getFocusTargets() -> [{lat, lon, rating, name}] strongest first: adds "Fly to strongest storm" (fly in low and follow),
//     .setDim(k) 0..1: the globe dims the other layers to 0.25 while the 'tornado-live' layer is on,
//     .setShowPaths(bool): adds a "show all paths" checkbox under the layer, default off.
import * as THREE from 'three';
import { makeDotMaterial, palette, setPalette, PALETTES, updateDotScale, dotScale, dotExag, seaExag, applyCssPalette, landTone, oceanTone, LAND_DOT_D, HUE_MAX, ICE_LAT } from './dots.js';
import { createTerrain } from './terrain.js?v=b53';
import { USE_AWS as TERRAIN_AWS } from './terrain-source.js?v=t5';

const RADIUS = 1.0;
const D2R = Math.PI / 180;
export function latLonToVector3(lat, lon, r = RADIUS) {
  const la = lat * D2R, lo = lon * D2R;
  return new THREE.Vector3(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
}

// ---------- renderer, scene, camera ----------
const canvas = document.getElementById('globe');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });   // MSAA does nothing for round point sprites
// LITE: a phone or tablet (primary pointer is a finger) or a small screen; ?lite=1 / ?lite=0 forces it. Asks the
// terrain for fewer tiles in the cache (terrain.js lite). Dot sizes are set in css px, so the look stays the same, only cheaper.
const LITE = (() => { const q = new URLSearchParams(location.search).get('lite'); if (q === '1' || q === '0') return q === '1';
  return matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 500; })();
// dad 2026-11-23 night (item 7, approved): one device switch for both pages. 'phone' = LITE: no layers on at first load
// except hurricanes, half the star field (the brightest half), card-only way into 3D (a pinch never opens it), the lite
// terrain budgets above; dots are never thinned. 'desktop' = everything. The viewer gets it as ?profile= (enterSpot).
const PROFILE = LITE ? 'phone' : 'desktop';
// phone 2026-11-23 late: the LITE cap 1.5 → 2 (same as desktop). At 1.5 a 3× iPhone stretched every frame 2×, which with
// the later tile split below read as soft blobs at Peniche; 390×844 at 2× is still a quarter of a desktop's pixels.
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
// palette.bg and .night are CSS-style sRGB values (as the page's colours); the renderer converts its clear colour and
// MeshBasicMaterial colours from linear, so they are read as sRGB here (read as linear they came out grey: #222b38)
const srgb = c => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);
renderer.setClearColor(srgb(palette.bg));             // the seafloor viewer's clear colour #04060a (palette.bg, dots.js)
applyCssPalette();                                     // the page's CSS colours come from the same palette
renderer.autoClear = false;                            // stars are drawn first in their own pass (see animate)
const starScene = new THREE.Scene();
const BASE_FOV = 40;
const camera = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.005, 100);
const starCam = new THREE.PerspectiveCamera(BASE_FOV, 1, 0.5, 100);

// ---------- camera rig ----------
// The camera always looks at a ground point. view.n: unit vector to that point; view.alt: camera distance from it in
// globe radii (what the zoom slider sets; straight down it is the altitude); view.heading: compass direction the camera
// faces (rad, 0 = north, + = east); view.pitch: angle away from straight down (rad). Pitch is automatic (it grows as
// the zoom slider goes in, see autoPitch) unless view.manual holds a value from the tilt slider or a tilt drag.
// view.look lifts the looked-at point above the ground (used to centre a storm column when following it).
// The camera is kept above a floor: about 2 km over the loaded terrain under it (terrain on) or the sea (terrain off).
// The rig's facing is kept as a tangent vector, view.f (unit, ⟂ n), not as an angle from north: north is undefined at the
// poles and swings round fast near them, so a heading held against north made the view whirl there. Every move of n
// carries f with it: rotateRig(q) turns both by the same rotation (drag, spin, zoom-to-cursor), and anything that sets
// n directly (flights, follow) is carried by the shortest rotation from where n was (rigFrame). view.heading (compass,
// rad, 0 = north, + = east) is derived from f for the hand-off link and the N button, and setting it sets f.
let detailFloor = 0;   // zoom floor where our terrain tiles stop (radii; 0 = none), see updateDetailFloor
const view = { n: latLonToVector3(25, -30, 1).normalize(), f: new THREE.Vector3(0, 1, 0), alt: 2.6, pitch: 0, manual: null, look: 0 };
// Start looking at the Atlantic (HOME below): Europe, Africa and the Americas in view, Portugal and France near the middle.
const WHOLE_ALT = 0.6;           // radii: from here out the view counts as whole-globe and keeps north up (northFrame)
const HOME = { lat: 25, lon: -30, alt: 2.6 };   // Home view: Atlantic-centred, Europe, Africa and the Americas in view
const PITCH_AUTO = 72 * D2R;     // auto tilt at the closest zoom
const PITCH_MAX = 92 * D2R;      // manual tilt limit: a touch past level, so a low camera can look up at a storm column
const north = new THREE.Vector3(), east = new THREE.Vector3(), fwd = new THREE.Vector3(), right = new THREE.Vector3();
const rigN = view.n.clone(), rigQ = new THREE.Quaternion();
function northAt(n) {                                  // local north (and east) at n; at a pole: a fixed tangent, so get/set agree
  north.set(0, 1, 0).addScaledVector(n, -n.y);
  if (north.lengthSq() < 1e-10) north.set(0, 0, -1).addScaledVector(n, -n.z);
  north.normalize(); east.copy(north).cross(n);
}
Object.defineProperty(view, 'heading', {
  get() { northAt(view.n); return Math.atan2(view.f.dot(east), view.f.dot(north)); },
  set(h) { northAt(view.n); view.f.copy(north).multiplyScalar(Math.cos(h)).addScaledVector(east, Math.sin(h)); rigN.copy(view.n); },
});
view.heading = 0;
function rotateRig(q) { view.n.applyQuaternion(q).normalize(); view.f.applyQuaternion(q); rigN.copy(view.n); }
function rigFrame() {                                  // fwd: horizontal facing direction at n (from f); right = fwd × n
  const n = view.n;
  if (rigN.distanceToSquared(n) > 1e-14) { view.f.applyQuaternion(rigQ.setFromUnitVectors(rigN, n)); rigN.copy(n); }   // n moved directly: carry f along
  view.f.addScaledVector(n, -view.f.dot(n));
  if (view.f.lengthSq() < 1e-10) { northAt(n); view.f.copy(north); }
  view.f.normalize();
  fwd.copy(view.f); right.copy(fwd).cross(n);
}
const sliderFrac = a => Math.max(0, Math.min(1, Math.log(ALT_MAX / a) / Math.log(ALT_MAX / altMin())));
const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const autoPitch = a => PITCH_AUTO * smooth((sliderFrac(a) - 0.4) / 0.6);   // straight down for the outer 40% of the slider
const pitchLimit = a => PITCH_MAX - (PITCH_MAX - 45 * D2R) * Math.max(0, Math.min(1, Math.log(a) / Math.log(ALT_MAX)));  // far: ≤45°
const camLL = { lat: 0, lon: 0 };
function cameraFloor() {                               // lowest camera distance from the globe centre, radii
  if (!terrain.enabled) return RADIUS + 0.0004;
  const p = camera.position, r = p.length();
  const h = terrain.elevationAt(Math.asin(p.y / r) / D2R, Math.atan2(-p.z, p.x) / D2R);
  return RADIUS + Math.max(0, h || 0) * dotExag.value / 6371000 + 0.00035;
}
// Place the camera from the rig. dt > 0 eases pitch, look-up and field of view; dt = 0 places it as is.
const lookPt = new THREE.Vector3();
function applyView(dt) {
  const k = Math.min(1, dt * 5);
  const target = Math.min(pitchLimit(view.alt), view.manual ?? autoPitch(view.alt));
  if (!flight) view.pitch += (target - view.pitch) * k;
  view.look += ((follow ? follow.look : 0) - view.look) * Math.min(1, dt * 3);
  const fovT = fitFov();
  if (Math.abs(camera.fov - fovT) > 0.01 && dt > 0) {
    camera.fov += (fovT - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); updateDotScale(renderer, camera);
  }
  const a = RADIUS + view.look, d = view.alt;
  const place = p => {
    rigFrame();
    lookPt.copy(view.n).multiplyScalar(a);
    camera.position.copy(view.n).multiplyScalar(a + d * Math.cos(p)).addScaledVector(fwd, -d * Math.sin(p));
    camera.up.copy(view.n).multiplyScalar(Math.sin(p)).addScaledVector(fwd, Math.cos(p));   // screen-up, ⟂ to the view line
    camera.lookAt(lookPt); camera.updateMatrixWorld();
  };
  place(view.pitch);
  // floor: |P|² = (a + d cos p)² + (d sin p)² ≥ R²  ⇒  cos p ≥ (R² − a² − d²) / 2ad
  const R = cameraFloor(), c = (R * R - a * a - d * d) / (2 * a * d);
  if (c > -1) { const pMax = Math.acos(Math.min(1, c)); if (view.pitch > pMax) { view.pitch = pMax; place(pMax); } }
  starCam.quaternion.copy(camera.quaternion);          // starCam stays at the centre: stars at infinity
  if (starCam.fov !== camera.fov || starCam.aspect !== camera.aspect) { starCam.fov = camera.fov; starCam.aspect = camera.aspect; starCam.updateProjectionMatrix(); }
}

// Field of view: BASE_FOV vertically, widened on a portrait screen (phone) so the horizontal view is never narrower than
// BASE_FOV: the whole globe then fits the width as it fits the height on a desktop.
const fitFov = () => camera.aspect >= 1 ? BASE_FOV : 2 * Math.atan(Math.tan(BASE_FOV * D2R / 2) / camera.aspect) / D2R;
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = fitFov(); camera.updateProjectionMatrix();
  updateDotScale(renderer, camera);
}
addEventListener('resize', resize); visualViewport?.addEventListener('resize', resize); resize();   // phones: the address bar shows and hides without a window resize

// ---------- regions ----------
const { regions, wantedSpots } = await (await fetch('./regions.json', { cache: 'no-cache' })).json();
// Wanted spots from the research file named in regions.json (wantedSpots): added as wanted markers with a kind
// (wave | research | hazard). The research file is read as is; the picks (skip, quick unlock) live in regions.json.
const KINDS = ['wave', 'research', 'hazard'];
for (const r of regions) if (r.wanted && !r.kind) r.kind = 'wave';
if (wantedSpots && wantedSpots.file) {
  try {
    const res = await fetch(new URL(wantedSpots.file, location.href), { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const { entries = [] } = await res.json();
    const skip = new Set(wantedSpots.skip || []), skipLow = new Set(wantedSpots.skipIfLowConfidence || []), quick = new Set(wantedSpots.quickUnlock || []);
    const have = new Set(regions.map(r => r.id));
    for (const e of entries) {
      if (!e || have.has(e.id) || skip.has(e.id) || (skipLow.has(e.id) && e.confidence === 'low')) continue;
      if (!isFinite(e.lat) || !isFinite(e.lon) || !KINDS.includes(e.kind) || typeof e.name !== 'string') continue;
      const tier = /already available/i.test(e.needs || '') ? 'swell-model' : 'seabed';
      regions.push({ id: e.id, name: e.name, lat: +e.lat, lon: +e.lon, type: e.kind, status: 'locked', kind: e.kind,
        wanted: { needs: e.needs || '', tier }, spot: e, quick: quick.has(e.id) });
      have.add(e.id);
    }
  } catch (e) { console.info('Oceany globe: wanted spots not loaded:', e && (e.message || String(e))); }
}
for (const r of regions) { r.pos = latLonToVector3(r.lat, r.lon); r.markAt = r.pos.clone().multiplyScalar(1.0005); }
const kindOn = { wave: true, research: true, hazard: true };
const shownKind = r => !r.wanted || kindOn[r.kind] !== false;
const unlocked = regions.filter(r => r.status === 'unlocked');

// ---------- Earth: ETOPO1 relief as dots (built by build_dots.py) ----------
// A dark, unlit sphere just under the dots hides the far side.
const occluder = new THREE.Mesh(new THREE.SphereGeometry(RADIUS * 0.995, 96, 48), new THREE.MeshBasicMaterial({ color: srgb(palette.night) }));
scene.add(occluder);

const DEEP_AT = 6000;          // m: ocean colour is shallow at 0 m, mid at 3000 m, deep at 6000 m and deeper (viewer's rule)
const EARTH_DOT = 0.0058;      // world units: ~0.9 of the 0.37 degree dot spacing, as in the viewer
const meta = await (await fetch('./assets/earth_dots.json')).json();
const buf = await (await fetch('./assets/earth_dots.bin')).arrayBuffer();
const N = meta.count;
const elev = new Int16Array(buf, 0, N), shore = new Uint8Array(buf, 2 * N, N);
const earthPos = new Float32Array(N * 3), lit = new Float32Array(N);
{
  const cosIn = Math.cos(3 * D2R), cosOut = Math.cos(8 * D2R);   // unlocked regions: full within 3 deg, fading out by 8 deg
  let k = 0, seed = 12345;
  // Each dot is nudged by up to ±0.3 of the dot spacing (a fixed pseudo-random pattern): a perfectly regular grid beats
  // against the screen's pixel grid and prints moiré rings across the oceans. These dots are a ~41 km display resampling
  // of ETOPO1, not survey points, so a nudge of ±12 km at most changes no value shown.
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.6;
  const dLat = meta.rings.length > 1 ? Math.abs(meta.rings[1][0] - meta.rings[0][0]) : 0.37;
  for (const [lat0, n] of meta.rings) {
    for (let j = 0; j < n; j++, k++) {
      const la = (lat0 + rnd() * dLat) * D2R, cl = Math.cos(la), sl = Math.sin(la);
      const lo = (-180 + (j + 0.5 + rnd()) * 360 / n) * D2R;
      const x = cl * Math.cos(lo), y = sl, z = -cl * Math.sin(lo);
      earthPos[3 * k] = x * RADIUS; earthPos[3 * k + 1] = y * RADIUS; earthPos[3 * k + 2] = z * RADIUS;
      let l = 0;
      for (const r of unlocked) {
        const d = (x * r.pos.x + y * r.pos.y + z * r.pos.z) / RADIUS;
        if (d > cosOut) { const t = Math.min(1, (d - cosOut) / (cosIn - cosOut)); l = Math.max(l, t * t * (3 - 2 * t)); }
      }
      lit[k] = l;
    }
  }
}
// Mountains on the base globe: land dots are lifted along the vertical by their ETOPO1 height × dotExag (the same eased
// exaggeration as the terrain tiles, so there is no jump when the tiles come in; the readout says "heights ×N"), and
// shaded from a fixed light in the north-west (45° up, the map convention) so ranges read from straight above too.
// The sea floor stays flat here: the owner asked for mountains, and lifting the ocean would swamp them.
// Slopes come from each dot's ring neighbours (~41 km apart), so the shading shows ranges, not invented detail.
const landElev = new Float32Array(N), hshade = new Float32Array(N).fill(1);
{
  const starts = []; let k0 = 0; for (const [, n] of meta.rings) { starts.push(k0); k0 += n; }
  const R_M = 6371000, ZF = 12;                       // ZF: slope exaggeration for the shading only (41 km spacing flattens slopes)
  const zAt = (i, j) => { const n = meta.rings[i][1]; return Math.max(0, elev[starts[i] + ((j % n) + n) % n]); };
  const lx = -0.5, ly = 0.5, lz = Math.SQRT1_2;      // light from the north-west, 45° up (x east, y north, z up)
  for (let i = 0; i < meta.rings.length; i++) {
    const [lat, n] = meta.rings[i], dx = 2 * Math.PI * R_M * Math.max(0.02, Math.cos(lat * D2R)) / n;
    for (let j = 0; j < n; j++) {
      const k = starts[i] + j; landElev[k] = Math.max(0, elev[k]);
      if (elev[k] <= 0) continue;
      const nb = ii => { if (ii < 0 || ii >= meta.rings.length) return [zAt(i, j), lat]; const n2 = meta.rings[ii][1]; return [zAt(ii, Math.round((j + 0.5) * n2 / n - 0.5)), meta.rings[ii][0]]; };
      const [zA, latA] = nb(i - 1), [zB, latB] = nb(i + 1);
      const dzdx = (zAt(i, j + 1) - zAt(i, j - 1)) / (2 * dx);
      const dy = (latA - latB) * D2R * R_M, dzdy = dy ? (zA - zB) / dy : 0;   // + toward north
      const nx = -ZF * dzdx, ny = -ZF * dzdy, len = Math.hypot(nx, ny, 1);
      hshade[k] = Math.max(0, (nx * lx + ny * ly + lz) / len) / lz;          // 1 on flat ground, < 1 facing away, > 1 facing the light
    }
  }
}
// Base globe dots: one dot style with the tiles. Land dots are drawn LAND_DOT_D × their spacing wide (dots.js: EARTH_DOT is
// 0.9 of the spacing, so LAND_SIZE = LAND_DOT_D / 0.9): their bright centres stay apart, so the whole globe reads as a
// cloud of glowing dots, not a painted surface, and the lit share of the screen (so the brightness) is the same as on the
// tiles close in. Sea dots are wider and overlap into a calm field (ETOPO1's sea floor is smooth at this scale).
// Additive blending sums the overlaps, so colours stay well under 1 (dots.js HUE_MAX clamps any dot, hue kept).
// Hillshade clamps HS_MIN..HS_MAX (gentler on the ice sheets, ICE_HS); land next to the sea × SHORE_K.
const LAND_SIZE = LAND_DOT_D / 0.9, SEA_SIZE = 2.4, BASE_LAND = 1, BASE_SEA = 1.6, HS_MIN = 0.65, HS_MAX = 1.45, SHORE_K = 1.2, ICE_HS = 0.35;
const BASE_MAX_PX = 12, BASE_CAP_COMP = 3;   // css px cap per dot (18 read as big soft discs at mid zoom); capped dots brightened up to ×3 (dots.js capComp; hue kept by HUE_MAX)
const mixC = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const earthGeo = new THREE.BufferGeometry();
earthGeo.setAttribute('position', new THREE.BufferAttribute(earthPos, 3));
earthGeo.setAttribute('aElev', new THREE.BufferAttribute(landElev, 1));
const earthSize = new Float32Array(N);
for (let i = 0; i < N; i++) earthSize[i] = elev[i] > 0 ? LAND_SIZE : SEA_SIZE;
earthGeo.setAttribute('aSize', new THREE.BufferAttribute(earthSize, 1));
const earthColor = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
earthGeo.setAttribute('color', earthColor);
function colourEarth() {
  const p = palette;
  for (let i = 0; i < N; i++) {
    const h = elev[i];
    let c;
    // land: paler and brighter when higher, hillshaded (floor 0.6, so a shaded lowland slope never sinks to the sea's tone)
    // BASE_LAND / BASE_SEA: at whole-globe zoom these dots are ~1.5 px soft discs that cover a fraction of each pixel, so
    // the same tones as the close tiles read far darker; the base globe lifts them to read the same.
    if (h > 0) {
      const la = Math.asin(earthPos[3 * i + 1] / RADIUS) / D2R;
      const lo = Math.atan2(-earthPos[3 * i + 2], earthPos[3 * i]) / D2R;
      let sh = Math.min(HS_MAX, Math.max(HS_MIN, hshade[i]));
      if (la < ICE_LAT || la > 59.5 && lo > -74 && lo < -10 && h > 1000) sh = 1 + (sh - 1) * ICE_HS;   // ice sheets: smooth domes, calm shading (no "crumpled paper")
      c = landTone(h, undefined, la, lo).map(v => v * sh * BASE_LAND);
    }
    else c = oceanTone(-h).map(v => v * BASE_SEA);             // sea: dark and calm (dots.js)
    // coastline: land dots next to the sea (shore flag from build_dots.py, computed once) a little brighter; unlocked regions brighter
    // (unlocked regions lift land less than sea: a ×1.5 on land pushed the tint to white around the spots)
    const b = h > 0 ? (1 + 0.3 * lit[i]) * (shore[i] ? SHORE_K : 1) : 0.75 + 0.75 * lit[i];
    earthColor.array[3 * i] = c[0] * b; earthColor.array[3 * i + 1] = c[1] * b; earthColor.array[3 * i + 2] = c[2] * b;
  }
  earthColor.needsUpdate = true;
}
colourEarth();
const coverK = { value: 0 };   // how far the base globe steps aside under drawn terrain tiles (terrainFrame; texture from terrain.js)
const earthMat = () => ({ size: EARTH_DOT, vertexColors: true, displace: true, sizeAttr: true, maxPx: BASE_MAX_PX * renderer.getPixelRatio(), capComp: BASE_CAP_COMP, grazeMin: 0.001, hueMax: HUE_MAX, cover: { texture: null, k: coverK } });
const earth = new THREE.Points(earthGeo, makeDotMaterial(earthMat()));   // dots ≤ BASE_MAX_PX css px
earth.frustumCulled = false;
scene.add(earth);
// Base globe heights at any point (m, ETOPO1 as sampled for the base dots, ~41 km apart), interpolated between the two
// nearest rings and along each ring. Used by terrain.js for the polar caps the web-mercator tiles cannot reach (±85.05°).
const ringStart = []; { let k0 = 0; for (const [, n] of meta.rings) { ringStart.push(k0); k0 += n; } }
function baseElev(lat, lon) {
  const R = meta.rings, dl = R.length > 1 ? R[1][0] - R[0][0] : 0.37;
  const f = Math.max(0, Math.min(R.length - 1.001, (lat - R[0][0]) / dl)), i = Math.floor(f), w = f - i;
  const along = r => { const n = R[r][1], g = ((lon + 180) / 360 * n - 0.5 + n) % n, j = Math.floor(g), u = g - j;
    return elev[ringStart[r] + j] * (1 - u) + elev[ringStart[r] + (j + 1) % n] * u; };
  return along(i) * (1 - w) + along(Math.min(R.length - 1, i + 1)) * w;
}

// ---------- terrain detail (prototype, terrain.js): switchable, off = the plain dot globe above ----------
const terrain = createTerrain({ scene, camera, renderer, baseElev, lite: LITE });
earth.material.uniforms.uCover.value = terrain.coverTex;
const MIN_ALT = 0.0015;                  // closest camera with terrain on: 0.0015 radii ≈ 9.6 km above sea level
// Vertical exaggeration eases off as you zoom in: ×20 seen from a whole-globe distance (altitude ≥ 1 radius),
// down to ×1.2 at altitude ≤ 0.002 radii (≈ 13 km), log-linear in between.
const EXAG_FAR = 20, EXAG_NEAR = 1.2, ALT_FAR = 1.0, ALT_NEAR = 0.002;
function exagFor(alt) {
  const t = Math.min(1, Math.max(0, (Math.log10(alt) - Math.log10(ALT_NEAR)) / (Math.log10(ALT_FAR) - Math.log10(ALT_NEAR))));
  return EXAG_NEAR + (EXAG_FAR - EXAG_NEAR) * t;
}
// The hint at the bottom says what the dots on screen are: the base globe, the terrain tiles, the storm layers.
const hint = document.getElementById('hint');
let hintExag = '1', terrainNote = '';   // terrainNote: loading / failure, said in the hint too
const exagLabel = x => (x < 3 ? x.toFixed(1) : String(Math.round(x)));
// UX 2026-11-23 (calm first view): the hint is plain words only, what your hands do and, when relief is stretched, by how
// much; the data sources, grid sizes and dot spacing live one tap away (View panel readout, About).
function updateHint() {
  const touch = matchMedia('(pointer: coarse)').matches;
  const parts = [touch ? 'Drag to move. Pinch to zoom.' : 'Drag to move. Scroll to zoom. Right-drag to tilt.'];
  hintExag = exagLabel(dotExag.value);
  if (dotExag.value > 1.05) parts.push(`Mountains and sea floor drawn ${hintExag}\u00d7 taller than real so they show.`);
  if (terrain.enabled && terrainNote) parts.push(terrainNote.replace(/^Terrain: /, 'Ground detail: '));
  let storms = false; try { storms = layers.some(l => l.visible); } catch (e) { /* layers not set up yet */ }
  if (storms) parts.push('Each layer says in the Layers panel what is data and what is illustrative.');
  hint.textContent = parts.filter(Boolean).join(' ');
}
const terrainBox = document.getElementById('terrain-toggle'), readout = document.getElementById('terrain-readout'),
  credits = document.getElementById('terrain-credits');
// Terrain credits: our own tiles' block (GEBCO_2026, Copernicus DEM); the AWS Terrain Tiles block only with ?terrain_src=aws
document.getElementById('tc-own').hidden = TERRAIN_AWS; document.getElementById('tc-aws').hidden = !TERRAIN_AWS;
function setTerrain(on) {
  terrain.setEnabled(on);
  updateHint();
  zoom.target = clampAlt(zoom.target);
  if (!on) {                                        // back to the plain globe
    camera.near = 0.005; camera.far = 100; camera.updateProjectionMatrix();
    occluder.scale.setScalar(1); earth.material.uniforms.uOpacity.value = 1; earth.visible = true; coverK.value = 0; dotExag.value = 1;
  }
  readout.style.display = credits.style.display = on ? '' : 'none';
  if (!on) { terrainNote = ''; updateHint(); showDetailEnds(false); }
}
// Terrain detail comes in by itself when you zoom past the base grid's limit (terrainAuto); unticking it is a manual
// off that holds (terrainOff) until it is ticked again.
let terrainOff = false;
terrainBox.onchange = () => { followTerrain = false; terrainOff = !terrainBox.checked; setTerrain(terrainBox.checked); };

// ---------- zoom: one eased controller for the slider, buttons, keys, wheel, trackpad scroll and pinch ----------
// Zoom works on altitude (camera height above the surface) on a log scale, so every step is the same fraction of
// the height, from the whole globe (5 radii up) down to the closest zoom of the current mode (terrain on: ~10 km;
// off: 0.12 radii, the old limit). Inputs only move zoom.target; the camera eases towards it every frame.
// The zoom limit is altMin() (one function, used by every input and by hand-offs): terrain on, MIN_ALT (~10 km); terrain off,
// ALT_MIN_PLAIN, where the base globe's ~41 km dots are about 10 px apart and the global grid runs out (a line says so and
// offers terrain detail); while following a storm, FOLLOW_D. The slider always spans ALT_MAX..MIN_ALT, so switching
// terrain never moves the camera or the thumb.
const ALT_MAX = 5, ALT_MIN_PLAIN = 0.3;
// While following a storm the plain globe may come as close as the follow view (FOLLOW_D), below its usual limit.
const altMin = () => (terrain.enabled ? Math.max(MIN_ALT, detailFloor) : follow ? Math.min(ALT_MIN_PLAIN, FOLLOW_D) : ALT_MIN_PLAIN);
const clampAlt = a => Math.min(ALT_MAX, Math.max(altMin(), a));
const zoom = { target: view.alt, cursor: null, held: false, give: 0, spot: null, c0: null, fine: false };
const slider = document.getElementById('zoom-slider');
const S_MAX = 1000;                                   // slider value S_MAX = closest, 0 = whole globe
const sliderFromAlt = a => Math.round(S_MAX * Math.log(ALT_MAX / a) / Math.log(ALT_MAX / MIN_ALT));
const altFromSlider = v => ALT_MAX * Math.exp(-v / S_MAX * Math.log(ALT_MAX / MIN_ALT));
// inputs ask for an altitude through askAlt: past the plain globe's limit it shows the "data ends" line
const zoomNote = document.getElementById('zoom-note');
let noteTimer = 0;
// Own terrain tiles: z0-z8 everywhere, finer only round the spots. Where they stop, the zoom stops too (detailFloor, the
// height at which the finest built dots there sit DETAIL_PX css px apart), instead of thinning out to sparse dots on
// black; asking past it (or a pan that lifts the floor) shows a calm line for 5 s. The readout says it while it holds.
const DETAIL_PX = 8;
let detailFloorAt = 0, detailFloorC = 0;   // detailFloorC: the floor at the screen centre alone (for the spot glide)
// Round 4 (round-3 #1): the floor is taken at the screen-centre ground point AND at the zoom's anchor (the ground under
// the wheel or pinch, or the spot it was aimed at), whichever has finer tiles. Taken at the centre alone, a wheel aimed
// at Peniche stopped ~200 km up because the centre was out at sea. The anchor then glides to the centre (zoomHold), so
// by the time the camera is below the outside-box limit the centre is over the fine tiles too.
const floorOf = m => m / 6371000 * (innerHeight / (2 * Math.tan(camera.fov * D2R / 2))) / DETAIL_PX;
const finestAt = v => terrain.finestM(Math.asin(Math.max(-1, Math.min(1, v.y))) / D2R, Math.atan2(-v.z, v.x) / D2R);
function updateDetailFloor(now) {
  if (now - detailFloorAt < 200) return; detailFloorAt = now;
  if (!terrain.enabled) { detailFloor = detailFloorC = 0; zoom.fine = false; return; }
  detailFloorC = floorOf(finestAt(view.n));
  const fa = zoom.cursor && zoom.anchor ? floorOf(finestAt(zoom.anchor)) : Infinity;
  zoom.fine = fa < detailFloorC * 0.7;                // the anchor sits on finer tiles than the centre: glide it in
  const f = Math.min(detailFloorC, fa);
  if (f > MIN_ALT && f > detailFloor * 1.05 && view.alt < f * 0.95 && !flight && !arrival) showDetailEnds(true);   // a pan lifted the floor
  detailFloor = f;
}
function showDetailEnds(on) {
  const btn = document.getElementById('zoom-note-terrain');
  if (on) {
    zoomNote.firstElementChild.textContent = 'As close as it goes here: sharper ground is built only around the surf spots.';
    btn.hidden = true; zoomNote.hidden = false; uiBoxesAt = -1e9; clearTimeout(noteTimer); noteTimer = setTimeout(() => { zoomNote.hidden = true; btn.hidden = false; }, 5000);
  } else if (btn.hidden) { zoomNote.hidden = true; btn.hidden = false; clearTimeout(noteTimer); }   // our line is up: take it down
}
function askAlt(a) {
  enterAsk(a);                                        // over an unlocked spot, asking past the limit is the way into the viewer
  // auto terrain detail. Round 4: as soon as a zoom heads in past ~0.9 radii (where the tiles start to take over), not
  // only at the plain globe's limit (0.3): the tiles then load while the base globe still reads, so a cold zoom no longer
  // passes through a second of sparse dots on black and a patchwork of tiles arriving at once
  if ((a < altMin() * 0.98 || (a < 0.9 && a < view.alt)) && !terrain.enabled && !follow && !terrainOff && !arrival) { terrainBox.checked = true; setTerrain(true); }
  if (a < altMin() * 0.98 && terrain.enabled && detailFloor > MIN_ALT && !follow && !flight) {
    showDetailEnds(true);
    // a soft limit: asking past it squeezes in a little further (up to ~10%), then eases back (zoomFrame), so the
    // input never just dies
    zoom.give = Math.min(0.1, zoom.give + 0.03);
    return Math.min(ALT_MAX, Math.max(altMin() * Math.exp(-zoom.give), a));
  }
  if (a < altMin() * 0.98 && !terrain.enabled && !follow) {
    zoomNote.firstElementChild.textContent = 'This is as close as the plain globe goes.';
    document.getElementById('zoom-note-terrain').hidden = false;
    zoomNote.hidden = false; clearTimeout(noteTimer); noteTimer = setTimeout(() => { zoomNote.hidden = true; }, 5000);
  }
  return clampAlt(a);
}
document.getElementById('zoom-note-terrain').onclick = () => { terrainBox.checked = true; setTerrain(true); zoomNote.hidden = true; };
slider.addEventListener('input', () => { zoom.target = askAlt(altFromSlider(+slider.value)); zoom.cursor = null; });
slider.addEventListener('pointerdown', () => { zoom.held = true; });
addEventListener('pointerup', () => { zoom.held = false; });
const stepZoom = dir => { spinPause(); zoom.target = askAlt(altFromSlider(sliderFromAlt(zoom.target) + dir * 80)); zoom.cursor = null; };
document.getElementById('zoom-in').onclick = () => stepZoom(1);
document.getElementById('zoom-out').onclick = () => stepZoom(-1);
// Wheel: a mouse sends a few large steps, a trackpad many small pixel steps, and a pinch arrives as wheel events with
// ctrlKey. Normalise to pixels, scale the zoom by the size of the delta (not per event), and ease it in zoomFrame.
function onWheel(e) {
  e.preventDefault();                                 // also stops the page itself zooming on pinch
  if (flight) return;
  const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
  const k = e.ctrlKey ? 0.01 : 0.002;                 // pinch deltas are small; one mouse notch (~100 px) ≈ ×1.2
  let ask = zoom.target * Math.exp(Math.max(-1, Math.min(1, px * k)));
  // at the zoom limit each wheel tick inward pushes at least like a + click (a mouse notch alone was ~0.1 of the 0.9
  // needed and drained between slow ticks, so the wheel never entered the spot viewer)
  if (px < 0 && zoom.target <= altMin() * 1.02) ask = Math.min(ask, altMin() * Math.exp(-0.32));
  ENTER.wheelT = e.ctrlKey ? -1e9 : performance.now(); ENTER.wheelPx = px;   // dad 2026-11-23 night: a wheel fills the card's open bar (enterAsk); a trackpad pinch (ctrlKey) never does
  zoom.target = askAlt(ask);
  wheelAnchor(e);
}
canvas.addEventListener('wheel', onWheel, { passive: false });
// round 4: the spot labels sit over the canvas and took the wheel, so a wheel aimed at a spot's name did nothing (the
// "wall" of round 3 #1): they pass it on to the same zoom
document.getElementById('labels').addEventListener('wheel', onWheel, { passive: false });
// The ground point under (x, y) becomes the zoom anchor (zoomHold keeps it under zoom.cursor). keep: only move the cursor
// when an anchor is already set (a pinch: the ground under the fingers follows their midpoint).
function zoomAnchor(x, y, keep) {
  const c = new THREE.Vector2(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1);
  if (keep && zoom.cursor && zoom.anchor) { zoom.cursor = c; return; }
  if (!zoom.cursor || !zoom.anchor || zoom.cursor.distanceTo(c) > 0.004) {   // a new place under the cursor: anchor that ground point
    zoom.cursor = c; zoom.c0 = c.clone(); zoom.spot = null; applyView(0); zRay.setFromCamera(c, camera);
    zoom.anchor = zRay.ray.intersectSphere(zSphere, new THREE.Vector3()) ? zRay.ray.intersectSphere(zSphere, new THREE.Vector3()).normalize() : null;
  }
}
// Round 4: a wheel aimed at a spot (its name, or within MAG_PX of its marker) zooms to the spot itself, not to the ground
// pixel under the cursor: at the whole globe one pixel is ~13 km, which grew to ~700 px of drift by the closest zoom.
// Wheel notches that keep coming from the same place stay on that spot (STICK) even after it has glided to the centre.
const MAG_PX = 36, STICK = { r: null, x: 0, y: 0, t: 0 };
function spotAt(e, mag = MAG_PX) {
  const lbl = e.target && e.target.closest ? e.target.closest('.lbl') : null;
  if (lbl) { const r = regions.find(q => q.label === lbl); if (r && r.pos) return r; }
  let best = null, bd = mag;
  for (const r of regions) {
    if (!r.pos || !r.label || !r.label.classList.contains('show') || !facing(r)) continue;
    const [x, y] = screenOf(r.pos), d = Math.hypot(x - e.clientX, y - e.clientY);
    if (d < bd) { bd = d; best = r; }
  }
  return best;
}
function wheelAnchor(e, mag) {
  const now = performance.now();
  const r = STICK.r && now - STICK.t < 2500 && Math.hypot(e.clientX - STICK.x, e.clientY - STICK.y) < 12 ? STICK.r : spotAt(e, mag);
  Object.assign(STICK, { r, x: e.clientX, y: e.clientY, t: now });
  if (!r) { if (zoom.spot) zoom.cursor = null; zoomAnchor(e.clientX, e.clientY, false); return; }
  if (zoom.spot === r && zoom.cursor && zoom.anchor) return;   // already holding (and gliding) this spot
  applyView(0);
  const [x, y] = screenOf(r.pos);
  zoom.spot = r; zoom.anchor = r.pos.clone().normalize();
  zoom.cursor = new THREE.Vector2(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1); zoom.c0 = zoom.cursor.clone();
}
// Glide: over the last ×4 of height before the outside-box limit (or before ~40 km, if the centre is already on fine
// tiles), a spot or a fine-tile anchor moves from where it was under the cursor to the screen centre, so the floor, the
// readout and the spot entry are all taken over it. It only ever moves inward; zooming out leaves it where it is.
function glideK(alt) {
  const a0 = Math.max(detailFloorC, 0.006), a1 = a0 * 4;
  return smooth(Math.log(alt / a0) / Math.log(a1 / a0));
}
addEventListener('gesturestart', e => e.preventDefault());   // Safari's own pinch-zoom of the page
for (const t of ['gesturechange', 'gestureend']) addEventListener(t, e => e.preventDefault(), { passive: false });   // 2026-11-23 night: the rest of Safari's gesture too
const zRay = new THREE.Raycaster(), zSphere = new THREE.Sphere(new THREE.Vector3(), RADIUS);
const zHit0 = new THREE.Vector3(), zHit1 = new THREE.Vector3(), zQ = new THREE.Quaternion();
// Zoom towards the point under the cursor (wheel / pinch): the ground point that was under the cursor when the wheel
// turned stays under it, through the zoom and through the auto-tilt that eases in after it (run after applyView, so the
// pitch of this frame is already in place). Ends when the zoom and the tilt have settled, or anything else moves the view.
function zoomHold() {
  if (!zoom.cursor || !zoom.anchor || flight || follow || drag) { if (!zoom.cursor) { zoom.anchor = null; zoom.spot = null; } return; }
  if ((zoom.spot || zoom.fine) && zoom.c0) {
    const g = glideK(view.alt);
    if (g < 1 && zoom.c0.lengthSq() * g * g < zoom.cursor.lengthSq()) zoom.cursor.copy(zoom.c0).multiplyScalar(g);
  }
  zRay.setFromCamera(zoom.cursor, camera);
  if (!zRay.ray.intersectSphere(zSphere, zHit1)) return;
  zQ.setFromUnitVectors(zHit1.normalize(), zoom.anchor);
  rotateRig(zQ);
  applyView(0);
}
function zoomFrame(dt) {
  const alt = view.alt;
  if (flight) zoom.target = alt;                      // a fly-in drives the camera; the slider follows it
  else {
    zoom.give = Math.max(0, zoom.give - dt * 0.12);   // the soft limit's give eases back (askAlt)
    zoom.target = Math.min(ALT_MAX, Math.max(altMin() * Math.exp(-zoom.give), zoom.target));
    const d = Math.log(zoom.target / alt);
    if (Math.abs(d) > 1e-4) {
      const step = Math.max(-0.25, Math.min(0.25, d * Math.min(1, dt * 10)));   // eased, at most ×1.28 per frame
      if (follow) zoom.cursor = null;                 // (the follow keeps the storm in view)
      view.alt = alt * Math.exp(step);
    } else if (zoom.cursor && Math.abs(view.pitch - Math.min(pitchLimit(view.alt), view.manual ?? autoPitch(view.alt))) < 0.002) zoom.cursor = null;
  }
  const v = sliderFromAlt(zoom.target);
  if (!zoom.held && document.activeElement !== slider && Math.abs(v - +slider.value) > 12) slider.value = v;
  else if (!zoom.held && document.activeElement === slider && Math.abs(v - +slider.value) > 40) slider.value = v;
}
let lastReadout = 0;
// Terrain-tile source codes (x-amz-meta-x-imagery-sources) as readable names (round-1 item 16); unknown codes upper-cased
const SRC_NAMES = { gebco: 'GEBCO_2026', copernicus: 'Copernicus DEM', srtm: 'SRTM', gmted: 'GMTED2010', eudem: 'EU-DEM', ned: 'USGS 3DEP', '3dep': 'USGS 3DEP', ned_topobathy: 'USGS 3DEP',
  etopo1: 'ETOPO1', cdem: 'Canada CDEM', nrcan: 'Canada CDEM', data_gov_uk: 'UK Environment Agency', ga: 'Geoscience Australia',
  dgm: 'Austria DGM', inegi: 'INEGI Mexico', linz: 'LINZ New Zealand', kartverket: 'Kartverket Norway', arcticdem: 'ArcticDEM' };
const srcName = c => SRC_NAMES[c.toLowerCase()] || c.toUpperCase();
const SEA_EXAG_F = 0.35;   // the sea floor is lifted by 1 + (exaggeration − 1) × this (round 3: calmer seabed, true scale when land is)
const TILE_IN = 5, TILE_FULL = 9;   // css px between base dots: tiles start to show / fully shown (alt ≈ 1.4 → 0.8 radii on a 800 px tall view)
function terrainFrame(now) {
  // relief from the camera's real height, so a low tilted camera sees near-true relief (straight down: as before)
  const alt = camera.position.length() - RADIUS;
  dotExag.value = exagFor(alt);
  seaExag.value = 1 + (dotExag.value - 1) * SEA_EXAG_F;
  occluder.scale.setScalar((1 - 8000 * dotExag.value / 6371000 - 0.002) / 0.995);   // keep it under the sunken sea floor
  updateDetailFloor(now);
  // b53 zoom-ahead: while zooming in, the ground under the cursor / pinch (else the middle of the view) and the height the zoom
  // is heading for: terrain.js prefetches the tiles the view will end on there, behind the visible ones
  if (!terrainOff && terrain.zoomAhead && !flight && zoom.target < view.alt * 0.95) {
    const g = zoom.cursor && zoom.anchor ? zoom.anchor : view.n;
    terrain.zoomAhead(Math.asin(Math.max(-1, Math.min(1, g.y))) / D2R, Math.atan2(-g.z, g.x) / D2R, zoom.target, view.alt);
  }
  terrain.update(now);
  // Base globe and tiles cross-fade by zoom: the base globe is the whole-globe look (with terrain on or off), the tiles take
  // over as its ~41 km dots spread apart on screen (TILE_IN css px apart: fully tiles by TILE_FULL). Both draw land the same
  // way (dots.js landTone, LAND_DOT_D), so the hand-over keeps the brightness. While no tile has arrived yet the base globe
  // stays at full strength, so loading never shows a dark patch; a missing tile shows its coarser parent (sharp capped dots).
  const earthPx = 0.0065 * innerHeight / (2 * Math.tan(camera.fov * D2R / 2)) / Math.max(1e-6, alt);
  // Round 3: the base globe steps aside only where a tile is drawn (terrain.coverTex, read per dot), so a region still loading
  // (a cold Arctic, a far corner of a fast wheel zoom) keeps the base globe instead of black.
  const tA = Math.max(0, Math.min(1, (earthPx - TILE_IN) / (TILE_FULL - TILE_IN))), tS = tA * tA * (3 - 2 * tA);
  terrain.setAlpha(tS * followDim);   // a storm follow dims the tiles like the base globe (70%), so the storm reads over the ground
  coverK.value = tS;
  earth.material.uniforms.uOpacity.value = 1; earth.visible = !(tS > 0.999 && terrain.coverFull);
  if (now - lastReadout < 250) return;
  lastReadout = now;
  const st = terrain.status(), hl = terrain.health;
  // never silent: loading and failure are said in the readout and in the hint line
  const note = hl.fails >= 3 && (hl.ok === 0 || !st) ? 'Terrain: could not load the elevation tiles, showing the base globe.'
    : hl.fails >= 3 ? 'Terrain: some elevation tiles did not load; those areas show the coarser level.'
    : terrain.pending > 0 || !st ? 'Terrain: loading…' : '';
  if (note !== terrainNote) { terrainNote = note; updateHint(); }
  if (!st) { readout.dataset.key = ''; readout.textContent = note || 'Terrain: loading…'; return; }
  const m = st.mPerDot >= 1000 ? (st.mPerDot / 1000).toFixed(1) + ' km' : Math.round(st.mPerDot) + ' m';
  readout.title = `tile zoom ${st.z}, ${st.tiles} tiles, ${Math.round(st.dots / 1000)}k dots`;   // the technical figures, on hover
  const sx = 1 + (st.exag - 1) * SEA_EXAG_F, fx = x => x.toFixed(x < 3 ? 1 : 0);
  const ex = st.exag < 1.05 ? 'Heights drawn true to scale.' : `Heights drawn ${fx(st.exag)} times taller than real, so relief shows from this far out` +
    (st.oceanInView ? (sx < 1.05 ? '; the sea floor true to scale.' : `; the sea floor ${fx(sx)} times.`) : '.');
  const lines = [[`Dots here are about ${m} apart. ${ex}`]];
  if (note) lines.unshift([note, hl.fails >= 3 ? 'warn' : '']);
  if (st.detailEnds) lines.push(['Detail ends here: finer terrain is built only around the spots.']);
  if (st.landSrc.length) lines.push(['Land heights from ' + [...new Set(st.landSrc.map(srcName))].join(', ') + '.']);
  if (st.polarInView) lines.push(['Near the pole (past 85° where the elevation tiles end): heights from ETOPO1 as sampled for the whole globe, about every 41 km; dots between are filled in, not measured.', 'warn']);
  if (st.oceanInView && !st.polarBest) lines.push(st.seabedCoarse
    ? [`Seabed from ${st.seabedName}, measured about every ${st.seabedLabel}: dots closer than that are filled in between, not measured.`, 'warn']
    : [`Seabed from ${st.seabedName}, measured about every ${st.seabedLabel}.`]);
  const key = lines.map(l => l.join('|')).join('\n');
  if (key === readout.dataset.key) return;            // rebuild the readout only when its text changes
  readout.dataset.key = key; readout.textContent = '';
  for (const [t, cls] of lines) { const d = document.createElement('div'); d.textContent = t; if (cls) d.className = cls; readout.appendChild(d); }
}
if (new URLSearchParams(location.search).get('terrain') === '1') { terrainBox.checked = true; setTerrain(true); }

// ---------- stars: HYG v4.4 (Hipparcos-Yale-Gliese, astronexus, CC BY-SA 4.0; build_stars.py → assets/stars.bin), naked-eye stars to V 6.5 ----------
// Each star is a dot on a sphere of radius 40 seen from the origin (starCam sits at the centre with the camera's turn, so
// the stars are at infinity: no parallax). Built in the equatorial frame: a star at right ascension α, declination δ is
// placed as if at latitude δ, longitude α. The whole sky is then turned about the polar axis by −GMST (Greenwich mean
// sidereal time, from the current UTC, re-read every second), so a star sits over longitude α − GMST: the star overhead any
// place on the globe is the one really overhead there now. Precession (J2000 positions) and nutation are ignored (well
// under a degree). Calm by design: dimmer than the Earth's dots, no twinkle, no zoom-dependent detail. Auto-rotate turns
// the camera, not the Earth, so it does not touch the sky.
const sky = new THREE.Points(new THREE.BufferGeometry(), makeDotMaterial({ size: 40 / 2000, vertexColors: true, sizeAttr: true, opacity: 1 }));
sky.frustumCulled = false; starScene.add(sky);
const starsLine = document.getElementById('stars-line');
const gmstDeg = ms => { const d = ms / 86400000 - 10957.5; return ((280.46061837 + 360.98564736629 * d) % 360 + 360) % 360; };   // d: days since J2000.0
let skyAt = -1e9;
function skyFrame(now) {
  const ms = Date.now(), ahead = spin.skyDeg;   // the sped-up view clock's lead over real GMST, degrees
  sky.rotation.y = -(gmstDeg(ms) + ahead) * D2R;     // rotation about +y by θ adds θ to longitude; every frame, so a fast spin stays locked
  if (now - skyAt < 1000 || !starsLine) return;
  skyAt = now;
  const t = new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
  const txt = ahead < 0.25 || ahead > 359.75 ? `Stars: real positions for ${t} UTC (HYG v4.4 star database, CC BY-SA 4.0).`
    : `Stars: HYG v4.4 star database (CC BY-SA 4.0), turned ${Math.round(ahead)}° ahead with the sped-up spin (view only). Data: ${t} UTC.`;
  if (starsLine.textContent !== txt) starsLine.textContent = txt;
}
fetch('./assets/stars.bin').then(r => r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status))).then(b => {
  let f = new Float32Array(b);
  if (PROFILE === 'phone') {                         // dad 2026-11-23 night: phones draw the brightest half (lowest magnitude V)
    const all = f, idx = Array.from({ length: all.length / 4 }, (_, i) => i).sort((p, q) => all[4 * p + 2] - all[4 * q + 2]).slice(0, Math.ceil(all.length / 8));
    f = new Float32Array(4 * idx.length); idx.forEach((i, k) => f.set(all.subarray(4 * i, 4 * i + 4), 4 * k));
  }
  const n = f.length / 4, pos = new Float32Array(3 * n), col = new Float32Array(3 * n), sz = new Float32Array(n);
  const blue = [0.72, 0.82, 1.0], white = [1.0, 0.98, 0.94], red = [1.0, 0.78, 0.58];
  for (let i = 0; i < n; i++) {
    const ra = f[4 * i] * D2R, de = f[4 * i + 1] * D2R, v = f[4 * i + 2], bv = f[4 * i + 3];
    pos[3 * i] = 40 * Math.cos(de) * Math.cos(ra); pos[3 * i + 1] = 40 * Math.sin(de); pos[3 * i + 2] = -40 * Math.cos(de) * Math.sin(ra);
    // brightness: a gentle magnitude curve (10^(−0.25 V), not the true 10^(−0.4 V), so faint stars still read); a soft
    // 2-px dot peaks at about a third of its colour, so the faintest land near 55/255 and the brightest (V < 0) saturate
    const b = 0.6 + 2.4 * Math.min(1, Math.pow(10, -0.25 * v));
    // tint from B−V: blue-white (−0.3) → white (0.6) → orange (1.6), kept subtle
    const t = Math.max(-1, Math.min(1, bv < 0.6 ? (bv - 0.6) / 0.9 : (bv - 0.6) / 1.0));
    const c = t < 0 ? mixC(white, blue, -t) : mixC(white, red, t);
    col[3 * i] = c[0] * b; col[3 * i + 1] = c[1] * b; col[3 * i + 2] = c[2] * b;
    sz[i] = 1.8 + 1.8 * Math.max(0, Math.min(1, (4.5 - v) / 6));   // css px: 1.8 (faint) to 3.6 (Sirius)
  }
  const g = sky.geometry;
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
  skyAt = -1e9;
}).catch(e => console.info('Oceany globe: stars not loaded:', e && (e.message || String(e))));
function updateSkySize() { sky.material.uniforms.uSize.value = 40 * renderer.getPixelRatio() / Math.max(1, sky.material.uniforms.uScale.value); }   // aSize is in css px

// ---------- region markers: a small cluster of dots (centre + ring of six) ----------
const MARK = { unlocked: { key: 'unlocked', size: 1.0, opacity: 1, pulse: 0.35 },
               'forecast-only': { key: 'forecast', size: 0.7, opacity: 0.85, pulse: 0.15 },
               locked: { key: 'locked', size: 0.55, opacity: 0.5, pulse: 0 } };
const labelBox = document.getElementById('labels');
// Wanted marker: a targeting hologram made of dots, built in the spot's local frame (x east, y north, z up), radius 1,
// scaled each frame with the camera height so it keeps its size on screen. Parts: a rotating segmented ring, a faint
// outer tick ring turning the other way, a scan line sweeping the ring, four corner brackets that close in ("lock on")
// on hover, and a thin beam of dots drifting up from the surface. Calm when idle, faster and brighter on hover.
function dotsGeo(pts, shade) {
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  if (shade) g.setAttribute('color', new THREE.Float32BufferAttribute(shade.flatMap(v => [v, v, v]), 3));
  return g;
}
function makeHologram(r) {
  const col = palette[r.style.key], parts = [];
  const add = (geo, rel, opacity) => {
    const p = new THREE.Points(geo, makeDotMaterial({ color: col, vertexColors: !!geo.attributes.color, opacity }));
    p.frustumCulled = false; p.userData.rel = rel; parts.push(p); return p;
  };
  const group = new THREE.Group();
  const ringPts = []; for (let i = 0; i < 60; i++) if (i % 10 < 7) { const a = i / 60 * Math.PI * 2; ringPts.push(Math.cos(a), Math.sin(a), 0); }
  const ring = add(dotsGeo(ringPts), 0.07, 0.9);
  const tickPts = []; for (let q = 0; q < 4; q++) for (let k = -1; k <= 1; k++) { const a = q * Math.PI / 2 + k * 0.06; tickPts.push(1.28 * Math.cos(a), 1.28 * Math.sin(a), 0); }
  const ticks = add(dotsGeo(tickPts), 0.05, 0.5);
  const scanPts = [], scanShade = []; for (let i = 1; i <= 12; i++) { scanPts.push(i / 12 * 0.95, 0, 0); scanShade.push(0.25 + 0.75 * i / 12); }
  const scan = add(dotsGeo(scanPts, scanShade), 0.05, 0.8);
  const brackets = [];
  for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const pts = [0, 0, 0]; for (let k = 1; k <= 3; k++) pts.push(-sx * 0.11 * k, 0, 0, 0, -sy * 0.11 * k, 0);
    const b = add(dotsGeo(pts), 0.055, 0.85); b.userData.corner = [sx, sy]; brackets.push(b);
  }
  const beamPts = [], beamShade = []; for (let i = 0; i < 22; i++) { beamPts.push(0, 0, i * 0.14); beamShade.push(Math.pow(1 - i / 22, 1.5)); }
  const beam = add(dotsGeo(beamPts, beamShade), 0.05, 0.9);
  const centre = add(dotsGeo([0, 0, 0]), 0.12, 1);
  parts.forEach(p => group.add(p));
  const n = r.pos.clone().normalize(), e = new THREE.Vector3(0, 1, 0).cross(n).normalize(), u = n.clone().cross(e);
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(e, u, n));
  group.position.copy(r.pos).multiplyScalar(1.0005);
  let h = 0, spin = 0, sweep = 0, last = null;
  group.userData.parts = parts;
  group.userData.update = (t, S, hover) => {
    const dt = last === null ? 0 : Math.min(0.1, t - last); last = t;
    h += ((hover ? 1 : 0) - h) * Math.min(1, dt * 8);                     // eased hover amount 0..1
    spin += dt * (0.35 + 1.4 * h); sweep += dt * (0.6 + 1.6 * h);
    group.scale.setScalar(S);
    ring.rotation.z = spin; ticks.rotation.z = -spin * 0.5; scan.rotation.z = sweep;
    const k = 1.5 - 0.42 * h;                                              // brackets close in on hover
    for (const b of brackets) b.position.set(b.userData.corner[0] * k * 0.78, b.userData.corner[1] * k * 0.78, 0);
    beam.position.z = (t * (0.25 + 0.5 * h)) % 0.14;                       // dots drift up the beam
    for (const p of parts) {
      p.material.uniforms.uSize.value = p.userData.rel * S * (1 + 0.25 * h);
      p.material.uniforms.uOpacity.value = Math.min(1, (0.55 + 0.45 * h) * (p === centre ? 1.4 : 1)) * (0.92 + 0.08 * Math.sin(t * 3 + r.lon));
    }
  };
  return group;
}
for (const r of regions) {
  const s = MARK[r.status] || MARK.locked;
  if (r.wanted) {
    // far away a wanted spot is one small dot (r.pin); the hologram grows in as you zoom toward it, or on hover
    r.style = { key: r.kind === 'hazard' ? 'hazard' : 'forecast', size: 1, pulse: 0 }; r.holo = makeHologram(r); r.marker = r.holo; scene.add(r.holo);
    r.holo.visible = false; r.hk = 0;
    r.pin = new THREE.Points(dotsGeo([0, 0, 0]), makeDotMaterial({ color: palette[r.style.key], opacity: 0.8 }));
    r.pin.position.copy(r.pos).multiplyScalar(1.0005); r.pin.frustumCulled = false; scene.add(r.pin);
    if (r.kind === 'hazard') {      // hazard pin: blue-grey is lost on blue water, so a faint, still ring of dots marks it
      const pts = []; for (let i = 0; i < 12; i++) { const a = i / 12 * Math.PI * 2; pts.push(Math.cos(a), Math.sin(a), 0); }
      r.halo = new THREE.Points(dotsGeo(pts), makeDotMaterial({ color: palette.hazard, opacity: 0.55 }));
      r.halo.position.copy(r.pin.position); r.halo.quaternion.copy(r.holo.quaternion); r.halo.frustumCulled = false; scene.add(r.halo);
    }
    r.label = document.createElement('div');
    r.label.className = 'lbl forecast-only wanted' + (r.kind === 'hazard' ? ' hazard' : ''); r.label.textContent = r.name;
    r.label.onclick = () => pickRegion(r);
    labelBox.appendChild(r.label);
    continue;
  }
  const n = r.pos.clone().normalize();
  const e = new THREE.Vector3(0, 1, 0).cross(n).normalize(), u = n.clone().cross(e);   // east and north on the surface
  const pts = [0, 0, 0];
  for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3, v = e.clone().multiplyScalar(Math.cos(a)).addScaledVector(u, Math.sin(a)); pts.push(v.x, v.y, v.z); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  r.marker = new THREE.Points(g, makeDotMaterial({ size: 0.01, color: palette[s.key], opacity: s.opacity }));
  r.marker.position.copy(r.pos).multiplyScalar(1.0005);   // ~3 km up: stays below the camera at the closest terrain zoom
  r.marker.frustumCulled = false;
  r.style = s;
  scene.add(r.marker);
  // unlocked spots: far off the small crisp marker above; the hologram (r.uholo) grows in on hover, when picked, or
  // close in with no other marker near it on screen. r.place: the shared place name from the note ("Peniche, ...").
  if (r.status === 'unlocked') { r.uholo = makeHologram(r); r.uholo.visible = false; scene.add(r.uholo); r.hk = 0; }
  r.place = (r.note || '').split(/[,.]/)[0].trim();
  r.label = document.createElement('div');
  r.label.className = 'lbl ' + r.status; r.label.textContent = r.name;
  r.label.onclick = () => tapSpot(r);   // dad 2026-11-23 night: a card at the name (was: fly down / zoom the cluster)
  labelBox.appendChild(r.label);
}
// every label: hover or keyboard focus names and highlights its marker; Enter picks it
for (const r of regions) {
  const L = r.label; L.tabIndex = 0; L.setAttribute('role', 'button');
  L.onmouseenter = L.onfocus = () => { r.hover = r.lblHover = true; };
  L.onmouseleave = L.onblur = () => { r.hover = r.lblHover = false; };
  L.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tapSpot(r); } };   // dad 2026-11-23 night
}

// ---------- side list: own spots, then the wanted spots with a filter by kind and a count ----------
const list = document.getElementById('list'), wantedList = document.getElementById('wanted-list');
const TAG = { unlocked: 'reef map', 'forecast-only': 'marked, no model yet', locked: 'locked' };   // 'forecast-only' is the data status; the site is not a forecast service, so it is not called that on screen
const KIND_TAG = { wave: 'wanted', research: 'wanted · research', hazard: 'data needed' };
for (const r of regions) {
  const li = document.createElement('li'); li.className = r.status;
  const b = document.createElement('button');
  b.innerHTML = `<span class="dot"></span><span></span><span class="tag"></span>`;
  if (r.wanted) li.classList.add('wanted', 'k-' + r.kind);
  b.children[1].textContent = r.name;
  b.children[2].textContent = r.wanted ? (r.spot ? KIND_TAG[r.kind] : 'wanted') : TAG[r.status] || r.status;
  b.onclick = () => pickRegion(r);
  li.appendChild(b); (r.spot ? wantedList : list).appendChild(li);
  r.li = li;
  li.onmouseenter = () => { r.hover = r.lblHover = true; }; li.onmouseleave = () => { r.hover = r.lblHover = false; };   // highlights its marker
}
const filterBox = document.getElementById('wanted-filter'), wantedCount = document.getElementById('wanted-count');
function refreshWanted() {
  const all = regions.filter(r => r.wanted), on = all.filter(shownKind);
  wantedCount.textContent = `${on.length} of ${all.length} wanted spots shown`;
  for (const r of all) r.li.style.display = shownKind(r) ? '' : 'none';
  for (const b of filterBox.children) { b.classList.toggle('on', kindOn[b.dataset.kind]); b.setAttribute('aria-pressed', kindOn[b.dataset.kind]); }
}
for (const k of KINDS) {
  const n = regions.filter(r => r.wanted && r.kind === k).length;
  const b = document.createElement('button'); b.type = 'button'; b.dataset.kind = k; b.className = 'k-' + k;
  b.textContent = `${k} ${n}`;
  b.onclick = () => { kindOn[k] = !kindOn[k]; refreshWanted(); };
  filterBox.appendChild(b);
}
refreshWanted();

// ---------- state carried through a spot visit (round-1 review item 11) ----------
// Entering a spot saves the layers, palette and terrain switch in sessionStorage (this tab only, nothing leaves the
// browser); arriving back from the viewer (?from=…) restores them, so zooming out of a reef lands on the globe you left.
const STATE_KEY = 'oceany.globe.state';
const restored = (() => {
  if (!new URLSearchParams(location.search).has('from')) return null;
  try { return JSON.parse(sessionStorage.getItem(STATE_KEY) || 'null'); } catch (e) { return null; }
})();
let paletteName = 'Ocean';
function saveState() {
  const ls = {}; for (const l of layers) if (l.userData.layerId) ls[l.userData.layerId] = !!l.visible;
  try { sessionStorage.setItem(STATE_KEY, JSON.stringify({ layers: ls, palette: paletteName, terrain: terrainBox.checked && !arrival, t: Date.now() })); } catch (e) { /* storage blocked: defaults on return */ }
}

// ---------- palette buttons ----------
{
  const box = document.getElementById('palettes');
  for (const name of Object.keys(PALETTES)) {
    const b = document.createElement('button'); b.textContent = name; if (name === 'Ocean') b.className = 'on';
    b.onclick = () => {
      paletteName = name;
      setPalette(name); applyCssPalette(); colourEarth(); terrain.recolour();   // page colours (labels, bar, panel) follow too
      // layers: the palette object they were given is updated in place; a layer that colours its dots once can recolour here
      for (const l of layers) if (typeof l.setPalette === 'function') { try { l.setPalette(name, palette); } catch (e) { /* ignore */ } }
      dispatchEvent(new CustomEvent('oceany:palette', { detail: { name, palette } }));
      for (const r of regions) for (const m of (r.holo ? [...r.holo.userData.parts, r.pin, ...(r.halo ? [r.halo] : [])] : [r.marker, ...(r.uholo ? r.uholo.userData.parts : [])])) m.material.uniforms.uColor.value.setRGB(...palette[r.style.key]);
      [...box.children].forEach(x => x.classList.toggle('on', x === b));
    };
    box.appendChild(b);
  }
}

// ---------- picking ----------
const card = document.getElementById('card');
const TIERS = ['forecast', 'seabed', 'swell model', 'breaking wave'];
// research notes can carry working notes ("… unreachable this session."): sentences about the research session are not shown
const clean = t => typeof t === 'string' ? t.split(/(?<=\.)\s+/).filter(x => !/\b(this session|unreachable|not reached)\b/i.test(x)).join(' ') : t;
function showCard(r) {
  card.style.display = 'block';
  card.textContent = '';
  card.classList.toggle('wanted', !!r.wanted && r.kind !== 'hazard');
  card.classList.toggle('hazard', r.kind === 'hazard');
  card.classList.toggle('research', r.kind === 'research');
  const line = (txt, cls) => { const d = document.createElement('div'); d.textContent = txt; if (cls) d.className = cls; card.appendChild(d); return d; };
  if (r.spot) {                   // a researched spot: plain text only; disaster coasts get the calm "DATA NEEDED" card
    const e = r.spot, hazard = r.kind === 'hazard';
    if (r.kind === 'research') { line('WANTED', 'w-head'); line('RESEARCH SITE', 'w-sub'); }   // research: same notice, own heading
    else line(hazard ? 'DATA NEEDED' : 'WANTED', 'w-head');
    line(r.name, 'w-name');
    if (e.country) line(e.country, 'w-country');
    // Round 5 (round-4 #6): every wanted card in one format. A hand-finished card (regions.json wantedSpots.cards) if there is
    // one, else the same four parts built from the entry's own fields (why, known_data, needs), with nothing added.
    const fin = (wantedSpots && wantedSpots.cards && wantedSpots.cards[e.id]) || {
      question: e.why || '', data: clean(e.known_data) || 'None recorded.', shows: '',
      cant: (e.needs ? 'Needed: ' + e.needs + '.' : '') + (e.confidence === 'low' ? ' The data status is not yet verified.' : '') };
    if (fin) {                    // round 4 (round-3 #7): a finished card: the question, the data, what it shows, what it can't
      line(fin.question, 'w-why');
      for (const [k, h] of [['data', 'Data'], ['shows', 'What it shows'], ['cant', 'What it cannot show']]) if (fin[k]) { const d = line(fin[k], 'w-part'); const b = document.createElement('b'); b.textContent = h + ': '; d.prepend(b); }
      const det = document.createElement('details'); det.className = 'w-src';
      const sm = document.createElement('summary'); sm.textContent = 'Sources'; det.appendChild(sm);
      const urls = [...new Set([e.data_url, ...(e.sources || [])].filter(u => typeof u === 'string' && /^https?:\/\//i.test(u) && !/nominatim/i.test(u)))];
      for (const u of urls) { try { const a = document.createElement('a'), uu = new URL(u); a.href = uu.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = uu.hostname + uu.pathname.replace(/\/$/, '').slice(0, 40); const d = document.createElement('div'); d.appendChild(a); det.appendChild(d); } catch (err) { /* skip */ } }
      card.appendChild(det);
      if (r.quick) line('Unlock candidate: open seabed data listed', 'w-quick');
      if (!hazard) line('Contributions open soon.', 'w-foot');
      return;
    }
    if (e.why) line(e.why, 'w-why');
    if (e.needs) line('Needs: ' + e.needs);
    const kd = line('Known open data: ' + (clean(e.known_data) || 'none recorded'), 'w-known');
    if (typeof e.data_url === 'string' && /^https?:\/\//i.test(e.data_url)) {
      try {
        const u = new URL(e.data_url), a = document.createElement('a');
        a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = 'Open data link (' + u.hostname + ')';
        const d = document.createElement('div'); d.className = 'w-link'; d.appendChild(a); kd.after(d);
      } catch (err) { /* malformed link: show none */ }
    }
    if (r.quick) line(hazard ? 'Open seabed data exists' : 'Quick unlock: data exists', 'w-quick');
    if (e.confidence === 'low') line('Data status not yet verified', 'w-low');
    if (!hazard) line('Contributions open soon.', 'w-foot');
  } else if (r.wanted) {          // bounty notice: plain text only
    line('WANTED', 'w-head');
    line(r.name, 'w-name');
    if (r.country) line(r.country, 'w-country');
    const fin = wantedSpots && wantedSpots.cards && wantedSpots.cards[r.id];
    if (fin) {                    // round 5: the home spots in the same format as every other wanted card (no sources yet)
      line(fin.question, 'w-why');
      for (const [k, h] of [['data', 'Data'], ['shows', 'What it shows'], ['cant', 'What it cannot show']]) if (fin[k]) { const d = line(fin[k], 'w-part'); const b = document.createElement('b'); b.textContent = h + ': '; d.prepend(b); }
      line('Contributions open soon.', 'w-foot');
      return;
    }
    if (r.note) line(r.note, 'w-why');
    line('Needs: ' + r.wanted.needs);
    line(`Next unlock: ${r.wanted.tier.replace('-', ' ')}`);
    line('Contributions open soon.', 'w-foot');
  } else { line(r.name, 'c-name'); line(r.note || TAG[r.status]); }
}
const hideCard = () => { card.style.display = 'none'; };
addEventListener('keydown', e => { if (e.key === 'Escape') hideCard(); });
addEventListener('pointerdown', e => { if (card.style.display === 'block' && !card.contains(e.target)) hideCard(); }, true);
let flight = null, follow = null, picked = null;
function pickRegion(r) {
  if (flight) return;
  popClose();                                         // dad 2026-11-23 night
  picked = r;
  releaseFollow();
  if (r.status === 'unlocked' && r.link) {          // UX 2026-11-23: down through the terrain to ~15 km, then stop there; the
    // "Open <spot>" button (enterFrame) offers the viewer, nothing opens it by itself
    if (!terrain.enabled && !terrainOff) { terrainBox.checked = true; setTerrain(true); }
    if (spin.on) setSpin(false); spin.k = 0;         // a spinning globe (and its eased-out speed) carried the landing ~170 km past the spot
    flyTo(r, () => popOpen(r), RADIUS + (terrain.enabled ? 0.0024 : 0.18), { extra: terrain.enabled ? 1400 : 0 });   // dad 2026-11-23 night: lands with its card open
  }
  else { showCard(r); flyTo(r, null, RADIUS + Math.min(1.2, view.alt)); }   // ease to it: 1.2 radii up from further out, else at your zoom
}
// dad 2026-11-23 night: a click or tap on a name or marker. An unlocked spot (or a cluster with one) opens its card right
// there (POP below) and the globe stays still; anything else does what it did (wanted cards, flights).
function tapSpot(r) {
  if (flight) return;
  const cl = r.cl && !r.clSplit ? r.cl : null;
  if (cl) { if (cl.members.some(m => m.status === 'unlocked' && m.link)) popOpen(cl.lead, cl); else zoomCluster(cl); return; }
  if (r.status === 'unlocked' && r.link) { picked = r; popOpen(r); return; }
  popClose(); pickRegion(r);
}
// ---------- zoom-in hand-off to the seafloor viewer (the mirror of the viewer's zoom-out; see the arrival code below) ----------
// UX 2026-11-23: the hand-off is offered, never automatic. Near an unlocked spot (within max(20 km, 8% of the camera
// distance) of the looked-at point, or 90 px of the pointer) an "Open <spot> in 3D" button shows; tapping it opens the
// viewer with ?from=globe&d=&h=&p= (distance m, heading and tilt deg), and the viewer starts at that view and eases in.
// Zooming on past the limit only makes the button glow. A wanted spot without data just stops; its card says what is
// missing. Clicking an unlocked spot's name flies down to it and stops; the button then offers the viewer.
const ENTER = { push: 0, at: 0, r: null, gone: false, cover: null, cue: null, need: 0.9 };
const ENTER_PTR = [NaN, NaN];                        // last pointer position: zooming toward the cursor leaves the spot there, not mid-screen
for (const t of ['pointermove', 'wheel']) addEventListener(t, e => { ENTER_PTR[0] = e.clientX; ENTER_PTR[1] = e.clientY; }, { passive: true, capture: true });
function enterCandidate() {                           // the spot nearest the looked-at point (within the ground limit) or the pointer (within 90 px)
  const lim = Math.max(20, 0.08 * view.alt * 6371) / 6371;
  let best = null, bd = 1;
  for (const r of regions) {
    if (!r.pos) continue;
    let sc = view.n.angleTo(r.pos) / lim;
    if (sc >= 1 && Number.isFinite(ENTER_PTR[0]) && facing(r)) { const [x, y] = screenOf(r.pos); sc = Math.hypot(x - ENTER_PTR[0], y - ENTER_PTR[1]) / 90; }
    if (sc < bd) { bd = sc; best = r; }
  }
  return best;
}
function enterAsk(a) {                                // from askAlt: an input asked for altitude a
  if (ENTER.gone || flight || arrival || follow || a >= altMin() * 0.999 || view.alt > altMin() * 1.15) return;
  const r = enterCandidate(); if (!r) return;
  if (r !== ENTER.r) { ENTER.r = r; ENTER.push = 0; }
  ENTER.at = performance.now();
  if (r.status !== 'unlocked' || !r.link) { if (picked !== r || card.style.display !== 'block') { picked = r; showCard(r); } return; }
  // UX 2026-11-23 (first-visitor feedback: "it jumped me to all kinds of screens"): zooming on past the limit never opens
  // the viewer by itself any more; it only nudges the "Open <spot>" button (enterFrame), which the visitor taps.
  ENTER.nudge = performance.now();
  popPush(r);                                         // dad 2026-11-23 night: desktop wheel, with the card's bar as the cue
}
function enterCover() {
  if (!ENTER.cover) {
    ENTER.cover = document.createElement('div');
    ENTER.cover.style.cssText = 'position:fixed;inset:0;background:#04070d;opacity:0;pointer-events:none;z-index:40;transition:opacity .15s linear';
    document.body.appendChild(ENTER.cover);
  }
  return ENTER.cover;
}
function enterSpot(r) {
  if (TOUR.on) {                                      // Benn 2026-11-23: a full bar or Open in 3D always acts; during the tour it ends the tour and goes
    // r3 (Benn: the tour "didn't keep on when I left reef view"): the tour ends quietly here (layers put back) and leaves a
    // marker: the viewer runs its own gesture tour at once, and back on the globe this one carries on at the next step
    // round 4: one key { page, step, next } (tour.js tourKey): the reef tour starts at its step 0, the globe resumes at next
    const nx = TOUR.g && TOUR.g.on ? TOUR.g.step + 1 : null;
    tourEnd();
    if (nx != null) try { sessionStorage.setItem('oceany-tour', JSON.stringify({ page: 'viewer', step: 0, next: nx, profile: PROFILE, t: Date.now() })); } catch (e) { /* storage blocked: no carrying on */ }
  }
  if (ENTER.gone) return;
  ENTER.gone = true;
  saveState();
  const h = Math.round(((view.heading / D2R) % 360 + 360) % 360), p = Math.round(view.pitch / D2R);
  const q = new URLSearchParams({ from: 'globe', d: Math.round(view.alt * 6371000), h, p, profile: PROFILE });   // dad 2026-11-23 night: profile
  // If Back reloads this page instead of restoring it, it arrives low over the spot and eases out (no bounce back in)
  const back = new URLSearchParams(location.search);
  Object.entries({ from: r.id, at: r.lat + ',' + r.lon, d: Math.round(Math.max(view.alt, altMin() * 3) * 6371000), h, p }).forEach(([k, v]) => back.set(k, v));
  history.replaceState(history.state, '', location.pathname + '?' + back + location.hash);
  const c = enterCover(); c.style.transition = 'opacity .45s ease'; c.style.opacity = '1';
  setTimeout(() => { location.href = r.link + (r.link.includes('?') ? '&' : '?') + q; }, 470);
}
// ---------- dad 2026-11-23 night: the spot card at the name ----------
// Benn's dad (desktop iMac): the bottom "Open <spot> in 3D" button was far from the spot and hid itself as the pointer
// moved down to it (it followed whichever spot was within 90 px of the pointer), so it "ran away". Now a click or tap on
// an unlocked spot's name (or marker) opens a small card AT the name: "Open in 3D", plus "Fly down to it" from far out;
// a cluster's card lists each spot. The card follows its name and nothing turns the globe while it is open (spin waits).
// On desktop, zooming close to a spot opens its card by itself (POP.auto), and that card stays on its spot until you zoom
// back out, close it or click another. One rule for entering 3D: only from the card. Click "Open in 3D", or, on desktop,
// keep scrolling in past the closest zoom: the card's bar fills (about four mouse notches) and opens when full. A pinch
// never opens it; phones also keep the bottom button.
const POP = { el: null, r: null, cl: null, auto: false, t0: 0, push: 0, pushT: 0, bar: null, dismissed: null };
const TOUR = { on: false };                           // the start tour (end of file); declared here because spinFrame reads it
const POP_NEAR = () => Math.max(altMin() * 2.5, 0.03);   // the "close to a spot" range (same as the bottom button's)
function popEl() {
  if (POP.el) return POP.el;
  const el = POP.el = document.createElement('div'); el.id = 'spot-pop'; el.setAttribute('role', 'dialog'); el.hidden = true;
  el.addEventListener('wheel', e => {                 // a wheel over the card zooms on toward its spot (and fills the bar)
    if (POP.r) Object.assign(STICK, { r: POP.r, x: e.clientX, y: e.clientY, t: performance.now() });
    onWheel(e); spinPause();
  }, { passive: false });
  document.body.appendChild(el);
  return el;
}
function popOpen(r, cl = null, auto = false) {
  if (!r || ENTER.gone) return;
  const el = popEl();
  Object.assign(POP, { r, cl, auto, t0: performance.now(), push: 0, pushT: 0, side: null });
  el.textContent = '';
  const add = (tag, cls, txt) => { const d = document.createElement(tag); if (cls) d.className = cls; if (txt) d.textContent = txt; el.appendChild(d); return d; };
  const x = add('button', 'sp-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.onclick = () => popClose(true);
  const name = cl ? clusterName(cl) : r.name;
  add('div', 'sp-name', name); el.setAttribute('aria-label', name);
  const list = cl ? cl.members.filter(m => m.status === 'unlocked' && m.link) : [r];
  for (const m of list) {
    const b = add('button', 'sp-open', (cl ? 'Open ' + m.name + ' in 3D' : 'Open in 3D') + ' →'); b.type = 'button';
    b.title = 'Open the 3D sea-floor viewer for ' + m.name; b.onclick = () => { popClose(); enterSpot(m); };
  }
  if (cl) { const z = add('button', 'sp-more', 'Zoom in closer'); z.type = 'button'; z.onclick = () => { popClose(); zoomCluster(cl); }; }
  else if (!auto && view.alt > 0.02) { const f = add('button', 'sp-more', 'Fly down to it'); f.type = 'button'; f.onclick = () => { popClose(); pickRegion(r); }; }
  POP.bar = null;
  if (!LITE && !cl) {                                 // desktop: the wheel way in, said before it can happen
    const c = add('div', 'sp-cue'); c.append('Or keep scrolling in to open it. ');
    POP.bar = document.createElement('i'); c.appendChild(POP.bar);
  }
  el.hidden = false; spin.k = 0; spinPause();
  const w = document.getElementById('welcome'); if (w && !w.hidden) { w.hidden = true; store.set('oceany-globe-welcome-v1', '1'); }   // started on their own
  popPlace();
}
function popClose(byHand) {
  if (!POP.r) return;
  if (byHand && POP.auto) POP.dismissed = POP.r;      // closed by hand: the zoom-close card stays shut until you zoom out
  POP.r = POP.cl = null; POP.auto = false; POP.push = 0;
  if (POP.el) POP.el.hidden = true;
  spinPause();
}
function popPlace() {                                 // under the spot's name (above it near the bottom), inside the screen
  const el = POP.el, r = POP.cl ? POP.cl.lead : POP.r;
  if (!el || !r) return;
  if (!r.pos || !facing(r) || !inFront(r.pos)) { if (!flight) popClose(); return; }
  { const [sx, sy] = screenOf(r.pos); if (sx < -40 || sy < -40 || sx > innerWidth + 40 || sy > innerHeight + 40) { if (!flight) popClose(); return; } }   // moved off screen
  let x, y0, y1;
  const L = r.label && r.label.classList.contains('show') ? r.label.getBoundingClientRect() : null;
  // centred on the marker, not the name: a hovered name shifts sideways, and the card must not move while you aim at it
  let my; [x, my] = screenOf(r.markAt || r.pos);
  if (L && L.width) { y0 = Math.min(L.top, my - 6); y1 = Math.max(L.bottom, my + 6); } else { y0 = my - 8; y1 = my + 8; }
  const w = el.offsetWidth, h = el.offsetHeight, m = 8;
  // below the name, else above, right or left: the first place that covers no other spot's name (a neighbour stays clickable)
  const others = [...labelBox.querySelectorAll('.lbl.show')].filter(e => e !== (r.label)).map(e => e.getBoundingClientRect());
  const fit = (l, t) => [Math.max(m, Math.min(innerWidth - w - m, l)), Math.max(56, Math.min(innerHeight - h - m, t))];
  const tries = [fit(x - w / 2, y1 + 8), fit(x - w / 2, y0 - 8 - h), fit(x + 24, (y0 + y1) / 2 - h / 2), fit(x - 24 - w, (y0 + y1) / 2 - h / 2)];
  const hits = ([l, t]) => others.some(o => l < o.right && l + w > o.left && t < o.bottom && t + h > o.top) || (y1 > t && y0 < t + h && x > l && x < l + w);
  const side = POP.atR === r && POP.side != null && !hits(tries[POP.side]) ? POP.side : Math.max(0, tries.findIndex(p => !hits(p)));
  POP.side = side; POP.atR = r; POP.at = tries[side];
  el.style.left = Math.round(POP.at[0]) + 'px'; el.style.top = Math.round(POP.at[1]) + 'px';
}
// every frame (from enterFrame): place the card; on desktop open or close the zoom-close card. near: the unlocked spot
// the bottom button would offer (or null).
function popNear(near, now) {
  const lim = POP_NEAR();
  if (POP.dismissed && view.alt > lim * 1.3) POP.dismissed = null;
  if (!LITE && !flight && !follow && !arrival) {
    if (POP.auto && view.alt > lim * 1.3) popClose();                       // zoomed back out: the zoom-close card goes
    else if (!POP.r && near && near !== POP.dismissed && view.alt < lim) popOpen(near, null, true);
  }
  if (!POP.r) return;
  if (POP.push > 0 && now - POP.pushT > 1200) POP.push = Math.max(0, POP.push - 0.03);   // stopped scrolling: the bar drains
  if (POP.bar) POP.bar.style.width = Math.round(100 * Math.min(1, POP.push)) + '%';
  popPlace();
}
function popPush(r) {                                 // from enterAsk: an input asked past the closest zoom near spot r
  const now = performance.now();
  if (LITE || now - (ENTER.wheelT || -1e9) > 60) return;   // the wheel only: a pinch, + or the slider never opens 3D
  if (!POP.r || POP.cl) { if (r.status === 'unlocked' && r.link && r !== POP.dismissed) popOpen(r, null, true); return; }   // the cue shows first
  if (now - POP.t0 < 500) return;                     // the card has to be on screen before the wheel counts
  POP.push += Math.min(0.26, Math.max(0.04, Math.abs(ENTER.wheelPx || 100) / 400)); POP.pushT = now;
  if (POP.push >= 1) { const t = POP.r; popClose(); enterSpot(t); }
}
addEventListener('keydown', e => { if (e.key === 'Escape') popClose(true); });
slider.addEventListener('keydown', e => {             // at the top the slider cannot move: the arrow keys still push on
  if (['ArrowUp', 'ArrowRight', 'PageUp', 'End'].includes(e.key) && +slider.value >= S_MAX) askAlt(altMin() * Math.exp(-0.3));
});
addEventListener('pageshow', e => {                   // Back from the viewer (page restored): clear the cover, ease out a little
  if (!e.persisted || !ENTER.gone) return;
  ENTER.gone = false; ENTER.push = 0; ENTER.r = null;
  if (ENTER.cover) { ENTER.cover.style.transition = 'opacity .6s ease'; ENTER.cover.style.opacity = '0'; }
  zoom.target = clampAlt(Math.max(view.alt, altMin() * 3)); zoom.cursor = null;
  const q = new URLSearchParams(location.search); ['from', 'at', 'd', 'h', 'p'].forEach(k => q.delete(k));
  history.replaceState(history.state, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
});
function enterFrame(now, dt) {                        // every frame: the "Open <spot>" button (UX 2026-11-23)
  if (ENTER.gone) return;
  // Close to an unlocked spot (or after a tap on its name flew you there), a calm button offers the 3D reef viewer.
  // Nothing opens it by itself: wheel, pinch, + and the slider only zoom.
  const r = !flight && !follow && !arrival && view.alt < Math.max(altMin() * 2.5, 0.03) ? enterCandidate() : null, ok = !!(r && r.status === 'unlocked' && r.link);
  if (!ENTER.cue) {
    ENTER.cue = document.createElement('button'); ENTER.cue.type = 'button'; ENTER.cue.id = 'open-spot'; ENTER.cue.hidden = true;
    ENTER.cue.onclick = () => { if (ENTER.cueR) enterSpot(ENTER.cueR); };
    document.body.appendChild(ENTER.cue);
  }
  if (ok) {
    ENTER.cueR = r;
    const t = 'Open ' + r.name + ' in 3D \u2192';
    if (ENTER.cue.textContent !== t) { ENTER.cue.textContent = t; ENTER.cue.title = 'Open the 3D sea-floor viewer for ' + r.name; }
  }
  popNear(ok ? r : null, now);                        // dad 2026-11-23 night: on desktop the card at the name replaces the bottom button
  const showCue = ok && LITE && POP.r !== r;         // phones keep the bottom button (thumb reach) unless its card is open; desktop uses the card
  if (ENTER.cue.hidden === showCue) ENTER.cue.hidden = !showCue;
  const nudge = ok && now - (ENTER.nudge || -1e9) < 900;   // zooming on past the limit: the button glows, it does not open
  if (ENTER.cue.classList.contains('nudge') !== nudge) ENTER.cue.classList.toggle('nudge', nudge);
}
// Fly the rig along the sphere to the region (eased), then call done. endDist is the old camera distance from the
// globe centre (1.18 = 0.18 radii up). opt.dir() gives a moving target's direction each frame (a storm); opt.pitch
// ends at that tilt (kept as manual tilt), else the tilt eases to automatic.
function flyTo(r, done, endDist = 1.18, opt = {}) {
  if (r) card.style.display = r.status === 'unlocked' ? 'none' : card.style.display;
  const startDir = view.n.clone(), endDir = (opt.dir ? opt.dir() : r.pos).clone().normalize();
  const angle = startDir.angleTo(endDir);
  flight = { angle, t0: performance.now(), dur: 900 + 900 * Math.min(1, angle / Math.PI) + (done ? 500 : 0) + (opt.extra || 0),
    startDir, endDir, getDir: opt.dir, startAlt: Math.max(1e-6, Number.isFinite(view.alt) ? view.alt : 2.6), endAlt: Math.max(1e-6, Number.isFinite(endDist) ? endDist - RADIUS : view.alt), startPitch: view.pitch,
    endPitch: opt.pitch ?? null, done, northUp: Math.abs(view.heading) < 2 * D2R };   // north-up before: north-up after (the path carries the facing round)
  // a flight out to the whole globe (the return from the seafloor viewer, Home) turns north-up on the way (northFrame)
  // terrain v2 (b52): start loading the landing spot's tiles now, so land is there when the flight ends (terrain.js prefetch)
  if (!terrainOff && terrain.prefetch) { const e = flight.endDir; terrain.prefetch(Math.asin(Math.max(-1, Math.min(1, e.y))) / D2R, Math.atan2(-e.z, e.x) / D2R, flight.endAlt); }
  flight.toNorth = flight.endAlt >= WHOLE_ALT && !follow;
  if (flight.toNorth) northEase = true;
  view.manual = flight.endPitch;
  pan.x = pan.y = 0;
}
const fq = new THREE.Quaternion(), fq0 = new THREE.Quaternion();
function stepFlight(now) {
  // t clamped at 0 too: a frame time stamp can be earlier than the performance.now() the flight started at (rAF gives
  // the frame's start time); a negative t made e < 0, so the hop term went negative and the altitude below zero (then NaN)
  const f = flight, t = Math.max(0, Math.min(1, (now - f.t0) / f.dur)), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  if (f.getDir) { const d = f.getDir(); if (d) f.endDir.copy(d); }
  fq.setFromUnitVectors(f.startDir, f.endDir); const q = fq0.clone().slerp(fq, e);
  // pull back mid-flight: a little on short hops, up and over (most of the globe in view) on long ones
  const hop = Math.min(1.8, 0.4 * f.angle + 0.5 * f.angle * f.angle) * Math.sin(Math.PI * e);
  // altitude eases on a log scale (a 5-radii-to-200-km fly-in spends its time near the ground, not in space)
  const a = Math.exp(Math.log(f.startAlt) + (Math.log(f.endAlt) - Math.log(f.startAlt)) * e) + hop;
  if (Number.isFinite(a) && a > 0) view.alt = a;   // guard: never a non-positive or NaN altitude
  view.n.copy(f.startDir).applyQuaternion(q).normalize();
  const pEnd = f.endPitch ?? Math.min(pitchLimit(f.endAlt), autoPitch(f.endAlt));
  view.pitch = f.startPitch + (pEnd - f.startPitch) * e;
  if (t >= 1) {
    flight = null; zoom.target = view.alt;           // the slider and zoom carry on from where the flight ended
    if (f.northUp && !follow && Math.abs(view.n.y) < Math.sin(80 * D2R)) northEase = true;
    if (f.done) f.done();
  }
}

// ---------- drag: left = move over the ground; right, shift or alt = tilt (up/down) and turn (left/right) ----------
const pan = { x: 0, y: 0 };                           // pending rotation of view.n (rad), applied with damping
let drag = null;
canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerdown', e => {
  if (flight) return;
  drag = { x: e.clientX, y: e.clientY, id: e.pointerId, tilt: e.button === 2 || e.shiftKey || e.altKey || (e.ctrlKey && e.pointerType === 'mouse'), moved: false };   // round 4: Mac Ctrl-click drag (trackpad) tilts too
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic or already-ended pointer */ }
});
canvas.addEventListener('pointermove', e => {
  if (!drag || e.pointerId !== drag.id) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
  if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 0) { drag.moved = true; releaseFollow(); }
  if (drag.tilt) {
    view.heading -= dx * 0.005; northEase = false;
    view.manual = Math.max(0, Math.min(pitchLimit(view.alt), (view.manual ?? view.pitch) - dy * 0.005));
    syncTilt();
  } else if (!dragGround(e.clientX - dx, e.clientY - dy, e.clientX, e.clientY)) {
    const k = 2 * Math.PI * Math.min(0.5, view.alt * 0.35) / innerHeight;   // off the globe (sky): drag moves the ground by angle
    pan.x -= dx * k; pan.y -= dy * k;
  }
});
// Drag on the globe: the ground point under the cursor stays under it. North-up views (heading within 2° of north at the
// drag's start) away from the poles move like a map: a turn about the polar axis for the longitude and a tilt along the
// meridian for the latitude, so north stays up. Elsewhere (a turned view, or within 20° of a pole) the rig turns by the
// one rotation that carries the new hit point onto the old one (arcball), which is defined everywhere, over the pole too.
const dgRay = new THREE.Raycaster(), dgS = new THREE.Sphere(new THREE.Vector3(), RADIUS), dgA = new THREE.Vector3(), dgB = new THREE.Vector3(), dgQ = new THREE.Quaternion(), dgQ2 = new THREE.Quaternion(), dgAx = new THREE.Vector3();
const ndc = (x, y) => new THREE.Vector2(x / innerWidth * 2 - 1, -(y / innerHeight) * 2 + 1);
function dragGround(x0, y0, x1, y1) {
  applyView(0);
  dgRay.setFromCamera(ndc(x0, y0), camera); if (!dgRay.ray.intersectSphere(dgS, dgA)) return false;
  dgRay.setFromCamera(ndc(x1, y1), camera); if (!dgRay.ray.intersectSphere(dgS, dgB)) return false;
  dgA.normalize(); dgB.normalize();
  if (drag.northUp === undefined) drag.northUp = Math.abs(view.heading) < 2 * D2R;
  const mapLike = drag.northUp && Math.abs(view.n.y) < Math.sin(70 * D2R);
  if (mapLike) {
    // longitude: turn about the polar axis so B's longitude becomes A's; latitude: along n's meridian by the difference
    const lonA = Math.atan2(-dgA.z, dgA.x), lonB = Math.atan2(-dgB.z, dgB.x);
    let dl = lonA - lonB; dl = Math.atan2(Math.sin(dl), Math.cos(dl));
    rotateRig(dgQ.setFromAxisAngle(dgAx.set(0, 1, 0), dl));   // the rig (and the cursor ray with it) turns so the ray meets A
    const dLat = Math.asin(Math.max(-1, Math.min(1, dgA.y))) - Math.asin(Math.max(-1, Math.min(1, dgB.y)));
    northAt(view.n);
    rotateRig(dgQ2.setFromAxisAngle(dgAx.copy(east), -dLat));   // about east by −δ moves n δ toward north (east = north × n)
    view.heading = 0;
  } else rotateRig(dgQ.setFromUnitVectors(dgB, dgA));
  applyView(0);
  return true;
}
// Released: the view eases back to north-up over about a second when the drag went near a pole (|lat| > 70°, where the
// arcball turns the view) or the camera is out at whole-globe range. A deliberate turn close in (right drag) is kept.
const endDrag = e => {
  if (!drag || e.pointerId !== drag.id) return;
  if (drag.moved && !follow && (drag.polar || view.alt >= WHOLE_ALT)) northEase = true;
  drag = null;
};
canvas.addEventListener('pointermove', () => { if (drag && Math.abs(view.n.y) > Math.sin(70 * D2R)) drag.polar = true; });
// Touch (pointer events with pointerType 'touch' only, so mouse, pen and trackpad keep their own paths):
// one finger drags (above). Two fingers, the maps way: one gesture per touch, read from how the pair has moved since the
// second finger came down, then kept until the fingers lift (touchKind):
//  - tilt: both fingers move up or down together → camera tilt, like a right-drag (up tilts toward the horizon);
//  - twist: the fingers turn around each other → heading only (the ground turns with the fingers);
//  - pinch: the spacing changes → zoom only, toward the fingers' midpoint (the ground under it stays under it).
// UX 2026-11-23 (first-visitor feedback: "with two fingers the angles keep shifting"): a pinch never turns or tilts the
// camera, a twist never zooms, a tilt never zooms or turns. Same askAlt path as the wheel (a pinch past the limit over an
// unlocked spot only makes the Open button glow). Lifting one finger hands the drag to the finger left down.
// 2026-11-23 (night, touch rotate and tilt; Benn on his iPhone: "can't rotate the view on the phone, only zoom"): the
// old rule wanted a turn 2.5x the spacing change and a vertical move 2.5x the spread, so real twists and two-finger drags
// almost always locked to pinch. Now the three moves are compared in the same unit, css px over the decision window:
//   spacing change |Δd|, the arc each finger turned through |Δangle|·d/2, and the pair's common vertical move (counted
//   only when both fingers move vertically the same way). After TOUCH_DECIDE px of movement (or TOUCH_TURN of turn) the
//   one that leads by TOUCH_MARGIN wins; a close call waits for more movement, up to TOUCH_LATE px, then the larger one
//   wins (spacing on a tie). The gesture that wins takes up the movement made while it was being read, so nothing is lost.
const touches = new Map(); let pinch = null, touchMulti = false;
const TOUCH_DECIDE = 12, TOUCH_LATE = 28, TOUCH_TURN = 10 * D2R, TOUCH_MARGIN = 1.3;
const pairOf = () => { const [a, b] = [...touches.values()]; return { d: Math.hypot(a.x - b.x, a.y - b.y), ang: Math.atan2(b.y - a.y, b.x - a.x), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; };
const pinchStart = () => { const p = pairOf(); return { ...p, start: p, f0: [...touches.values()].map(t => ({ ...t })), kind: null }; };
function touchKind(P, p) {                                // null = keep reading
  const s0 = P.start, dd = Math.abs(p.d - s0.d);
  let da = p.ang - s0.ang; da = Math.abs(Math.atan2(Math.sin(da), Math.cos(da)));
  const arc = da * s0.d / 2, mx = p.mx - s0.mx, my = p.my - s0.my;
  const [a1, b1] = [...touches.values()], ya = a1.y - P.f0[0].y, yb = b1.y - P.f0[1].y;
  const together = ya * yb > 0 && Math.min(Math.abs(ya), Math.abs(yb)) > 0.35 * Math.max(Math.abs(ya), Math.abs(yb));
  const vert = together && Math.abs(my) > 1.2 * Math.abs(mx) ? Math.abs(my) : 0;
  const moved = Math.max(dd, arc, Math.hypot(mx, my));
  if (moved < TOUCH_DECIDE && da < TOUCH_TURN) return null;
  const top = Math.max(dd, arc, vert);
  if (vert === top && vert >= TOUCH_MARGIN * Math.max(dd, arc)) return 'tilt';
  if (arc === top && arc >= 6 && (arc >= TOUCH_MARGIN * Math.max(dd, vert) || (da >= TOUCH_TURN && arc >= dd))) return 'twist';
  if (dd === top && dd >= TOUCH_MARGIN * Math.max(arc, vert)) return 'pinch';
  if (moved < TOUCH_LATE) return null;
  return vert > Math.max(dd, arc) ? 'tilt' : arc > dd ? 'twist' : 'pinch';   // late: the larger one (a two-finger slide with no spacing/turn reads as pinch: the ground follows the midpoint)
}
canvas.addEventListener('pointerdown', e => {
  if (e.pointerType !== 'touch') return;
  if (!touches.size) touchMulti = false;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size === 2) { drag = null; touchMulti = true; down = null; pinch = pinchStart(); zoom.cursor = null; }
  else if (touches.size > 2) pinch = null;            // three fingers: nothing (lift back to two to carry on)
});
canvas.addEventListener('pointermove', e => {
  if (!touches.has(e.pointerId)) return;
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (!pinch || touches.size !== 2 || flight) return;
  const p = pairOf(); if (p.d < 1 || pinch.d < 1) return;
  if (!pinch.kind) {
    pinch.kind = touchKind(pinch, p);
    if (!pinch.kind) return;                             // not decided yet: nothing moves (pinch.d/ang/mx/my stay at the start)
    if (window.__globe) window.__globe.touchKind = pinch.kind;   // test hook (review/ux/phone3)
    // UX 2026-11-23: a pinch centred within 60 px of a spot zooms to the spot itself (as the wheel does), so it stays put
    if (pinch.kind === 'pinch') { zoom.cursor = null; zoom.spot = null; STICK.r = null; wheelAnchor({ clientX: p.mx, clientY: p.my, target: null }, 60); }
  }
  let dAng = p.ang - pinch.ang; dAng = Math.atan2(Math.sin(dAng), Math.cos(dAng));
  const dy = p.my - pinch.my;
  if (pinch.kind === 'twist') {                          // heading only (the ground turns with the fingers)
    if (follow) releaseFollow();
    northEase = false; view.heading -= dAng;
  } else if (pinch.kind === 'tilt') {
    releaseFollow(); northEase = false;
    view.manual = Math.max(0, Math.min(pitchLimit(view.alt), (view.manual ?? view.pitch) - dy * 0.005));
    syncTilt();
  } else {
    let ask = zoom.target * pinch.d / p.d;
    if (p.d > pinch.d && zoom.target <= altMin() * 1.02) ask = Math.min(ask, altMin() * Math.exp(-Math.min(0.45, Math.log(p.d / pinch.d) * 3)));
    zoom.target = askAlt(ask);
    if (!follow && !zoom.spot) zoomAnchor(p.mx, p.my, true);
  }
  pinch.d = p.d; pinch.ang = p.ang; pinch.mx = p.mx; pinch.my = p.my;
});
const endTouch = e => {
  if (!touches.delete(e.pointerId)) return;
  if (touches.size < 2) pinch = null;
  else if (touches.size === 2) pinch = pinchStart();     // back from three fingers to two: read a new gesture
  if (touches.size === 1 && touchMulti && !flight) {     // back to one finger: it carries on dragging from where it is
    const [[id, t]] = [...touches.entries()];
    drag = { x: t.x, y: t.y, id, tilt: false, moved: true };
  }
};
canvas.addEventListener('pointerup', endTouch); canvas.addEventListener('pointercancel', endTouch);
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
const pq = new THREE.Quaternion();
function panFrame() {
  if (Math.abs(pan.x) + Math.abs(pan.y) < 1e-9) return;
  rigFrame();
  const ax = pan.x * 0.25, ay = pan.y * 0.25; pan.x -= ax; pan.y -= ay;
  // about fwd by ax: n moves toward right; about right by ay: n moves toward −fwd for ay > 0
  const r0 = right.clone(), f0 = fwd.clone();
  rotateRig(pq.setFromAxisAngle(f0, ax)); rotateRig(pq.setFromAxisAngle(r0, ay));
}

// ---------- tilt control beside the zoom slider ----------
const tiltSlider = document.getElementById('tilt-slider'), tiltAuto = document.getElementById('tilt-auto');
tiltSlider.max = Math.round(PITCH_MAX / D2R);
let tiltInputAt = -1e9;
tiltSlider.addEventListener('input', () => { view.manual = Math.min(pitchLimit(view.alt), +tiltSlider.value * D2R); tiltInputAt = performance.now(); syncTilt(); });
// The slider shows the pitch actually reached (the camera floor, ~2 km above the ground, can stop a low camera short of
// the asked tilt), except while it is being dragged or just after an input, so the thumb does not fight the user.
let tiltHeld = false;
tiltSlider.addEventListener('pointerdown', () => { tiltHeld = true; });
addEventListener('pointerup', () => { tiltHeld = false; }); addEventListener('pointercancel', () => { tiltHeld = false; });
tiltAuto.onclick = () => { view.manual = null; syncTilt(); };
function syncTilt() {
  tiltAuto.classList.toggle('on', view.manual === null);
  tiltAuto.setAttribute('aria-pressed', view.manual === null);
  if (!tiltHeld && performance.now() - tiltInputAt > 600) tiltSlider.value = Math.round(view.pitch / D2R);   // (a moment after a key or click, too)
}

// ---------- fly to storm and follow (layers with getFocusTargets) ----------
// Follow view: an oblique three-quarter view, 40° above the horizon (pitch 50° from straight down), far enough back
// that the storm's whole inflow disc and its full column fit in the frame, slowly orbiting. From above the inward
// pull of the haze reads; from near the horizon it does not. Manual tilt down to the horizon stays available.
const FOLLOW_PITCH = 50 * D2R;
// hurricanes (no anvil) are followed a little lower, ~57°, so the spiral reads as a disc with depth (storms session ask)
const followPitch = layer => ((layer.userData || {}).anvilSpanR > 0 ? FOLLOW_PITCH : 57 * D2R);
const FOLLOW_FOV = BASE_FOV;
const FOLLOW_ORBIT = 0.035;     // rad/s: one turn around the storm in about 3 minutes
const FOLLOW_D = 0.06;          // closest follow distance, radii (~380 km; also the plain globe's zoom limit while following)
function followDist(layer, rating) {   // camera distance (radii) that frames the inflow disc and the column
  const u = layer.userData || {};
  const rk = Math.max(0, Math.min(5, Math.round(isFinite(rating) ? rating : 2)));
  // what must fit: a storm with an anvil (tornado-live) is framed by its anvil, so the funnel and cloud fill the view (its
  // illustrative inflow haze reaches 2-3x further and framing that left the camera ~2,000-3,000 km up); a storm without
  // one (hurricanes) by its haze reach for this rating (the recorded gale radius scale); else 0.12
  let rho = u.anvilSpanR > 0 ? 0.8 * u.anvilSpanR : Array.isArray(u.hazeReach) && u.hazeReach[rk] > 0 ? u.hazeReach[rk] : 0.12;
  const el = 90 * D2R - followPitch(layer), vHalf = Math.tan(fitFov() * D2R / 2), hHalf = vHalf * camera.aspect;
  let d = 0.3;
  for (let i = 0; i < 3; i++) {        // the drawn column height depends on the distance (the layer eases its exaggeration)
    const H = stormHeight(layer, d);
    const dV = (2 * rho * Math.sin(el) + H * Math.cos(el)) / (2 * vHalf * 0.85);   // disc foreshortened + column, 85% of the height
    const dH = rho / (hHalf * 0.85);
    d = Math.max(FOLLOW_D, dV, dH);
  }
  return Number.isFinite(d) ? Math.min(d, 1.5) : 0.3;
}
const llDir = t => latLonToVector3(t.lat, t.lon).normalize();
function stormHeight(layer, d) {  // the layer's drawn column height at camera distance d (radii), 0 if unknown
  const u = layer.userData || {}, m = u.funnels && u.funnels.material && u.funnels.material.uniforms;
  const H = u.systemHeightR; if (!(H > 0)) return 0;
  const ex = (u.exaggeration && u.exaggeration.height) || 1, near = m && m.uNear ? m.uNear.value : 0.1, far = m && m.uFar ? m.uFar.value : 1.1;
  const tz = Math.max(0, Math.min(1, (d - near) / ((far - near) || 1)));
  return H * (1 / ex + (1 - 1 / ex) * tz);
}
function targetsOf(layer) { try { const t = layer.getFocusTargets(); return Array.isArray(t) ? t.filter(x => x && isFinite(x.lat) && isFinite(x.lon)) : []; } catch (e) { return []; } }
const FLY_MIN_LEFT = 12;   // display seconds a storm should still have when Fly picks it (else the next strongest)
function flyToStorm(layer) {
  if (flight && !follow) return;                       // during a follow (e.g. a tornado hand-over flight) a Fly button takes over
  const ts = targetsOf(layer); if (!ts.length) return;
  hideCard();
  // round 3 (#3): the strongest storm with time left in the replay. From a fresh load the strongest was often ~10 display s
  // from its end, so it faded out ~8 s after the click and the camera sat on empty sea until the hand-over (~14 s).
  const left = t => (isFinite(t.timeLeft) ? t.timeLeft : Infinity);
  // Round 4 (round-3 #3): timeLeft now counts the storms layer's watch hold (08-storms), so the strongest storm usually
  // passes the 12 s test. Guard kept anyway: never a storm under 34 kt (a depression) while a stronger one with >= 6 s exists.
  let t0 = ts.find(t => left(t) >= FLY_MIN_LEFT) || ts.find(t => left(t) >= 6) || ts[0];
  if (isFinite(t0.wind) && t0.wind < 34) {
    const strong = ts.filter(t => isFinite(t.wind) && t.wind >= 34 && left(t) >= 6).sort((a, b) => b.wind - a.wind)[0];
    if (strong) t0 = strong;
  }
  follow = { layer, id: t0.id ?? null, name: t0.name, dir: llDir(t0), look: 0, rating: t0.rating };
  flyTo(null, null, RADIUS + followDist(layer, t0.rating), { dir: () => follow && follow.dir, pitch: followPitch(layer), extra: 800 });
}
function releaseFollow() { if (follow) { follow = null; zoom.target = clampAlt(zoom.target); northEase = true; } }   // ends: ease back to north-up
// North-up: eases the heading back to 0 (after a follow, or from the N button). A turn-drag cancels it.
// At whole-globe range the Earth always sits north-up when nothing holds it (no drag, follow, or turned flight): a view
// that arrives there turned (zoomed out from a turned close view, a flight that carried a heading) eases back by itself.
let northEase = false;
function northFrame(dt) {
  if (!northEase && !drag && !pinch && !follow && !flight && view.alt >= WHOLE_ALT && Math.abs(view.heading) > 0.2 * D2R) northEase = true;
  if (!northEase || (flight && !flight.toNorth) || drag) return;
  const d = Math.atan2(Math.sin(-view.heading), Math.cos(-view.heading));   // shortest turn to north
  if (Math.abs(d) < 1e-3) { view.heading = 0; northEase = false; if (follow) follow.noOrbit = true; return; }
  // on a flight out, the turn waits until the camera has climbed (no whirl over the reef), done by ~0.3 radii up
  const climb = flight ? smooth((Math.log(view.alt) - Math.log(0.01)) / (Math.log(0.3) - Math.log(0.01))) : 1;
  view.heading += d * Math.min(1, dt * 2.5 * climb);
}
document.getElementById('north').onclick = () => { northEase = true; if (follow) follow.noOrbit = true; };
// Compass (top right, always shown): a ring of dots whose bright dot points to north on screen; click = north up.
const compass = document.getElementById('compass'), rose = compass.querySelector('.rose');
for (let i = 0; i < 8; i++) {
  const a = i * Math.PI / 4, d = document.createElement('i'); if (!i) d.className = 'n';
  d.style.transform = `translate(${(12 * Math.sin(a)).toFixed(2)}px, ${(-12 * Math.cos(a)).toFixed(2)}px)`; rose.appendChild(d);
}
{ const b = document.createElement('b'); b.textContent = 'N'; b.style.marginTop = '-5px'; rose.appendChild(b); }
compass.onclick = () => { northEase = true; if (follow) follow.noOrbit = true; };
let compassDeg = NaN;
function compassFrame() {   // north on screen sits −heading from screen-up (the camera's screen-up is the facing direction)
  const deg = -view.heading / D2R;
  if (!(Math.abs(deg - compassDeg) < 0.2)) { compassDeg = deg; rose.style.transform = `rotate(${deg.toFixed(1)}deg)`; }
}
// Home (top bar): eases back to the default whole-globe, north-up view (HOME), Atlantic-centred.
document.getElementById('home-btn').onclick = () => {
  if (arrival) return;
  releaseFollow(); hideCard(); view.manual = null; zoom.cursor = null;
  flyTo({ pos: latLonToVector3(HOME.lat, HOME.lon, 1), status: 'home' }, null, RADIUS + HOME.alt);
};
// Storm lock: the follow stays on the storm that was strongest when the button was pressed (the layer gives no id), matched
// each frame by name within LOCK_GATE of where it was (an unnamed storm: the nearest within the gate; a storm moves far
// less than that between frames), and kept until it has been gone from the list for LOST_S (flicker does not drop it).
// Then the strongest storm left is picked and the camera flies there; follow stays set during that flight.
const LOCK_GATE = 0.03, LOST_S = 1.5;
const END_HOLD_S = 2.5, END_FLY_EXTRA = 1600, END_OUT_ALT = 0.6;   // a storm that ended: held 2.5 s, then a slow (+1.6 s) fly on or out
function followFrame(dt) {
  if (!follow) return;
  if (!follow.layer.visible) { releaseFollow(); return; }
  const ts = targetsOf(follow.layer);
  let best = null, bd = LOCK_GATE;
  if (follow.id != null) best = ts.find(t => t.id === follow.id) || null;   // a stable id (layers give one now): stay with that storm until it ends
  else for (const t of ts) if (t.name && t.name === follow.name) { const a = llDir(t).angleTo(follow.dir); if (a < bd) { bd = a; best = t; } }
  if (!best && follow.id == null && !follow.name) for (const t of ts) { const a = llDir(t).angleTo(follow.dir); if (a < bd) { bd = a; best = t; } }   // unnamed: nearest
  // A storm about to end (the layer's fade < 0.6 or under 2 display s left; 08-storms getFocusTargets) starts the calm
  // ease-out while it is still visible: "… ending", the orbit slows to a stop over END_HOLD_S, then the hand-over. A storm
  // gone from the list without that warning (flicker, or a layer without timeLeft/fade) is declared ended after LOST_S.
  // (a storm fading IN also has fade < 0.6: only a falling fade with under 4 s left counts)
  const fadingOut = !!best && isFinite(best.fade) && best.fade < 0.6 && best.fade < (follow.lastFade ?? 1) - 1e-4 && !(best.timeLeft >= 4);
  const recovered = !!best && !(best.fade < 0.8) && !(best.timeLeft < 4);   // once "ending", it stays so unless clearly back
  const ending = !!best && (fadingOut || (isFinite(best.timeLeft) && best.timeLeft < 2) || (!!follow.ended && follow.fading && !recovered));
  follow.lastFade = best && isFinite(best.fade) ? best.fade : null;
  if (best && !ending) { follow.lost = 0; follow.ended = null; follow.endT = 0; follow.orbit0 = 1; follow.name = best.name; follow.rating = best.rating; follow.dir.copy(llDir(best)); }
  else {
    if (best) { follow.lost = 0; follow.name = best.name; follow.rating = best.rating; follow.dir.copy(llDir(best)); }   // still drawn: keep it centred
    else follow.lost = (follow.lost || 0) + dt;
    follow.fading = !!best;
    if (!follow.ended && (ending || follow.lost >= LOST_S)) { follow.ended = follow.name || 'The storm'; follow.endT = 0; }
    if (follow.ended) { follow.endT = (follow.endT || 0) + dt; follow.orbit0 = Math.max(0, (follow.orbit0 ?? 1) - dt / END_HOLD_S); }
    if (follow.ended && follow.endT >= END_HOLD_S && !flight) {
      // the next storm: not the one ending, and one with >= 3 display s left when there is such a storm
      const others = ts.filter(t => !(follow.id != null ? t.id === follow.id : (t.name && t.name === follow.name)));
      const next = others.find(t => !(isFinite(t.timeLeft) && t.timeLeft < FLY_MIN_LEFT)) || others.find(t => !(isFinite(t.timeLeft) && t.timeLeft < 3)) || others[0];
      if (next) {                                              // to the strongest storm left: a slow fly with a climb
        follow.prev = follow.ended; follow.ended = null; follow.endT = 0; follow.fading = false; follow.orbit0 = 1; follow.lastFade = null;
        follow.id = next.id ?? null; follow.name = next.name; follow.rating = next.rating; follow.dir.copy(llDir(next)); follow.lost = 0; follow.handover = true;
        const f = follow;
        flyTo(null, () => { f.handover = false; }, RADIUS + followDist(follow.layer, next.rating), { dir: () => follow && follow.dir, pitch: followPitch(follow.layer), extra: END_FLY_EXTRA });
      } else {                                                 // none left: let go and ease back out to a regional view
        const where = follow.dir.clone(), out = Math.min(ALT_MAX, Math.max(END_OUT_ALT, view.alt * 3));
        endedNote = { name: follow.ended, until: performance.now() + 6000 };
        releaseFollow(); view.manual = null;
        flyTo({ pos: where, status: 'storm-ended' }, null, RADIUS + out, { extra: END_FLY_EXTRA });
        return;
      }
    }
  }
  follow.look = 0.3 * stormHeight(follow.layer, view.alt);
  if (!flight) { view.n.lerp(follow.dir, Math.min(1, dt * 4)).normalize(); if (!follow.noOrbit && !northEase) view.heading += FOLLOW_ORBIT * dt * (follow.orbit0 ?? 1); }
  follow.aimK = flight ? 0 : Math.min(1, (follow.aimK || 0) + dt / 0.8);   // the aim (followAim) eases in after a flight
}
// After applyView: turn the rig so the followed storm sits in the middle of the part of the screen left free by the top
// bar and an open panel (not the middle of the window, which put it half under the panel), and exactly on its track (the
// lerp above alone trailed a fast replayed storm by 30-50 px). Eased in over 0.8 s after each flight (aimK).
const aimRay = new THREE.Raycaster(), aimS = new THREE.Sphere(new THREE.Vector3(), RADIUS), aimH = new THREE.Vector3(), aimP = new THREE.Vector3(), aimQ = new THREE.Quaternion(), aimI = new THREE.Quaternion();
function followAim() {
  if (!follow || flight || drag || !(follow.aimK > 0)) return;
  let L = 0, T = 0;
  const bar = document.getElementById('bar'), pr = panel.hidden ? null : panel.getBoundingClientRect();
  if (bar) T = bar.getBoundingClientRect().bottom;
  if (pr && pr.width) { if (pr.width < innerWidth * 0.6) L = pr.right; else T = Math.max(T, pr.bottom); }   // phone: the panel spans the width
  const cx = (L + innerWidth) / 2, cy = (T + innerHeight) / 2;
  aimS.radius = RADIUS + view.look;
  aimRay.setFromCamera(new THREE.Vector2(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1), camera);
  if (!aimRay.ray.intersectSphere(aimS, aimH)) return;
  aimP.copy(follow.dir).normalize(); aimH.normalize();
  aimQ.setFromUnitVectors(aimH, aimP);
  rotateRig(aimI.identity().slerp(aimQ, follow.aimK));
  applyView(0);
}
// Round 3 (#12): the followed storm's name under the top bar while following (the Fly button's text sits in the panel)
const followCap = document.getElementById('follow-cap');
setInterval(() => {
  if (!followCap) return;
  const t = !follow ? '' : follow.ended ? `${follow.ended} ${follow.fading ? 'ending' : 'ended'}`
    : follow.handover ? `Flying to ${follow.name || 'the next storm'}` : `Following ${follow.name || 'storm'} · drag to let go`;
  if (followCap.textContent !== t) followCap.textContent = t;
  followCap.hidden = !t;
}, 300);
let endedNote = null;   // { name, until }: "… ended" shown on the layer's fly button after a follow lets go
// Click on the canvas: nearest visible marker within 18 px of the pointer.
const tmp = new THREE.Vector3();
function screenOf(v) { tmp.copy(v).project(camera); return [(tmp.x + 1) / 2 * innerWidth, (1 - tmp.y) / 2 * innerHeight]; }
function facing(r) { return r.pos.dot(tmp.copy(camera.position).sub(r.pos)) > 0; }   // on the camera's side of the globe
let down = null;
canvas.addEventListener('pointerdown', e => { down = e.button === 0 && !e.shiftKey && !e.altKey && !e.ctrlKey ? [e.clientX, e.clientY] : null; });
canvas.addEventListener('pointerup', e => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;   // a drag, not a click
  if (e.pointerType === 'touch' && touchMulti) return;   // part of a two-finger gesture
  // UX 2026-11-23: on touch the spot names let gestures through to the globe (index.html), so a tap on a name is found
  // here, from the name's box (8 px slack), before the nearest marker within 28 px
  if (e.pointerType === 'touch') {
    for (const r of regions) {
      if (!r.label || !r.label.classList.contains('show')) continue;
      const b = r.label.getBoundingClientRect();
      if (e.clientX > b.left - 8 && e.clientX < b.right + 8 && e.clientY > b.top - 8 && e.clientY < b.bottom + 8) { tapSpot(r); return; }   // dad 2026-11-23 night
    }
  }
  let best = null, bd = e.pointerType === 'touch' ? 28 : 18;
  for (const r of regions) {
    if (!facing(r) || !shownKind(r) || !inFront(r.pos) || (follow && r.wanted)) continue;
    const [x, y] = screenOf(r.markAt), d = Math.hypot(x - e.clientX, y - e.clientY);
    if (d < bd) { bd = d; best = r; }
  }
  if (best) tapSpot(best); else popClose(true);   // dad 2026-11-23 night: a marker opens its card; a click on the globe closes it
});
canvas.addEventListener('pointermove', e => {
  let hit = null, bd = 22;
  if (drag) return;
  for (const r of regions) { if (!facing(r) || !shownKind(r) || !inFront(r.pos) || (follow && r.wanted)) continue; const [x, y] = screenOf(r.markAt), d = Math.hypot(x - e.clientX, y - e.clientY); if (d < bd) { bd = d; hit = r; } }
  if (hit && hit.cl) hit = hit.cl.lead;              // a cluster highlights as one
  for (const r of regions) if (!r.lblHover) r.hover = r === hit;
  canvas.style.cursor = hit ? 'pointer' : 'grab';
});

// ---------- optional layer modules (layers.json) ----------
// ---------- notices: every "research and play, not a forecast" text in one place (wording follows research/licences-for-app.md) ----------
const NOTICE = {
  standing: 'For research and play only. Not a forecast or warning service.',
  about: 'Oceany is for research and play only. It is not a forecast, warning or navigation tool. The data can be late, wrong or missing, and the illustrative parts are labelled as such. For real warnings, use the official services:',
  official: [
    ['US tornado and severe weather', 'https://www.weather.gov/'],
    ['Hurricanes', 'https://www.nhc.noaa.gov/'],
    ['Space weather (aurora)', 'https://www.swpc.noaa.gov/'],
    ['Earthquakes', 'https://earthquake.usgs.gov/'],   // 12-quakes
  ],
  officialTail: 'For marine forecasts, use your national weather service.',
  liveLayer: 'Not an official product. Do not use for safety decisions.',
  liveExtra: { 'tornado-live': 'If a warning is in effect where you are, follow weather.gov and local officials.' },
  liveCue: { 'tornado-live': 'NOAA reports active tornado warnings' },   // the glow's tooltip: a report, never an instruction
  liveIds: new Set(['hurricanes', 'tornado-live', 'aurora', 'quakes-live', 'snow', 'wind', 'waves', 'swell']),  // live data and model layers (the SPC tornado archive is history)
  // the on-globe line under the standing line: live feeds and model output (hurricanes are an IBTrACS replay of past
  // tracks, so their line stays in the panel only)
  globeIds: new Set(['hurricanes', 'tornadoes', 'tornado-live', 'aurora', 'quakes-live', 'snow', 'wind', 'waves', 'swell']),
};
{
  const a = document.getElementById('notice-standing');
  if (a) {
    a.textContent = '';
    const s1 = document.createElement('span'); s1.textContent = NOTICE.standing;
    const s2 = document.createElement('span'); s2.id = 'notice-live'; s2.textContent = NOTICE.liveLayer; s2.hidden = true;
    a.append(s1, s2);
    a.onclick = e => { e.preventDefault(); openSection('about'); };
  }
  const box = document.getElementById('notice-about');
  if (box) {
    const p1 = document.createElement('div'); p1.textContent = NOTICE.about; box.appendChild(p1);
    const ul = document.createElement('ul');
    for (const [t, u] of NOTICE.official) { const li = document.createElement('li'), l = document.createElement('a'); l.href = u; l.target = '_blank'; l.rel = 'noopener noreferrer'; l.textContent = `${t}: ${u.replace(/^https:\/\/(www\.)?|\/$/g, '')}`; li.appendChild(l); ul.appendChild(li); }
    box.appendChild(ul);
    const p2 = document.createElement('div'); p2.textContent = NOTICE.officialTail; box.appendChild(p2);
  }
}
const layers = [];
const layerBox = document.getElementById('layers');
// A layer may expose plain strings .label (what is real and what is illustrative) and .status (what it shows now),
// and .setMode(m). Label and status are shown under its toggle while it is on, as text (never HTML); status is
// re-read every second. If it has setMode, a small mode switch is shown (auto | live | replay when the layer
// reports a current mode in userData.mode, else live | replay).
function layerInfo(obj, item, box) {
  const info = document.createElement('div'); info.className = 'layer-info';
  const lab = document.createElement('div'); lab.className = 'layer-label';
  const st = document.createElement('div'); st.className = 'layer-status';
  // the layer's full account (obj.details, plain text) on demand, under a small toggle
  const more = document.createElement('button'); more.type = 'button'; more.className = 'layer-more'; more.textContent = 'about this layer';
  more.setAttribute('aria-expanded', 'false');
  const det = document.createElement('div'); det.className = 'layer-details'; det.hidden = true;
  more.onclick = () => { det.hidden = !det.hidden; more.setAttribute('aria-expanded', String(!det.hidden)); more.classList.toggle('on', !det.hidden); };
  const lid = obj.userData.layerId;
  if (NOTICE.liveIds.has(lid)) {                      // live data: the safety line comes first, ahead of the details
    const warn = document.createElement('div'); warn.className = 'layer-notice';
    warn.textContent = NOTICE.liveLayer + (NOTICE.liveExtra[lid] ? ' ' + NOTICE.liveExtra[lid] : '');
    info.appendChild(warn);                           // always visible while the layer is on (round-2 #1), not inside the collapsed details
  }
  const detText = document.createElement('div'); det.appendChild(detText);
  info.append(lab, st, more, det);
  let modeBox = null;
  if (typeof obj.setMode === 'function') {
    modeBox = document.createElement('div'); modeBox.className = 'layer-modes'; modeBox.setAttribute('role', 'group'); modeBox.setAttribute('aria-label', 'Mode');
    const modes = obj.userData && 'mode' in obj.userData ? ['auto', 'live', 'replay'] : ['live', 'replay'];
    for (const m of modes) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = m; b.dataset.mode = m;
      b.onclick = () => { obj.setMode(m); refresh(); };
      modeBox.appendChild(b);
    }
    info.insertBefore(modeBox, lab);
  }
  item.appendChild(info);
  function refresh() {
    info.style.display = box.checked ? '' : 'none';
    lab.textContent = typeof obj.label === 'string' ? obj.label : '';
    let dt = typeof obj.details === 'string' ? obj.details : '';
    if (NOTICE.liveIds.has(lid) && dt.startsWith(NOTICE.liveLayer)) dt = dt.slice(NOTICE.liveLayer.length).trim();   // the layer's own copy of the safety line: shown once, above
    if (detText.textContent !== dt) detText.textContent = dt;
    more.style.display = dt ? '' : 'none'; if (!dt) det.hidden = true;
    st.textContent = typeof obj.status === 'string' ? obj.status : '';
    lab.style.display = lab.textContent ? '' : 'none'; st.style.display = st.textContent ? '' : 'none';
    if (modeBox) {
      const cur = obj.userData && obj.userData.mode;
      for (const b of modeBox.children) b.classList.toggle('on', b.dataset.mode === cur);
    }
  }
  const prev = obj.userData && obj.userData.onChange;
  if (obj.userData) obj.userData.onChange = l => { if (prev) prev(l); refresh(); };
  setInterval(refresh, 1000);
  refresh();
  return refresh;
}
// Extra controls under a layer, only for the methods it has: "show all paths" (setShowPaths, default off) and
// "Fly to strongest storm" (getFocusTargets). Returns a function that shows/hides them with the layer.
function layerExtras(obj, item, box) {
  const wrap = document.createElement('div'); wrap.className = 'layer-extras';
  if (typeof obj.setShowPaths === 'function') {
    const row = document.createElement('label'); row.className = 'layer sub';
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = false;
    try { obj.setShowPaths(false); } catch (e) { /* layer refused: leave as is */ }
    cb.onchange = () => { try { obj.setShowPaths(cb.checked); } catch (e) { /* ignore */ } };
    row.append(cb, document.createTextNode(' show all paths')); wrap.appendChild(row);
  }
  let fly = null;
  if (typeof obj.getFocusTargets === 'function') {
    fly = document.createElement('button'); fly.type = 'button'; fly.className = 'fly-storm';
    fly.onclick = () => { if (follow && follow.layer === obj) releaseFollow(); else flyToStorm(obj); refreshFly(); };
    wrap.appendChild(fly);
    setInterval(refreshFly, 500);
  }
  function refreshFly() {
    if (!fly) return;
    const mine = follow && follow.layer === obj, n = targetsOf(obj).length;
    fly.disabled = !mine && (!n || !!flight);
    fly.classList.toggle('on', !!mine);
    const ended = endedNote && endedNote.until > performance.now() ? `${endedNote.name} ended · ` : '';
    fly.textContent = mine ? (follow.ended ? `${follow.ended} ${follow.fading ? 'ending' : 'ended'} · ${n > (follow.fading ? 1 : 0) ? 'moving on to the next' : 'none left, easing out'}` : `Following ${follow.name || 'storm'} · ${follow.handover ? (follow.prev ? follow.prev + ' ended, flying to the next' : 'next storm') : 'drag or click to release'}`) : ended + (n ? 'Fly to strongest storm' : 'Fly to strongest storm (none active now)');
  }
  if (wrap.children.length) item.appendChild(wrap);
  const sync = () => { wrap.style.display = box.checked ? '' : 'none'; refreshFly(); };
  sync();
  return sync;
}
// While the live tornado layer is on, the other layers that can dim are dimmed to 0.25; restored when it goes off.
// "Not an official product…" under the standing line whenever a live or model layer is on (round-2 #1)
function syncLiveNotice() {
  const el = document.getElementById('notice-live'); if (!el) return;
  const on = layers.some(l => NOTICE.globeIds.has(l.userData.layerId) && l.visible);
  if (el.hidden === on) el.hidden = !on;
}
setInterval(syncLiveNotice, 500);
function syncDim() {
  syncLiveNotice();
  const live = layers.some(l => l.userData.layerId === 'tornado-live' && l.visible);
  for (const l of layers) {
    if (l.userData.layerId === 'tornado-live' || typeof l.setDim !== 'function') continue;
    const k = live ? 0.25 : 1;
    if (l.userData.dimNow !== k) { try { l.setDim(k); l.userData.dimNow = k; } catch (e) { /* ignore */ } }
  }
}
// Live cue: a layer may offer async checkActivity() -> { active, where: {lat, lon} | null, note } (safe while hidden, one
// light request). It is polled at load and every 10 minutes; while active, the layer's row in Layers glows softly (slow
// pulse), its note shows under it and as its tooltip, and the Layers button in the top bar glows while that section is
// closed. Layers without the method are never asked.
function liveCue() {
  let any = false;
  for (const l of layers) {
    const row = l.userData.row, a = l.userData.activity; if (!row) continue;
    const on = !!(a && a.active); any = any || on;
    row.classList.toggle('live', on);
    const cue = NOTICE.liveCue[l.userData.layerId];
    const note = on && cue ? cue : a && typeof a.note === 'string' ? a.note : '';
    row.title = note;
    let sub = row.parentElement && row.parentElement.querySelector(':scope > .live-note');
    if (note && !sub && row.parentElement) { sub = Object.assign(document.createElement('div'), { className: 'live-note' }); row.after(sub); }
    if (sub) { sub.textContent = note; sub.hidden = !note; }
  }
  const lb = document.querySelector('#bar button[data-sec="layers"]');
  if (lb) lb.classList.toggle('live', any && lb.getAttribute('aria-expanded') !== 'true');
}
setInterval(liveCue, 1000);
// Arrival of a layer switched on: it fades in over about a second (setDim if it has one, else its materials' opacity),
// and, seen from whole-globe zoom with nothing else going on, the camera eases 40% of the way toward its place
// (checkActivity().where, else its first focus target) at the same zoom. The fly pauses auto-rotate, which resumes after.
function layerArrive(obj) {
  const t0 = performance.now(), D = 1000;
  const dimTo = obj.userData.dimNow ?? 1, mats = [];
  if (typeof obj.setDim !== 'function') obj.traverse(o => { const m = o.material; if (!m) return; for (const mm of (Array.isArray(m) ? m : [m])) {
    if (mm.uniforms && mm.uniforms.uOpacity) mats.push([mm.uniforms.uOpacity, 'value', mm.uniforms.uOpacity.value]); else if (mm.transparent) mats.push([mm, 'opacity', mm.opacity]); } });
  const step = () => {
    const k = Math.min(1, (performance.now() - t0) / D), e = k * k * (3 - 2 * k);
    if (typeof obj.setDim === 'function') { try { obj.setDim(dimTo * e); } catch (err) { /* ignore */ } }
    else for (const [o, f, v] of mats) o[f] = v * e;
    if (k < 1 && obj.visible) setTimeout(step, 30);
    else if (typeof obj.setDim === 'function') { try { obj.setDim(dimTo); } catch (err) { /* ignore */ } }
    else for (const [o, f, v] of mats) o[f] = v;
  };
  step();
  if (view.alt < 1.2 || flight || drag || follow || arrival) return;
  const a = obj.userData.activity, w = a && a.where && isFinite(a.where.lat) && isFinite(a.where.lon) ? a.where : targetsOf(obj)[0];
  if (!w) return;
  const to = latLonToVector3(w.lat, w.lon).normalize(), from = view.n.clone();
  const q = new THREE.Quaternion().setFromUnitVectors(from, to), dir = from.applyQuaternion(new THREE.Quaternion().slerp(q, 0.4));
  flyTo({ pos: dir, status: 'nudge' }, null, RADIUS + view.alt);
}
async function loadOne(ent, item, row, box, txt) {
  try {
    // ent.v (optional, layers.json): a version tag added to the module URL, so a changed layer is not served from cache.
    // The module file's Last-Modified (one no-cache HEAD) is added too, so an edited layer loads fresh on a normal reload even
    // when nobody bumped its tag. (Its own imports, e.g. dots_common.js, are not tagged: bump the tag when only those change.)
    const base = new URL(ent.module, new URL('./layers.json', location.href)).href;
    let lm = '';
    try { const h = await fetch(base, { method: 'HEAD', cache: 'no-cache' }); const m = h.ok && h.headers.get('last-modified'); if (m) lm = String(Date.parse(m) / 1000 | 0); } catch (e) { /* offline or no HEAD: the tag alone */ }
    const tag = [ent.v, lm].filter(Boolean).join('.');
    const url = base + (tag ? '?v=' + encodeURIComponent(tag) : '');
    const mod = await import(url);
    const obj = await mod.createLayer({ THREE, radius: RADIUS, makeDotMaterial, palette, latLonToVector3 });
    if (!(obj instanceof THREE.Object3D)) throw new Error('createLayer did not return an Object3D');
    obj.userData.layerId = ent.id;
    scene.add(obj); layers.push(obj);
    box.disabled = false; box.checked = restored && restored.layers && ent.id in restored.layers ? restored.layers[ent.id] : ent.on === true && (PROFILE === 'desktop' || ent.id === 'hurricanes'); obj.visible = box.checked; txt.textContent = ent.label;   // layers.json 'on': starts shown (dad 2026-11-23 night: on phones only hurricanes starts on; the rest is one tap in Layers)
    const refresh = (typeof obj.label === 'string' || typeof obj.status === 'string' || typeof obj.setMode === 'function')
      ? layerInfo(obj, item, box) : () => {};
    const extras = layerExtras(obj, item, box);
    obj.userData.row = row;
    box.onchange = () => { obj.visible = box.checked; refresh(); extras(); syncDim(); updateHint(); if (box.checked) layerArrive(obj); };
    syncDim(); updateHint();
    if (typeof obj.checkActivity === 'function') {            // optional live cue (see liveCue)
      const poll = async () => {
        try { const a = await obj.checkActivity(); obj.userData.activity = a && typeof a === 'object' ? a : null; } catch (e) { obj.userData.activity = null; }
        liveCue();
      };
      poll(); setInterval(poll, 10 * 60 * 1000);
    }
  } catch (e) {
    row.classList.add('missing'); txt.textContent = ent.label; txt.after(Object.assign(document.createElement('span'), { className: 'state', textContent: 'not available' }));
    console.info(`Oceany globe: layer "${ent.id}" skipped:`, e && (e.message || e.type || String(e)));
  }
}
async function loadLayers() {
  let entries = [];
  try { const r = await fetch('./layers.json', { cache: 'no-cache' }); if (r.ok) entries = await r.json(); } catch (e) { /* no layers.json: nothing to load */ }
  if (!entries.length) return;
  layerBox.textContent = '';
  await Promise.all(entries.map(ent => {
    const item = document.createElement('div'); item.className = 'layer-item';
    const row = document.createElement('label'); row.className = 'layer';
    const box = document.createElement('input'); box.type = 'checkbox'; box.disabled = true;
    const txt = document.createElement('span'); txt.textContent = ent.label;
    const state = Object.assign(document.createElement('span'), { className: 'state', textContent: 'loading' });
    row.append(box, txt, state); item.appendChild(row); layerBox.appendChild(item);
    return loadOne(ent, item, row, box, txt).finally(() => state.remove());
  }));
}
loadLayers();

// ---------- top bar: one panel section open at a time (remembered), the spin toggle ----------
let uiBoxes = [], uiBoxesAt = -1e9;   // the panel, zoom bar and card: labels are not placed under them
const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
const panel = document.getElementById('panel'), barBtns = [...document.querySelectorAll('#bar button[data-sec]')];
function openSection(sec) {
  panel.hidden = !sec;
  for (const el of panel.querySelectorAll('section')) el.hidden = el.dataset.sec !== sec;
  for (const b of barBtns) b.setAttribute('aria-expanded', String(b.dataset.sec === sec));
  store.set('oceany.globe.section', sec || '');
  uiBoxesAt = -1e9;                                   // labels re-check what the panel covers
}
for (const b of barBtns) b.onclick = () => openSection(b.getAttribute('aria-expanded') === 'true' ? null : b.dataset.sec);
openSection(innerWidth <= 600 ? null : store.get('oceany.globe.section') || null);   // first visit: everything closed, the globe is clear; a phone always starts closed (a panel covers the globe there)

// Auto-rotate, physically: the camera holds still against the stars and the Earth turns under it, west to east. In the
// scene (Earth-fixed) frame that is the camera rig's ground point moving westward about the polar axis while the sky
// turns by the same angle, so stars hold still on screen and keep their sidereal alignment with the Earth at the view
// clock. Speed ×1 is Earth's real spin, one turn per sidereal day (360.9856° per 24 h, the GMST rate below); faster speeds
// run the view clock fast (sky and Earth together), never the data, which stays at the current time. Full speed from
// the whole globe in to SPIN_FULL radii up, none closer than SPIN_NONE. It pauses on any drag, zoom, tilt, marker click,
// open card, storm follow or fly-in, and comes back SPIN_RESUME_MS after the last of those.
const SPIN_SPEED_DEFAULT = 780, SPIN_SPEED_MAX = 5000;     // ×780 ≈ one turn in 1 min 50 s
const SIDEREAL_S = 86400 * 360 / 360.98564736629;          // 86164.09 s = 23 h 56 min 4 s
const SPIN_FULL = 2.0, SPIN_NONE = 0.5, SPIN_RESUME_MS = 6000;
const spin = { on: new URLSearchParams(location.search).get('spin') !== '0',   // on at every load (owner); ?spin=0 is the only way to start without it
  k: 0, quietUntil: 0, speed: SPIN_SPEED_DEFAULT, skyDeg: 0 };   // skyDeg: how far the view clock's sky has run ahead of real GMST
const spinBtn = document.getElementById('spin-btn'), spinBox = document.getElementById('spin-toggle');
function setSpin(on) { spin.on = on; spinBtn.setAttribute('aria-pressed', String(on)); spinBox.checked = on; spin.quietUntil = 0;
  const sb = document.getElementById('spin-speed-box'); if (sb) sb.hidden = !on; }   // UX 2026-11-23: speed shows only while spinning   // toggles within a visit only, not remembered
const spinAsk = on => { setSpin(on); if (on && zoom.target < SPIN_OFF_ALT && !flight && !arrival) { releaseFollow(); zoom.cursor = null; zoom.target = clampAlt(SPIN_FULL); } };   // phone 2026-11-23 late
spinBtn.onclick = () => spinAsk(!spin.on); spinBox.onchange = () => spinAsk(spinBox.checked);
setSpin(spin.on);
// speed slider: log scale 0…1000 → ×1…×SPIN_SPEED_MAX, rounded to two significant figures; snaps to the ×1 notch
const speedSlider = document.getElementById('spin-speed'), speedOut = document.getElementById('spin-speed-out'), speedReal = document.getElementById('spin-real');
const LOG_MAX = Math.log10(SPIN_SPEED_MAX), SNAP = 70;   // slider units: the bottom 7 % snaps to ×1
const round2 = x => { const p = Math.pow(10, Math.floor(Math.log10(x)) - 1); return Math.round(x / p) * p; };
const speedFromSlider = v => v < SNAP ? 1 : round2(Math.pow(10, v / 1000 * LOG_MAX));
const sliderFromSpeed = s => Math.round(Math.log10(s) / LOG_MAX * 1000);
function turnWords(sec) {
  if (sec < 60) return `${sec < 10 ? sec.toFixed(1) : Math.round(sec)} s`;
  if (sec < 3600) { const m = Math.floor(sec / 60), r = Math.round(sec - 60 * m); return r ? `${m} min ${r} s` : `${m} min`; }
  const h = Math.floor(sec / 3600), m = Math.floor((sec - 3600 * h) / 60); return m ? `${h} h ${m} min` : `${h} h`;
}
function setSpeed(s) {
  spin.speed = s;
  const real = s === 1;
  speedSlider.value = String(real ? 0 : sliderFromSpeed(s));
  speedSlider.setAttribute('aria-valuetext', real ? 'Real speed' : `×${s.toLocaleString('en')}`);
  speedOut.textContent = real ? 'Real speed: one turn in 23 h 56 min' : `×${s.toLocaleString('en')}, one turn in ${turnWords(SIDEREAL_S / s)}`;
  speedReal.setAttribute('aria-pressed', String(real));
}
speedSlider.addEventListener('input', () => setSpeed(speedFromSlider(+speedSlider.value)));
speedReal.onclick = () => { setSpeed(1); if (!spin.on) spinAsk(true); };
// phone 2026-11-23 late: on a phone (≤600 px) the speed controls sit in the View panel under the Spin checkbox, so the bar
// is one row; back in the bar when the window is wider
{ const mq = matchMedia('(max-width: 600px)'), box = document.getElementById('spin-speed-box'), holder = document.getElementById('spin-speed-holder');
  const place = () => { if (mq.matches) holder.appendChild(box); else spinBtn.after(box); };
  if (box && holder) { place(); mq.addEventListener('change', place); } }
setSpeed(SPIN_SPEED_DEFAULT);
const spinPause = () => { spin.quietUntil = performance.now() + SPIN_RESUME_MS; };
canvas.addEventListener('pointerdown', () => { zoom.cursor = null; });   // a drag ends any zoom-to-cursor hold
canvas.addEventListener('pointerdown', spinPause); canvas.addEventListener('wheel', spinPause, { passive: true }); labelBox.addEventListener('wheel', spinPause, { passive: true });
for (const el of [slider, tiltSlider, document.getElementById('zoom-in'), document.getElementById('zoom-out'), tiltAuto]) el.addEventListener('pointerdown', spinPause);
addEventListener('keydown', e => { if (e.target !== speedSlider) { spinPause(); zoom.cursor = null; } });
const spinQ = new THREE.Quaternion(), yAxis = new THREE.Vector3(0, 1, 0);
// phone 2026-11-23 late: Spin is for the whole globe. Closer than SPIN_OFF_ALT (1 radius, ~6,400 km up: about a
// continent across the screen) it switches itself off, button and checkbox too, whatever brought the camera down (pinch,
// wheel, +, slider, a fly-to, a return from the viewer). Asking for Spin while close lifts the view back out to SPIN_FULL.
const SPIN_OFF_ALT = 1.0;
function spinFrame(now, dt) {
  if (spin.on && view.alt < SPIN_OFF_ALT && zoom.target < SPIN_OFF_ALT) { setSpin(false); spin.k = 0; }
  const busy = !!(drag || flight || follow || arrival) || card.style.display === 'block' || now < spin.quietUntil;
  // dad 2026-11-23 night: a spot under the pointer, an open spot card or the tour stops the turn at once, so names don't
  // drift away while you aim at them
  if (POP.r || TOUR.on || regions.some(q => q.hover)) { spin.k = 0; return; }
  const zoomK = smooth((Math.log(view.alt) - Math.log(SPIN_NONE)) / (Math.log(SPIN_FULL) - Math.log(SPIN_NONE)));
  const want = spin.on && !busy ? zoomK : 0;
  spin.k += (want - spin.k) * Math.min(1, dt * 1.5);  // eases in and out over about a second
  if (spin.k < 1e-4) return;
  const rate = spin.speed * spin.k;                    // × real spin
  const deg = 360 / SIDEREAL_S * dt * rate;
  rotateRig(spinQ.setFromAxisAngle(yAxis, -deg * D2R));   // n and the facing together: at a pole the view simply turns
  // the real clock already turns the sky ×1; the view clock adds the rest, so the sky turns with the camera
  spin.skyDeg = (spin.skyDeg + 360 / SIDEREAL_S * dt * Math.max(0, rate - 1)) % 360;
}

// Zoom and tilt bar: faint until the pointer comes near it (or it has keyboard focus)
const zoomBar = document.getElementById('zoom');
addEventListener('pointermove', e => {
  const b = zoomBar.getBoundingClientRect(), dx = Math.max(b.left - e.clientX, 0, e.clientX - b.right), dy = Math.max(b.top - e.clientY, 0, e.clientY - b.bottom);
  zoomBar.classList.toggle('faded', Math.hypot(dx, dy) > 110 && !zoomBar.contains(document.activeElement));
});
zoomBar.classList.add('faded');
zoomBar.addEventListener('focusin', () => zoomBar.classList.remove('faded'));

// Markers sit on the ground: with terrain on, just above the drawn relief under them (it is exaggerated far out), so a
// low camera never sees them float in the sky; with terrain off, just above the base globe. Re-read twice a second.
function groundLift(r) {
  const now = performance.now();
  if (r.liftAt && now - r.liftAt < 500) return;
  r.liftAt = now;
  let lift = 0.0005;                                   // ~3 km: above the base globe's dots, as before
  if (terrain.enabled) { const h = terrain.elevationAt(r.lat, r.lon); lift = (Math.max(0, h || 0) * dotExag.value + 120) / 6371000; }
  r.markAt.copy(r.pos).multiplyScalar(1 + lift);
  for (const m of [r.marker, r.pin, r.halo, r.uholo]) if (m) m.position.copy(r.markAt);
}

// ---------- frame loop ----------
const camDir = new THREE.Vector3();
let lastFrame = 0, lastTiltSync = 0;
const HOLO_NEAR = 1.0;          // radii: wanted holograms show closer than this (whole globe: small dots only)
let followDim = 1;
const followDimFor = () => /^hurricane/.test((follow && follow.layer && follow.layer.userData && follow.layer.userData.layerId) || '') ? 0.5 : 0.7;   // ground under a storm follow
// Tornado follow ground (08-storms ask): at the follow distance (~0.14 radii) the base globe's 41 km dots stood ~30 px apart
// on black under the storm. Terrain detail comes on for a tornado follow (our tiles cover the globe to z7, ~2 km dots, same
// origin, so the ground fills in within a second or two) and goes off again when the follow ends, if it was this that
// turned it on. A manual untick (terrainOff) is respected; ticking or unticking during the follow hands it back to the user.
let followTerrain = false;
function followGroundFrame() {
  // Round 5 (round-4 #4): hurricane follows too. At ~0.22 radii the base globe's 41 km dots read as a sparse lattice round the
  // storm; the tiles (z7, ~2 km dots, everywhere) fill the ground in, dimmed harder than for a tornado (followDimFor) so the storm reads.
  const want = !!follow && /^(tornado|hurricane)/.test((follow.layer && follow.layer.userData && follow.layer.userData.layerId) || '');
  if (want && !terrain.enabled && !terrainOff && !arrival) { followTerrain = true; terrainBox.checked = true; setTerrain(true); }
  else if (!want && followTerrain && !flight) { followTerrain = false; if (terrain.enabled) { terrainBox.checked = false; setTerrain(false); } }
}
const perf = { frames: 0, worst: 0 };   // read from the console: __globe.perf
const inFront = v => { tmp.copy(v).applyMatrix4(camera.matrixWorldInverse); return tmp.z < 0; };
function animate(now) { requestAnimationFrame(animate); frame(now); }
// Labels: shown little by default, more on interaction. Always named: unlocked spots, the hovered or focused marker and
// the picked one (card open). Others are named only as you zoom in, a few at a time, nearest the screen centre first by
// priority (quick-unlock wanted spots, then the rest): none at whole-globe zoom, up to LBL_MAX close in. A label that
// would overlap one already placed tries the left side of its point, then stays hidden. Labels fade (CSS) in and out.
const lblCand = [], placed = [];
const LBL_MAX = 10, LBL_FAR = 1.2, LBL_NEAR = 0.04;   // camera distance (radii): no optional names at LBL_FAR, all slots at LBL_NEAR
// hidden: the side preference resets, so a label that had to go left of its marker comes back to the right next time
function showLbl(r, on) { if (r.lblOn !== on) { r.lblOn = on; r.label.classList.toggle('show', on); } if (!on) r.lblSide = 0; }
function placeLabels() {
  const nowMs = performance.now();
  if (nowMs - uiBoxesAt > 500) {
    uiBoxesAt = nowMs;
    uiBoxes = ['bar', 'panel', 'zoom', 'zoom-note', 'card', 'hint'].map(id => document.getElementById(id)).filter(e => e && e.getClientRects().length)
      .map(e => { const b = e.getBoundingClientRect(); return [b.left, b.top, b.right, b.bottom]; });
  }
  const zk = smooth((Math.log(LBL_FAR) - Math.log(view.alt)) / (Math.log(LBL_FAR) - Math.log(LBL_NEAR)));
  const nOpt = Math.round(LBL_MAX * zk), rad = (0.2 + 0.6 * zk) * Math.min(innerWidth, innerHeight);
  lblCand.sort((a, b) => a[3] - b[3] || a[4] - b[4]);
  placed.length = 0; placed.push(...uiBoxes);
  let opt = 0;
  for (const c of lblCand) {
    const [r, x, y, pr, dc] = c, el = r.label;
    if (!Number.isFinite(x) || !Number.isFinite(y)) { showLbl(r, false); continue; }
    if (pr >= 1 && (opt >= nOpt || dc > rad)) { showLbl(r, false); continue; }
    if (!r.lblSize || !r.lblSize[0]) r.lblSize = [el.offsetWidth, el.offsetHeight];   // measured once (fixed text)
    const [w, h] = r.lblSize;
    let side = -1;
    for (const s of [r.lblSide ?? 0, 1 - (r.lblSide ?? 0)]) {
      const x0 = s ? x - 10 - w - 2 : x + 10 - 2, y0 = y - h / 2 - 1, x1 = x0 + w + 4, y1 = y0 + h + 2;
      let free = w > 0 && x0 >= 4 && x1 <= innerWidth - 4 && y0 >= 0 && y1 <= innerHeight;   // inside the window: never clipped at the edge (phone)
      for (const q of placed) if (x0 < q[2] && x1 > q[0] && y0 < q[3] && y1 > q[1]) { free = false; break; }
      if (free) { placed.push([x0, y0, x1, y1]); side = s; break; }
    }
    if (side < 0) { showLbl(r, false); continue; }
    if (pr >= 1) opt++;
    r.lblSide = side;
    const lx = side ? x - 10 - w : x + 10, ly = y;
    if (!r.lblAt || !(Math.abs(r.lblAt[0] - lx) < 0.5 && Math.abs(r.lblAt[1] - ly) < 0.5)) {
      r.lblAt = [lx, ly]; el.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly - h / 2)}px)`;   // whole pixels: crisp text
    }
    showLbl(r, true);
  }
  lblCand.length = 0;
}
// Ocean and continent names: faint, at whole-globe zoom only (gone by GEO_NEAR radii up), fading toward the limb.
const GEO = [['Atlantic Ocean', 28, -42, 1], ['Atlantic Ocean', -22, -18, 1], ['Pacific Ocean', 8, -145, 1], ['Pacific Ocean', -25, -120, 1],
  ['Pacific Ocean', 25, 160, 1], ['Indian Ocean', -20, 78, 1], ['Southern Ocean', -60, 20, 1], ['Arctic Ocean', 80, 0, 1],
  ['Africa', 6, 21, 0], ['Europe', 53, 20, 0], ['Asia', 48, 92, 0], ['North America', 45, -102, 0], ['South America', -12, -58, 0],
  ['Australia', -25, 134, 0], ['Antarctica', -80, 30, 0]].map(([t, la, lo, sea]) => {
  const el = document.createElement('div'); el.className = 'geo-name' + (sea ? ' sea' : ''); el.textContent = t;
  document.getElementById('geo-names').appendChild(el);
  return { el, pos: latLonToVector3(la, lo), sea, w: 0, o: -1 };
});
const GEO_FAR = 1.6, GEO_NEAR = 0.9;
function geoFrame() {
  const zk = smooth((Math.log(view.alt) - Math.log(GEO_NEAR)) / (Math.log(GEO_FAR) - Math.log(GEO_NEAR)));
  for (const g of GEO) {
    const d = g.pos.dot(camDir) / RADIUS;
    let o = zk * smooth((d - 0.45) / 0.3) * (follow ? 0 : 1);
    if (o > 0.01) {
      if (!g.w) g.w = g.el.offsetWidth;
      const [x, y] = screenOf(g.pos);
      g.el.style.transform = `translate(${Math.round(x - g.w / 2)}px, ${Math.round(y - 7)}px)`;
    }
    o = Math.round(o * (g.sea ? 0.45 : 0.55) * 20) / 20;
    if (o !== g.o) { g.o = o; g.el.style.opacity = o; }
  }
}
// Marker sizes are in css px: pxW(px, d) is the world size that px css pixels cover at distance d from the camera.
const pxW = (px, d) => px * renderer.getPixelRatio() / dotScale.value * d;
const UHOLO_NEAR = 0.12;        // radii: an unlocked spot's hologram shows closer than this (if nothing is near it on screen)
// Unlocked spots closer on screen than CL_PX merge into one cluster marker at the spot nearest the screen centre (the
// picked one first), with one label: "<place>: n spots" when the notes share a place name, else "<name> +n". The
// cluster splits as you zoom in. Where the zoom limit stops it splitting (plain globe, spots a few km apart), the
// members keep one marker but each gets its own label (clSplit). Clicking a cluster flies in until it splits.
const CL_PX = 16;
let CL_ID = 0;                                        // dad 2026-11-23 night: cluster identity across frames
function clusterName(cl) {
  const m = cl.members, places = new Set(m.map(b => b.place));
  const p = places.size === 1 ? [...places][0] : '';
  // short: the first part of a "Place / Break" name, so a cluster label stays a short tag beside its marker
  return p && !m.some(b => b.name === p) ? `${p}: ${m.length} spots` : `${cl.lead.name.split(' / ')[0]} +${m.length - 1}`;
}
function clusterFrame() {
  const vis = [], cx = innerWidth / 2, cy = innerHeight / 2;
  for (const r of regions) {
    r.wasLead = r.clLead; r.wasCl = r.cl && !r.clSplit ? r.cl.id : (r.clSplit ? r.clSplitId : 0);   // dad 2026-11-23 night: last frame's cluster
    r.cl = null; r.clLead = false; r.clSplit = false; r.nearPx = 1e9;
    if (r.wanted || r.status !== 'unlocked') continue;
    if (!(r.pos.dot(camDir) > 0.18 && facing(r) && inFront(r.pos))) continue;
    [r.sx, r.sy] = screenOf(r.markAt); vis.push(r);
  }
  for (const a of vis) for (const b of vis) if (a !== b) a.nearPx = Math.min(a.nearPx, Math.hypot(a.sx - b.sx, a.sy - b.sy));
  // dad 2026-11-23 night: on a phone pinch the lead (the member nearest the centre) kept swapping, so the one label jumped
  // ~80 px between Supertubos and Porto Batel, and the cluster split and re-formed at the CL_PX edge. Last frame's lead
  // now keeps the lead, and spots that were together stay together until 1.5 × CL_PX apart.
  vis.sort((a, b) => (b === picked) - (a === picked) || (b.wasLead ? 1 : 0) - (a.wasLead ? 1 : 0) || Math.hypot(a.sx - cx, a.sy - cy) - Math.hypot(b.sx - cx, b.sy - cy));
  const atLimit = view.alt < altMin() * 1.6;
  for (const a of vis) {
    if (a.cl) continue;
    const m = vis.filter(b => !b.cl && Math.hypot(a.sx - b.sx, a.sy - b.sy) < (a.wasCl && b.wasCl === a.wasCl ? CL_PX * 1.5 : CL_PX));
    if (m.length < 2) continue;
    const cl = { members: m, lead: a, id: a.wasCl || ++CL_ID };
    for (const b of m) { b.cl = cl; b.clSplit = atLimit; b.clSplitId = cl.id; }
    a.clLead = true;
  }
  for (const r of regions) {
    if (r.wanted || r.status !== 'unlocked') continue;
    const text = r.cl && !r.clSplit && r.clLead ? clusterName(r.cl) : r.name;   // only the lead carries the cluster's label (no hidden duplicate)
    if (r.label.textContent !== text) { r.label.textContent = text; r.lblSize = null; }
    if (r.clSplit) r.cl = null;                     // split labels pick their own spot
  }
}
function zoomCluster(cl) {
  if (flight) return;
  const c = new THREE.Vector3(); let sep = Infinity;
  for (const a of cl.members) { c.add(a.pos); for (const b of cl.members) if (a !== b) sep = Math.min(sep, a.pos.distanceTo(b.pos)); }
  const k = dotScale.value / renderer.getPixelRatio();          // css px per world unit at distance 1
  const a = Math.max(altMin() * 1.05, Math.min(view.alt * 0.6, sep * k / 48));   // far enough in that they sit ~48 px apart
  releaseFollow();
  flyTo({ pos: c.normalize(), status: 'cluster' }, null, RADIUS + a);
}
function frame(now) {
  const t = now / 1000, dt = Math.max(0, Math.min(0.1, (now - (lastFrame || now)) / 1000)); lastFrame = Math.max(lastFrame, now);
  if (arrival) arrivalFrame(now);
  if (flight) stepFlight(now); else { panFrame(); spinFrame(now, dt); }
  followFrame(dt);
  northFrame(dt);
  zoomFrame(dt);
  enterFrame(now, dt);
  if (TOUR.tick) TOUR.tick(now);                     // gesture tour 2026-11-23: its demo moves the camera here, before it is placed
  applyView(dt);
  zoomHold();
  followAim();
  if (now - lastTiltSync > 100) { lastTiltSync = now; syncTilt(); }
  const h = camera.position.length() - RADIUS;      // the camera's real height (low when tilted)
  const near = Math.min(0.005, Math.max(2e-6, h * 0.05)), far = h < 0.2 ? 4 : 100;
  if (camera.near !== near || camera.far !== far) { camera.near = near; camera.far = far; camera.updateProjectionMatrix(); }
  followGroundFrame();
  if (terrain.enabled) terrainFrame(now);
  else dotExag.value = exagFor(camera.position.length() - RADIUS);   // base-globe mountains: same eased exaggeration
  if (exagLabel(dotExag.value) !== hintExag) updateHint();
  // following a storm: the Earth's dots dim to 70% so the sea does not swamp the storm's dots (storms session ask)
  const fd0 = followDim; followDim += ((follow ? followDimFor() : 1) - followDim) * Math.min(1, dt * 3);
  if (followDim > 0.999) followDim = 1;
  if (followDim < 1 || fd0 < 1) earth.material.uniforms.uOpacity.value = (terrain.enabled ? earth.material.uniforms.uOpacity.value : 1) * followDim;
  // markers keep a roughly constant screen size: scale with their distance from the camera
  camDir.copy(camera.position).normalize();
  labelBox.classList.toggle('following', !!follow);
  const cx = innerWidth / 2, cy = innerHeight / 2;
  clusterFrame();
  for (const r of regions) {
    const front = r.pos.dot(camDir) > 0.18 && facing(r) && inFront(r.pos);
    const alt = Math.max(MIN_ALT, camera.position.distanceTo(r.pos));
    const sel = r === picked && card.style.display === 'block', hot = r.hover || sel;
    groundLift(r);
    if (r.holo) {
      const on = front && shownKind(r) && !follow;       // wanted spots step aside while a storm is followed
      // hologram grows in within ~1 radius of the camera (about the middle of the zoom slider) or on hover
      r.hk += ((on && (alt < HOLO_NEAR || hot) ? 1 : 0) - r.hk) * Math.min(1, dt * 6);
      r.holo.visible = on && r.hk > 0.02;
      r.pin.visible = on && r.hk < 0.9;
      const hz = r.kind === 'hazard';
      // pin: a few px at every zoom, a little larger on hover
      const dp = Math.max(1e-6, camera.position.distanceTo(r.markAt));
      if (r.pin.visible) r.pin.material.uniforms.uSize.value = pxW(hz ? 4.5 : 4, dp) * (r.hover ? 1.5 : 1);
      if (r.halo) {
        r.halo.visible = r.pin.visible;
        if (r.halo.visible) { r.halo.scale.setScalar(pxW(7, dp)); r.halo.material.uniforms.uSize.value = pxW(1.8, dp); }
      }
      // the picked spot (card open) shows a larger hologram, locked on, so it reads from the pick altitude
      r.pk = (r.pk || 0) + ((sel ? 1 : 0) - (r.pk || 0)) * Math.min(1, dt * 4);
      if (r.holo.visible) r.holo.userData.update(t, 0.02 * alt * r.hk * (1 + 1.2 * r.pk), hot);
      if (on) { const [x, y] = screenOf(r.markAt); lblCand.push([r, x + 14 * r.hk, y, hot ? 0 : r.quick ? 1 : 2, Math.hypot(x - cx, y - cy)]); }
      else showLbl(r, false);
      continue;
    }
    // a small crisp marker of a fixed size in css px at every zoom (pxW): centre dot and a ring of six; a cluster of
    // spots (clusterFrame) draws one, a little wider; hover grows it by a fifth, never back into a blob
    const s = r.style, pulse = 1 + 0.25 * s.pulse * Math.sin(t * 2.5 + r.lon);
    r.hg = (r.hg || 0) + ((hot ? 1 : 0) - (r.hg || 0)) * Math.min(1, dt * 10);   // hover: the marker grows and brightens
    const d = Math.max(1e-6, camera.position.distanceTo(r.markAt)), lead = !r.cl || r.clLead;
    if (r.uholo) {
      const close = view.alt < UHOLO_NEAR && r.nearPx > 70;   // close in, with room for it on screen
      r.pk = (r.pk || 0) + ((sel ? 1 : 0) - (r.pk || 0)) * Math.min(1, dt * 4);
      r.hk += ((front && lead && !follow && (hot || close) ? 1 : 0) - r.hk) * Math.min(1, dt * 6);
      r.uholo.visible = r.hk > 0.02;
      if (r.uholo.visible) r.uholo.userData.update(t, pxW(16, d) * r.hk * (1 + 0.8 * r.pk), hot);
    }
    const hk = r.hk || 0;
    r.marker.scale.setScalar(pxW((r.clLead ? 6.5 : 5) * s.size * pulse * (1 + 0.2 * r.hg), d));   // ring radius
    r.marker.material.uniforms.uSize.value = pxW(3.4 * s.size * (1 + 0.2 * r.hg), d);              // dot size
    r.marker.material.uniforms.uOpacity.value = s.opacity * (r.uholo ? 1.7 : 1) * (1 + 0.4 * r.hg);   // > 1: a saturated core, crisp when small
    r.marker.visible = front && lead && hk < 0.9 && !follow;   // spots step aside while a storm is followed
    if (front && !follow && (lead || r.clSplit)) { const [x, y] = screenOf(r.markAt); lblCand.push([r, x + 14 * hk, y, r.status === 'unlocked' || hot ? 0 : 2, Math.hypot(x - cx, y - cy)]); }
    else showLbl(r, false);
  }
  placeLabels(); geoFrame(); compassFrame();
  for (const l of layers) if (l.visible && typeof l.update === 'function') l.update(t, camera);   // hidden layers: skipped; camera: optional, for zoom-dependent sizing
  skyFrame(now); updateSkySize();
  renderer.clear();
  renderer.render(starScene, starCam);
  renderer.clearDepth();
  renderer.render(scene, camera);
  perf.frames++; perf.worst = Math.max(perf.worst, dt);
}
// ---------- arriving from the seafloor viewer: ?from=<spot id>&at=lat,lon&d=<m>&h=<deg>&p=<deg> ----------
// The viewer sends this when you zoom out past a reef patch (or press "Back to globe"). The camera starts where the
// viewer's left off: low over the spot (d metres away, h compass heading, p degrees from straight down), terrain detail
// on so the close view is not empty. A dark cover (the viewer's last frame) fades straight away; once the tiles under
// the camera are in (or after 2.5 s) the camera eases out to a whole-Earth view: the mirror of the fly-in. The parameters are removed from the
// address at once (history.replaceState), so a reload or Back never replays the arrival or bounces into the viewer.
let arrival = null;
{
  const q = new URLSearchParams(location.search), from = q.get('from'), at = (q.get('at') || '').split(',').map(Number);
  if (from !== null || q.has('at')) {
    const keep = new URLSearchParams(location.search); ['from', 'at', 'd', 'h', 'p'].forEach(k => keep.delete(k));
    history.replaceState(history.state, '', location.pathname + (keep.toString() ? '?' + keep : '') + location.hash);
    const r = regions.find(x => x.id === from);
    const ll = at.length === 2 && at.every(Number.isFinite) && Math.abs(at[0]) <= 90 ? at : r ? [r.lat, r.lon] : null;
    if (ll) {
      const terrainBefore = restored && typeof restored.terrain === 'boolean' ? restored.terrain : terrainBox.checked;   // round 4: no longer restored (terrain stays on at the 0.3 stop)
      if (!terrainBox.checked) { terrainBox.checked = true; setTerrain(true); }
      const num = (k, def) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : def; };
      view.n.copy(latLonToVector3(ll[0], ll[1], 1)).normalize();
      view.alt = zoom.target = clampAlt(num('d', 15000) / 6371000);
      view.heading = num('h', 0) * D2R;
      view.pitch = view.manual = Math.min(pitchLimit(view.alt), Math.max(0, num('p', 50)) * D2R);
      const cover = document.createElement('div');
      cover.style.cssText = 'position:fixed;inset:0;background:#04070d;opacity:1;pointer-events:none;z-index:40;transition:opacity .9s ease';
      document.body.appendChild(cover);
      requestAnimationFrame(() => requestAnimationFrame(() => { cover.style.opacity = '0'; }));   // fade in at once: the globe's dots show while the close tiles load
      arrival = { t0: performance.now(), cover, dir: view.n.clone(), terrainBefore };
    }
  }
}
function arrivalFrame(now) {
  const a = arrival;
  if (a.flying) return;
  const st = terrain.status(), wait = now - a.t0;
  // hold low until the tiles under the camera are in: a close level is drawn and nothing is still being fetched
  // (or 6 s at most, so a slow or failed tile server never strands the camera; here tiles reached z11 after ~5 s)
  if (!(st && st.z >= 10 && terrain.pending === 0) && wait < 6000) return;
  a.flying = true; a.cover.style.opacity = '0';
  setTimeout(() => a.cover.remove(), 1000);
  // terrain goes back to what it was before the hand-off (off by default) once the camera is out at the whole Earth
  // Round 4 (round-3 #10): ease out to ~0.3 radii over the spot (the region in view, your place kept), not to the whole
  // Earth. Terrain stays on there: switched off at 0.3 the plain globe is sparse dots on black.
  flyTo(null, () => { arrival = null; view.manual = null; }, RADIUS + 0.3, { dir: () => a.dir, extra: 1400 });
  view.manual = null;
}

requestAnimationFrame(animate);
if (restored && restored.palette && restored.palette !== 'Ocean') {   // back from a spot: the palette you had (item 11)
  const b = [...document.getElementById('palettes').children].find(x => x.textContent === restored.palette); if (b) b.onclick();
}

// Debug hook for the browser console.
// ---------- UX 2026-11-23: first-visit welcome (calm first view) ----------
// One line on what this is and one suggested first action (fly down to Supertubos), shown once per browser; any drag,
// pinch or wheel on the globe also puts it away (the visitor has started on their own). Never shown on a return from the
// viewer or a deep link.
// dad 2026-11-23 night: a third button, "Show me around", starts a short tour of the controls round the screen (never
// forced), and the bar's "?" brings the welcome (and so the tour) back at any time.
const touchUI = matchMedia('(pointer: coarse)').matches;
function showWelcome(first) {
  const W_KEY = 'oceany-globe-welcome-v1', w = document.getElementById('welcome');
  if (!w) return;
  if (touchUI) document.getElementById('welcome-how').textContent = 'Drag to move. Pinch to zoom.';
  w.hidden = false; popClose();
  const done = () => { if (w.hidden) return; w.hidden = true; store.set(W_KEY, '1'); canvas.removeEventListener('pointerdown', done); canvas.removeEventListener('wheel', done); };
  document.getElementById('welcome-close').onclick = done;
  document.getElementById('welcome-go').onclick = () => {
    done(); const r = regions.find(q => q.id === 'supertubos' && q.pos);
    if (r) pickRegion(r);
  };
  const t = document.getElementById('welcome-tour'); if (t) t.onclick = () => { done(); tourStart(); };
  canvas.addEventListener('pointerdown', done, { once: true });
  canvas.addEventListener('wheel', done, { once: true, passive: true });
  if (!first) { const g = document.getElementById('welcome-tour') || document.getElementById('welcome-go'); g.focus({ preventScroll: true }); }
}
{
  const qs = new URLSearchParams(location.search);
  if (!store.get('oceany-globe-welcome-v1') && !qs.has('from') && !qs.has('at')) showWelcome(true);
  const h = document.getElementById('help-btn');
  // on a phone (≤600 px) the one-row bar has no room left (it ends at the compass): "?" sits at the foot of the zoom column
  if (h) { const mq = matchMedia('(max-width: 600px)'), place = () => { if (mq.matches) document.getElementById('zoom').appendChild(h); else document.getElementById('home-btn').after(h); }; place(); mq.addEventListener('change', place); }
  if (h) h.onclick = () => { const w = document.getElementById('welcome'); if (w && !w.hidden) { w.hidden = true; store.set('oceany-globe-welcome-v1', '1'); } tourStart(); };
  setTimeout(() => tourResume(), 0);                  // r3: the tour carries on after a visit to the viewer (defined below)   // gesture tour 2026-11-23: "?" (re)starts the tour
}
// gesture tour 2026-11-23 late night: the tour teaches HOW to move (Benn: "swipe like this to zoom, move here to move
// this"). It lives in tour.js (loaded on first use): an animated cue on the globe itself, the camera moving with it as a
// demo, then the visitor's turn with a "Nice" tick, then rings round the real controls. Started only from the welcome's
// "Show me around" or "?". While it runs: spin waits (spinFrame), nothing opens the viewer (enterSpot, popPush), and
// when it ends nothing carries the camera on: any pending zoom, pan or demo stops where the view is.
const tourApi = { TOUR, PROFILE, view, zoom, pan, regions, POP, popOpen, popClose, tapSpot, syncTilt, clampAlt, pitchLimit,
  setNorthEase: v => { northEase = v; }, busy: () => !!(flight || arrival),
  // layer steps (Benn 2026-11-23): the panel, the layers, the followed storm and where the nearest storm is on screen
  layers, openSection, get section() { const b = barBtns.find(x => x.getAttribute('aria-expanded') === 'true'); return b ? b.dataset.sec : null; },
  get follow() { return follow; }, releaseFollow,
  stormAt: () => {
    const h = layers.find(l => l.userData.layerId === 'hurricanes' && l.visible); if (!h) return null;
    for (const t of targetsOf(h)) {
      const pos = latLonToVector3(t.lat, t.lon, RADIUS); if (!facing({ pos }) || !inFront(pos)) continue;
      const [x, y] = screenOf(pos); if (x > 30 && y > 70 && x < innerWidth - 30 && y < innerHeight - 70) return [x, y, t.name];
    }
    return null;
  },
  ended: () => { TOUR.on = false; TOUR.tick = null; TOUR.tried = null; zoom.target = view.alt; zoom.cursor = null; pan.x = pan.y = 0; spin.k = 0; spinPause(); store.set('oceany-globe-welcome-v1', '1'); } };
function tourStart(at = 0) {
  popClose(); spin.k = 0; TOUR.on = true; TOUR.tried = null;
  const go = () => { TOUR.tick = TOUR.g.tick; TOUR.g.start(at); };
  if (TOUR.g) { go(); return; }
  import('./tour.js?v=b51').then(m => { TOUR.g = m.globeTour(tourApi); go(); }).catch(e => { TOUR.on = false; console.error('Oceany globe: tour not loaded', e); });
}
// r3/round 4: the tour's key (tour.js tourKey, sessionStorage 'oceany-tour'). On load and on a restored page:
// page 'viewer' = back from the reef by any route (zoom-out, browser Back, Back to globe at any step): carry on at
// `next`; page 'globe' = a reload mid-tour: the same step. Either once the arrival flight has settled. The tour
// rewrites the key at every step (onStep); only Skip, Escape or Done remove it.
function tourResume() {
  let m = null; try { m = JSON.parse(sessionStorage.getItem('oceany-tour')); } catch (e) { /* none */ }
  if (!m) return;
  const at = m.page === 'viewer' ? m.next : m.page === 'globe' ? m.step : NaN;
  if (!Number.isFinite(at)) { if (m.page === 'viewer') try { sessionStorage.removeItem('oceany-tour'); } catch (e) { /* ignore */ } return; }   // a reef-only tour: nothing to carry on here
  if (TOUR.g && TOUR.g.on && TOUR.g.step === at) return;   // a restored page whose tour is already there
  const t0 = performance.now();
  const wait = () => {
    if ((flight || arrival) && performance.now() - t0 < 20000) { setTimeout(wait, 300); return; }
    const w = document.getElementById('welcome'); if (w && !w.hidden) { w.hidden = true; store.set('oceany-globe-welcome-v1', '1'); }
    tourStart(at);
  };
  setTimeout(wait, 800);
}
addEventListener('pageshow', e => { if (e.persisted) tourResume(); });
function tourEnd() { if (TOUR.g && TOUR.g.on) TOUR.g.end(); else TOUR.on = false; }
window.__globe = { LITE, sky, frame, spin, setSpeed, THREE, renderer, terrain, scene, camera, view, zoom, setTerrain, perf, flyToStorm, get follow() { return follow; }, get flight() { return flight; }, regions, layers, latLonToVector3, pickRegion, earth, dotCount: N, POP, popOpen, popClose, tapSpot, TOUR, tourStart, PROFILE };
// ---------- offline (opt-in): ?offline=1 registers sw.js (app shell and terrain tiles kept for offline use); ?offline=0
// unregisters it and deletes its caches. Without the parameter nothing changes (an earlier opt-in stays until ?offline=0).
{
  const q = new URLSearchParams(location.search).get('offline');
  if ('serviceWorker' in navigator && q === '1') navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(e => console.info('Oceany globe: offline mode not available:', e && e.message));
  if ('serviceWorker' in navigator && q === '0') {
    navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => { if (new URL(r.scope).pathname.endsWith('/07-globe/')) r.unregister(); }));
    if (self.caches) caches.keys().then(ks => ks.filter(k => k.startsWith('oceany-')).forEach(k => caches.delete(k)));
  }
  // Round 4 (round-3 #14): an offline cue. Served from the cache with no network, live layers cannot update: say so in a
  // small line under the bar (the zoom note's place) instead of failing silently.
  // b38: navigator.onLine alone missed it (it can stay true, e.g. under DevTools/CDP emulation or a dead link). The service
  // worker (sw.js) also reports when its network fetches fail ({ type: 'oceany-net' }), and the page asks it once at start.
  let swOffline = false;
  const cue = () => {
    let el = document.getElementById('offline-cue');
    if (navigator.onLine && !swOffline) { if (el) el.hidden = true; return; }
    if (!el) { el = document.createElement('div'); el.id = 'offline-cue'; el.setAttribute('role', 'status'); el.className = 'offline-cue'; document.body.appendChild(el); }
    el.textContent = 'Offline: showing the saved globe and terrain. Live layers will not update.'; el.hidden = false;
  };
  addEventListener('online', cue); addEventListener('offline', cue); cue();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', e => { if (e.data && e.data.type === 'oceany-net') { swOffline = !!e.data.offline; cue(); } });
    navigator.serviceWorker.startMessages();
    if (navigator.serviceWorker.controller) navigator.serviceWorker.controller.postMessage({ type: 'oceany-net?' });
  }
}
