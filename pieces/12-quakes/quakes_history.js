// Earthquake history layer for the Oceany globe: every M5+ earthquake in the USGS ComCat catalogue since 1970, as faint dots.
// Data: USGS ComCat (public domain), built by build_history.py into data/quakes_m5.bin + .json; see SOURCES.md.
//
//   const layer = await createLayer({ THREE, radius: 1, makeDotMaterial, palette });
//   layer.update(t)           follows the globe's palette (four uniform writes when it changes)
//   layer.label / .details    what the dots are
//   layer.setDim(k)           0..1 brightness (the globe dims this while the live tornado layer is on)
//   layer.userData.setYear(y) limit to quakes up to year y (draw range; geometry is never rebuilt)
//
// What is data: each dot is one catalogued earthquake of magnitude 5.0 or more: its epicentre (the point on the surface
// above where the rupture started), its magnitude (dot size) and its hypocentre depth (colour). Nothing is drawn where
// no quake was recorded, so the dots trace the plate edges on their own: no plate-boundary lines are drawn.
// Limits: the catalogue is less complete before the global network grew (1970s), and depth is often fixed at 10 or 33 km
// by the location method when it is poorly known. Dots sit on the surface; depth is shown by colour only.

import { LIFT, toXYZ, DEPTH_GLSL, DOT_FRAG, depthUniforms, setDepthUniforms, paletteName, borrowScale } from './quakes_common.js';

const DOT_SIZE = 0.0030;     // world units at M5 (the Earth's dots are 0.0058)
const ALPHA = 0.38;          // faint: 92k overlapping dots must not burn the plate edges to white (review: 0.30 left the Mid-Atlantic Ridge near invisible at whole globe)

const VERT = /* glsl */`
  uniform float uSize, uScale, uMinPx, uMaxPx, uAlpha;
  attribute vec2 aQ;          // x magnitude, y depth km
  varying vec3 vColor; varying float vAlpha;
  ${DEPTH_GLSL}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float facing = dot(normalize(-mv.xyz), normalize(normalMatrix * normalize(position)));
    float m = aQ.x;
    float k = 0.75 + 0.25 * (m - 5.0);                       // M5 0.75, M6 1.0, M7 1.25, M9 1.75
    vColor = depthColour(aQ.y);
    vAlpha = uAlpha * (0.8 + 0.1 * (m - 5.0)) * smoothstep(0.0, 0.3, facing);   // limb fade: no bright rim of edge-on dots
    gl_PointSize = clamp(uSize * k * uScale / -mv.z, uMinPx * k, uMaxPx * k);
    gl_Position = vAlpha < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
  }`;

export async function createLayer({ THREE, radius = 1.0, makeDotMaterial, palette } = {}) {
  const url = (f) => new URL(f, import.meta.url);
  const get = (f, kind) => fetch(url(f)).then((r) => { if (!r.ok) throw new Error(f + ' ' + r.status); return r[kind](); });
  const [meta, buf] = await Promise.all([get('./data/quakes_m5.json', 'json'), get('./data/quakes_m5.bin', 'arrayBuffer')]);
  const N = meta.count;
  const lat = new Int16Array(buf, 0, N), lon = new Int16Array(buf, 2 * N, N), dep = new Uint16Array(buf, 4 * N, N);
  const mag = new Uint8Array(buf, 6 * N, N);

  const pos = new Float32Array(N * 3), q = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    toXYZ(lat[i] / 100, lon[i] / 100, radius * LIFT, pos, i * 3);
    q[i * 2] = mag[i] / 10; q[i * 2 + 1] = dep[i] / 10;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aQ', new THREE.BufferAttribute(q, 2));
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const uniforms = { uSize: { value: DOT_SIZE }, uScale: borrowScale(makeDotMaterial), uMinPx: { value: 1.5 * dpr }, uMaxPx: { value: 5 * dpr },
    uAlpha: { value: ALPHA }, ...depthUniforms(THREE) };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: DOT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(g, mat);
  points.frustumCulled = false; points.name = 'quake-history-dots';

  const group = new THREE.Group();
  group.name = 'quakes-history';
  group.add(points);
  let pal = '';
  const setPalette = (name) => { if (name !== pal) { pal = name; setDepthUniforms(uniforms, name); } };
  setPalette(paletteName(palette));
  group.update = () => { setPalette(paletteName(palette)); };
  group.setPalette = (name) => setPalette(name);
  group.setDim = (k) => { uniforms.uAlpha.value = ALPHA * Math.max(0, Math.min(1, k)); };

  const last = meta.lastEvent ? meta.lastEvent.slice(0, 10) : String(meta.lastYear);
  group.label = `Earthquakes M5+ since ${meta.firstYear} (USGS): ${N.toLocaleString('en-GB')} quakes. Pale = shallow, accent = 70 km, violet = deep (300-700 km).`;
  group.details = `Every earthquake of magnitude 5.0 or more in the USGS ComCat catalogue from ${meta.firstYear} to ${last}, ` +
    `${N.toLocaleString('en-GB')} in all, one dot each at its epicentre. Dot size grows with magnitude; colour is the depth where the rupture started: ` +
    `pale for shallow (0-70 km), the accent at 70 km, cooler down to violet for deep quakes (300-700 km). ` +
    `No plate boundaries are drawn: the dots outline the plate edges on their own (the Ring of Fire, the Mid-Atlantic Ridge, the Himalaya). ` +
    `The deep quakes lie on the landward side of ocean trenches (Japan, Tonga, the Andes), where one plate dives under another. ` +
    `Limits: the catalogue is less complete in the 1970s; depths that could not be measured are often fixed at 10 or 33 km. ` +
    `Dots are drawn on the surface; depth is shown by colour only. History, not a forecast. U.S. Geological Survey data, public domain.`;
  group.userData = {
    points, meta,
    setYear: (y) => { const k = Math.max(0, Math.min(meta.yearOffsets.length - 1, Math.floor(y - meta.firstYear) + 1)); g.setDrawRange(0, meta.yearOffsets[k]); },
    showAll: () => g.setDrawRange(0, N),
  };
  return group;
}
