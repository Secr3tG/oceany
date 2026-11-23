// Oceany viewer: sea floor around Klitmoller as a glowing 3D point cloud, two switchable datasets.
// Sections: 1 setup, 2 layers (load + build points), 3 colours, 4 controls and camera moves,
//           5 UI, 6 hover, 7 loop.
// PLUMBING (safe to ignore): shader strings in section 2, picking maths in section 6.
// WORTH READING: section 3 (palettes) and section 5 (what the buttons do).
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { USE_AWS, SEABED } from '../../07-globe/terrain-source.js?v=t3';   // same module as terrarium.js: Oceany's own tiles unless ?terrain_src=aws

// ---------- 1. Setup: renderer, scene, camera ----------
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x04060a);
const scene = new THREE.Scene();
const FOV = 50;
const camera = new THREE.PerspectiveCamera(FOV, 1, 10, 6000000); // units are metres
// World axes: x = east, y = up, z = south. The sea (west) is on the left, north is "into" the screen.

// ---------- 2. Layers: load a dataset, build the points ----------
// Per layer: file, point size (m), default vertical stretch, colour depth range (m), cap on how high
// land is drawn (m), marker size multiplier, and two camera views { pos, target } (far and near).
const v3 = (x, y, z) => new THREE.Vector3(x, y, z);
const FINE_VIEWS = { far: { pos: v3(-14000, 8000, 7500), target: v3(0, 0, 0) },
                     near: { pos: v3(-2300, 1500, 1500), target: v3(0, -300, 0) } };
// Porto Batel beach view: the filming position on the cliff (breaking-wave slice origin, porto_batel_slice meta house_x/y_m), eye 1.7 m, looking at the take-off.
const PB_BEACH = { at: [578.74, -277.32], look: [488, -348], eye: 1.7 };
const LAYERS = {
  'EMODnet ~115 m': { file: 'data/seafloor.json', size: 100, exag: 60, deepAt: 34, landCap: 1e9, mark: 1, views: FINE_VIEWS },
  'Danish model 50 m': { file: 'data/seafloor_ddm.json', size: 55, exag: 60, deepAt: 34, landCap: 1e9, mark: 1, views: FINE_VIEWS },
  'North Sea (zoomed out)': { file: 'data/seafloor_wide.json', size: 3800, exag: 25, deepAt: 120, landCap: 100, mark: 40, wide: true,
    views: { far: { pos: v3(-1000000, 650000, 420000), target: v3(-300000, -20000, -150000) },
             near: { pos: v3(-130000, 70000, 90000), target: v3(0, -2000, 0) } } },
  // Portugal, ~4 km box (x,z in metres from the box middle; z = south). reef: true switches on the title, labels,
  // button names and tooltip wording for this layer.
  'Reef maps: Consolação and Porto Batel': { file: 'data/reefs.json', size: 14, exag: 5, deepAt: 12, landCap: 15, mark: 1, reef: true, portugal: true, spot: 'porto_batel', swellFile: 'data/swell_sim.json',
    // spotCams: surf-check viewpoint per spot button. sea = compass bearing from the break out to sea (waves travel the other way); at = [x_m, y_m north] break/take-off if not the label position (take-off 39.31887, -9.356829 = observer's take-off zone)
    spotCams: { 'Porto Batel': { sea: 236, at: [488, -348], beach: PB_BEACH }, 'Consolação': { sea: 290 } },
    title: 'Peniche reefs, Portugal', zoomIn: 'Zoom to the two spots', zoomOut: 'Whole box',
    views: { far: { pos: v3(-1500, 1100, 2000), target: v3(-100, -30, 0) },
             // near = the two spots: target is the midpoint of Consolação (103, -278) and Porto Batel (662, 267); camera sits
             // ~1.4 km out on the perpendicular to the line joining them, so both spots and the reef between sit mid-screen.
             near: { pos: v3(-594, 700, 997), target: v3(383, -20, -6) } } },
  // Oahu North Shore, ~4 x 5 km box (x east, z south, metres from the Pipeline origin). reef: true (spot buttons, labels, shift-click marks);
  // no portugal flag, so the Portuguese-only extras (swell, breaking-wave slice, break line, sketch pins) stay off. Datum is LMSL, not LAT.
  // seaDir: unit vector (x, z) from the spot towards open sea (north-west here); the close-up camera sits on that side.
  'Reef map: Pipeline, Oahu': { file: 'data/pipeline.json', size: 14, exag: 5, deepAt: 25, landCap: 15, mark: 1, reef: true,
    title: 'Pipeline, Oahu North Shore', zoomIn: 'Zoom to Pipeline', zoomOut: 'Whole box', datumLabel: 'LMSL', seaDir: [-0.707, -0.707],
    spotCams: { 'Pipeline': { sea: 310 }, 'Backdoor': { sea: 305 }, 'Waimea Bay': { sea: 285, D: 380, H: 110 } },
    // spot: key for data/<spot>_slice.json (listed in data/slices.json); swellFile: data/*_swell.json for this layer's points (same order and count)
    spot: 'pipeline', swellFile: 'data/pipeline_swell.json',
    views: { far: { pos: v3(-3600, 2600, -3200), target: v3(-300, -20, 300) },
             // near = take-off (-247, -123) seen from 600 m out along bearing 310, 250 m up (B-DATA-READY.md): x -707, z (south) -263
             near: { pos: v3(-707, 250, -263), target: v3(-247, -20, 123) } } },
  // Supertubos, Peniche: the wide Portuguese box (reefs_wide.json, 2011 lidar). No portugal flag (Porto Batel pins, break line, play controls stay on the first Portuguese layer).
  'Reef map: Supertubos, Peniche': { file: 'data/reefs_wide.json', size: 14, exag: 5, deepAt: 14, landCap: 15, mark: 1, reef: true,
    title: 'Supertubos, Peniche (2011 seabed)', zoomIn: 'Zoom to Supertubos', zoomOut: 'Whole box', seaDir: [-1, 0],
    spotCams: { 'Supertubos': { sea: 266, at: [50, 1977] }, 'Consolação': { sea: 290 }, 'Porto Batel': { sea: 236, at: [488, -348], beach: PB_BEACH } },
    spot: 'supertubos', swellFile: 'data/supertubos_swell.json',
    views: { far: { pos: v3(-5200, 4200, -1500), target: v3(0, -20, -800) },
             // near = take-off (50, 1977) seen from 500 m out along bearing 266, 200 m up: x -449, z (south) -1942
             near: { pos: v3(-449, 200, -1942), target: v3(50, -20, -1977) } } },
  // Basque coast, France (Litto3D NAQ 2020-2022, 4 m, datum IGN69). Same pattern as Pipeline: reef: true, no portugal flag.
  // spot keys guethary and hossegor match data/<spot>_slice.json. One swell file per points file (same order and count).
  // x east, z south, metres from the spot (meta.origin). seaDir points to open sea (west).
  'Reef map: Guéthary / Parlementia, France': { file: 'data/guethary.json', size: 14, exag: 5, deepAt: 25, landCap: 15, mark: 1, reef: true,
    title: 'Guéthary / Parlementia, France', zoomIn: 'Zoom to Parlementia', zoomOut: 'Whole box', datumLabel: 'IGN69', seaDir: [-0.996, -0.087],
    spotCams: { 'Parlementia': { sea: 332 }, 'Parlementia candidate take-off': { sea: 332 } },
    spot: 'guethary', swellFile: 'data/guethary_swell.json',
    views: { far: { pos: v3(-4200, 2800, 600), target: v3(-500, -20, 300) },
             near: { pos: v3(-598, 250, -52), target: v3(0, -20, 0) } } },
  'Reef map: Hossegor / La Gravière, France': { file: 'data/hossegor.json', size: 14, exag: 5, deepAt: 20, landCap: 15, mark: 1, reef: true,
    title: 'Hossegor / La Gravière, France', zoomIn: 'Zoom to La Gravière', zoomOut: 'Whole box', datumLabel: 'IGN69', seaDir: [-0.918, 0.396],
    spotCams: { 'La Gravière': { sea: 275 }, 'La Gravière candidate take-off': { sea: 275, at: [-12.9, 5.2] } },
    spot: 'hossegor', swellFile: 'data/hossegor_swell.json',
    views: { far: { pos: v3(-3000, 2400, 1900), target: v3(150, -20, 500) },
             near: { pos: v3(-563, 250, 237), target: v3(-13, -20, -5) } } },
};
const material = new THREE.ShaderMaterial({
  // uDim: brightness (below 1 while the swell is on, so the bed reads through the water); uHideAbove: bed higher than this (m above LAT) is not drawn (the awash/land sets draw it while the swell is on)
  uniforms: { uExag: { value: 60 }, uSize: { value: 100 }, uScale: { value: 1 }, uLandCap: { value: 1e9 }, uDim: { value: 1 }, uHideAbove: { value: 1e9 }, uMaxPx: { value: 1e5 } },   // uMaxPx: dot size cap (px), only lowered in beach view
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `
    uniform float uExag, uSize, uScale, uLandCap, uHideAbove, uMaxPx;
    attribute float aDepth, aShore; attribute vec3 aColor;
    varying vec3 vColor; varying float vShore;
    void main() {
      if (-aDepth > uHideAbove) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
      vec3 p = position;
      float z = aDepth < 0.0 ? -min(-aDepth, uLandCap) : aDepth;   // land height is capped for display
      p.y = -z * uExag;                            // depth down, stretched
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = min(uMaxPx, max(2.0, uSize * (1.0 + aShore * 0.7) * uScale / -mv.z));
      gl_Position = projectionMatrix * mv;
      vColor = aColor; vShore = aShore;
    }`,
  fragmentShader: `
    uniform float uDim; varying vec3 vColor; varying float vShore;
    void main() {
      float r = length(gl_PointCoord - 0.5) * 2.0;
      if (r > 1.0) discard;
      float glow = pow(1.0 - r, 2.0);              // soft round falloff
      gl_FragColor = vec4(vColor * (1.0 + vShore * 1.5) * uDim, glow * 0.85);
    }`,
});
const cloud = new THREE.Points(new THREE.BufferGeometry(), material);
cloud.frustumCulled = false;   // the shader moves points, so the stored bounds are wrong
scene.add(cloud);

// Loading line: shows what is loading while the big JSON files download; an error stays on screen if a fetch fails.
const DATA_VERSION = 's12';
const loadingEl = document.getElementById('loading'), loadingNow = new Set();
async function loadJSON(url, what) {
  loadingNow.add(what); loadingEl.className = ''; loadingEl.textContent = 'Loading data\u2026 ' + [...loadingNow].join(', '); loadingEl.style.display = 'block';
  try {
    const r = await fetch(url + '?v=' + DATA_VERSION);   // cache tag: bump DATA_VERSION when a data file changes
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json(); loadingNow.delete(what);
    if (!loadingNow.size && loadingEl.className !== 'err') loadingEl.style.display = 'none';
    else if (loadingNow.size) loadingEl.textContent = 'Loading data\u2026 ' + [...loadingNow].join(', ');
    return j;
  } catch (err) {
    loadingNow.delete(what); loadingEl.className = 'err'; loadingEl.style.display = 'block';
    loadingEl.textContent = `Could not load ${what} (${url}): ${err.message}. Open this page over http, not from a file.`;
    throw err;
  }
}
let cur = null;                // the layer on screen: { meta, N, pos, depth, shore, kilde, aar, colorAttr, shoreCells }
const cache = {};
async function showLayer(label) {
  if (!cache[label]) {
    const d = await loadJSON(LAYERS[label].file, label);
    const N = d.depth_m.length, pos = new Float32Array(N * 3), depth = Float32Array.from(d.depth_m);
    for (let i = 0; i < N; i++) { pos[3 * i] = d.x_m[i]; pos[3 * i + 2] = -d.y_m[i]; }   // north = -z
    const shoreCells = [];
    d.shore.forEach((s, i) => { if (s) shoreCells.push(i); });  // used for "km from shore" in the tip
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aDepth', new THREE.BufferAttribute(depth, 1));
    g.setAttribute('aShore', new THREE.BufferAttribute(Float32Array.from(d.shore), 1));
    const colorAttr = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
    g.setAttribute('aColor', colorAttr);
    // The three profile lines (wide layer only): faint lines floating at sea level.
    const lines = new THREE.Group();
    // 235 (SW swell) and 315 (N swell) are the chosen swell bearings: brighter. Every line gets a text label at its far end.
    const lineCols = { 270: 0x4aa3ff, 300: 0xff6b6b, 235: 0xffb347, 315: 0x7fe3f0 };
    const lineNames = { 235: 'SW 235 (up the southern North Sea)', 315: 'N 315 (past Shetland)', 300: 'NW 300 (Orkney-Shetland gap)', 270: 'W 270 (wind swell, comparison)' };
    const lineTags = [];                          // { el, x, z } for the labels, placed every frame in animate()
    for (const [b, [lx, ly]] of Object.entries(d.lines || {})) {
      const pts = lx.map((x, i) => v3(x, 0, -ly[i]));
      lines.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: lineCols[b], transparent: true, opacity: (b === '235' || b === '315') ? 0.9 : 0.55 })));
      if (lineNames[b]) {
        const el = document.createElement('div');
        el.className = 'tag'; el.textContent = lineNames[b]; el.style.color = '#' + lineCols[b].toString(16);
        document.body.appendChild(el);
        lineTags.push({ el, x: lx[lx.length - 1], z: -ly[ly.length - 1] });
      }
    }
    scene.add(lines);
    // Named spots (reef layer only): one HTML label each, placed every frame in animate().
    const spotTags = Object.entries(d.meta.spots || {}).map(([name, s]) => {
      const el = document.createElement('div');
      el.className = 'tag'; el.textContent = s.label || name; el.style.color = '#5ff2ff';   // the globe's colour for unlocked spots el.style.display = 'none';
      document.body.appendChild(el);
      return { el, name, x: s.x_m, z: -s.y_m };
    });
    cache[label] = { meta: d.meta, N, pos, depth, kilde: d.kilde, aar: d.aar, shoreCells, colorAttr, g, lines, lineTags, spotTags };
  }
  const L = LAYERS[label], prevViews = cur && cur.cfg.views;
  if (cur) { cur.lines.visible = false; cur.lineTags.forEach(t => { t.el.style.display = 'none'; }); cur.spotTags.forEach(t => { t.el.style.display = 'none'; }); }
  cur = cache[label];
  cur.cfg = L;
  cur.lines.visible = true;
  document.title = 'Oceany - ' + (L.title || 'how the North Sea hits the Danish coast');
  switchSwellLayer(label);
  cloud.geometry = cur.g;
  material.uniforms.uSize.value = L.size;
  material.uniforms.uLandCap.value = L.landCap;
  marker.scale.setScalar(L.mark); marker.visible = !L.reef;   // the gold Klitmoller marker is not drawn on the reef layer
  if (BEACH.active) setBeachActive(false);
  exagInput.value = L.exag; setExag();           // each layer starts with its own vertical stretch
  applyPalette(currentPalette);
  if (prevViews && prevViews !== L.views) flyTo(L.views.far);   // different scale (own views): fly to this layer's overview
  else if (!fly && !cameraSet) { camera.position.copy(L.views.far.pos); controls.target.copy(L.views.far.target); controls.update(); }
  cameraSet = true;
  setCamMode(L.reef ? 'fly' : 'orbit');          // free-fly on the reef layer, orbit elsewhere (the button switches)
  const m = cur.meta;
  // Panel title, zoom button names and page title follow the layer.
  document.querySelector('#panel h1').innerHTML = 'Oceany <span class="sub">' + (L.title || 'Klitm&oslash;ller sea floor') + '</span>';
  document.getElementById('zoom-in').innerHTML = L.zoomIn || 'Zoom to Klitm&oslash;ller';
  document.getElementById('zoom-out').textContent = L.zoomOut || 'Zoom out';
  marksBox.style.display = L.reef ? '' : 'none';
  document.getElementById('brk').style.display = L.portugal ? '' : 'none';
  document.getElementById('swl').style.display = L.swellFile ? '' : 'none';
  setSwellUI(L);
  if (L.spot === 'porto_batel' && !BW.auto) {      // Porto Batel: the breaking wave is on the first time you open the layer (the checkbox is far down the panel); untick to hide it
    BW.auto = true; const cb = document.getElementById('bw-on'); cb.checked = true; cb.dispatchEvent(new Event('change'));
  }
  if (L.reef && !marksLoaded) loadMarks();
  document.getElementById('view-row').style.display = L.reef && cur.spotTags.length ? '' : 'none';
  [0, 1, 2].forEach(i => {                       // reef layer: one close-up button per named spot
    const b = document.getElementById('spot-' + i), t = L.reef && cur.spotTags[i];
    b.style.display = t ? '' : 'none'; if (t) b.textContent = t.name;
  });
  document.getElementById('caption').innerHTML = m.caption ? m.caption : (
    `${m.source}, ${m.resolution}, depths relative to ${m.datum}. ${m.reef_note} ` +
    `<br>${m.attribution}` + (m.datum === 'MSL' ? ' <a href="https://dataforsyningen.dk/data/4817" target="_blank" rel="noopener">terms</a>' : ''));
  surroundPts.visible = false; ensureSurround(label);   // the surroundings follow once their tiles are in (reef layers only)
  document.getElementById('status').textContent = `${cur.N.toLocaleString()} points`;
  [...layerBox.children].forEach(b => b.classList.toggle('on', b.textContent === label));
}

// Marker at the shoreline point (0, 0, 0): a thin vertical line and a small sphere (scaled per layer).
const gold = 0xffd36b;
const marker = new THREE.Group();
marker.add(new THREE.Mesh(new THREE.SphereGeometry(40, 16, 12), new THREE.MeshBasicMaterial({ color: gold })));
marker.add(new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([v3(0, 0, 0), v3(0, 1500, 0)]),
  new THREE.LineBasicMaterial({ color: gold })));
scene.add(marker);
let cameraSet = false;
const villageX = 1765;   // metres east of the shoreline point (village at 8.4985 E); only used for its label

// ---------- 3. Colours ----------
// Each palette: colours at 3 depths (shallow, middle, deep) and a land colour. Edit freely.
// Values are red, green, blue from 0 to 1.
const PALETTES = {
  Ocean: { shallow: [0.35, 1.0, 0.95], mid: [0.1, 0.5, 0.95], deep: [0.03, 0.08, 0.45], land: [0.30, 0.26, 0.22] },
  Ember: { shallow: [1.0, 0.85, 0.35], mid: [0.95, 0.3, 0.1], deep: [0.3, 0.04, 0.12], land: [0.22, 0.2, 0.24] },
  Mono:  { shallow: [1.0, 1.0, 1.0], mid: [0.45, 0.5, 0.55], deep: [0.1, 0.12, 0.16], land: [0.22, 0.22, 0.22] },
};
const mix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
let currentPalette = 'Ocean';

// Break-line overlay (reef layer only). Edit this object to change the case; lidar depth = water depth - tideAboveLAT.
const BREAK = { waveHeight: 2.7, tideAboveLAT: 2.10, factor: 1.3, range: [0.8, 1.7], band: 0.25,
  label: "0.78 rule break line (H = 0.78 h), 17 Sep 18:00", on: false,
  bright: [1.0, 0.15, 0.85], tint: [1.0, 0.72, 0.4], tintMix: 0.55 };
BREAK.centre = BREAK.waveHeight * BREAK.factor - BREAK.tideAboveLAT;                 // lidar depth of the bright line
BREAK.lo = BREAK.waveHeight * BREAK.range[0] - BREAK.tideAboveLAT;                   // band edges, lidar depth
BREAK.hi = BREAK.waveHeight * BREAK.range[1] - BREAK.tideAboveLAT;
function applyBreak() {
  if (!cur || !cur.cfg.portugal || !BREAK.on) return;
  const { depth, N, colorAttr } = cur, a = colorAttr.array;
  for (let i = 0; i < N; i++) {
    const d = depth[i];
    if (d < BREAK.lo || d > BREAK.hi) continue;
    if (Math.abs(d - BREAK.centre) <= BREAK.band) a.set(BREAK.bright, 3 * i);
    else a.set(mix([a[3 * i], a[3 * i + 1], a[3 * i + 2]], BREAK.tint, BREAK.tintMix), 3 * i);
  }
  colorAttr.needsUpdate = true;
}

function applyPalette(name) {
  currentPalette = name;
  if (!cur) return;
  const p = PALETTES[name], { depth, N, colorAttr } = cur, DEEP_AT = cur.cfg.deepAt;  // depth where colour reaches "deep"
  for (let i = 0; i < N; i++) {
    let c;
    if (depth[i] <= 0) {                                  // land: dim, a little brighter when higher
      c = p.land.map(v => v * (0.7 + Math.min(-depth[i], 20) / 40));
    } else {
      const t = Math.min(depth[i] / DEEP_AT, 1);
      c = t < 0.5 ? mix(p.shallow, p.mid, t * 2) : mix(p.mid, p.deep, (t - 0.5) * 2);
    }
    colorAttr.array.set(c, 3 * i);
  }
  colorAttr.needsUpdate = true;
  applyBreak();
  const ks = document.getElementById('key-scale');     // legend line, from the same numbers as the loop above
  if (ks) {
    const nm = { Ocean: ['bright teal', 'blue', 'dark navy'], Ember: ['yellow', 'red', 'dark maroon'], Mono: ['white', 'grey', 'near black'] }[name] || ['light', 'mid', 'dark'];
    const fm = v => Math.round(v * 10) / 10;
    ks.textContent = `${nm[0]} at 0 m, ${nm[1]} at ${fm(DEEP_AT / 2)} m, ${nm[2]} at ${DEEP_AT} m and deeper (this layer). Land, above zero, is drawn dim.`;
  }
  colourSurround();
}

// ---------- 3b. Reef layers: the surroundings (surround.js) ----------
// Coast and sea floor for ~5 km around the lidar from the globe's terrain tiles: same dot shader and palette as the
// lidar, but dimmer (SURROUND_BRIGHT), sparser (30 m land, ~150 m sea) and fading out with distance. Built once per
// layer; on any failure there is simply no surround. Heights: tile elevations are about mean sea level, the
// Portuguese lidar is relative to LAT, so they are shifted by MSL_ABOVE_LAT there (Peniche, about 2.0 m).
const SURROUND_BRIGHT = 0.42;
const MSL_ABOVE_LAT = 2.0;
const surroundMat = new THREE.ShaderMaterial({
  uniforms: { uExag: material.uniforms.uExag, uScale: material.uniforms.uScale, uLandCap: material.uniforms.uLandCap,
    uMaxPx: material.uniforms.uMaxPx, uDim: material.uniforms.uDim, uBright: { value: SURROUND_BRIGHT } },   // shared with the lidar: same stretch, size scale and dimming
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `
    uniform float uExag, uScale, uLandCap, uMaxPx;
    attribute float aDepth, aSize, aFade; attribute vec3 aColor;
    varying vec3 vColor;
    void main() {
      vec3 p = position;
      float z = aDepth < 0.0 ? -min(-aDepth, uLandCap) : aDepth;
      p.y = -z * uExag - 0.5;                      // half a metre under the lidar's frame, so the two never sit on one plane
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = min(uMaxPx, max(1.5, aSize * uScale / -mv.z));
      gl_Position = projectionMatrix * mv;
      vColor = aColor * aFade;
    }`,
  fragmentShader: `
    uniform float uDim, uBright; varying vec3 vColor;
    void main() {
      float r = length(gl_PointCoord - 0.5) * 2.0;
      if (r > 1.0) discard;
      float glow = pow(1.0 - r, 2.0);
      gl_FragColor = vec4(vColor * uDim * uBright, glow * 0.85);
    }`,
});
const surroundPts = new THREE.Points(new THREE.BufferGeometry(), surroundMat);
surroundPts.frustumCulled = false; surroundPts.visible = false; scene.add(surroundPts);
const surroundCache = {};                    // layer label -> built surround (or null), a promise while building
async function ensureSurround(label) {
  const L = LAYERS[label], c = cache[label];
  if (!L.reef || !c) { surroundPts.visible = false; setSurroundNote(); return; }
  if (!(label in surroundCache)) {
    surroundCache[label] = (async () => {
      try {
        const { buildSurround } = await import('./surround.js?v=s5');
        const s = await buildSurround({ meta: c.meta, pos: c.pos, N: c.N });
        if (!s) return null;
        const off = /^LAT/.test(c.meta.datum || '') ? MSL_ABOVE_LAT : 0;
        s.depth = s.elev.map(h => -h - off);   // viewer depth: down positive, land negative
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(s.pos, 3));
        g.setAttribute('aDepth', new THREE.BufferAttribute(s.depth, 1));
        g.setAttribute('aSize', new THREE.BufferAttribute(s.size, 1));
        g.setAttribute('aFade', new THREE.BufferAttribute(s.fade, 1));
        s.colorAttr = new THREE.BufferAttribute(new Float32Array(s.count * 3), 3);
        g.setAttribute('aColor', s.colorAttr);
        s.g = g; s.deepAt = L.deepAt; s.palette = null;
        return s;
      } catch (e) { console.info('Oceany viewer: no surroundings for this layer:', e && (e.message || String(e))); return null; }
    })();
  }
  const s = await surroundCache[label];
  if (!cur || cur !== c) return;               // the layer changed while the tiles loaded
  surroundCache[label] = s;
  if (!s) { surroundPts.visible = false; setSurroundNote(); return; }
  surroundPts.geometry = s.g; surroundPts.visible = true; cur.surround = s;
  colourSurround(); setSurroundNote();
}
function colourSurround() {
  const s = cur && cur.surround; if (!s || s.palette === currentPalette) return;
  const p = PALETTES[currentPalette], DEEP_AT = s.deepAt, a = s.colorAttr.array;   // same ramp as applyPalette
  for (let i = 0; i < s.count; i++) {
    const d = s.depth[i];
    const c = d <= 0 ? p.land.map(v => v * (0.7 + Math.min(-d, 20) / 40))
      : (t => t < 0.5 ? mix(p.shallow, p.mid, t * 2) : mix(p.mid, p.deep, (t - 0.5) * 2))(Math.min(d / DEEP_AT, 1));
    a.set(c, 3 * i);
  }
  s.colorAttr.needsUpdate = true; s.palette = currentPalette;
}
function setSurroundNote() {                   // one caption line saying what the dimmer dots are
  let el = document.getElementById('surround-note');
  const s = cur && cur.surround && surroundPts.visible ? cur.surround : null;
  if (!s) { if (el) el.remove(); return; }
  if (!el) { el = document.createElement('div'); el.id = 'surround-note'; }
  const land = s.sources.filter(x => x !== 'etopo1');
  el.textContent = USE_AWS
    ? `Surroundings (dimmer dots): global terrain tiles (AWS Terrain Tiles, test switch), ~${Math.round(s.landM)} m per dot on land, ` +
      `~${Math.round(s.seaM / 10) * 10} m at sea, coarse. Seabed there is low-resolution and approximate (mostly ETOPO1, a ~1.85 km grid)` + (land.length ? `; land from ${land.join(', ')}.` : '.')
    : `Surroundings (dimmer dots): Oceany terrain tiles, ~${Math.round(s.landM)} m per dot on land (Copernicus DEM, a surface model: trees and buildings included), ` +
      `~${Math.round(s.seaM / 10) * 10} m apart at sea. Seabed there is from ${SEABED.name}, measured only about every ${SEABED.label}, so it is coarse and approximate. Not for navigation.`;
  document.getElementById('caption').appendChild(el);
}

// ---------- 4. Controls and camera moves ----------
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.autoRotateSpeed = 0.5;
controls.zoomToCursor = true;                  // wheel zoom goes toward the pointer, not the view centre
// Camera views live in LAYERS above (each layer has its own far and near view).

// Fly smoothly (about 1.6 s) from where the camera is now to a saved view.
let fly = null;
function flyTo(view) {
  fly = { t0: performance.now(), p0: camera.position.clone(), g0: controls.target.clone(), view };
}
function stepFly(now) {
  if (!fly) return;
  const k = Math.min((now - fly.t0) / (fly.dur || 1600), 1), e = fly.ease ? fly.ease(k) : k * k * (3 - 2 * k);   // ease in and out
  if (fly.path) fly.path(e);                       // a flight with its own path (the arrival from the globe)
  else { camera.position.lerpVectors(fly.p0, fly.view.pos, e); controls.target.lerpVectors(fly.g0, fly.view.target, e); }
  if (k >= 1) { fly = null; FLY.jump = true; }    // fly mode takes the final view even when the whole jump fell between two frames (slow or hidden tab)
}

// ---- Free-fly camera (default on the reef layer; the "Orbit / Fly" button switches to the old orbit controls) ----
// Keys (event.code, so layout does not matter): W/S forward/back, A/D strafe, E or Space up, Q or C down; Shift = fast (x4),
// Alt = slow (x0.2). Drag = look (yaw/pitch, never roll). Wheel = glide along the ray through the pointer. Speed scales with
// the camera's height (low = slow and precise, high = fast), and everything is damped so movement flows.
// A camera jump (flyTo: spot buttons, zoom buttons, the wave-slice view) runs as before and then hands control back.
let camMode = 'orbit';
const FLY = { yaw: 0, pitch: 0, vel: new THREE.Vector3(), wheel: new THREE.Vector3(), keys: new Set(), last: null, drag: null };
const flyDir = new THREE.Vector3(), flyTmp = new THREE.Vector3(), flyRight = new THREE.Vector3();
const FLY_UP = new THREE.Vector3(0, 1, 0);
function flySync() {                              // yaw/pitch from where the camera now looks (after a jump or a mode switch)
  camera.getWorldDirection(flyDir);
  FLY.pitch = Math.asin(Math.max(-1, Math.min(1, flyDir.y))); FLY.yaw = Math.atan2(flyDir.x, -flyDir.z);
}
function flyForward(out) {
  const c = Math.cos(FLY.pitch); return out.set(Math.sin(FLY.yaw) * c, Math.sin(FLY.pitch), -Math.cos(FLY.yaw) * c);
}
const flyBase = () => Math.max(5, 0.7 * (camera.position.y + 10));   // m/s: scales with height above the sea (about 5 m/s near the water, ~800 m/s at 1.1 km)
function setCamMode(mode) {
  if (mode === camMode && mode === 'orbit' && controls.enabled) { updateCamUI(); return; }
  if (mode === 'orbit') {                          // target = where the view ray meets the sea level, else 150 m ahead
    camera.getWorldDirection(flyDir);
    const t = flyDir.y < -0.05 ? Math.min(-camera.position.y / flyDir.y, 1e6) : 150;
    controls.target.copy(camera.position).addScaledVector(flyDir, Math.max(t, 20));
    controls.enabled = true; controls.update();
  } else { controls.enabled = false; flySync(); FLY.vel.set(0, 0, 0); FLY.wheel.set(0, 0, 0); }
  camMode = mode; updateCamUI();
}
function updateCamUI() {
  const fl = camMode === 'fly', b = document.getElementById('cam-mode');
  b.textContent = 'Orbit / Fly: ' + (fl ? 'fly' : 'orbit'); b.classList.toggle('on', fl);
  document.getElementById('cam-hint').textContent = fl
    ? 'Fly: W/S forward/back, A/D strafe, E/Space up, Q/C down, drag to look, wheel glides toward the pointer, Shift fast, Alt slow.'
    : 'Orbit: drag to rotate, wheel zooms toward the pointer, right-drag pans.';
}
function stepFree(now) {
  const dt = FLY.last === null ? 0 : Math.min((now - FLY.last) / 1000, 0.1); FLY.last = now;
  if (fly) {                                       // a camera jump is running: follow it, then pick up from where it ends
    camera.lookAt(controls.target); flySync(); FLY.vel.set(0, 0, 0); FLY.wheel.set(0, 0, 0); FLY.jump = true; return;
  }
  if (FLY.jump) { FLY.jump = false; camera.lookAt(controls.target); flySync(); }   // the frame the jump ended (or was cancelled): take its final view
  const K = FLY.keys, f = flyForward(flyDir);
  flyRight.crossVectors(f, FLY_UP).normalize();
  const sp = flyBase() * (K.has('shift') ? 4 : 1) * (K.has('alt') ? 0.2 : 1);
  flyTmp.set(0, 0, 0);
  if (K.has('KeyW')) flyTmp.add(f); if (K.has('KeyS')) flyTmp.sub(f);
  if (K.has('KeyD')) flyTmp.add(flyRight); if (K.has('KeyA')) flyTmp.sub(flyRight);
  if (K.has('KeyE') || K.has('Space')) flyTmp.y += 1; if (K.has('KeyQ') || K.has('KeyC')) flyTmp.y -= 1;
  if (flyTmp.lengthSq() > 0) flyTmp.normalize().multiplyScalar(sp);
  FLY.vel.lerp(flyTmp, 1 - Math.exp(-dt * 8));     // ease towards the wanted velocity
  FLY.wheel.multiplyScalar(Math.exp(-dt * 6));     // wheel impulse dies away smoothly
  camera.position.addScaledVector(FLY.vel, dt).addScaledVector(FLY.wheel, dt);
  camera.lookAt(flyTmp.copy(camera.position).add(f));
  controls.target.copy(camera.position).addScaledVector(f, 100);   // keeps a sensible target for jumps and for switching to orbit
}
const typing = e => { const t = e.target; return t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' ||
  (t.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button'].includes(t.type))); };
const FLY_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyC', 'Space'];
window.addEventListener('keydown', e => {
  if (camMode !== 'fly' || typing(e) || e.ctrlKey || e.metaKey) return;
  if (e.code === 'Space' && e.target && e.target.tagName !== 'BODY' && e.target.tagName !== 'CANVAS') return;   // Space belongs to a focused button/checkbox
  if (FLY_KEYS.includes(e.code)) { FLY.keys.add(e.code); fly = null; e.preventDefault(); }
  FLY.keys[e.shiftKey ? 'add' : 'delete']('shift'); FLY.keys[e.altKey ? 'add' : 'delete']('alt');
});
window.addEventListener('keyup', e => {
  FLY.keys.delete(e.code); FLY.keys[e.shiftKey ? 'add' : 'delete']('shift'); FLY.keys[e.altKey ? 'add' : 'delete']('alt');
});
window.addEventListener('blur', () => FLY.keys.clear());
// Touch (fly mode): one finger = look (same as mouse drag), two fingers = pinch to move along the view and drag to pan.
// Orbit mode uses OrbitControls' own touch handling.
const TOUCH = new Map();
const touchRight = new THREE.Vector3(), touchUp = new THREE.Vector3();
canvas.addEventListener('pointerdown', e => {
  if (camMode !== 'fly' || e.shiftKey || (e.button !== 0 && e.button !== 2)) return;   // Shift+click is "mark a surf zone"
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();   // so keys reach the camera
  if (e.pointerType === 'touch') {                  // touch: track fingers; a second finger turns the drag into pinch/pan
    TOUCH.set(e.pointerId, { x: e.clientX, y: e.clientY }); fly = null; try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    if (TOUCH.size === 2) { FLY.drag = null; const [a, b] = [...TOUCH.values()]; FLY.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; return; }
    if (TOUCH.size > 2) return;
  }
  fly = null; FLY.drag = { id: e.pointerId, x: e.clientX, y: e.clientY }; try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
});
canvas.addEventListener('pointermove', e => {
  if (e.pointerType === 'touch' && TOUCH.has(e.pointerId)) {
    TOUCH.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (TOUCH.size === 2 && FLY.pinch) {
      const [a, b] = [...TOUCH.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const k = flyBase() * 0.03;                                  // metres per pixel of spread or pan
      flyTmp.set((mx / window.innerWidth) * 2 - 1, 1 - (my / window.innerHeight) * 2, 0.5).unproject(camera).sub(camera.position).normalize();
      camera.position.addScaledVector(flyTmp, (d - FLY.pinch.d) * k);          // fingers apart = move forward
      touchRight.setFromMatrixColumn(camera.matrixWorld, 0); touchUp.setFromMatrixColumn(camera.matrixWorld, 1);
      camera.position.addScaledVector(touchRight, -(mx - FLY.pinch.mx) * k).addScaledVector(touchUp, (my - FLY.pinch.my) * k);   // grab-the-world pan
      FLY.pinch.d = d; FLY.pinch.mx = mx; FLY.pinch.my = my;
      return;
    }
  }
  if (!FLY.drag || FLY.drag.id !== e.pointerId) return;
  FLY.yaw -= (e.clientX - FLY.drag.x) * 0.0035;    // grab-the-world feel: drag right turns the view left
  FLY.pitch = Math.max(-1.55, Math.min(1.55, FLY.pitch + (e.clientY - FLY.drag.y) * 0.0035));
  FLY.drag.x = e.clientX; FLY.drag.y = e.clientY;
});
const endDrag = e => { TOUCH.delete(e.pointerId); if (TOUCH.size < 2) FLY.pinch = null; if (FLY.drag && FLY.drag.id === e.pointerId) FLY.drag = null; };
canvas.addEventListener('pointerup', endDrag); canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('contextmenu', e => { if (camMode === 'fly') e.preventDefault(); });
canvas.addEventListener('wheel', e => {
  if (camMode !== 'fly') return;
  e.preventDefault(); fly = null;
  if (cur && cur.cfg.reef) { zoomWheel(e); return; }   // reef layers: the zoom bar's eased log zoom toward the pointer (section 6e)
  const px = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1, dy = Math.max(-300, Math.min(300, e.deltaY * px));
  flyTmp.set((e.clientX / window.innerWidth) * 2 - 1, 1 - (e.clientY / window.innerHeight) * 2, 0.5).unproject(camera).sub(camera.position).normalize();
  FLY.wheel.addScaledVector(flyTmp, -dy * 0.006 * flyBase() * 6 * (e.altKey ? 0.2 : 1));   // total glide ~ 0.6 x base speed per 100 px of wheel (impulse x decay rate 6)
}, { passive: false });
document.getElementById('cam-mode').addEventListener('click', () => setCamMode(camMode === 'fly' ? 'orbit' : 'fly'));

// ---------- 5. UI ----------
const exagInput = document.getElementById('exag');
function setExag() {
  material.uniforms.uExag.value = Number(exagInput.value);
  document.getElementById('exag-text').textContent = `depth stretched ${exagInput.value}x`;
}
exagInput.addEventListener('input', setExag);
setExag();

function makeButtons(box, names, onPick) {
  for (const name of names) {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => { onPick(name); [...box.children].forEach(x => x.classList.toggle('on', x === b)); };
    box.appendChild(b);
  }
}
const layerBox = document.getElementById('layers');
makeButtons(layerBox, Object.keys(LAYERS), showLayer);
const palBox = document.getElementById('palettes');
makeButtons(palBox, Object.keys(PALETTES), applyPalette);
palBox.firstChild.classList.add('on');

document.getElementById('brk-label').textContent = BREAK.label;
document.getElementById('brk-cap').innerHTML = `Rule of thumb, not a simulation: breaks where depth is about ${BREAK.factor} x wave height (${BREAK.waveHeight} m waves, tide ${BREAK.tideAboveLAT} m above lowest tide).<br>Bright = ${BREAK.factor} x, tint = the rule's real range ${BREAK.range[0]} to ${BREAK.range[1]}.`;
document.getElementById('brk-on').addEventListener('change', e => { BREAK.on = e.target.checked; applyPalette(currentPalette); });
document.getElementById('rotate').addEventListener('change', e => { controls.autoRotate = e.target.checked; });
// Reef layer, both spots: target = midpoint, camera back far enough that the ~780 m between them (plus margin) fits in
// the screen area right of the left panel; the target is shifted left so that area is centred on the midpoint.
function pairView() {
  const [a, b] = cur.spotTags, n = [-0.698, 0.716], r = [0.716, 0.698];
  const span = Math.hypot(a.x - b.x, a.z - b.z) * 1.3 + 100, W = window.innerWidth;
  const panelR = document.getElementById('panel').getBoundingClientRect().right;
  const k = Math.tan(camera.fov / 2 * Math.PI / 180) * camera.aspect;     // half-width per metre of distance
  const visible = (W - panelR) / W;                                         // fraction of the width not under the panel
  const D = Math.max(1565, span / (2 * k * visible)), Dh = D / 1.118;       // total distance; camera height = Dh / 2
  const halfW = D * k, shift = panelR / W * halfW;
  const tx = (a.x + b.x) / 2 - r[0] * shift, tz = (a.z + b.z) / 2 - r[1] * shift;
  return { pos: v3(tx + n[0] * Dh, Dh / 2, tz + n[1] * Dh), target: v3(tx, -20, tz) };
}
document.getElementById('zoom-in').onclick = () => (setBeachActive(false), flyTo(cur.cfg.portugal ? pairView() : cur.cfg.views.near));
// Close-up on one reef spot: ~360 m from it, seen from the sea side (same bearing as the near view), and the target
// is shifted so the spot lands in the middle of the part of the screen the left panel does not cover.
function spotView(t) {
  // Surf-check viewpoint: out on the water behind the break (against the wave travel direction), elevated, looking shoreward at the take-off so the waves
  // are in front and the coast sits behind them. Falls back to the layer's seaDir when a spot has no spotCams entry.
  const sc = (cur.cfg.spotCams && cur.cfg.spotCams[t.name]) || {}, b = sc.sea != null ? sc.sea * Math.PI / 180 : null;
  const n = b != null ? [Math.sin(b), -Math.cos(b)] : (cur.cfg.seaDir || [-0.698, 0.716]), r = [n[1], -n[0]];   // n = unit vector to sea in (x, z); r = screen-right
  const at = sc.at ? [sc.at[0], -sc.at[1]] : [t.x, t.z], D = sc.D || 300, H = sc.H || 100;
  const halfW = Math.hypot(D, H) * Math.tan(camera.fov / 2 * Math.PI / 180) * camera.aspect;
  const shift = document.getElementById('panel').getBoundingClientRect().right / window.innerWidth * halfW;   // the spot lands in the middle of the part the left panel does not cover
  const tx = at[0] - r[0] * shift, tz = at[1] - r[1] * shift;
  return { pos: v3(tx + n[0] * D, H, tz + n[1] * D), target: v3(tx, 0, tz) };
}
// ---- Beach view (default for the spot buttons): stand on the shore near the take-off at eye height and look out to sea,
// against the incoming waves, so the swell crests march toward you. True vertical scale (stretch 1x), swell layer on.
// Where you stand: walk from the take-off along the wave travel direction (opposite of spotCams.sea) until the lidar bed is
// dry (above the tide), then a few metres further up the beach. spotCams[name].beach overrides it: { at: [x, y north] stand
// here, look: [x, y north] look toward this, eye: m above the ground }. Porto Batel: the filming position on the cliff.
const BEACH = { mode: 'beach', active: false, exag: 1, eye: 3, back: 8, near: 1.5, maxPx: 40, swellMaxPx: 400, swellSize: 2.5, fadeFar: 700, fov: 30, bedDim: 0.06, waterDim: 0.2, spot: null };
function heightGrid(c) {                              // once per layer: 6 m buckets holding one lidar point index each
  if (c.hgrid) return c.hgrid;
  const B = 6; let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < c.N; i++) { const x = c.pos[3 * i], z = c.pos[3 * i + 2];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (z < zmin) zmin = z; if (z > zmax) zmax = z; }
  const nx = Math.floor((xmax - xmin) / B) + 1, nz = Math.floor((zmax - zmin) / B) + 1, head = new Int32Array(nx * nz).fill(-1);
  for (let i = 0; i < c.N; i++) if (isFinite(c.depth[i])) head[Math.floor((c.pos[3 * i + 2] - zmin) / B) * nx + Math.floor((c.pos[3 * i] - xmin) / B)] = i;
  return (c.hgrid = { B, xmin, zmin, nx, nz, head });
}
function bedHeightAt(c, x, z, r = 3) {                // bed height above the datum (m, land positive) of the nearest lidar point within ~r buckets; NaN if none
  const G = heightGrid(c), q = Math.floor((x - G.xmin) / G.B), w = Math.floor((z - G.zmin) / G.B);
  let best = Infinity, h = NaN;
  for (let a = Math.max(0, w - r); a <= Math.min(G.nz - 1, w + r); a++) for (let b = Math.max(0, q - r); b <= Math.min(G.nx - 1, q + r); b++) {
    const i = G.head[a * G.nx + b]; if (i < 0) continue;
    const d = (c.pos[3 * i] - x) ** 2 + (c.pos[3 * i + 2] - z) ** 2; if (d < best) { best = d; h = -c.depth[i]; }
  }
  return h;
}
function swellTide() { return SWELL.data ? SWELL.data.tide : 0; }
function beachView(t) {
  const sc = (cur.cfg.spotCams && cur.cfg.spotCams[t.name]) || {}, bc = sc.beach || {}, tide = swellTide(), exag = BEACH.exag;
  const b = sc.sea != null ? sc.sea * Math.PI / 180 : null;
  let n = b != null ? [Math.sin(b), -Math.cos(b)] : (cur.cfg.seaDir || [-0.698, 0.716]);   // unit (x, z) toward open sea
  const at = sc.at ? [sc.at[0], -sc.at[1]] : [t.x, t.z];
  let stand;
  if (bc.at) stand = [bc.at[0], -bc.at[1]];
  else {                                            // walk landward from the take-off to the first dry lidar point, then a few metres on
    stand = null;
    const dry = (x, z) => bedHeightAt(cur, x, z) > tide + 0.3;
    if (dry(at[0], at[1])) {                         // the spot's label sits on land: walk seaward to the water's edge, stand just behind it
      for (let s = 0; s <= 1500 && !stand; s += 3) if (!dry(at[0] + n[0] * s, at[1] + n[1] * s)) stand = [at[0] + n[0] * (s - BEACH.back), at[1] + n[1] * (s - BEACH.back)];
    } else {
      for (let s = 0; s <= 2500 && !stand; s += 3) if (dry(at[0] - n[0] * s, at[1] - n[1] * s)) stand = [at[0] - n[0] * (s + BEACH.back), at[1] - n[1] * (s + BEACH.back)];
    }
    if (!stand) stand = [at[0] - n[0] * 150, at[1] - n[1] * 150];
  }
  const look = bc.look ? [bc.look[0], -bc.look[1]] : at;
  let lx = look[0] - stand[0], lz = look[1] - stand[1]; const dist = Math.hypot(lx, lz);
  if (dist > 20 && lx * n[0] + lz * n[1] > 0) n = [lx / dist, lz / dist];   // look from where you stand toward the take-off (and on out to sea); else along the sea bearing
  let g = bedHeightAt(cur, stand[0], stand[1]); if (!isFinite(g)) g = tide;
  g = Math.min(Math.max(g, tide), cur.cfg.landCap);  // drawn land is capped at landCap; never stand under the water line
  const eye = bc.eye || BEACH.eye, y = (g + eye) * exag;
  const D = Math.max(dist + 40, 120);               // aim at the sea surface beyond the take-off: the horizon sits in the upper part of the view
  const r = [-n[1], n[0]], W = window.innerWidth;   // screen-right when looking along n
  const halfW = D * Math.tan(camera.fov / 2 * Math.PI / 180) * camera.aspect;
  const shift = W < 600 ? 0 : document.getElementById('panel').getBoundingClientRect().right / W * halfW;   // keep the take-off clear of the left panel (not on a phone)
  // Look down at least enough that the horizon sits about 40% from the top of the screen (the water, not the empty sky, fills the view).
  const tilt = Math.max((y - tide * exag) / D, 0.2 * Math.tan(camera.fov / 2 * Math.PI / 180));
  return { pos: v3(stand[0], y, stand[1]), target: v3(stand[0] + n[0] * D - r[0] * shift, y - tilt * D, stand[1] + n[1] * D - r[1] * shift),
           info: { stand: [stand[0], -stand[1]], ground: g, eye, tide, distToTakeoff: dist } };
}
function setBeachActive(on) {                       // beach look: true vertical scale, close near plane, capped dot sizes
  BEACH.active = on;
  if (on) { exagInput.value = BEACH.exag; setExag(); }
  else if (cur) { exagInput.value = cur.cfg.exag; setExag(); }
  camera.near = on ? BEACH.near : 10; onResize();
  material.uniforms.uMaxPx.value = on ? BEACH.maxPx : 1e5;
  document.getElementById('beach-note').style.display = on ? '' : 'none';
}
async function swellOnForBeach() {                  // the swell layer is what you came to see: switch it on and wait for it
  if (!cur.cfg.swellFile) return;
  const cb = document.getElementById('swl-on');
  if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
  for (let i = 0; i < 300 && !SWELL.data; i++) await new Promise(r => setTimeout(r, 50));
}
async function flySpot(i, mode = BEACH.mode) {
  const t = cur && cur.spotTags[i]; if (!t) return;
  BEACH.spot = t.name;
  if (mode === 'beach') {
    await swellOnForBeach();
    if (!cur || cur.spotTags[i] !== t) return;      // layer changed while the swell loaded
    setBeachActive(true); const v = beachView(t); BEACH.last = v.info; flyTo(v);
  } else { setBeachActive(false); flyTo(spotView(t)); }
}
function setViewMode(mode) {
  BEACH.mode = mode;
  document.getElementById('view-beach').classList.toggle('on', mode === 'beach');
  document.getElementById('view-off').classList.toggle('on', mode !== 'beach');
  const i = cur ? cur.spotTags.findIndex(t => t.name === BEACH.spot) : -1;
  if (i >= 0 && i < 3) flySpot(i, mode);            // re-fly to the spot you were looking at
}
document.getElementById('view-beach').onclick = () => setViewMode('beach');
document.getElementById('view-off').onclick = () => setViewMode('offshore');
[0, 1, 2].forEach(i => { document.getElementById('spot-' + i).onclick = () => flySpot(i); });
document.getElementById('zoom-out').onclick = () => { setBeachActive(false); flyTo(cur.cfg.views.far); };
controls.addEventListener('start', () => { fly = null; });   // grabbing the scene cancels a flight

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // beach view: a narrow lens (30 deg tall) so the crests near the horizon get more pixels; on a portrait phone it widens so at least 45 deg stay visible across
  camera.fov = BEACH.active ? Math.min(70, Math.max(BEACH.fov, 2 * Math.atan(Math.tan(22.5 * Math.PI / 180) / camera.aspect) * 180 / Math.PI)) : FOV;
  camera.updateProjectionMatrix();
  // pixels per metre at distance 1: lets points keep a fixed size in metres
  material.uniforms.uScale.value = (h * renderer.getPixelRatio()) / (2 * Math.tan((camera.fov / 2) * Math.PI / 180));   // camera.fov: narrower in beach view
}
window.addEventListener('resize', onResize);
onResize();

// Place an HTML label next to a 3D point.
function placeLabel(el, x, y, z) {
  const p = new THREE.Vector3(x, y, z).project(camera);
  el.style.display = (p.z < 1 && Math.abs(p.x) < 1.2 && Math.abs(p.y) < 1.2) ? 'block' : 'none';
  el.style.left = ((p.x + 1) / 2 * window.innerWidth) + 'px';
  el.style.top = ((1 - p.y) / 2 * window.innerHeight) + 'px';
}
const labelShore = document.getElementById('label-shore');
const labelVillage = document.getElementById('label-village');

// ---------- 6. Hover: nearest point on screen ----------
const tip = document.getElementById('tip');
let mouse = null;
canvas.addEventListener('pointermove', e => { mouse = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointerleave', () => { mouse = null; tip.style.display = 'none'; });

// Hover picks the dot nearest the cursor, within 8 px. Each dot is placed exactly as the vertex shader places it
// (same land-height cap, same stretch); before, land was placed uncapped, so land dots were "picked" where they
// are not drawn. Note the limit: zoomed out, one pixel is 2-3 km of sea floor and the grid is 2-4 km, so the
// tooltip can differ from what the colour under the cursor suggests wherever the bottom is steep; the tooltip
// therefore also names the dot's position relative to Klitmoller (wide layer).
// Nearest drawn dot to a screen point (within `maxPx`), or -1.
function nearestDot(mx, my, maxPx = 8) {
  const { pos, depth, N } = cur;
  const exag = material.uniforms.uExag.value, cap = cur.cfg.landCap, w = window.innerWidth, h = window.innerHeight;
  const v = new THREE.Vector3();
  let best = -1, bestD = maxPx * maxPx;
  for (let i = 0; i < N; i++) {
    const z = depth[i] < 0 ? -Math.min(-depth[i], cap) : depth[i];   // same height rule as the shader
    v.set(pos[3 * i], -z * exag, pos[3 * i + 2]).project(camera);
    if (v.z > 1) continue;
    const dx = (v.x + 1) / 2 * w - mx, dy = (1 - v.y) / 2 * h - my;
    if (dx * dx + dy * dy < bestD) { bestD = dx * dx + dy * dy; best = i; }
  }
  return best;
}
// Flat map distance (m) from dot i to the nearest shoreline cell in the loaded box.
function shoreDist(i) {
  const { pos, shoreCells } = cur;
  let near = Infinity;
  for (const j of shoreCells) near = Math.min(near, Math.hypot(pos[3 * j] - pos[3 * i], pos[3 * j + 2] - pos[3 * i + 2]));
  return near;
}
function pick() {
  if (!mouse || !cur) return;
  const { pos, depth, N, shoreCells, kilde, aar, meta } = cur;
  const best = nearestDot(mouse.x, mouse.y);
  if (best < 0) { tip.style.display = 'none'; return; }
  const near = shoreDist(best);
  const d = depth[best];
  // Reef layer: the box is only ~4 km, so distances are in metres and measured from the nearest shoreline cell.
  const dist = cur.cfg.reef ? `${Math.round(near)} m from the nearest shoreline cell` : `${(near / 1000).toFixed(2)} km from the nearest coast`;
  let text = d > 0 ? `depth ${d.toFixed(1)} m (below ${cur.cfg.datumLabel || 'LAT'}), ${dist}`
                   : `land ${(-d).toFixed(1)} m high, ${dist.replace('coast', 'shore')}`;
  if (cur.cfg.wide) { const ex = pos[3 * best] / 1000, ez = pos[3 * best + 2] / 1000;   // z points south
    text += ` (dot ${Math.abs(ex).toFixed(0)} km ${ex < 0 ? 'W' : 'E'}, ${Math.abs(ez).toFixed(0)} km ${ez < 0 ? 'N' : 'S'} of Klitmøller)`; }
  if (kilde) text += `, source: ${meta.kilde_codes[kilde[best]] || 'none'}${aar[best] ? ' ' + aar[best] : ''}`;
  if (cur.cfg.swellFile && SWELL.on && SWELL.data) {
    const st = SWELL.data.state ? SWELL.data.state[best] : undefined;
    const hv = SWELL.data.H ? SWELL.data.H[best] : undefined;   // guard: H or index may be missing
    text += (st === 1 || st === 2) && Number.isFinite(hv) ? `; model wave ${hv.toFixed(1)} m, ${st === 2 ? 'broken' : 'unbroken'}`
          : st === 3 ? '; model: wave not reachable here' : '';
  }
  tip.textContent = text;
  tip.style.display = 'block';
  tip.style.left = (mouse.x + 14) + 'px';
  tip.style.top = (mouse.y + 14) + 'px';
}

// ---------- 6b. Reef layer: "My marks" (Shift+click a point to mark where you surf) ----------
const MARK_KEY = 'oceany.reef.marks';
const MARK_COL = 0x3dffa0;                          // green: distinct from the cyan spot labels
const marks = [];                                   // { name, x, z, depth, near, lat, lon } (plain data)
const markVis = new WeakMap();                      // mark -> { grp, el }
const markGroup = new THREE.Group(); scene.add(markGroup);
const marksBox = document.getElementById('marks'), marksList = document.getElementById('marks-list');
function toLatLon(x, z) {                           // same flat-earth scaling as 02-reefs/export_reefs.py (inverse)
  const o = cur.meta.origin, M = 111195.0;
  return { lat: o.lat + (-z) / M, lon: o.lon + x / (M * Math.cos(o.lat * Math.PI / 180)) };
}
function saveMarks() {
  try { localStorage.setItem(MARK_KEY, JSON.stringify(marks.map(m => ({ name: m.name, x: m.x, z: m.z, depth: m.depth, near: m.near })))); } catch (e) { /* storage unavailable */ }
}
function addMarkVisual(m) {
  const grp = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: MARK_COL, depthTest: false, transparent: true });
  const ring = new THREE.Mesh(new THREE.TorusGeometry(22, 3.5, 8, 32), mat); ring.rotation.x = Math.PI / 2;
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(2, 2, 90, 6), mat); pin.position.y = 45;
  grp.add(ring, pin); grp.renderOrder = 10; markGroup.add(grp);
  const el = document.createElement('div');
  el.className = 'tag'; el.textContent = m.name; el.style.color = '#' + MARK_COL.toString(16); el.style.display = 'none';
  document.body.appendChild(el);
  markVis.set(m, { grp, el });
}
function renderMarks() {
  marksList.innerHTML = '';
  marks.forEach(m => {
    const row = document.createElement('div'); row.className = 'mark-row';
    const t = document.createElement('span');
    t.textContent = `${m.name}: ${Math.abs(m.lat).toFixed(5)} ${m.lat >= 0 ? 'N' : 'S'}, ${Math.abs(m.lon).toFixed(5)} ${m.lon >= 0 ? 'E' : 'W'}, ` +
      (m.depth > 0 ? `depth ${m.depth.toFixed(1)} m (below LAT)` : `land ${(-m.depth).toFixed(1)} m high`) + `, ${Math.round(m.near)} m from the nearest shoreline cell`;
    const x = document.createElement('button'); x.textContent = 'x'; x.title = 'Remove this mark'; x.className = 'mark-x';
    x.onclick = () => removeMark(m);
    row.append(t, x); marksList.appendChild(row);
  });
}
function removeMark(m) {
  const vis = markVis.get(m);
  if (vis) { markGroup.remove(vis.grp); vis.el.remove(); }
  marks.splice(marks.indexOf(m), 1);
  saveMarks(); renderMarks();
}
function addMark(raw) {
  const m = { ...raw, ...toLatLon(raw.x, raw.z) };
  marks.push(m); addMarkVisual(m);
}
let marksLoaded = false;
function loadMarks() {
  marksLoaded = true;
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(MARK_KEY) || '[]'); } catch (e) { saved = []; }
  if (Array.isArray(saved)) saved.forEach(m => { if (m && isFinite(m.x) && isFinite(m.z)) addMark(m); });
  renderMarks();
}
let down = null;
canvas.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('click', e => {
  if (!e.shiftKey || !cur || !cur.cfg.reef) return;
  if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;   // it was a drag, not a click
  const i = nearestDot(e.clientX, e.clientY, 14);
  if (i < 0) return;
  const n = marks.reduce((a, m) => Math.max(a, parseInt(m.name.replace(/\D/g, ''), 10) || 0), 0) + 1;
  addMark({ name: 'Surf zone ' + n, x: cur.pos[3 * i], z: cur.pos[3 * i + 2], depth: cur.depth[i], near: shoreDist(i) });
  saveMarks(); renderMarks();
});
function placeMarks(show) {                         // every frame: follow the vertical stretch, hide off the reef layer
  markGroup.visible = show;
  marks.forEach(m => {
    const { grp, el } = markVis.get(m);
    if (!show) { el.style.display = 'none'; return; }
    const exag = material.uniforms.uExag.value, z = m.depth < 0 ? -Math.min(-m.depth, cur.cfg.landCap) : m.depth;
    grp.position.set(m.x, -z * exag, m.z);
    placeLabel(el, m.x, -z * exag + 110, m.z);
  });
}

// ---------- 6c. Reef layer: simulated swell (data from 02-reefs/simulate_swell.py) ----------
// A second point cloud: the water surface above each wet reef cell. Height = tide + (H/2) cos(phase - omega t),
// stretched like the sea floor. Phase grows towards the shore, so crests march in; H is the model's wave height.
// Broken cells (H >= 0.78 x depth) are white foam, unbroken cells translucent blue-green; cells the model
// cannot reach are not drawn. Sea-floor points are never moved.
// PLUMBING: the loading and the typed-array update below. WORTH READING: the height formula in updateSwell().
const SWELL = { file: 'data/swell_sim.json', layer: null, on: false, speed: 1, data: null, loading: false, t: 0, last: null };
const SWELL_SURF_ALPHA = 0.7;      // swell surface and water fill opacity multipliers (1 = the old, denser look)
const WATER_FILL_ALPHA = 0.5;
const swellMat = new THREE.ShaderMaterial({
  uniforms: { uSize: { value: 14 }, uScale: { value: 1 }, uExag: { value: 5 }, uTide: { value: 0 }, uMaxPx: { value: 8 }, uFadeFar: { value: 0 }, uLow: { value: 0 } },   // uMaxPx/uFadeFar/uLow: beach view only (defaults = the usual look)
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `
    uniform float uSize, uScale, uExag, uTide, uMaxPx, uFadeFar, uLow;
    attribute vec4 aCol; attribute float aAmp; varying vec4 vCol; varying float vSq;
    void main() {
      vec3 p = position;
      if (uLow > 0.5) {                             // beach view: jitter each dot within its 5 m square, so the regular grid does not draw streaks toward a low camera
        vec2 h = fract(sin(vec2(dot(p.xz, vec2(12.9898, 78.233)), dot(p.xz, vec2(39.3468, 11.135)))) * 43758.5453);
        p.xz += (h - 0.5) * 4.0;
      }
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = clamp(uSize * uScale / -mv.z, 2.0, uMaxPx);   // capped: close-up dots would overlap hundreds deep and slow the GPU
      gl_Position = projectionMatrix * mv;
      vSq = 1.0;                                    // beach view: each dot is drawn as a flat disc lying on the water (an ellipse squashed by the viewing angle), so crests read as lines
      if (uLow > 0.5) vSq = clamp(abs(dot(normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz), normalize(mv.xyz))), 0.04, 1.0);
      float crest = clamp((position.y / uExag - uTide) / max(aAmp, 0.01), -1.0, 1.0);   // +1 crest, -1 trough
      float up = (crest + 1.0) / 2.0;
      // Beach view (uLow = 1): seen from eye height the rows of dots pile up, so troughs are dimmed further and crests
      // sharpened (up^4 instead of up^2), and far water fades out (uFadeFar m) instead of piling into a bright band.
      float a = mix(0.12 + 0.88 * up * up, 0.04 + 0.96 * up * up * up * up, uLow);
      if (uFadeFar > 0.0) a *= 1.0 - smoothstep(0.35 * uFadeFar, uFadeFar, -mv.z);
      vCol = vec4(aCol.rgb, aCol.a * a);                                                 // crests bright, troughs faint
    }`,
  fragmentShader: `
    varying vec4 vCol; varying float vSq;
    void main() {
      vec2 d = gl_PointCoord - 0.5; d.y /= vSq;
      float r = length(d) * 2.0;
      if (r > 1.0) discard;
      gl_FragColor = vec4(vCol.rgb, vCol.a * ${SWELL_SURF_ALPHA.toFixed(2)} * pow(1.0 - r, 0.6));     // translucent so the bed reads through; fuller dots than the sea floor's: the surface is drawn with small, overlapping dots
    }`,
});
const swellCloud = new THREE.Points(new THREE.BufferGeometry(), swellMat);
swellCloud.frustumCulled = false; swellCloud.visible = false; scene.add(swellCloud);
// ---- Drawing the surface (DRAWING ONLY: swell_sim.json and the model are untouched) ----
// The model has one value per 11 x 14 m lidar cell, but a crest is ~60 m long, so one dot per cell looks like a lattice.
// So we draw on a finer grid (FINE_M) and blend the four nearest model cells. This adds no detail: it only smooths.
// Rules: only cells the model drew are used (dry land and missing cells stay gaps); the wave phase is blended as its
// cos and sin (blending raw angles would make 6.1 and 0.2 rad meet in the middle at 3 rad, a wrong crest).
const FINE_M = 5;                  // spacing of the drawn grid in metres
const FADE_WAVELEN = [20, 40];     // wavelength (m): fully faded below 20, fully drawn above 40 (about 3 lidar cells)
const FADE_WATER = [0.5, 1.0];     // water depth (m): fully faded below 0.5, fully drawn above 1.0
const FADE_WAVELEN_FLOOR = 0.3;    // the short-wavelength fade never goes below this, so the swell reaches down to 0.5 m of water (was: cut off at ~1 m)
const SWELL_DOT = 0.5;             // swell dot size as a fraction of the sea-floor dot size
const SWELL_BED_DIM = 0.5;         // sea-floor brightness while the swell is on (1 = as without the swell)
const smooth01 = (lo, hi, x) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };
const pitch = a => { const u = [...new Set(a.map(v => Math.round(v * 10)))].sort((p, q) => p - q);   // grid spacing
  const gaps = []; for (let i = 1; i < u.length; i++) gaps.push(u[i] - u[i - 1]); gaps.sort((p, q) => p - q); return gaps[gaps.length >> 1] / 10; };
// ---- Awash zone and land while the swell is on (DRAWING ONLY, not simulated) ----
// The swell surface fades out in under ~1 m of water, which would draw a rock shelf that is wet by run-up as black nothing.
// So the reef points near the tide level are redrawn as a pale "awash" set, and higher rock as dim land.
// illustrative allowance for wave set-up and run-up; not simulated
const AWASH_BELOW_TIDE_M = 0.5;    // bed this far below the tide level is still treated as awash (below that: swell surface covers it)
const AWASH_ABOVE_TIDE_M = 1.0;    // bed up to this far above the tide level is wet by run-up (above that: dry land)
const AWASH_COL = [0.85, 1.0, 0.97], LAND_COL = [0.30, 0.23, 0.16];   // pale foam/ice-blue; muted grey-brown, dim
const awashMat = (col) => new THREE.ShaderMaterial({
  uniforms: { uExag: { value: 5 }, uSize: { value: 100 }, uScale: { value: 1 }, uLandCap: { value: 1e9 }, uBright: { value: 1 }, uMaxPx: { value: 1e5 }, uCol: { value: new THREE.Color(col[0], col[1], col[2]) } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `
    uniform float uExag, uSize, uScale, uLandCap, uMaxPx;
    attribute float aDepth;
    void main() {
      vec3 p = position;
      float z = aDepth < 0.0 ? -min(-aDepth, uLandCap) : aDepth;   // same height rule as the sea-floor cloud
      p.y = -z * uExag;
      vec4 mv = modelViewMatrix * vec4(p, 1.0);
      gl_PointSize = min(uMaxPx, max(2.0, uSize * uScale / -mv.z));
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform vec3 uCol; uniform float uBright;
    void main() {
      float r = length(gl_PointCoord - 0.5) * 2.0;
      if (r > 1.0) discard;
      gl_FragColor = vec4(uCol * uBright, pow(1.0 - r, 2.0) * 0.85);
    }`,
});
const awashPts = new THREE.Points(new THREE.BufferGeometry(), awashMat(AWASH_COL));
const landPts = new THREE.Points(new THREE.BufferGeometry(), awashMat(LAND_COL));
[awashPts, landPts].forEach(o => { o.frustumCulled = false; o.visible = false; scene.add(o); });
// Calm water fill at the tide level where the swell draws nothing; colour by water depth (turquoise under ~1 m to dim deep blue past ~5 m). Not simulated.
const waterMat = new THREE.ShaderMaterial({
  uniforms: { uExag: { value: 5 }, uTide: { value: 2.1 }, uSize: { value: 100 }, uScale: { value: 1 }, uMaxPx: { value: 1e5 }, uBright: { value: 1 } },   // uBright < 1 in beach view only
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `
    uniform float uExag, uTide, uSize, uScale, uMaxPx;
    attribute float aWd; varying vec3 vCol;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position.x, uTide * uExag, position.z, 1.0);
      gl_PointSize = min(uMaxPx, max(2.0, uSize * uScale / -mv.z));
      gl_Position = projectionMatrix * mv;
      float t = smoothstep(1.0, 5.0, aWd);
      vCol = mix(vec3(0.05, 0.50, 0.55), vec3(0.02, 0.08, 0.28), t) * 0.7;   // dimmer than the swell, so the swell reads on top
      vCol = mix(vec3(0.20, 0.72, 0.70) * 0.85, vCol, smoothstep(0.0, 0.5, aWd));   // ankle-deep (<0.5 m) shelf: lighter aqua, still water not rock
    }`,
  fragmentShader: `
    uniform float uBright; varying vec3 vCol;
    void main() {
      float r = length(gl_PointCoord - 0.5) * 2.0;
      if (r > 1.0) discard;
      gl_FragColor = vec4(vCol * uBright, pow(1.0 - r, 2.0) * 0.85 * ${WATER_FILL_ALPHA.toFixed(2)});   // translucent: the sea floor shows through
    }`,
});
const waterPts = new THREE.Points(new THREE.BufferGeometry(), waterMat);
waterPts.frustumCulled = false; waterPts.visible = false; scene.add(waterPts);
function buildAwash(reef, tide) {                    // once, from the reef cloud: bed height above LAT = -depth
  const A = [], Ld = [], Wt = [];
  for (let i = 0; i < reef.N; i++) {
    const h = -reef.depth[i];
    if (!isFinite(h)) continue;
    if (h > tide + AWASH_ABOVE_TIDE_M) Ld.push(i); else if (h >= tide) A.push(i); else Wt.push(i);   // awash = exposed rock above the water line only; every cell below the tide gets the still-water fill (shallow strip drawn lighter)
  }
  const mk = (idx, pts) => {
    const pos = new Float32Array(idx.length * 3), dep = new Float32Array(idx.length);
    idx.forEach((i, j) => { pos[3 * j] = reef.pos[3 * i]; pos[3 * j + 2] = reef.pos[3 * i + 2]; dep[j] = reef.depth[i]; });
    pts.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    pts.geometry.setAttribute('aDepth', new THREE.BufferAttribute(dep, 1));
  };
  mk(A, awashPts); mk(Ld, landPts);
  const wp = new Float32Array(Wt.length * 3), wd = new Float32Array(Wt.length);
  Wt.forEach((i, j) => { wp[3 * j] = reef.pos[3 * i]; wp[3 * j + 2] = reef.pos[3 * i + 2]; wd[j] = reef.depth[i] + tide; });
  waterPts.geometry.setAttribute('position', new THREE.BufferAttribute(wp, 3));
  waterPts.geometry.setAttribute('aWd', new THREE.BufferAttribute(wd, 1));
  window.__awashCount = A.length; window.__landCount = Ld.length; window.__waterCount = Wt.length;
}
// Each layer with a swellFile keeps its own swell state; switching layers stashes the current one and restores the target's (or none).
const swellStash = {};
const swellFiles = {};                                // parsed swell JSON per file (play.js "Python file" and layer switches reuse it)
function switchSwellLayer(label) {
  if (SWELL.layer === label) return;
  if (SWELL.layer) swellStash[SWELL.layer] = { data: SWELL.data, file_data: SWELL.file_data, awashTide: SWELL.awashTide };
  const st = swellStash[label] || {}, L = LAYERS[label];
  SWELL.layer = label; SWELL.data = st.data || null; SWELL.file_data = st.file_data || null; SWELL.awashTide = undefined;
  if (L.swellFile) SWELL.file = L.swellFile;
  swellCloud.visible = false;
  if (SWELL.data) { buildAwash(cache[label], SWELL.data.tide); SWELL.awashTide = SWELL.data.tide; swellCloud.geometry = SWELL.geom || swellCloud.geometry; }
  else if (SWELL.on && L.swellFile) loadSwell().catch(() => {});
}
// Per-layer text in the swell box: the Porto Batel wording stays; other spots say what file/swell is drawn.
function setSwellUI(L) {
  const porto = !!L.portugal, show = (id, on) => { const e = document.getElementById(id); if (e) e.style.display = on ? '' : 'none'; };
  document.getElementById('swl-on-text').textContent = porto ? 'Simulated swell (illustrative), 17 Sep 2026 18:00' : 'Simulated swell (illustrative, not a forecast)';
  document.getElementById('swl-note').textContent = SWELL.data && SWELL.data.note ? SWELL.data.note : '';
  const hasBW = !!(L.spot && BW.avail && BW.avail.includes(L.spot));
  show('bw-row', hasBW); show('bw-variant', hasBW && !!BW_VARIANTS[L.spot]);
  show('bw-note', hasBW && BW.on);
  document.getElementById('play-only').style.display = porto ? 'none' : 'block';   // play.js controls: Porto Batel only
  const pl = document.getElementById('play'); if (pl) pl.style.display = porto ? '' : 'none';
  if (BW.on && hasBW) selectBW(L.spot).catch(() => {});
}
async function loadSwell() {
  if (SWELL.data || SWELL.loading) return;
  SWELL.loading = true;
  const layerLabel = SWELL.layer, file = SWELL.file;
  try {
    const d = swellFiles[file] || (swellFiles[file] = await loadJSON(file, 'swell model'));
    SWELL.file_data = d;               // the Python run as shipped; play.js resets to it
    if (SWELL.layer === layerLabel) buildSwell(d);
  } finally { SWELL.loading = false; }
}
// HOOK (play.js): rebuild the swell surface from any object shaped like swell_sim.json (meta, H, broken, k, phase, state).
function buildSwell(d) {
  const reef = cache[SWELL.layer] || cache[Object.keys(LAYERS).find(k => LAYERS[k].portugal)];   // the swell belongs to the layer that is on screen (play.js: Porto Batel)
  if (!reef) throw new Error('reef layer not loaded');
  if (d.H.length !== reef.N) throw new Error(`swell file has ${d.H.length} points, layer has ${reef.N}`);
  const c0 = d.meta.config, tide = c0.tide_above_lat_m != null ? c0.tide_above_lat_m : (c0.tide_above_datum_m || 0);
  // PLUMBING: put the model cells on a 2D grid (nx x nz), in the same row/column layout as the lidar.
  const X = [], Z = []; for (let i = 0; i < reef.N; i++) { X.push(reef.pos[3 * i]); Z.push(reef.pos[3 * i + 2]); }
  let xmin = Infinity, xmax = -Infinity, zmin = Infinity, zmax = -Infinity;   // loops, not Math.min(...X): 170k points overflow the argument limit
  for (let i = 0; i < reef.N; i++) { if (X[i] < xmin) xmin = X[i]; if (X[i] > xmax) xmax = X[i]; if (Z[i] < zmin) zmin = Z[i]; if (Z[i] > zmax) zmax = Z[i]; }
  const dx = pitch(X), dz = pitch(Z), x0 = xmin, z0 = zmin;
  const nx = Math.round((xmax - x0) / dx) + 1, nz = Math.round((zmax - z0) / dz) + 1;
  const st = new Uint8Array(nx * nz), Hc = new Float32Array(nx * nz), Cc = new Float32Array(nx * nz), Sc = new Float32Array(nx * nz);
  const Fc = new Float32Array(nx * nz), flag = new Uint8Array(nx * nz);
  let faded = 0;
  for (let i = 0; i < reef.N; i++) {
    const c = Math.round((Z[i] - z0) / dz) * nx + Math.round((X[i] - x0) / dx);
    if (d.state[i] !== 1 && d.state[i] !== 2) continue;           // dry, in a lee or missing: stays a gap
    st[c] = 1; Hc[c] = d.H[i]; Cc[c] = Math.cos(d.phase[i]); Sc[c] = Math.sin(d.phase[i]); flag[c] = d.broken[i] ? 1 : 0;
    // Fade: waves shorter than ~3 cells, or in under ~1 m of water, are not resolved by the data, so they fade out.
    const wl = d.k[i] > 0 ? 2 * Math.PI / d.k[i] : 0;
    Fc[c] = Math.max(FADE_WAVELEN_FLOOR, smooth01(FADE_WAVELEN[0], FADE_WAVELEN[1], wl)) * smooth01(FADE_WATER[0], FADE_WATER[1], reef.depth[i] + tide);
    if (Fc[c] < 0.03) faded++;
  }
  // Colour only: a cell is drawn white if most of the drawn cells in its 3 x 3 block are broken (the flags themselves stay).
  const colourFlag = new Uint8Array(nx * nz); let flicker = 0;
  for (let r = 0; r < nz; r++) for (let q = 0; q < nx; q++) {
    const c = r * nx + q; if (!st[c]) continue;
    let n = 0, b = 0;
    for (let rr = Math.max(0, r - 1); rr <= Math.min(nz - 1, r + 1); rr++) for (let qq = Math.max(0, q - 1); qq <= Math.min(nx - 1, q + 1); qq++) {
      const e = rr * nx + qq; if (st[e]) { n++; b += flag[e]; }
    }
    colourFlag[c] = 2 * b > n ? 1 : 2 * b < n ? 0 : flag[c];
    if (colourFlag[c] !== flag[c]) flicker++;
  }
  // The drawn grid: one point per FINE_M square whose nearest model cell was drawn; values blended from drawn neighbours.
  const nfx = Math.ceil((nx * dx) / FINE_M) + 1, nfz = Math.ceil((nz * dz) / FINE_M) + 1, cap = nfx * nfz;
  const pos = new Float32Array(cap * 3), col = new Float32Array(cap * 4), amp = new Float32Array(cap), ph = new Float32Array(cap);
  let n = 0, fadedPts = 0;
  for (let fz = 0; fz < nfz; fz++) for (let fx = 0; fx < nfx; fx++) {
    const wx = x0 - dx / 2 + fx * FINE_M, wz = z0 - dz / 2 + fz * FINE_M;
    const u = (wx - x0) / dx, v = (wz - z0) / dz, nq = Math.round(u), nr = Math.round(v);
    if (nq < 0 || nr < 0 || nq >= nx || nr >= nz || !st[nr * nx + nq]) continue;       // gap in the data stays a gap
    const q0 = Math.floor(u), r0 = Math.floor(v), tu = u - q0, tv = v - r0;
    let w = 0, h = 0, cs = 0, sn = 0, f = 0;
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) {
      const q = q0 + b, r = r0 + a; if (q < 0 || r < 0 || q >= nx || r >= nz || !st[r * nx + q]) continue;
      const wt = (b ? tu : 1 - tu) * (a ? tv : 1 - tv), e = r * nx + q;
      w += wt; h += wt * Hc[e]; cs += wt * Cc[e]; sn += wt * Sc[e]; f += wt * Fc[e];
    }
    if (w <= 0) continue;
    f /= w; if (f < 0.03) { fadedPts++; continue; }                                  // too short a wave to draw
    pos[3 * n] = wx; pos[3 * n + 2] = wz;
    amp[n] = (h / w) / 2 * f; ph[n] = Math.atan2(sn, cs);
    col.set(colourFlag[nr * nx + nq] ? [1.0, 1.0, 1.0, 1.0 * f] : [0.25, 0.95, 0.8, 0.85 * f], 4 * n);
    n++;
  }
  swellCloud.geometry.dispose(); swellCloud.geometry = new THREE.BufferGeometry();   // fresh buffers on a redraw (play.js)
  const g = swellCloud.geometry;
  g.setAttribute('position', new THREE.BufferAttribute(pos.slice(0, 3 * n), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aCol', new THREE.BufferAttribute(col.slice(0, 4 * n), 4));
  g.setAttribute('aAmp', new THREE.BufferAttribute(amp.slice(0, n), 1));
  SWELL.geom = g;
  SWELL.data = { meta: d.meta, n, pos: g.attributes.position.array, amp: amp.slice(0, n), ph: ph.slice(0, n),
                 state: d.state, H: d.H,   // per reef point (same index as the pick), for the tooltip
                 omega: d.meta.config.omega_rad_s, tide, stats: { cells: nx * nz, fadedCells: faded, fadedPts, recoloured: flicker, points: n } };
  SWELL.data.period = d.meta.config.T_s || (2 * Math.PI / d.meta.config.omega_rad_s) || 8;   // pulse period for the awash set
  if (SWELL.awashTide !== tide) { buildAwash(reef, tide); SWELL.awashTide = tide; }   // only when the tide changes (play.js)
  // On-screen label: the file's own wording (viewer_note), plus its label / caveat / source if the note does not already carry them.
  const m = d.meta; let note = m.viewer_note || '';
  [m.label && (m.label.charAt(0).toUpperCase() + m.label.slice(1) + '.'), m.caveat].forEach(t => { if (t && !note.toLowerCase().includes(t.replace(/\.$/, '').toLowerCase())) note += (note ? ' ' : '') + t; });
  if (m.config && m.config.H0_m && m.config.T_s) note += ` Drawn: ${m.config.H0_m} m, ${m.config.T_s} s, from ${m.config.direction_from_deg} deg, tide ${tide} m above ${m.config.datum || 'LAT'}.`;
  SWELL.data.note = note;
  document.getElementById('swl-note').textContent = note;
}
// Every frame: surface height = tide + (H/2) cos(phase - omega t), times the vertical stretch. No allocations.
function updateSwell(now) {
  const show = SWELL.on && !!SWELL.data && !!cur && !!cur.cfg.swellFile;
  swellCloud.visible = show;
  awashPts.visible = landPts.visible = waterPts.visible = show;
  // The sea floor stays drawn under the water, dimmer (its depth colours still read) and only where the bed is below the
  // tide level (above that the awash/land sets draw it), so the bed shows through the translucent water and swell.
  cloud.visible = true;
  material.uniforms.uDim.value = show ? (BEACH.active ? BEACH.bedDim : SWELL_BED_DIM) : 1;   // beach view: the bed under the water is barely seen from the shore
  material.uniforms.uHideAbove.value = show ? SWELL.data.tide : 1e9;
  const dt = SWELL.last === null ? 0 : Math.min((now - SWELL.last) / 1000, 0.25);
  SWELL.last = now;
  if (!show) return;
  swellMat.uniforms.uScale.value = material.uniforms.uScale.value;   // same point size rule as the sea floor
  swellMat.uniforms.uSize.value = material.uniforms.uSize.value * SWELL_DOT * (BEACH.active ? BEACH.swellSize : 1);   // finer dots for the finer grid (beach view: wider flat discs, so neighbours join into crest lines)
  swellMat.uniforms.uExag.value = material.uniforms.uExag.value; swellMat.uniforms.uTide.value = SWELL.data.tide;
  SWELL.t += dt * SWELL.speed;                          // model seconds (real time, or x4)
  [awashPts, landPts].forEach(o => { const u = o.material.uniforms;   // same size/stretch/land cap as the sea-floor cloud
    u.uExag.value = material.uniforms.uExag.value; u.uSize.value = material.uniforms.uSize.value;
    u.uScale.value = material.uniforms.uScale.value; u.uLandCap.value = material.uniforms.uLandCap.value; u.uMaxPx.value = material.uniforms.uMaxPx.value; });
  { const u = waterMat.uniforms; u.uExag.value = material.uniforms.uExag.value; u.uTide.value = SWELL.data.tide;
    u.uSize.value = material.uniforms.uSize.value; u.uScale.value = material.uniforms.uScale.value; u.uMaxPx.value = material.uniforms.uMaxPx.value; u.uBright.value = BEACH.active ? BEACH.waterDim : 1; }
  { const u = swellMat.uniforms, on = BEACH.active; u.uMaxPx.value = on ? BEACH.swellMaxPx : 8; u.uFadeFar.value = on ? BEACH.fadeFar : 0; u.uLow.value = on ? 1 : 0; }
  awashPts.material.uniforms.uBright.value = 0.8 + 0.2 * Math.sin(2 * Math.PI * SWELL.t / (SWELL.data.period || 8));   // slow, subtle
  const { n, pos, amp, ph, omega, tide } = SWELL.data, exag = material.uniforms.uExag.value, wt = omega * SWELL.t;
  for (let j = 0; j < n; j++) pos[3 * j + 1] = (tide + amp[j] * Math.cos(ph[j] - wt)) * exag;
  swellCloud.geometry.attributes.position.needsUpdate = true;
}
document.getElementById('swl-on').addEventListener('change', async e => {
  SWELL.on = e.target.checked;
  document.getElementById('swl-speed-row').style.display = SWELL.on ? '' : 'none';
  document.getElementById('swl-awash-note').style.display = SWELL.on ? '' : 'none';
  if (SWELL.on) await loadSwell();
});
document.getElementById('swl-fast').addEventListener('change', e => { SWELL.speed = e.target.checked ? 4 : 1; });

// ---------- 6e. Reef layer: breaking-wave slice (data from 03-breaking-wave, a 2D particle simulation along one line) ----------
// Particles, free surface and bed along the 236 deg line from the filming position. Built in metres (y = height above LAT) and the
// group is scaled in y by the same vertical stretch as the sea floor, so the slice sits on the lidar. Illustrative, one wave.
// Variants per spot: the first is the default. file = data file; fb = first-break fallback (m) when the slice meta has no first_break_s_m.
const BW_VARIANTS = {
  porto_batel: [
    { key: 's8', file: 'porto_batel_slice_s8.json', label: 'Typical wave, 1.5 m (s8)', fb: 142 },
    { key: 's7', file: 'porto_batel_slice.json', label: 'Upper bound, 2.7 m (s7)', fb: 194 },
    { key: 'fw', fw: true, file: 'porto_batel_funwave.json', label: 'Whole reef, 2DH model (FUNWAVE), 1.45 m (not default)', fb: 136 },
  ],
};
const BW = { on: false, loading: false, data: null, t: 0, last: null, avail: null, byspot: {}, variant: {} };   // slices: data/<spot>_slice.json for every spot listed in data/slices.json
const bwGroup = new THREE.Group(); bwGroup.visible = false; scene.add(bwGroup);
const bwMat = new THREE.ShaderMaterial({
  uniforms: { uSize: { value: 14 }, uScale: { value: 1 }, uVmax: { value: 40 } },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: `
    uniform float uSize, uScale; attribute float aV; varying float vV;
    void main() {
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      gl_PointSize = clamp(uSize * uScale / -mv.z, 2.0, 6.0);
      gl_Position = projectionMatrix * mv; vV = aV;
    }`,
  fragmentShader: `
    uniform float uVmax; varying float vV;
    void main() {
      float r = length(gl_PointCoord - 0.5) * 2.0;
      if (r > 1.0) discard;
      float t = clamp(vV / uVmax, 0.0, 1.0);                       // slow = deep blue, fast = white
      gl_FragColor = vec4(mix(vec3(0.08, 0.25, 0.9), vec3(1.0), t), pow(1.0 - r, 1.5) * 0.9);
    }`,
});
const bwPts = new THREE.Points(new THREE.BufferGeometry(), bwMat); bwPts.frustumCulled = false; bwPts.renderOrder = 12; bwGroup.add(bwPts);
const bwSurf = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x7fe3f0, transparent: true, opacity: 0.9, depthTest: false }));
bwSurf.frustumCulled = false; bwSurf.renderOrder = 12; bwGroup.add(bwSurf);
const bwBed = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4f6f8a, transparent: true, opacity: 0.55, depthTest: false }));
bwBed.frustumCulled = false; bwBed.renderOrder = 12; bwGroup.add(bwBed);
const bwLabel = document.createElement('div'); bwLabel.className = 'tag'; bwLabel.style.color = '#cfefff'; bwLabel.style.fontSize = '11px';
bwLabel.style.display = 'none'; bwLabel.textContent = 'front goes vertical here (sim)'; document.body.appendChild(bwLabel);
// Which slices exist: data/slices.json = { "slices": ["porto_batel", ...] } (the simulation worker appends). A missing manifest = Porto Batel only. No 404s for slices that do not exist.
async function loadSliceManifest() {
  try { const r = await fetch('data/slices.json?v=' + DATA_VERSION); const j = r.ok ? await r.json() : null; BW.avail = (j && j.slices) || ['porto_batel']; }
  catch (e) { BW.avail = ['porto_batel']; }
  if (cur) setSwellUI(cur.cfg);
}
loadSliceManifest();
function bwVariantOf(spot) { const vs = BW_VARIANTS[spot]; if (!vs) return null; return vs.find(v => v.key === BW.variant[spot]) || vs[0]; }
function bwPortoNote(m, v) {
  return 'Breaking wave slice (illustrative, 2D slice, not a forecast). ' + (v.key === 's7' ? 'Upper bound: ' : 'Typical wave: ') + 'simulated along one line from the filming position (236\u00b0), ' + m.H_m + ' m / ' + m.T_s + ' s, tide ' + m.tide_above_lat_m + ' m. One representative wave, no refraction, bed interpolated from 11 \u00d7 14 m lidar. Break position good to about \u00b115\u201320 m.';
}
// FUNWAVE-TVD 2DH layer (pieces/05-funwave/export_viewer_layer.py): eta on a 3 m grid over the whole Porto Batel reef, a seamless
// two-period loop of a regular swell; foam = model breaking (fading trace). Drawn as points in the same frame and stretch as the slice.
// Drawn as a lit, semi-transparent surface (points at grazing angles merged into one white smear): troughs dark, crests bright,
// foam white. Wave height gets its own visual stretch so the swell reads at any depth stretch (labelled on screen).
const FW = { exag: 3, flown: false };                 // visual vertical exaggeration of the FUNWAVE surface (slider 1-5, labelled on screen)
const fwMat = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 30, specular: 0x223344, side: THREE.DoubleSide });
const fwMesh = new THREE.Mesh(new THREE.BufferGeometry(), fwMat); fwMesh.frustumCulled = false; fwMesh.renderOrder = 12; fwMesh.visible = false; bwGroup.add(fwMesh);
const fwSun = new THREE.DirectionalLight(0xffffff, 0.6); fwSun.position.set(0.5, 0.8, -0.35);   // from the shore side and above: lights the wave faces seen from the cliff
const fwSky = new THREE.HemisphereLight(0x9fcfff, 0x000000, 0.3);
scene.add(fwSun); scene.add(fwSky);
const fwTag = document.createElement('div'); fwTag.className = 'tag'; fwTag.style.cssText = 'color:#fff;font-size:12px;font-weight:600;display:none;left:50%;bottom:34px;top:auto;transform:translateX(-50%);position:fixed;background:rgba(0,0,0,.45);padding:3px 8px;border-radius:4px';
document.body.appendChild(fwTag);
{
  const row = document.createElement('div'); row.id = 'fw-exag-row'; row.className = 'hint'; row.style.display = 'none';
  row.innerHTML = '<label>Wave heights (2DH model) <input id="fw-exag" type="range" min="1" max="5" step="0.5" value="3" style="vertical-align:middle;width:110px"> <span id="fw-exag-text">heights exaggerated \u00d73</span></label>';
  const anchor = document.getElementById('bw-variant'); anchor.parentNode.insertBefore(row, anchor.nextSibling);
  row.querySelector('#fw-exag').addEventListener('input', e => { FW.exag = Number(e.target.value); document.getElementById('fw-exag-text').textContent = `heights exaggerated \u00d7${FW.exag}`; });
}
async function loadFW(spot, v, key) {
  BW.loading = true;
  try {
    const d = await loadJSON('data/' + v.file, 'FUNWAVE layer'), m = d.meta, n = d.frames.length, P = m.ns * m.ny;
    const [ux, uy] = m.direction_unit_xy, [ax, ay] = m.along_unit_xy, hx = m.house_x_m, hy = m.house_y_m;
    const X = new Float32Array(P), Zc = new Float32Array(P);
    for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.ns; i++) {
      const k = j * m.ns + i, s = m.s_m[i], y = m.y_m[j];
      X[k] = hx + s * ux + y * ax; Zc[k] = -(hy + s * uy + y * ay);
    }
    const E = d.frames.map(f => Float32Array.from(f.eta_cm, c => c === 9999 ? NaN : c / 100));
    const F = d.frames.map(f => Float32Array.from(f.foam, c => +c / 9));
    const brk = m.first_break_house_m || v.fb;
    BW.byspot[key] = { fw: true, spot, key, n, P, X, Zc, E, F, dt: m.frame_dt_s, tide: m.tide_above_lat_m,
      note: 'Breaking wave, whole reef (illustrative, not a forecast): FUNWAVE-TVD 2DH Boussinesq model over the 2011 lidar, regular swell ' + m.H_m + ' m / ' + m.T_s +
            ' s from ' + m.from_deg + '\u00b0, tide ' + m.tide_above_lat_m + ' m. White = where the model breaks. In front of the house the wave peels as a right-hander (toward ' +
            m.peel.toward_deg + '\u00b0, about ' + m.peel.alongshore_m_s + ' m/s). Bed from 11 \u00d7 14 m lidar; no overturning lip in a depth-averaged model.',
      labelText: `first breaks here (2DH model): ${Math.round(brk)} m from the house`, labelX: hx + brk * ux, labelZ: -(hy + brk * uy),
      pos: new THREE.BufferAttribute(new Float32Array(P * 3), 3).setUsage(THREE.DynamicDrawUsage),
      aF: new THREE.BufferAttribute(new Float32Array(P), 1).setUsage(THREE.DynamicDrawUsage) };
    const idx = [];                                      // all grid triangles; dry ones are dropped per frame
    for (let j = 0; j + 1 < m.ny; j++) for (let i = 0; i + 1 < m.ns; i++) { const k = j * m.ns + i; idx.push(k, k + 1, k + m.ns, k + 1, k + m.ns + 1, k + m.ns); }
    Object.assign(BW.byspot[key], { tri: Uint32Array.from(idx), index: new THREE.BufferAttribute(new Uint32Array(idx.length), 1).setUsage(THREE.DynamicDrawUsage),
      col: new THREE.BufferAttribute(new Float32Array(P * 3), 3).setUsage(THREE.DynamicDrawUsage) });
    Object.assign(BW.byspot[key], { hx, hy, ux, uy, ax, ay });
    window.__fwFrames = n; window.__fwPoints = P;
  } finally { BW.loading = false; }
}
async function loadBW(spot) {
  const v = bwVariantOf(spot), key = spot + (v ? '|' + v.key : '');
  if (BW.byspot[key] || BW.loading) return;
  if (v && v.fw) return loadFW(spot, v, key);
  BW.loading = true;
  try {
  const d = await loadJSON('data/' + (v ? v.file : spot + '_slice.json'), 'breaking-wave slice'), m = d.meta, n = d.frames.length, P = d.frames[0].s_cm.length;
  const [ux, uy] = m.direction_unit_xy, hx = m.house_x_m, hy = m.house_y_m;     // same x_m / -y_m frame as the reef cloud
  const S = [], Z = [], V = [], F = [], s = Float64Array.from(d.frames[0].s_cm), z = Float64Array.from(d.frames[0].z_cm);
  const ss = m.surface_s_m, ns = Math.floor((ss.stop - ss.start) / ss.step) + 1;
  d.frames.forEach((f, i) => {                          // decode the deltas once: absolute metres per frame
    if (i) for (let j = 0; j < P; j++) { s[j] += f.ds_cm[j]; z[j] += f.dz_cm[j]; }
    S.push(Float32Array.from(s, v => v / 100)); Z.push(Float32Array.from(z, v => v / 100)); V.push(Float32Array.from(f.v_dms));
    F.push(Float32Array.from(f.surface_cm, v => v === null ? NaN : v / 100));
  });
  const sx = j => hx + (ss.start + j * ss.step) * ux, sz = j => -(hy + (ss.start + j * ss.step) * uy);
  const bed = [], bs = d.bed.s_m, bz = d.bed.z_above_lat_m;
  for (let j = 0; j < bs.length; j++) bed.push(new THREE.Vector3(hx + bs[j] * ux, bz[j], -(hy + bs[j] * uy)));
  const vs = []; for (let i = 0; i < n; i += 5) for (let j = 0; j < P; j++) vs.push(V[i][j]);
  vs.sort((a, b) => a - b);
  const brk = m.first_break_s_m || (v && v.fb);
  const note = spot === 'porto_batel' ? bwPortoNote(m, v) : ('Breaking wave slice (illustrative, 2D slice, not a forecast). ' + (m.case || '') + (m.H_m ? ` ${m.H_m} m / ${m.T_s} s` : '') + (m.tide_above_lat_m != null ? `, tide ${m.tide_above_lat_m} m` : '') + '. One representative wave, no refraction.' + (m.caveat ? ' ' + m.caveat : ''));
  BW.byspot[key] = { spot, key, n, P, S, Z, V, F, ns, sx, sz, hx, hy, ux, uy, dt: m.frame_dt_s, tide: m.tide_above_lat_m != null ? m.tide_above_lat_m : (m.tide_above_datum_m || 0),
              vmax: Math.max(1, vs[Math.floor(vs.length * 0.98)]), bed, note,
              labelText: spot === 'porto_batel' ? `front goes vertical here (sim): ${Math.round(brk)} m from the house` : (brk ? `front goes vertical here (sim): ${Math.round(brk)} m from the start of the line` : 'breaking-wave slice (sim)'),
              labelX: hx + (brk || 181) * ux, labelZ: -(hy + (brk || 181) * uy),
              pos: new THREE.BufferAttribute(new Float32Array(P * 3), 3).setUsage(THREE.DynamicDrawUsage),
              aV: new THREE.BufferAttribute(new Float32Array(P), 1).setUsage(THREE.DynamicDrawUsage),
              surf: new THREE.BufferAttribute(new Float32Array(ns * 6), 3).setUsage(THREE.DynamicDrawUsage) };
  window.__bwFrames = n; window.__bwParticles = P;
  } finally { BW.loading = false; }
}
async function selectBW(spot) {                         // make the slice of this spot the one that is drawn (shared meshes, per-spot buffers)
  const v = bwVariantOf(spot), key = spot + (v ? '|' + v.key : '');
  if (BW.data && BW.data.key === key) return;
  await loadBW(spot);
  const D = BW.byspot[key]; if (!D || BW.data === D) return; if (!D || !cur || cur.cfg.spot !== spot) return;
  fwMesh.visible = !!D.fw; bwPts.visible = bwSurf.visible = bwBed.visible = !D.fw;
  if (D.fw) {
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', D.pos); geo.setAttribute('color', D.col); geo.setIndex(D.index);
    fwMesh.geometry.dispose(); fwMesh.geometry = geo;
    bwLabel.textContent = D.labelText; document.getElementById('bw-note').textContent = D.note;
    BW.data = D; BW.t = 0; return;
  }
  bwBed.geometry.setFromPoints(D.bed); bwMat.uniforms.uVmax.value = D.vmax;
  bwPts.geometry.setAttribute('position', D.pos); bwPts.geometry.setAttribute('aV', D.aV); bwSurf.geometry.setAttribute('position', D.surf);
  bwLabel.textContent = D.labelText; document.getElementById('bw-note').textContent = D.note;
  BW.data = D; BW.t = 0;
}
function updateBW(now) {
  const dt = BW.last === null ? 0 : Math.min((now - BW.last) / 1000, 0.25);
  BW.last = now;
  const show = BW.on && !!BW.data && !!cur && !!cur.cfg.spot && BW.data.spot === cur.cfg.spot;
  bwGroup.visible = show;
  if (!show || !BW.data.fw) fwTag.style.display = 'none';
  document.getElementById('fw-exag-row').style.display = show && BW.data.fw ? '' : 'none';
  if (!show) { bwLabel.style.display = 'none'; return; }
  const D = BW.data, exag = material.uniforms.uExag.value;
  bwGroup.scale.y = exag;                               // same vertical stretch as the reef cloud
  bwMat.uniforms.uSize.value = material.uniforms.uSize.value * 0.8; bwMat.uniforms.uScale.value = material.uniforms.uScale.value;
  BW.t += dt * SWELL.speed;                              // real time, or x4 with the swell's speed box
  if (D.fw) {                                            // FUNWAVE layer: periodic loop, so blend across the seam too
    const kE = FW.exag / exag;                           // the group is stretched by the depth stretch; this makes the wave exactly FW.exag
    const f = (BW.t / D.dt) % D.n, i = Math.floor(f), a = f - i, i2 = (i + 1) % D.n;
    const pp = D.pos.array, pc = D.col.array, pf = D.aF.array, E0 = D.E[i], E1 = D.E[i2], F0 = D.F[i], F1 = D.F[i2];
    for (let k = 0; k < D.P; k++) {
      const e0 = E0[k], e1 = E1[k];
      if (isNaN(e0) || isNaN(e1)) { pf[k] = -1; continue; }
      const e = e0 + (e1 - e0) * a, fo = Math.min(1, Math.max(0, (F0[k] + (F1[k] - F0[k]) * a - 0.35) / 0.25));   // breaking (and just broken) = opaque white
      pp[3 * k] = D.X[k]; pp[3 * k + 1] = D.tide + e * kE; pp[3 * k + 2] = D.Zc[k]; pf[k] = fo;
      const c = Math.pow(Math.min(1, Math.max(0, (e + 0.5) / 1.5)), 1.3);   // trough (navy) -> crest (bright cyan)
      const r = 0.01 + 0.20 * c, g = 0.04 + 0.70 * c, b = 0.10 + 0.70 * c;   // linear colour (the renderer outputs sRGB)
      pc[3 * k] = r + (1.9 - r) * fo; pc[3 * k + 1] = g + (1.9 - g) * fo; pc[3 * k + 2] = b + (1.9 - b) * fo;   // >1: stays white under the dim lights
    }
    const T = D.tri, ix = D.index.array; let m = 0;
    for (let t = 0; t < T.length; t += 3) { const p = T[t], q = T[t + 1], r = T[t + 2]; if (pf[p] < 0 || pf[q] < 0 || pf[r] < 0) continue; ix[m++] = p; ix[m++] = q; ix[m++] = r; }
    fwMesh.geometry.setDrawRange(0, m); D.index.needsUpdate = true;
    D.pos.needsUpdate = true; D.col.needsUpdate = true; fwMesh.geometry.computeVertexNormals();
    fwTag.textContent = `FUNWAVE 2DH model: heights exaggerated \u00d7${FW.exag}; white = breaking; illustrative, not a forecast`;
    fwTag.style.display = '';
    placeLabel(bwLabel, D.labelX, D.tide * exag + 25, D.labelZ);
    return;
  }
  const f = (BW.t / D.dt) % D.n, i = Math.floor(f), a = f - i, i2 = i + 1 < D.n ? i + 1 : i;   // no blend across the loop seam
  const pp = bwPts.geometry.attributes.position.array, pv = bwPts.geometry.attributes.aV.array;
  for (let j = 0; j < D.P; j++) {
    const s = D.S[i][j] + (D.S[i2][j] - D.S[i][j]) * a;
    pp[3 * j] = D.hx + s * D.ux; pp[3 * j + 1] = D.Z[i][j] + (D.Z[i2][j] - D.Z[i][j]) * a; pp[3 * j + 2] = -(D.hy + s * D.uy);
    pv[j] = D.V[i][j] + (D.V[i2][j] - D.V[i][j]) * a;
  }
  bwPts.geometry.attributes.position.needsUpdate = true; bwPts.geometry.attributes.aV.needsUpdate = true;
  const sp = bwSurf.geometry.attributes.position.array, y = j => { const p = D.F[i][j], q = D.F[i2][j]; return isNaN(p) ? q : isNaN(q) ? p : p + (q - p) * a; };
  let k = 0;
  for (let j = 0; j + 1 < D.ns; j++) {                  // segments between neighbouring wet surface points; dry gaps are skipped
    const y0 = y(j), y1 = y(j + 1); if (isNaN(y0) || isNaN(y1)) continue;
    sp.set([D.sx(j), y0, D.sz(j), D.sx(j + 1), y1, D.sz(j + 1)], 6 * k++);
  }
  bwSurf.geometry.setDrawRange(0, 2 * k); bwSurf.geometry.attributes.position.needsUpdate = true;
  placeLabel(bwLabel, D.labelX, D.tide * exag + 25, D.labelZ);
}
document.getElementById('bw-on').addEventListener('change', async e => {
  BW.on = e.target.checked;
  document.getElementById('bw-note').style.display = BW.on ? '' : 'none';
  if (BW.on && cur && cur.cfg.spot) await selectBW(cur.cfg.spot);
});
// Variant toggle (Porto Batel): typical wave (s8, default), upper bound (s7) or the whole-reef 2DH model (FUNWAVE). All labelled illustrative, not a forecast. Both stay labelled illustrative, not a forecast.
{
  const row = document.getElementById('bw-variant');
  if (row && BW_VARIANTS.porto_batel) {
    BW_VARIANTS.porto_batel.forEach((v, i) => {
      const lb = document.createElement('label'); lb.style.marginRight = '10px';
      const r = document.createElement('input'); r.type = 'radio'; r.name = 'bw-var'; r.value = v.key; r.checked = i === 0;
      r.addEventListener('change', async () => { BW.variant.porto_batel = v.key; if (BW.on && cur && cur.cfg.spot === 'porto_batel') await selectBW('porto_batel'); });
      lb.append(r, ' ' + v.label); row.appendChild(lb);
    });
  }
}

// ---------- 6d. Reef layer: observer marks, 17 Sep 2026 ----------
// Observer marks (Google Earth): where the observer sat (= the take-off zone, rock contact observed here) and the
// filming position. 2026-11-14: the separate rock-contact pin (39.3192267, -9.3562366, on the dry shelf) was
// removed; the observer places the contact in the take-off zone, and the footage puts the take-off at the outer
// break about 115 m (90-145 m) from the camera, matching this mark.
// Orange diamonds at sea level (distinct from the green shift+click marks and the cyan spot names).
const SKETCH_COL = 0xff9f43;
const SKETCH = [
  // Moved 2026-11-12 from 39.3191039, -9.3565475 (placed on a high-tide image,
  // on the shelf). New point: 50 m past the keyhole line's end toward 223 deg.
  { name: 'take-off zone, where the observer sat; rock contact here (observed)', lat: 39.318870, lon: -9.356829,
    note: 'lidar cell: 0.5 m above LAT, 1.6 m of water at tide 2.1 m; shelf (2.0 m) starts about 10 m inshore' },
  { name: 'filming position (13 m above water)', lat: 39.319506, lon: -9.355772 },
];
// Lines traced by eye from an observer's Google Earth screenshot on 2026-11-12 (about +-5 m); points are [lat, lon], land to sea.
const SKETCH_LINES = [
  { name: 'Keyhole + paddle-out (traced from photo, about \u00b15 m)', col: 0xff4d2e, pts: [
    [39.3194893, -9.3560076], [39.3194569, -9.3562320], [39.3193850, -9.3563331], [39.3193247, -9.3564412],
    [39.3192771, -9.3564842], [39.3192294, -9.3564412], [39.3191988, -9.3564330] ] },
];
const KEYHOLE_WIDTH_M = 9;           // estimated from the observer's photo
const KEYHOLE_COL = 0x2ad4c4;
const keyhole = {};                  // { ribbon, dash, el, mid }: built in buildSketch()
const sketchTide = () => (SWELL.data && SWELL.data.tide != null) ? SWELL.data.tide : 2.1;
const sketchGroup = new THREE.Group(); sketchGroup.visible = false; scene.add(sketchGroup);
let sketchBuilt = false;
function buildSketch() {                              // inverse of toLatLon(): same flat-earth scaling as export_reefs.py
  const o = cur.meta.origin, M = 111195.0, mat = new THREE.MeshBasicMaterial({ color: SKETCH_COL, depthTest: false, transparent: true });
  SKETCH.forEach(s => {
    s.x = (s.lon - o.lon) * M * Math.cos(o.lat * Math.PI / 180); s.z = -(s.lat - o.lat) * M;
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(9), mat); m.renderOrder = 11; s.mesh = m; sketchGroup.add(m);
    s.house = /filming/.test(s.name);                    // the filming position stays on the cliff top at the old fixed height
    let txt = 'observer marks (one surfer, 17 Sep 2026)\n' + s.name + (s.note && s.house ? '\n' + s.note : '');
    if (!s.house) {                                    // pin sits on the lidar bed (nearest cell); stick from bed to the water surface
      const reef = cache[Object.keys(LAYERS).find(k => LAYERS[k].portugal)];
      let best = 1e18, bi = -1;
      for (let i = 0; i < reef.N; i++) { const dx = reef.pos[3 * i] - s.x, dz = reef.pos[3 * i + 2] - s.z, d = dx * dx + dz * dz; if (d < best && isFinite(reef.depth[i])) { best = d; bi = i; } }
      s.bed = bi >= 0 && best < 30 * 30 ? -reef.depth[bi] : 2.1;           // bed height above LAT (m); falls back to the tide if no cell within 30 m
      const wd = 2.1 - s.bed;
      s.stick = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.2, 1, 6).translate(0, 0.5, 0), mat); s.stick.renderOrder = 11; sketchGroup.add(s.stick);
      txt += `\nlidar bed ${s.bed.toFixed(1)} m above LAT; ` + (wd > 0 ? `${wd.toFixed(1)} m of water at tide 2.1 m` : `dry, ${(-wd).toFixed(1)} m above the water at tide 2.1 m`);
    }
    s.el = document.createElement('div'); s.el.className = 'tag'; s.el.textContent = txt; s.el.style.whiteSpace = 'pre'; s.el.style.color = '#ff9f43';
    s.el.style.fontSize = '11px'; s.el.style.display = 'none'; document.body.appendChild(s.el);
  });
  SKETCH_LINES.forEach(l => {                         // same conversion; built flat at y=0, lifted per frame in placeSketch
    l.xz = l.pts.map(q => [(q[1] - o.lon) * M * Math.cos(o.lat * Math.PI / 180), -(q[0] - o.lat) * M]);
    const path = new THREE.CurvePath();
    for (let i = 1; i < l.xz.length; i++) path.add(new THREE.LineCurve3(new THREE.Vector3(l.xz[i - 1][0], 0, l.xz[i - 1][1]), new THREE.Vector3(l.xz[i][0], 0, l.xz[i][1])));
    l.mesh = new THREE.Mesh(new THREE.TubeGeometry(path, 96, 1.5, 6, false), new THREE.MeshBasicMaterial({ color: l.col, depthTest: false, transparent: true }));
    l.mesh.renderOrder = 11; sketchGroup.add(l.mesh);
  });
  { // keyhole channel: flat ribbon over SKETCH_LINES[0] points 1..end, then a dashed "paddled on" line to the last SKETCH pin
    const P = SKETCH_LINES[0].xz.slice(1), w = KEYHOLE_WIDTH_M / 2, V = [], I = [];
    const dirs = P.map((q, i) => { const a = P[Math.max(i - 1, 0)], b = P[Math.min(i + 1, P.length - 1)];
      const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; });
    P.forEach((q, i) => { const [dx, dz] = dirs[i]; V.push(q[0] - dz * w, 0, q[1] + dx * w, q[0] + dz * w, 0, q[1] - dx * w);
      if (i) { const k = 2 * i; I.push(k - 2, k - 1, k, k - 1, k + 1, k); } });
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(V, 3)); rg.setIndex(I);
    keyhole.ribbon = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: KEYHOLE_COL, transparent: true, opacity: 0.5, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
    keyhole.ribbon.renderOrder = 10; sketchGroup.add(keyhole.ribbon);
    const e = P[P.length - 1], far = SKETCH[0];     // the 'where I sat' pin, by position in SKETCH
    const dg = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(e[0], 0, e[1]), new THREE.Vector3(far.x, 0, far.z)]);
    keyhole.dash = new THREE.Line(dg, new THREE.LineDashedMaterial({ color: KEYHOLE_COL, dashSize: 6, gapSize: 6, depthTest: false, transparent: true }));
    keyhole.dash.computeLineDistances(); keyhole.dash.renderOrder = 10; sketchGroup.add(keyhole.dash);
    keyhole.mid = P[P.length >> 1];
    keyhole.el = document.createElement('div'); keyhole.el.className = 'tag'; keyhole.el.style.color = '#2ad4c4'; keyhole.el.style.fontSize = '11px';
    keyhole.el.textContent = "keyhole channel (from observer's photo; not in the lidar, depth unknown)"; keyhole.el.style.display = 'none'; document.body.appendChild(keyhole.el);
  }
  sketchBuilt = true;
}
function placeSketch(show) {                          // every frame: sit at the tide level, follow the vertical stretch
  if (show && !sketchBuilt) buildSketch();
  sketchGroup.visible = show;
  SKETCH.forEach((s, i) => {
    if (!s.el) return;
    if (!show) { s.el.style.display = 'none'; return; }
    const ex = material.uniforms.uExag.value, yw = 2.1 * ex;   // water surface: tide 2.10 m above LAT on 17 Sep 18:00
    let y = yw;
    if (s.stick) {                                     // on the bed, stick up/down to the water surface
      y = Math.max(-1e9, (s.bed) * ex);
      s.stick.position.set(s.x, Math.min(y, yw), s.z); s.stick.scale.y = Math.max(Math.abs(yw - y), 0.01);
    }
    s.mesh.position.set(s.x, y, s.z);
    const near = BEACH.active && Math.hypot(s.x - camera.position.x, s.z - camera.position.z) < 80;   // beach view: a pin you are standing on would fill the screen
    s.mesh.visible = !near; if (s.stick) s.stick.visible = !near;
    s.mesh.scale.setScalar(BEACH.active ? 0.3 : 1);                   // beach view: smaller pins (they are sized to read from above)
    if (near) { s.el.style.display = 'none'; return; }
    placeLabel(s.el, s.x, Math.max(y, yw) + 25 + 22 * i, s.z);       // labels stacked a little so they do not overlap
  });
  SKETCH_LINES.forEach(l => {                          // at the water surface (no text label: the channel label covers it)
    if (!l.mesh) return;
    l.mesh.position.y = 2.1 * material.uniforms.uExag.value;
    l.mesh.visible = !BEACH.active;                    // beach view: the traced paddle-out tube lies right below the cliff and reads as a slab
  });
  if (keyhole.el) {                                    // channel: tide level (loaded swell tide if present), a hair above the awash points
    if (!show) keyhole.el.style.display = 'none';
    else {
      const y = sketchTide() * material.uniforms.uExag.value;
      keyhole.ribbon.position.y = y; keyhole.dash.position.y = y;
      keyhole.ribbon.visible = keyhole.dash.visible = !BEACH.active;   // beach view: the flat channel ribbon reads as a slab from eye height
      if (BEACH.active) keyhole.el.style.display = 'none'; else placeLabel(keyhole.el, keyhole.mid[0], y + 25, keyhole.mid[1]);
    }
  }
}

// PLUMBING: keep the left panel clear of the source caption. The caption's height changes with pane width, so the CSS
// max-height of #panel reads the variable --cap-h, which is refreshed whenever the caption is resized.
const capBox = document.getElementById('caption');
const setCapH = () => document.documentElement.style.setProperty('--cap-h', capBox.offsetHeight + 'px');
setCapH(); new ResizeObserver(setCapH).observe(capBox); new MutationObserver(setCapH).observe(capBox, { childList: true, subtree: true, characterData: true });
addEventListener('resize', () => { setCapH(); setCredH(); setStandH(); });   // also when the pane is hidden and observers sleep
const credBox = document.getElementById('credits');   // the caption sits on top of the credits block (style.css uses --cred-h)
const setCredH = () => document.documentElement.style.setProperty('--cred-h', credBox.offsetHeight + 'px');
setCredH(); new ResizeObserver(setCredH).observe(credBox);
const standBox = document.getElementById('standing');   // the standing notice; on phones it sits above the credits (style.css uses --stand-h)
const setStandH = () => document.documentElement.style.setProperty('--stand-h', standBox.offsetHeight + 'px');
setStandH(); new ResizeObserver(setStandH).observe(standBox);

// ---------- 6d. Back to the globe: zooming out past the reef patch continues onto the whole-Earth globe ----------
// Reef layers only. Once the camera is more than EXIT.start (scaled to the patch) from the middle of the lidar box
// the view fades to black; at EXIT.end it opens the globe (pieces/07-globe) with ?from=<spot>&at=lat,lon&d=&h=&p=,
// and the globe arrives low over the same spot, facing the same way, and eases out (the mirror of the fly-in).
// Coming back with the browser's Back button resets the camera to the layer's overview (no bounce back out).
const EXIT = { gone: false, fade: 0 };
const fadeEl = document.getElementById('globe-fade'), fadeHint = document.getElementById('globe-fade-hint');
const GLOBE_URL = '../../07-globe/index.html';
function exitRange() {                             // [start, end] distances (m) from the box middle, per layer, cached
  if (cur.exitR) return cur.exitR;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < cur.N; i++) { const x = cur.pos[3 * i], z = cur.pos[3 * i + 2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
  const half = Math.hypot(x1 - x0, z1 - z0) / 2, start = Math.max(9000, 2 * half + 6000);   // well past the far view and the 5 km surround
  return (cur.exitR = { cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, start, end: start * 1.6 });
}
function globeHref() {                             // the globe, arriving over this layer's spot as the camera sees it now
  const L = cur && cur.cfg, o = cur && cur.meta && cur.meta.origin;
  if (!L || !o || !L.reef) return GLOBE_URL;
  const r = exitRange(), ll = toLatLon(r.cx, r.cz);
  camera.getWorldDirection(flyDir);
  const dx = camera.position.x - r.cx, dz = camera.position.z - r.cz, dy = Math.max(1, camera.position.y);
  const d = Math.hypot(dx, dy, dz), tilt = Math.atan2(Math.hypot(dx, dz), dy) * 180 / Math.PI;   // angle from straight down
  const head = ((Math.atan2(flyDir.x, -flyDir.z) * 180 / Math.PI) + 360) % 360;                 // compass: 0 north, 90 east
  const q = new URLSearchParams({ from: L.spot || '', at: ll.lat.toFixed(5) + ',' + ll.lon.toFixed(5), d: Math.round(d), h: Math.round(head), p: Math.round(tilt) });
  return GLOBE_URL + '?' + q.toString();
}
function goToGlobe() { if (EXIT.gone) return; EXIT.gone = true; fadeEl.style.opacity = 1; location.href = globeHref(); }
document.getElementById('to-globe').addEventListener('click', () => {   // button: pull out to the exit distance, then go
  if (!cur || !cur.cfg.reef) { location.href = GLOBE_URL; return; }
  const r = exitRange(), dir = flyTmp.set(camera.position.x - r.cx, 0, camera.position.z - r.cz);
  if (dir.lengthSq() < 1) dir.set(0, 0, 1); dir.normalize();
  setBeachActive(false);
  flyTo({ pos: v3(r.cx + dir.x * r.end * 0.75, r.end * 0.66, r.cz + dir.z * r.end * 0.75), target: v3(r.cx, 0, r.cz) });
  EXIT.button = performance.now();
});
function stepExit(now) {                           // every frame, reef layers: cheap distance test and the fade
  if (EXIT.gone || !cur || !cur.cfg.reef) { if (!EXIT.gone && EXIT.fade) { EXIT.fade = 0; fadeEl.style.opacity = 0; } return; }
  if (arriveFade(now)) return;                     // arriving from the globe: the fade runs on time, not distance (section 6e)
  const r = exitRange(), d = Math.max(Math.hypot(camera.position.x - r.cx, camera.position.y, camera.position.z - r.cz), ZB.d || 0);   // ZB.d: zoom distance (to the point the view centre looks at)
  // UX 2026-11-23 (first-visitor feedback: "it jumped me to all kinds of screens"): zooming out no longer fades into the
  // globe by itself; the zoom stops at EXIT.start with a line pointing at the Back to globe button, which is the only way out.
  void d; let f = 0;
  if (EXIT.button) { f = Math.max(f, smooth01(0, 1600, now - EXIT.button)); if (now - EXIT.button > 1600) { goToGlobe(); return; } }
  if (Math.abs(f - EXIT.fade) > 0.002) {
    EXIT.fade = f; fadeEl.style.opacity = f.toFixed(3);
    fadeHint.style.opacity = EXIT.button ? 0 : Math.min(1, f * 3).toFixed(2);
  }
}
addEventListener('pageshow', e => {                // back from the globe (page restored from the cache): start over at the overview
  if (!e.persisted || !EXIT.gone) return;
  EXIT.gone = false; EXIT.button = 0; EXIT.fade = 0; fadeEl.style.opacity = 0; fadeHint.style.opacity = 0;
  fly = null;
  if (cur) { camera.position.copy(cur.cfg.views.far.pos); controls.target.copy(cur.cfg.views.far.target); camera.lookAt(controls.target); FLY.jump = true; FLY.wheel.set(0, 0, 0); FLY.vel.set(0, 0, 0); }
});

// ---------- 6e. Zoom bar: the globe's zoom control, and the arrival from the globe ----------
// Reef layers only. The bar sits where the globe's does and works the same way: a log slider (top = closest, bottom =
// "Earth"), +/- buttons, arrow keys on the focused slider, and an eased wheel/trackpad/pinch zoom toward the pointer.
// Zoom distance ZB.d = camera to the sea-level point the view centre looks at; zooming scales the camera about that
// point (or about the sea-level point under the pointer), so the heading and tilt never change. Inner end: where one
// lidar cell would span ZB_CELL_PX on screen (closer only makes the dots bigger, it shows no more detail). Outer end:
// EXIT.start, where the fade to the globe begins; pushing on past it (wheel, - button, slider held at the bottom, arrow
// down) runs into the hand-off of 6d. Anything else that moves the camera (presets, keys, flights) just moves the slider.
const ZB = { target: 0, d: 0, active: false, cursor: null, held: false, last: 0, noteUntil: 0 };
const zbBar = document.getElementById('zoom'), zbSlider = document.getElementById('zoom-slider'), zbNote = document.getElementById('zoom-note');
const ZB_MAX = 1000, ZB_CELL_PX = 48;
function lidarCellM() {                            // grid cell of the layer (m), the larger side, from its resolution text
  if (cur.cellM) return cur.cellM;
  const t = String(cur.meta.resolution || '').split('(')[0], m = [...t.matchAll(/(\d+(?:\.\d+)?)\s*m\b/g)].map(x => +x[1]);
  return (cur.cellM = m.length ? Math.max(...m) : 10);
}
const zoomMin = () => lidarCellM() * innerHeight / (2 * Math.tan(camera.fov / 2 * Math.PI / 180)) / ZB_CELL_PX;
const zoomMax = () => exitRange().start;
const zbF = new THREE.Vector3(), zbP = new THREE.Vector3();
function zoomFocus(out, nx = 0, ny = 0) {          // sea-level point on the ray through (nx, ny) in NDC; a near point if the ray misses
  out.set(nx, ny, 0.5).unproject(camera).sub(camera.position).normalize();
  const t = out.y < -0.02 && camera.position.y > 0 ? camera.position.y / -out.y : NaN;
  return out.multiplyScalar(Number.isFinite(t) ? Math.min(t, exitRange().end * 2) : Math.max(150, 2 * Math.abs(camera.position.y))).add(camera.position);
}
const sliderFromD = d => Math.round(ZB_MAX * Math.max(0, Math.min(1, Math.log(zoomMax() / d) / Math.log(zoomMax() / zoomMin()))));
const dFromSlider = v => zoomMax() * Math.exp(-v / ZB_MAX * Math.log(zoomMax() / zoomMin()));
function showZoomNote() {
  zbNote.textContent = `As close as the data goes: the survey here has one depth point every ~${Math.round(lidarCellM())} m, so closer would only make the dots bigger.`;
  ZB.noteUntil = performance.now() + 3500;
}
function showOutNote() {                           // UX 2026-11-23: the far end says how to leave instead of leaving
  zbNote.textContent = 'As far out as this spot goes. Tap \u2190 Back to globe (top left) for the whole Earth.';
  ZB.noteUntil = performance.now() + 3500;
}
function zoomSet(t, cursor = null) {               // every zoom input ends here: new eased target distance
  if (!cur || !cur.cfg.reef || EXIT.gone) return;
  const lo = Math.min(zoomMin(), ZB.d || Infinity), hi = Math.max(zoomMax(), ZB.d || 0);   // UX 2026-11-23: out to EXIT.start only
  if (t <= zoomMin() * 1.001) showZoomNote();
  else if (t >= zoomMax() * 0.999) showOutNote();
  ZB.target = Math.max(lo, Math.min(hi, t)); ZB.active = true; ZB.cursor = cursor; fly = null;
}
const zbBase = () => (ZB.active ? ZB.target : ZB.d);
function zoomWheel(e) {                            // same feel as the globe: pixels normalised, a pinch (ctrlKey) is stronger
  const px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1), k = e.ctrlKey ? 0.01 : 0.002;
  zoomSet(zbBase() * Math.exp(Math.max(-1, Math.min(1, px * k))), [e.clientX / innerWidth * 2 - 1, 1 - e.clientY / innerHeight * 2]);
}
const zoomOutStep = () => { const b = zbBase(); zoomSet(b >= zoomMax() * 0.98 ? zoomMax() : dFromSlider(sliderFromD(b) - 80)); };
document.getElementById('zb-in').onclick = () => zoomSet(dFromSlider(sliderFromD(zbBase()) + 80));
document.getElementById('zb-out').onclick = zoomOutStep;
zbSlider.addEventListener('input', () => zoomSet(dFromSlider(+zbSlider.value)));
zbSlider.addEventListener('pointerdown', () => { ZB.held = true; });
addEventListener('pointerup', () => { ZB.held = false; });
zbSlider.addEventListener('keydown', e => {        // at the ends the slider itself cannot move: carry on out to the globe, or say why it stops
  const up = ['ArrowUp', 'ArrowRight', 'PageUp', 'End'].includes(e.key), down = ['ArrowDown', 'ArrowLeft', 'PageDown', 'Home'].includes(e.key);
  if (down && +zbSlider.value <= 0) { e.preventDefault(); zoomOutStep(); }
  else if (up && +zbSlider.value >= ZB_MAX) { e.preventDefault(); showZoomNote(); }
});
addEventListener('pointermove', e => {             // faint until the pointer comes near it, as on the globe
  const b = zbBar.getBoundingClientRect(), dx = Math.max(b.left - e.clientX, 0, e.clientX - b.right), dy = Math.max(b.top - e.clientY, 0, e.clientY - b.bottom);
  zbBar.classList.toggle('faded', Math.hypot(dx, dy) > 110 && !zbBar.contains(document.activeElement));
});
zbBar.classList.add('faded');
zbBar.addEventListener('focusin', () => zbBar.classList.remove('faded'));
function zoomFrame(now) {
  const dt = ZB.last ? Math.min(0.1, (now - ZB.last) / 1000) : 0; ZB.last = now;
  const on = !!(cur && cur.cfg.reef) && !EXIT.gone;
  if (zbBar.hidden === on) zbBar.hidden = !on;
  if (!on) { ZB.d = 0; ZB.active = false; zbNote.hidden = true; return; }
  if (ARRIVE.pending && cur.cfg === LAYERS[ARRIVE.pending.layer]) startArrival();
  ZB.d = camera.position.distanceTo(zoomFocus(zbF));
  if (fly) ZB.active = false;
  if (ZB.held && !fly) {
    if (+zbSlider.value <= 0) zoomSet(Math.max(zbBase(), zoomMax()) * Math.exp(dt * 1.2));   // held at the Earth end: keep going out
    else if (+zbSlider.value >= ZB_MAX) showZoomNote();
  }
  if (ZB.active) {
    const g = Math.log(ZB.target / ZB.d);
    if (Math.abs(g) < 2e-3) { ZB.active = false; ZB.cursor = null; }
    else {
      const k = Math.exp(Math.max(-0.25, Math.min(0.25, g * Math.min(1, dt * 10))));   // eased, at most x1.28 per frame (the globe's rate)
      const c = ZB.cursor ? zoomFocus(zbP, ZB.cursor[0], ZB.cursor[1]) : zbF;
      camera.position.sub(c).multiplyScalar(k).add(c);
      if (camMode !== 'fly') controls.target.sub(c).multiplyScalar(k).add(c);
      ZB.d *= k;
    }
  }
  const v = sliderFromD(zbBase()), gap = Math.abs(v - +zbSlider.value);
  if (!ZB.held && (document.activeElement !== zbSlider ? gap > 12 : gap > 40)) zbSlider.value = v;
  const noteOn = now < ZB.noteUntil;
  if (zbNote.hidden === noteOn) zbNote.hidden = !noteOn;
}
// Arrival from the globe (?layer=<label>&from=globe&d=<m>&h=<deg>&p=<deg>, sent when you zoom in past the globe's closest
// zoom over this spot, or click it): the camera starts at the globe's distance (kept within the outer range) over the
// middle of the lidar box, facing the same compass heading with the same tilt from straight down, and eases in to the
// layer's overview while the black fades on time (the globe already faded out). The mirror of 6d.
const ARRIVE = { pending: null, fly: null, t0: 0 };
function startArrival() {
  const a = ARRIVE.pending; ARRIVE.pending = null;
  const r = exitRange(), far = cur.cfg.views.far, c = v3(r.cx, 0, r.cz);
  const D1 = far.pos.distanceTo(far.target), D0 = Math.min(r.end * 0.97, Math.max(D1 * 1.5, a.d || r.end));
  const h = a.h * Math.PI / 180, p = Math.min(85, Math.max(0, a.p)) * Math.PI / 180;
  const u1 = far.pos.clone().sub(far.target).normalize();
  const h1 = Math.atan2(-u1.x, u1.z), p1 = Math.acos(Math.min(1, u1.y)), dh = Math.atan2(Math.sin(h1 - h), Math.cos(h1 - h));   // the overview's heading/tilt; shortest turn
  const g = new THREE.Vector3(), u = new THREE.Vector3();
  if (BEACH.active) setBeachActive(false);
  ARRIVE.fly = fly = { t0: performance.now(), dur: 3000, ease: k => 1 - Math.pow(1 - k, 3),   // ease-out: the zoom carries on at speed, then settles
    path: e => {
      const w = e * e * (3 - 2 * e), hh = h + dh * w, pp = p + (p1 - p) * w;   // heading and tilt turn as angles (no swing through straight down), gently at first
      g.lerpVectors(c, far.target, e); u.set(-Math.sin(hh) * Math.sin(pp), Math.cos(pp), Math.cos(hh) * Math.sin(pp));
      camera.position.copy(g).addScaledVector(u, Math.exp(Math.log(D0) + (Math.log(D1) - Math.log(D0)) * e)); controls.target.copy(g);
    } };
  fly.path(0); camera.lookAt(controls.target);
  ARRIVE.t0 = ARRIVE.began = performance.now();   // began: ms since this page started loading (how long the screen stayed dark)
}
function arriveFade(now) {                         // from stepExit: true while the arrival owns the fade
  if (!ARRIVE.t0 && !ARRIVE.pending) return false;
  if (ARRIVE.pending) { fadeEl.style.opacity = 1; return true; }   // still loading the layer: stay dark
  const f = 1 - smooth01(100, 1000, now - ARRIVE.t0);
  EXIT.fade = f; fadeEl.style.opacity = f.toFixed(3); fadeHint.style.opacity = 0;
  if (fly !== ARRIVE.fly) { ARRIVE.t0 = 0; ARRIVE.fly = null; return false; }   // arrived, or the user took over
  return true;
}

// Reef labels: at an oblique view several can land on one spot and pile up. Placed in priority order (spot names,
// channel, sketch pins, your marks); a label whose box would overlap one already placed is hidden for that frame.
const tagBoxes = [];
function declutterTags(els) {
  tagBoxes.length = 0;
  for (const el of els) tagFree(el);
}
function tagFree(el) {                             // also used by live.js for its own label, after this frame's labels
  {
    if (!el || el.style.display === 'none') return;
    if (!el._wh || !el._wh[0]) el._wh = [el.offsetWidth, el.offsetHeight];   // fixed text: measured once
    const [w, h] = el._wh, x0 = parseFloat(el.style.left) + 8, y0 = parseFloat(el.style.top) - h / 2, x1 = x0 + w, y1 = y0 + h;   // CSS: translate(8px, -50%)
    if (tagBoxes.some(b => x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1])) { el.style.display = 'none'; return; }
    tagBoxes.push([x0, y0, x1, y1]);
  }
}

// ---------- 7. Loop ----------
let frame = 0;
function animate(now) {
  requestAnimationFrame(animate);
  drawFrame(now);
}
function drawFrame(now) {                          // one frame (also the debug hook __viewer.tick, for stepping a hidden tab)
  stepFly(now);
  if (camMode === 'fly') stepFree(now); else controls.update();
  zoomFrame(now);
  updateSwell(now);
  updateBW(now);
  if (frame++ % 3 === 0) pick();                   // picking is the costly part, so not every frame
  if (cur && cur.cfg.reef) {                       // reef layer: no Klitmoller labels, show the two spot labels instead
    labelShore.style.display = 'none'; labelVillage.style.display = 'none';
    cur.spotTags.forEach(t => placeLabel(t.el, t.x, 40, t.z));
    placeMarks(true); placeSketch(!!cur.cfg.portugal);
    declutterTags([...cur.spotTags.map(t => t.el), keyhole.el, bwLabel, ...SKETCH.map(s => s.el), ...marks.map(m => markVis.get(m).el)]);
    stepExit(now);
    renderer.render(scene, camera); return;
  }
  placeMarks(false); placeSketch(false);
  placeLabel(labelShore, 0, 400 * (cur ? cur.cfg.mark : 1), 0);
  if (cur && cur.cfg.wide) labelVillage.style.display = 'none'; else placeLabel(labelVillage, villageX, 0, 0);
  if (cur && cur.cfg.wide) cur.lineTags.forEach(t => placeLabel(t.el, t.x, 0, t.z));   // line labels, wide layer only
  stepExit(now);
  renderer.render(scene, camera);
}
// ?layer=<exact LAYERS label> opens that layer first (used by the globe front page, pieces/07-globe); otherwise the first layer.
const wantLayer = new URLSearchParams(location.search).get('layer');
{ // arriving from the globe (6e): note the heading/tilt/distance, go dark until the layer is in, and drop the parameters
  // from the address at once so a reload or Back never replays the arrival
  const q = new URLSearchParams(location.search);
  if (q.get('from') === 'globe' && wantLayer && LAYERS[wantLayer] && LAYERS[wantLayer].reef) {
    const num = (k, def) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) ? v : def; };
    ARRIVE.pending = { layer: wantLayer, h: num('h', 0), p: num('p', 45), d: num('d', 0) };
    fadeEl.style.opacity = 1;
  }
  if (q.has('from')) { ['from', 'd', 'h', 'p'].forEach(k => q.delete(k)); history.replaceState(history.state, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash); }
}
([...layerBox.children].find(b => b.textContent === wantLayer) || layerBox.firstChild).click();
if (wantLayer && LAYERS[wantLayer] && LAYERS[wantLayer].reef) {   // came from the globe to a reef spot: the first-visit intro names that spot, not the North Sea
  const intro = document.getElementById('intro'), L = LAYERS[wantLayer];
  intro.querySelector('h2').textContent = L.title;
  intro.querySelector('p').textContent = `The sea floor at ${L.title} from lidar, as a 3D point cloud, set in its coast from coarse global terrain tiles (the dimmer dots). ` +
    'Fly in to see the reef up close; the Back to globe button takes you back to the whole Earth.';
}
requestAnimationFrame(animate);
// Debug hook (lets the browser console inspect the scene and test hover; harmless to leave in).
window.__viewer = { ZB, ARRIVE, zoomSet, zoomMin, zoomMax, exitRange, get fly() { return fly; }, DATA_VERSION, LAYERS, tagFree, tick: drawFrame, renderer, BEACH, beachView, flySpot, setViewMode, bedHeightAt, marks, camera, scene, controls, material, canvas, pick, get cur() { return cur; }, showLayer, SWELL, swellCloud, loadSwell, buildSwell };   // loadSwell/buildSwell: hooks for play.js
