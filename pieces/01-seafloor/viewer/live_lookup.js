// live_lookup.js: read the Stage A lookup table (pieces/06-live-wave/lookup) and interpolate it for one sea state.
// Used by live.js in the browser and by pieces/06-live-wave/lookup/validate_interp.mjs in Node (same code, so the
// check tests what the viewer shows). No three.js, no DOM.
//
// PLUMBING, except interpolate(): 4-D linear interpolation in (Tp, direction, tide, H0) between the 16 grid nodes
// around the point. Inputs outside the grid are clamped to its edge and reported in `clamped`.
//
// What is reported for the house line:
//   status 'reef'      breaks on the reef: break distance, breaker height and peel are numbers
//   status 'edge'      the first H/h >= 0.78 cell is within EDGE_M of the water's edge (shore or dry rock): not on the reef
//   status 'off-house' most of the surrounding nodes break somewhere on the reef but not on the house line
//   lowConfidence      the surrounding nodes disagree by more than SPREAD_M (the break jumps between reef sections), or
//                      some of them do not break on the house line: the interpolated number is less trustworthy there

export const EDGE_M = 10;      // one model cell
export const SPREAD_M = 30;    // corner-to-corner spread of the house-line break above which the value is flagged

export function createLookup({ loadJSON, loadBin }) {
  const files = {};            // Tp -> Promise of decoded arrays
  let index = null, shore = null;
  const ready = Promise.all([loadJSON('index.json'), loadJSON('shore.json')]).then(([ix, sh]) => { index = ix; shore = sh; return ix; });

  function decode(buf) {
    const out = {};
    for (const a of index.arrays) {
      const T = a.dtype === 'uint16' ? Uint16Array : Float32Array;   // v2: both arrays uint16
      out[a.name] = new T(buf, a.byte_offset, a.byte_length / T.BYTES_PER_ELEMENT);
    }
    return out;
  }
  function tpFile(tp) {
    if (!files[tp]) files[tp] = loadBin(index.files[String(tp)]).then(decode);
    return files[tp];
  }
  function bracket(axis, v) {  // index i and fraction t so that v = axis[i] + t (axis[i+1] - axis[i]); clamped
    const lo = axis[0], hi = axis[axis.length - 1];
    const c = Math.min(hi, Math.max(lo, v));
    let i = 0; while (i < axis.length - 2 && axis[i + 1] <= c) i++;
    const t = axis.length === 1 ? 0 : (c - axis[i]) / (axis[i + 1] - axis[i]);
    return { i, t: Math.min(1, Math.max(0, t)), clamped: v < lo || v > hi };
  }

  async function interpolate(hs, tp, dir, tide) {
    await ready;
    const ax = index.axes, NP = index.profile_offsets_m.length, NS = index.scalar_columns.length, NO = index.nobreak_u16;
    const tideAx = ax.tide_above_LAT_m || ax.tide_above_datum_m;   // Porto Batel: LAT; other sites: their map datum
    const dirIn = wrapDir(dir, ax.dir_from_deg);
    const bT = bracket(ax.tp_s, tp), bD = bracket(ax.dir_from_deg, dirIn), bZ = bracket(tideAx, tide), bH = bracket(ax.H0_m, hs);
    const nd = ax.dir_from_deg.length, nt = tideAx.length, nh = ax.H0_m.length;
    const tps = [ax.tp_s[bT.i], ax.tp_s[Math.min(bT.i + 1, ax.tp_s.length - 1)]];
    const data = await Promise.all(tps.map(tpFile));
    const hi = Math.floor(NP / 2), sc = index.scalar_columns;
    const col = n => sc.indexOf(n);
    // the 16 corners and their weights
    const corners = [];
    for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) for (let c = 0; c < 2; c++) for (let d = 0; d < 2; d++) {
      const w = (a ? bT.t : 1 - bT.t) * (b ? bD.t : 1 - bD.t) * (c ? bZ.t : 1 - bZ.t) * (d ? bH.t : 1 - bH.t);
      if (w < 1e-9) continue;
      const di = Math.min(bD.i + b, nd - 1), ti = Math.min(bZ.i + c, nt - 1), h = Math.min(bH.i + d, nh - 1);
      corners.push({ w, arr: data[a], node: (di * nt + ti) * nh + h });
    }
    // per profile: weighted mean over corners that break on that profile; NaN if corners carrying half the weight or more do not
    const prof = (name, scale) => {
      const out = new Float64Array(NP);
      for (let p = 0; p < NP; p++) {
        let s = 0, ws = 0, wn = 0;
        for (const k of corners) { const v = k.arr[name][k.node * NP + p]; if (v === NO) wn += k.w; else { s += k.w * v / scale; ws += k.w; } }
        out[p] = (ws > 0 && wn < 0.5) ? s / ws : NaN;
      }
      return out;
    };
    const breakS = prof('break_s', 10);
    const raw = (k, name) => { const c = col(name), v = k.arr.scalars[k.node * NS + c]; return v === NO ? NaN : v / index.scalar_scale[c]; };
    const scal = name => { let s = 0, ws = 0; for (const k of corners) { const v = raw(k, name); if (Number.isFinite(v)) { s += k.w * v; ws += k.w; } } return ws > 0 ? s / ws : NaN; };
    // house line: spread of the corner values, and the share of weight on corners that miss the house line
    let wOff = 0, mn = Infinity, mx = -Infinity;
    for (const k of corners) {
      const st = raw(k, 'status'), b = raw(k, 'break_house');
      if (st !== 0 || !Number.isFinite(b)) { wOff += k.w; continue; }
      if (k.w > 0.01) { mn = Math.min(mn, b); mx = Math.max(mx, b); }
    }
    const spread = Number.isFinite(mx) ? mx - mn : NaN;
    // water's edge on the house line at this tide (linear in tide; bed only)
    const ed = shore.edge_s_m, e0 = ed[bZ.i][hi], e1 = ed[Math.min(bZ.i + 1, nt - 1)][hi];
    const edge = e0 == null ? e1 : e1 == null ? e0 : e0 + bZ.t * (e1 - e0);
    const bh = breakS[hi];
    let status = 'reef';
    if (wOff >= 0.5 || !Number.isFinite(bh)) status = 'off-house';
    else if (edge != null && bh - edge <= EDGE_M) status = 'edge';
    const clamped = { hs: bH.clamped, tp: bT.clamped, dir: bD.clamped, tide: bZ.clamped };
    return {
      status, breakHouse: bh, breakerHHouse: scal('breaker_H_house'),
      peelAngleNear: scal('peel_angle_near'), peelSpeedNear: scal('peel_speed_near'),
      edgeHouse: edge, spread, cornerMin: mn, cornerMax: mx, lowConfidence: wOff > 0 || spread > SPREAD_M,
      breakS, clamped, outOfRange: Object.values(clamped).some(Boolean),
      inputs: { hs, tp, dir, tide }, profileOffsets: index.profile_offsets_m,
      lineDeg: index.profile_line_deg, alongDeg: index.profile_along_deg, house: index.house,
      site: index.site || 'porto_batel', shoreS: index.shore_s_lmsl_m, takeoffS: index.takeoff ? index.takeoff.s : null, reefs: index.reefs,
    };
  }
  return { ready, interpolate, get index() { return index; } };
}

// A direction axis may run through north (Pipeline: 270-390, 390 = 30 deg). Use d + 360 or d - 360 when only that lies on
// the axis; otherwise keep d (it is then clamped to the nearer end, as before).
export function wrapDir(d, axis) {
  const lo = axis[0], hi = axis[axis.length - 1], inside = v => v >= lo && v <= hi;
  if (inside(d)) return d;
  if (inside(d + 360)) return d + 360;
  if (inside(d - 360)) return d - 360;
  return d;
}

// Break-line points (east, north metres from the house) for the profiles that break.
export function breakLinePoints(r) {
  const s1 = Math.sin(r.lineDeg * Math.PI / 180), c1 = Math.cos(r.lineDeg * Math.PI / 180);
  const s2 = Math.sin(r.alongDeg * Math.PI / 180), c2 = Math.cos(r.alongDeg * Math.PI / 180);
  const out = [];
  r.profileOffsets.forEach((o, p) => {
    const s = r.breakS[p];
    if (Number.isFinite(s)) out.push({ p, east: s * s1 + o * s2, north: s * c1 + o * c2, s });
  });
  return out;
}
