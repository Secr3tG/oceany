// The fixed colour scale for significant wave height, shared by the wave layer (a GPU lookup texture) and the legend in
// the time bar (a CSS gradient), so the two can never disagree. Independent of the globe's palette on purpose: a
// height scale has to mean the same thing every time. Positions on the scale follow the square root of height, so
// 0 to 3 m (most surf) gets half the width, and storms (8 m and up) still separate.
export const HS_MAX = 12;
export const hsX = (h) => Math.sqrt(Math.max(0, Math.min(HS_MAX, h)) / HS_MAX);
export const HS_STOPS = [
  [0, '#0b1f3d'], [0.5, '#123f73'], [1, '#1767a8'], [1.5, '#1b93c4'], [2, '#25bfb8'], [3, '#86df84'],
  [4, '#efe05c'], [6, '#f6a13e'], [8, '#e8584f'], [12, '#fff0e0'],   // red to warm white at the top: no purple
];

// 256 x 1 RGBA lookup along hsX
export function hsLut(THREE) {
  const rgb = HS_STOPS.map(([h, c]) => [hsX(h), parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]);
  const d = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0; while (k < rgb.length - 2 && rgb[k + 1][0] < x) k++;
    const a = rgb[k], b = rgb[k + 1], f = Math.max(0, Math.min(1, (x - a[0]) / (b[0] - a[0])));
    for (let c = 1; c < 4; c++) d[i * 4 + c - 1] = Math.round(a[c] + (b[c] - a[c]) * f);
    d[i * 4 + 3] = 255;
  }
  const t = new THREE.DataTexture(d, 256, 1, THREE.RGBAFormat);
  t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
  return t;
}
