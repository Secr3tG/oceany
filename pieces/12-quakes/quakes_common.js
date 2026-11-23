// Shared parts of the two earthquake layers (live and history): depth colours per palette and the dot shader.
// Contract: globe radius 1.0 at origin; x = cos(lat)cos(lon), y = sin(lat), z = -cos(lat)sin(lon).

export const D2R = Math.PI / 180;
export const LIFT = 1.004;   // dots sit ~25 km above sea level, so the land relief does not swallow them

export function toXYZ(latDeg, lonDeg, r, out, o) {
  const la = latDeg * D2R, lo = lonDeg * D2R;
  out[o] = r * Math.cos(la) * Math.cos(lo);
  out[o + 1] = r * Math.sin(la);
  out[o + 2] = -r * Math.cos(la) * Math.sin(lo);
}

// Colour by depth, the seismologists' three bands: shallow (0-70 km), intermediate (70-300 km), deep (300-700 km).
// A calm sequential ramp, pale near the surface and cooler with depth, so the deep quakes under Japan, Tonga, the
// Andes and the Philippines read as their own band. The 70 km stop is the palette's one accent; no red anywhere.
export const DEPTH_KM = [0, 70, 300, 700];
const DEPTH_COLOURS = {
  Ocean: [[1.0, 0.93, 0.80], [0.37, 0.95, 1.0], [0.45, 0.52, 1.0], [0.70, 0.45, 0.98]],   // ivory, cyan accent, periwinkle, violet
  Ember: [[1.0, 0.92, 0.76], [1.0, 0.62, 0.30], [0.80, 0.45, 0.60], [0.58, 0.38, 0.85]],   // pale gold, ember accent, dusty rose, violet
  Mono:  [[0.95, 0.95, 0.95], [0.55, 0.86, 1.0], [0.42, 0.56, 0.90], [0.50, 0.46, 0.80]],  // white, ice accent, steel blue, slate violet
};
// Which palette is on: the globe mutates one shared palette object, so read it back from its accent and shallow colour.
export function paletteName(p) {
  if (!p || !p.unlocked) return 'Ocean';
  if (p.unlocked[0] > 0.9) return 'Ember';
  if (p.shallow && Math.abs(p.shallow[0] - 0.5) < 0.05) return 'Mono';
  return 'Ocean';
}
export const depthColours = (name) => DEPTH_COLOURS[name] || DEPTH_COLOURS.Ocean;
export function depthColour(name, km) {
  const c = depthColours(name);
  for (let i = 1; i < DEPTH_KM.length; i++) {
    if (km <= DEPTH_KM[i] || i === DEPTH_KM.length - 1) {
      const f = Math.max(0, Math.min(1, (km - DEPTH_KM[i - 1]) / (DEPTH_KM[i] - DEPTH_KM[i - 1])));
      return c[i - 1].map((v, k) => v + (c[i][k] - v) * f);
    }
  }
  return c[0];
}

// GLSL: the same ramp on the GPU (colours as uniforms, so a palette switch is four uniform writes, no buffer upload)
export const DEPTH_GLSL = /* glsl */`
  uniform vec3 uC0, uC1, uC2, uC3;
  vec3 depthColour(float km) {
    if (km < 70.0) return mix(uC0, uC1, km / 70.0);
    if (km < 300.0) return mix(uC1, uC2, (km - 70.0) / 230.0);
    return mix(uC2, uC3, clamp((km - 300.0) / 400.0, 0.0, 1.0));
  }`;
export function depthUniforms(THREE) {
  return { uC0: { value: new THREE.Vector3() }, uC1: { value: new THREE.Vector3() }, uC2: { value: new THREE.Vector3() }, uC3: { value: new THREE.Vector3() } };
}
export function setDepthUniforms(u, name) {
  const c = depthColours(name);
  u.uC0.value.set(...c[0]); u.uC1.value.set(...c[1]); u.uC2.value.set(...c[2]); u.uC3.value.set(...c[3]);
}

// The globe's dot: round, soft, additive (same falloff as makeDotMaterial)
export const DOT_FRAG = /* glsl */`
  varying vec3 vColor; varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    gl_FragColor = vec4(vColor, pow(1.0 - r, 2.0) * 0.85 * vAlpha);
  }`;

// pixels per world unit at distance 1, shared with the globe's dots (so sizes follow the window and pixel ratio)
export function borrowScale(makeDotMaterial) {
  let uScale = { value: 450 };
  if (makeDotMaterial) { const probe = makeDotMaterial({ size: 0.001 }); if (probe.uniforms?.uScale) uScale = probe.uniforms.uScale; probe.dispose?.(); }
  return uScale;
}

export const fmtUTC = (d) => d.toISOString().slice(11, 16) + ' UTC';
export const fmtDay = (d) => d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
