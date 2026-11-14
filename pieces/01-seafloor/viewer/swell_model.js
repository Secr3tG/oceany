// swell_model.js: the swell model of pieces/02-reefs/simulate_swell.py, line for line in JavaScript.
// Used by play.js to redraw the swell layer in the browser for any height, period, direction and tide.
// Shoaling + refraction (Snell's law on straight local contours) + breaking at gamma x depth, marched shoreward.
// Illustrative, not a forecast. See simulate_swell.py for the full explanation and its limits.
// Pure functions, no DOM: it also runs in node (that is how it is checked against the Python output).

export const G = 9.81;
// The lidar grid of simulate_swell.py (590_HR_Lidar_Centro, same box as export_reefs.py), printed by the Python.
export const GRID = { nrow: 184, ncol: 346, x0: -1932.0923834924738, y0: -1324.2050418400154,
                      dx: 11.200535555239744, dy: 14.47851562478931 };
// Model knobs, same values as the Python CONFIG block.
export const KNOBS = { gamma: 0.78, normalSmooth: 100, regionalSmooth: 600, edgeDepth: 12.0, maxTheta0: 80, wetMin: 0.05 };

// Python's round(): halves go to the even number.
const pyRound = x => { const r = Math.round(x); return (Math.abs(x % 1) === 0.5) ? 2 * Math.round(x / 2) : r; };

// Dispersion relation omega^2 = g k tanh(k d), solved for k by Newton's method (same first guess and 20 steps).
export function wavenumber(T, d) {
  const w2 = (2 * Math.PI / T) ** 2;
  let k = w2 / G / Math.sqrt(Math.tanh(w2 * d / G));
  for (let i = 0; i < 20; i++) {
    const th = Math.tanh(k * d);
    k -= (G * k * th - w2) / (G * th + G * k * d * (1 - th * th));
  }
  return k;
}
export function waveSpeeds(T, d) {
  const k = wavenumber(T, d), c = (2 * Math.PI / T) / k, kd2 = Math.min(2 * k * d, 700);
  return { k, c, Cg: c / 2 * (1 + kd2 / Math.sinh(kd2)) };
}

// ---- grid tools (match scipy.ndimage / numpy) ----
// Exact Euclidean distance transform (Felzenszwalb-Huttenlocher), distances in metres with cell sizes (dy, dx).
function dt1d(f, n, s, out, v, z) {   // lower envelope of parabolas; positions p*s
  const BIG = 1e30; let k = 0; v[0] = 0; z[0] = -BIG; z[1] = BIG;
  for (let q = 1; q < n; q++) {
    let sq;
    while (true) {
      const p = v[k];
      sq = ((f[q] + (q * s) ** 2) - (f[p] + (p * s) ** 2)) / (2 * s * (q - p));
      if (sq <= z[k] && k > 0) k--; else break;
    }
    if (sq <= z[k]) { v[0] = q; z[0] = -BIG; z[1] = BIG; k = 0; continue; }
    k++; v[k] = q; z[k] = sq; z[k + 1] = BIG;
  }
  k = 0;
  for (let q = 0; q < n; q++) { while (z[k + 1] < q * s) k++; out[q] = (s * (q - v[k])) ** 2 + f[v[k]]; }
}
function edt(isZero, R, C, dy, dx) {   // distance from each cell to the nearest cell with isZero = 1
  const INF = 1e20, D = new Float64Array(R * C), n = Math.max(R, C);
  const f = new Float64Array(n), o = new Float64Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  for (let c = 0; c < C; c++) {
    for (let r = 0; r < R; r++) f[r] = isZero[r * C + c] ? 0 : INF;
    dt1d(f, R, dy, o, v, z); for (let r = 0; r < R; r++) D[r * C + c] = o[r];
  }
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) f[c] = D[r * C + c];
    dt1d(f, C, dx, o, v, z); for (let c = 0; c < C; c++) D[r * C + c] = Math.sqrt(o[c]);
  }
  return D;
}
// scipy.ndimage.gaussian_filter: mode 'reflect' (d c b a | a b c d | d c b a), truncate 4.
function gauss1d(src, R, C, sigma, axis) {
  const rad = Math.floor(4 * sigma + 0.5), w = new Float64Array(2 * rad + 1); let sum = 0;
  for (let i = -rad; i <= rad; i++) { w[i + rad] = Math.exp(-0.5 * i * i / (sigma * sigma)); sum += w[i + rad]; }
  for (let i = 0; i < w.length; i++) w[i] /= sum;
  const n = axis === 0 ? R : C, refl = i => { const p = 2 * n; i = ((i % p) + p) % p; return i < n ? i : p - 1 - i; };
  const idx = new Int32Array(n + 2 * rad); for (let i = -rad; i < n + rad; i++) idx[i + rad] = refl(i);
  const out = new Float64Array(R * C);
  if (axis === 0) for (let c = 0; c < C; c++) for (let r = 0; r < R; r++) {
    let a = 0; for (let j = 0; j <= 2 * rad; j++) a += w[j] * src[idx[r + j] * C + c]; out[r * C + c] = a;
  } else for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
    let a = 0; const b = r * C; for (let j = 0; j <= 2 * rad; j++) a += w[j] * src[b + idx[c + j]]; out[b + c] = a;
  }
  return out;
}

// Build the model for one grid. reefs = reefs.json (x_m, y_m, depth_m in the same order as swell_sim.json).
export function makeModel(reefs) {
  const { nrow: R, ncol: C, x0, y0, dx, dy } = GRID, NC = R * C, N = reefs.depth_m.length;
  const lidar = new Float64Array(NC).fill(NaN), valid = new Uint8Array(NC), cellOf = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const c = pyRound((reefs.y_m[i] - y0) / dy) * C + pyRound((reefs.x_m[i] - x0) / dx);
    cellOf[i] = c; lidar[c] = reefs.depth_m[i]; valid[c] = 1;
  }
  const normals = new Map();   // the shore direction depends on the tide only: cache it
  function shoreNormal(tide, smooth) {
    const key = tide.toFixed(3) + '/' + smooth; if (normals.has(key)) return normals.get(key);
    const dry = new Uint8Array(NC);
    for (let c = 0; c < NC; c++) dry[c] = valid[c] && lidar[c] + tide <= KNOBS.wetMin ? 1 : 0;
    const dist = edt(dry, R, C, dy, dx);
    const sm = gauss1d(gauss1d(dist, R, C, smooth / 2 / dy, 0), R, C, smooth / 2 / dx, 1);
    const nx = new Float64Array(NC), ny = new Float64Array(NC), slope = new Float64Array(NC);
    for (let r = 0; r < R; r++) for (let c = 0; c < C; c++) {
      const i = r * C + c;
      const gy = r === 0 ? (sm[i + C] - sm[i]) / dy : r === R - 1 ? (sm[i] - sm[i - C]) / dy : (sm[i + C] - sm[i - C]) / (2 * dy);
      const gx = c === 0 ? (sm[i + 1] - sm[i]) / dx : c === C - 1 ? (sm[i] - sm[i - 1]) / dx : (sm[i + 1] - sm[i - 1]) / (2 * dx);
      const nrm = Math.hypot(gx, gy) + 1e-9;
      nx[i] = -gx / nrm; ny[i] = -gy / nrm; slope[i] = nrm;
    }
    const res = { nx, ny, sm, slope };
    if (normals.size > 40) normals.clear();
    normals.set(key, res); return res;
  }

  // One case. Same steps as run() in simulate_swell.py. Returns per-cell grids and per-reef-point arrays.
  function run({ H0, T, dir, tide, gamma = KNOBS.gamma, wrapped = true }) {
    const d = new Float64Array(NC), wet = new Uint8Array(NC);
    for (let c = 0; c < NC; c++) { d[c] = lidar[c] + tide; wet[c] = valid[c] && d[c] > KNOBS.wetMin ? 1 : 0; }
    const { nx, ny, sm: smdist, slope } = shoreNormal(tide, KNOBS.normalSmooth);
    const to = (dir + 180) * Math.PI / 180, c0 = G * T / (2 * Math.PI);
    let ux0 = null, uy0 = null, uxS = Math.sin(to), uyS = Math.cos(to), cRef = c0;
    if (wrapped) { const rg = shoreNormal(tide, KNOBS.regionalSmooth); ux0 = rg.nx; uy0 = rg.ny; cRef = waveSpeeds(T, KNOBS.edgeDepth).c; }
    const k = new Float64Array(NC), KsKr = new Float64Array(NC), Hlin = new Float64Array(NC);
    const reach = new Uint8Array(NC), Cg0 = c0 / 2;
    for (let i = 0; i < NC; i++) {
      const ax = wrapped ? ux0[i] : uxS, ay = wrapped ? uy0[i] : uyS;
      const th0 = Math.acos(Math.min(1, Math.max(-1, ax * nx[i] + ay * ny[i])));
      reach[i] = wet[i] && th0 * 180 / Math.PI < KNOBS.maxTheta0 ? 1 : 0;
      const ws = waveSpeeds(T, wet[i] ? d[i] : 1.0);
      k[i] = ws.k;
      const Ks = Math.sqrt(Cg0 / ws.Cg);
      const th = Math.asin(Math.min(1, Math.max(-1, Math.sin(th0) * ws.c / cRef)));
      const Kr = Math.sqrt(Math.max(Math.cos(th0), 1e-6) / Math.cos(th));
      KsKr[i] = Ks * Kr; Hlin[i] = H0 * Ks * Kr;
    }
    // March shoreward, from the cells furthest from shore inwards (stable sort, as numpy's argsort(kind="stable")).
    const step = Math.max(dx, dy), order = [];
    for (let i = 0; i < NC; i++) if (reach[i]) order.push(i);
    order.sort((a, b) => smdist[b] - smdist[a]);
    const rank = new Int32Array(NC).fill(-1); order.forEach((c, j) => { rank[c] = j; });
    const H = new Float64Array(NC).fill(NaN), phase = new Float64Array(NC).fill(NaN);
    const broken = new Uint8Array(NC), first = new Uint8Array(NC);
    for (const i of order) {
      const r = (i / C) | 0, cc = i - r * C;
      const ur = pyRound(r - ny[i] * step / dy), uc = pyRound(cc - nx[i] * step / dx);
      const inside = ur >= 0 && ur < R && uc >= 0 && uc < C, u = ur * C + uc;
      if (inside && valid[u] && !(d[u] > KNOBS.wetMin)) continue;          // in the lee of dry rock: not modelled
      let h, ph, upBroken;
      if (inside && rank[u] >= 0 && rank[u] < rank[i] && Number.isFinite(H[u])) {
        h = H[u] * KsKr[i] / KsKr[u];
        ph = phase[u] + k[i] * (smdist[u] - smdist[i]) / Math.max(slope[i], 0.5);
        upBroken = broken[u];
      } else { h = Hlin[i]; ph = -k[i] * smdist[i]; upBroken = 0; }
      if (h >= gamma * d[i]) { h = gamma * d[i]; broken[i] = 1; first[i] = upBroken ? 0 : 1; }
      H[i] = h; phase[i] = ph;
    }
    // Per reef point, in the swell_sim.json format.
    const P = { H: new Array(N), broken: new Array(N), k: new Array(N), phase: new Array(N), state: new Array(N), first: new Uint8Array(N) };
    const TWO_PI = 2 * Math.PI;
    for (let j = 0; j < N; j++) {
      const i = cellOf[j], drawn = Number.isFinite(H[i]);
      P.H[j] = drawn ? Math.round(H[i] * 100) / 100 : -1;
      P.broken[j] = drawn && broken[i] ? 1 : 0;
      P.k[j] = wet[i] ? k[i] : 0;
      P.phase[j] = drawn ? ((phase[i] % TWO_PI) + TWO_PI) % TWO_PI : 0;
      P.state[j] = (wet[i] && !reach[i]) ? 3 : (drawn && broken[i]) ? 2 : drawn ? 1 : 0;
      P.first[j] = drawn && first[i] ? 1 : 0;
    }
    return { grid: { H, broken, first, d, wet, reach, nx, ny }, points: P };
  }

  // Helpers for challenges: model cell nearest to a point (metres east, north), and a walk along a line.
  const cellAt = (x, y) => { const r = pyRound((y - y0) / dy), c = pyRound((x - x0) / dx);
    return r >= 0 && r < R && c >= 0 && c < C ? r * C + c : -1; };
  // Outermost break onset along the line from (ax, ay) through (bx, by), walking in from `maxM` metres.
  // Returns the distance (m) from (ax, ay), or null when nothing on the line breaks.
  function outerBreak(res, ax, ay, bx, by, maxM = 450, ds = 2) {
    const L = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / L, uy = (by - ay) / L;
    for (let s = maxM; s >= 0; s -= ds) {
      const c = cellAt(ax + ux * s, ay + uy * s);
      if (c >= 0 && Number.isFinite(res.grid.H[c]) && res.grid.broken[c]) return s;
    }
    return null;
  }
  return { run, cellAt, outerBreak, valid, lidar, N, cellOf };
}

// Degrees (lat, lon) to the model's metres, same flat-earth conversion as simulate_swell.py.
export function toMetres(lat, lon) {
  const ORIGIN_LAT = 39.322, ORIGIN_LON = -9.3625, M = 111195.0;
  return [(lon - ORIGIN_LON) * M * Math.cos(ORIGIN_LAT * Math.PI / 180), (lat - ORIGIN_LAT) * M];
}
