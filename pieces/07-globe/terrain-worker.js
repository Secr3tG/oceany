// Terrain tile worker (b53, 2026-11-24): the per-tile work that does not need the page, off the main thread, so a phone
// panning over new ground does not stutter while tiles stream in.
//   op 'tile': a terrain2 tile body (deflate-raw, tiles-build/v2/FORMAT.md) -> heights, cleaned exactly as terrain.js load()
//              did on the main thread (ocean-void rule, despike, largest |height|), plus the tile's dot geometry.
//   op 'geom': only the dot geometry of a tile (stand-ins: terrain.js asks while it queues them).
// Geometry = what terrain.js build() computed per dot from the tile's z/x/y alone: positions relative to the tile centre
// (jittered), the keeper dots' offsets to their parent-level dot (aPar), per-row size scale. Same formulas and constants as
// terrain.js (unitM, jit, desc's centre; N = 128, JIT = 0.42); keep the two in step. Mercator tiles only (polar ones stay
// on the main thread: their heights come from the base globe there). Classic worker, no imports.
'use strict';
const N = 128, NN = N * N, JIT = 0.42, D2R = Math.PI / 180;
const lonOf = (px, n) => px / n * 360 - 180;
const latOf = (py, n) => Math.atan(Math.sinh(Math.PI * (1 - 2 * py / n))) / D2R;
function unitM(py, n, lon, o) {
  const m = Math.PI * (1 - 2 * py / n), e = Math.exp(m), ie = 1 / e, ch = (e + ie) / 2, lo = lon * D2R;
  o[0] = Math.cos(lo) / ch; o[1] = (e - ie) / (e + ie); o[2] = -Math.sin(lo) / ch; return o;
}
function jit(a, b, c) { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return (((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5) * 2 * JIT; }

function geom(z, x, y) {
  const n = 2 ** z, latC = latOf(y + 0.5, n), lonC = lonOf(x + 0.5, n), la = latC * D2R, lc = lonC * D2R;
  const cx = Math.cos(la) * Math.cos(lc), cy = Math.sin(la), cz = -Math.cos(la) * Math.sin(lc);   // desc(): unit(latC, lonC)
  const cosC = Math.cos(la), pos = new Float32Array(NN * 3), sz = new Float32Array(NN), rs = new Float32Array(N), par = new Float32Array(NN * 4), v = [0, 0, 0];
  for (let j = 0; j < N; j++) {
    const s = Math.cos(latOf(y + (j + 0.5) / N, n) * D2R) / cosC; rs[j] = s;
    for (let i = 0; i < N; i++) {
      const k = j * N + i, gi = x * N + i, gj = y * N + j;
      const jx = jit(gi, gj, z), jy = jit(gj + 7919, gi, z);
      unitM(y + (j + 0.5 + jy) / N, n, lonOf(x + (i + 0.5 + jx) / N, n), v);
      pos[3 * k] = v[0] - cx; pos[3 * k + 1] = v[1] - cy; pos[3 * k + 2] = v[2] - cz; sz[k] = s;
    }
  }
  const n2 = n / 2;
  for (let j = 0; j < N; j += 2) for (let i = 0; i < N; i += 2) {
    const k = j * N + i, GI = (x * N + i) >> 1, GJ = (y * N + j) >> 1, pz = z - 1;
    const pjx = jit(GI, GJ, pz), pjy = jit(GJ + 7919, GI, pz);
    unitM((GJ + 0.5 + pjy) / N, n2, lonOf((GI + 0.5 + pjx) / N, n2), v);
    par[4 * k] = v[0] - cx - pos[3 * k]; par[4 * k + 1] = v[1] - cy - pos[3 * k + 1]; par[4 * k + 2] = v[2] - cz - pos[3 * k + 2]; par[4 * k + 3] = 1;
  }
  return { pos, sz, rs, par };
}

async function inflate(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
// tilepack.js decodeTile, then terrain.js load()'s clean-up
async function tile(body) {
  const raw = await inflate(body);
  if (raw.length < 16 + 2 * NN || raw[0] !== 79 || raw[1] !== 84 || raw[2] !== 50 || raw[3] !== 84) throw new Error('terrain2: not a tile');
  const dv = new DataView(raw.buffer, raw.byteOffset, 16);
  if (raw[4] !== 1 || dv.getUint16(6, true) !== N) throw new Error('terrain2: unsupported tile version');
  const flags = raw[5], base = dv.getFloat32(8, true), step = dv.getFloat32(12, true);
  const q = new Int32Array(NN), elev = new Float32Array(NN), LO = 16, HI = 16 + NN;
  for (let j = 0, k = 0; j < N; j++) for (let i = 0; i < N; i++, k++) {
    const zz = raw[LO + k] | (raw[HI + k] << 8), r = (zz >>> 1) ^ -(zz & 1);
    const a = i ? q[k - 1] : 0, b = j ? q[k - N] : 0, c = i && j ? q[k - N - 1] : 0;
    const val = (r + a + b - c) & 0xFFFF; q[k] = val; elev[k] = base + val * step;
  }
  let zeros = 0; for (let k = 0; k < NN; k++) if (elev[k] === 0) zeros++;
  const voidTile = zeros > 0.5 * NN;
  if (voidTile) for (let k = 0; k < NN; k++) if (elev[k] < 0) elev[k] = 0;
  despike(elev);
  let maxAbs = 0; for (let k = 0; k < NN; k++) maxAbs = Math.max(maxAbs, Math.abs(elev[k]));
  return { elev, flags, voidTile, maxAbs };
}
function despike(e) {   // terrain.js despike(), same rule
  for (const [di, dj] of [[0, 1], [1, 0]]) for (let j = 3 * dj; j < N - 3 * dj; j++) for (let i = 3 * di; i < N - 3 * di; i++) {
    const k = j * N + i, h = e[k]; if (h >= 0) continue;
    const o = 3 * (dj * N + di), a = e[k - o], b = e[k + o];
    if (a < 0 && b < 0 && Math.abs(a - b) < 300 && Math.abs(h - (a + b) / 2) > 1000) e[k] = (a + b) / 2;
  }
}

self.onmessage = async (ev) => {
  const m = ev.data;
  try {
    const res = {};
    if (m.op === 'tile') Object.assign(res, await tile(new Uint8Array(m.body)));
    if (m.geom) Object.assign(res, geom(m.z, m.x, m.y));
    const tr = []; for (const k of ['elev', 'pos', 'sz', 'rs', 'par']) if (res[k]) tr.push(res[k].buffer);
    self.postMessage({ id: m.id, ok: true, res }, tr);
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  }
};
