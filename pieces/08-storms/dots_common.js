// Shared helpers for the storm and tornado dot layers (THREE.Points only).
// Contract: globe radius 1.0 at origin; x = cos(lat)cos(lon), y = sin(lat), z = -cos(lat)sin(lon).

export const D2R = Math.PI / 180;

export function toXYZ(latDeg, lonDeg, r, out, o) {
  const la = latDeg * D2R, lo = lonDeg * D2R;
  out[o] = r * Math.cos(la) * Math.cos(lo);
  out[o + 1] = r * Math.sin(la);
  out[o + 2] = -r * Math.cos(la) * Math.sin(lo);
}

// Dot material: the globe's makeDotMaterial when passed, otherwise a close stand-in
// (additive, round soft dots, size in world units with perspective, like the seafloor viewer).
export function dotMaterial(THREE, makeDotMaterial, { size, opacity = 1, vertexColors = true }) {
  if (makeDotMaterial) return makeDotMaterial({ size, vertexColors, opacity });
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,0.85)'); grad.addColorStop(0.5, 'rgba(255,255,255,0.25)'); grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.PointsMaterial({
    size, sizeAttenuation: true, vertexColors, opacity, map: new THREE.CanvasTexture(c),
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

// Density dots: file = int16 lat*100[M], int16 lon*100[M], uint8 value[M] (1..255, log scale).
// One dot per cell with data, lifted above the surface by up to `maxLift` * radius, coloured by `ramp(v01) -> [r,g,b]`.
export function densityPoints(THREE, buf, M, radius, maxLift, ramp, material) {
  const lat = new Int16Array(buf, 0, M), lon = new Int16Array(buf, 2 * M, M), val = new Uint8Array(buf, 4 * M, M);
  const pos = new Float32Array(M * 3), col = new Float32Array(M * 3), aValue = new Float32Array(M);
  for (let i = 0; i < M; i++) {
    const v = val[i] / 255;
    toXYZ(lat[i] / 100, lon[i] / 100, radius * (1.004 + maxLift * v), pos, i * 3);
    const c = ramp(v); col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
    aValue[i] = v;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aValue', new THREE.BufferAttribute(aValue, 1));
  const pts = new THREE.Points(g, material);
  pts.frustumCulled = false;
  return pts;
}

// piecewise-linear colour ramp from stops [[v, [r,g,b]], ...]
export function makeRamp(stops) {
  return (v) => {
    for (let i = 1; i < stops.length; i++) {
      if (v <= stops[i][0]) {
        const [v0, c0] = stops[i - 1], [v1, c1] = stops[i], f = (v - v0) / (v1 - v0 || 1);
        return [c0[0] + (c1[0] - c0[0]) * f, c0[1] + (c1[1] - c0[1]) * f, c0[2] + (c1[2] - c0[2]) * f];
      }
    }
    return stops[stops.length - 1][1];
  };
}

// Dim a dot material: k = 1 is normal, 0 is invisible. Multiplies opacity and dot size (k in 0..1).
// Works on the globe's makeDotMaterial (uniforms uOpacity / uSize) and on the fallback PointsMaterial.
export function dimMaterial(mat, k) {
  k = Math.max(0, Math.min(1, k));
  const base = mat.userData.dimBase || (mat.userData.dimBase = mat.uniforms
    ? { opacity: mat.uniforms.uOpacity.value, size: mat.uniforms.uSize.value } : { opacity: mat.opacity, size: mat.size });
  if (mat.uniforms) { mat.uniforms.uOpacity.value = base.opacity * k; mat.uniforms.uSize.value = base.size * k; }
  else { mat.opacity = base.opacity * k; mat.size = base.size * k; }
  mat.visible = k > 0.001;
}
