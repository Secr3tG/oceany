// play.js: "Play with the swell". Sliders for swell height, period, direction and tide that redraw the swell layer.
//
// THE CHOICE: port the model to JavaScript, not precompute a grid of cases in Python.
//   - The model (pieces/02-reefs/simulate_swell.py) is small: 184 x 346 cells, of which 20,325 have lidar.
//     In the browser one case takes about 40-50 ms, plus ~40 ms the first time a new tide is used
//     (the shore directions depend on the tide only and are cached). Well under the 300 ms budget.
//   - Precomputing would mean 4 knobs x ~10 steps = 10,000 cases x 20,325 points: far too big to ship,
//     and any coarser grid would snap the sliders to a few values.
//   - The port (swell_model.js) is line for line the Python run(): same dispersion solver, same distance
//     transform and smoothing (scipy semantics), same shoreward march and breaking rule. Checked against the
//     Python for four cases: heights within 0.005 m (the rounding of the output), identical break-onset cells.
// WHAT YOU SHOULD UNDERSTAND: swell_model.js run() (the physics). PLUMBING: everything in this file.
// Illustrative, not a forecast.

import { makeModel, toMetres, waveSpeeds, G } from './swell_model.js?v=c3';

// Observer marks (one surfer, 17 Sep 2026), as in simulate_swell.py USER_SKETCH. (lat, lon)
const FILM = toMetres(39.319506, -9.355772), TAKEOFF = toMetres(39.318870, -9.356829);
const PORTO_BATEL = [662.4, -266.9], COVER_R = 300, SIZE_R = 600, SIZE_DEPTH = 3;   // cover: wet cells within 300 m; size: lidar 3 m+ within 600 m
const PRESETS = {
  sep_total: { label: '17 Sep total sea', H0: 2.7, T: 7.8, dir: 337, tide: 2.1, wrapped: true },
  sep_swell: { label: '17 Sep swell only', H0: 1.9, T: 9.7, dir: 325, tide: 2.1, wrapped: true },
  storm: { label: 'Storm', H0: 6, T: 16, dir: 300, tide: 2.0, wrapped: false },   // big WNW swell, mid tide, direction matters (wrapped off). 315 deg is shadowed by Peniche (1% reached), 300 still arrives
  storm_nw: { label: 'Storm from NW (315°, shadowed)', H0: 6, T: 16, dir: 315, tide: 2.0, wrapped: false },   // same storm 15 deg further north: the Peniche headland blocks most of it (a lesson in how coastline angle filters swell)
};
const SLIDERS = {
  H0:   { label: 'Height', min: 0.5, max: 7, step: 0.1, fmt: v => v.toFixed(1) + ' m' },
  T:    { label: 'Period', min: 5, max: 18, step: 0.1, fmt: v => v.toFixed(1) + ' s' },
  dir:  { label: 'From', min: 180, max: 360, step: 5, fmt: v => v.toFixed(0) + '° ' + compass(v) },
  tide: { label: 'Tide', min: 0, max: 3.8, step: 0.1, fmt: v => v.toFixed(1) + ' m above LAT' },
};
function compass(b) { return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((b % 360) + 360) % 360 / 22.5) % 16]; }

const params = { ...PRESETS.sep_total };
const listeners = new Set(), inputs = [];   // inputs: every slider/checkbox bound to params (panel and tutorial copies)
let model = null, modelP = null, last = null, scheduled = false, busy = false;
const viewer = () => window.__viewer;

function loadModel() {
  if (!modelP) modelP = fetch('data/reefs.json').then(r => { if (!r.ok) throw new Error('reefs.json ' + r.status); return r.json(); })
    .then(reefs => { model = makeModel(reefs); model.cover = near(reefs, COVER_R, -99); model.approach = near(reefs, SIZE_R, SIZE_DEPTH); return model; });
  return modelP;
}
function near(reefs, radius, minDepth) {   // reef points within radius of Porto Batel, lidar depth at least minDepth
  const out = [];
  for (let j = 0; j < reefs.depth_m.length; j++)
    if (reefs.depth_m[j] >= minDepth && Math.hypot(reefs.x_m[j] - PORTO_BATEL[0], reefs.y_m[j] - PORTO_BATEL[1]) < radius) out.push(j);
  return out;
}

// Numbers the readout and the tutorial use.
function stats(res, p, ms) {
  const tc = model.cellAt(TAKEOFF[0], TAKEOFF[1]), g = res.grid;
  let wet = 0, drawn = 0, open = 0, hsum = 0;
  for (const j of model.cover) { const c = model.cellOf[j]; if (g.wet[c]) { wet++; if (Number.isFinite(g.H[c])) drawn++; } }
  for (const j of model.approach) { const c = model.cellOf[j];   // the deeper water off Porto Batel, outside the surf zone
    open++; if (Number.isFinite(g.H[c]) && !g.broken[c]) hsum += g.H[c] / p.H0; }
  const w5 = waveSpeeds(p.T, 5);
  return {
    params: { ...p }, ms,
    outer: model.outerBreak(res, FILM[0], FILM[1], TAKEOFF[0], TAKEOFF[1]),   // m from the filming position, or null
    takeoff: !g.wet[tc] ? 'dry' : !Number.isFinite(g.H[tc]) ? (g.reach[tc] ? 'in the lee of rock' : 'not reached') : g.broken[tc] ? 'broken' : 'unbroken',
    cover: wet ? drawn / wet : 0,                                             // share of Porto Batel's wet cells the swell reaches
    size: open ? hsum / open : 0,   // mean wave height / offshore height in the 3 m+ water off Porto Batel (0 where not reached): refraction losses show here
    ks5: Math.sqrt((G * p.T / (4 * Math.PI)) / w5.Cg),                        // shoaling factor in 5 m of water
    L0: G * p.T * p.T / (2 * Math.PI), L5: 2 * Math.PI / w5.k,               // wavelength: deep water, 5 m of water
  };
}

// Run the model for params (no drawing). Used by the tutorial for its checks too.
async function compute(p = params) {
  await loadModel();
  const t0 = performance.now(), res = model.run(p);
  return { res, stats: stats(res, p, performance.now() - t0) };
}

async function ensureSwellOn() {
  const V = viewer(); if (!V || !V.cur || !V.cur.cfg.portugal) return false;
  if (!V.SWELL.on) { const cb = document.getElementById('swl-on'); cb.checked = true; cb.dispatchEvent(new Event('change')); }
  await V.loadSwell();
  for (let i = 0; i < 200 && !V.SWELL.data; i++) await new Promise(r => setTimeout(r, 50));   // another call may be loading it
  return !!V.SWELL.data;
}

async function redraw() {
  if (busy) { scheduled = true; return; }
  busy = true;
  try {
    const { res, stats: s } = await compute(params);
    const V = viewer();
    if (await ensureSwellOn()) {
      const base = V.SWELL.file_data, p = params;
      const meta = { ...base.meta, mode: p.wrapped ? 'WRAPPED' : 'STRICT',
        config: { ...base.meta.config, H0_m: p.H0, T_s: p.T, direction_from_deg: p.dir, tide_above_lat_m: p.tide, omega_rad_s: 2 * Math.PI / p.T },
        viewer_note: `Your settings: ${p.H0.toFixed(1)} m, ${p.T.toFixed(1)} s, from ${p.dir}°, tide ${p.tide.toFixed(1)} m, computed in your browser. Illustrative, not a forecast.` +
          (p.wrapped ? ' Wrapped: the swell is assumed to bend round Peniche and arrive head-on at full height (an upper bound).' : ' Strict: the offshore direction is used as it is.') };
      const t1 = performance.now();
      V.buildSwell({ meta, ...res.points });
      s.drawMs = performance.now() - t1;
    }
    last = s; render(s);
    listeners.forEach(f => { try { f(s); } catch (e) { console.error(e); } });
    window.dispatchEvent(new CustomEvent('play:update', { detail: s }));
  } finally {
    busy = false;
    if (scheduled) { scheduled = false; setTimeout(redraw, 0); }
  }
}
function schedule() { if (!scheduled) { scheduled = true; setTimeout(() => { scheduled = false; redraw(); }, 16); } }   // coalesces slider moves

function set(p, { draw = true } = {}) {
  Object.assign(params, p); syncInputs();
  return draw ? redraw() : Promise.resolve();
}
function syncInputs() {
  for (const el of inputs) {
    const k = el.dataset.key;
    if (k === 'wrapped') el.checked = params.wrapped;
    else { el.value = params[k]; const o = el.parentElement.querySelector('output'); if (o) o.textContent = SLIDERS[k].fmt(params[k]); }
  }
  document.querySelectorAll('.play-dirnote').forEach(n => { n.style.display = params.wrapped ? '' : 'none'; });
}

// A labelled slider bound to params (the tutorial puts copies of these in its card, so they work on a phone).
function slider(key) {
  const s = SLIDERS[key], row = document.createElement('label');
  row.className = 'play-row';
  row.innerHTML = `<span>${s.label}</span><output></output><input type="range" min="${s.min}" max="${s.max}" step="${s.step}" data-key="${key}" aria-label="${s.label}">`;
  const inp = row.querySelector('input'); inputs.push(inp);
  inp.addEventListener('input', () => { params[key] = parseFloat(inp.value); syncInputs(); schedule(); });
  syncInputs();
  return row;
}
function wrappedToggle() {
  const row = document.createElement('label'); row.className = 'play-check';
  row.innerHTML = '<input type="checkbox" data-key="wrapped"> Wrapped (swell bends round Peniche)';
  const inp = row.querySelector('input'); inputs.push(inp);
  inp.addEventListener('change', () => { params.wrapped = inp.checked; syncInputs(); schedule(); });
  syncInputs();
  return row;
}
function dirNote() {
  const n = document.createElement('div'); n.className = 'play-dirnote hint';
  n.textContent = 'With "wrapped" on, direction does nothing: the swell is assumed to arrive head-on. Turn it off to use the direction as it is.';
  return n;
}

function render(s) {
  const el = document.getElementById('play-read'); if (!el) return;
  const outer = s.outer == null ? 'no break on the line out from the filming position' : `outer break about ${Math.round(s.outer / 5) * 5} m out from the filming position`;
  el.innerHTML = `${outer}; take-off zone: ${s.takeoff}.<br>` +
    `Reaches ${Math.round(s.cover * 100)}% of Porto Batel's water; waves off it ${Math.round(s.size * 100)}% of offshore height. In 5 m of water the wave is x${s.ks5.toFixed(2)} its deep-water height ` +
    `(shoaling only), wavelength ${Math.round(s.L5)} m (deep water ${Math.round(s.L0)} m).<br>` +
    `<span class="play-ms">Model ${s.ms.toFixed(0)} ms${s.drawMs != null ? `, drawing ${s.drawMs.toFixed(0)} ms` : ''}</span>`;
}

function buildPanel() {
  const swl = document.getElementById('swl'); if (!swl || document.getElementById('play')) return;
  const box = document.createElement('div'); box.id = 'play';
  box.innerHTML = '<div class="play-h">Play with the swell <span class="hint">(illustrative, not a forecast)</span></div>';
  ['H0', 'T', 'dir', 'tide'].forEach(k => box.appendChild(slider(k)));
  box.appendChild(wrappedToggle()); box.appendChild(dirNote());
  const pr = document.createElement('div'); pr.className = 'play-presets';
  Object.entries(PRESETS).forEach(([k, p]) => { const b = document.createElement('button'); b.textContent = p.label; b.onclick = () => set(p); pr.appendChild(b); });
  const f = document.createElement('button'); f.textContent = 'My swell'; f.title = 'My own swell: swell_sim.json exactly as the Python wrote it (2.7 m, 12 s)';
  f.onclick = async () => { if (!(await ensureSwellOn())) return; const V = viewer(), c = V.SWELL.file_data.meta.config;
    set({ H0: c.H0_m, T: c.T_s, dir: c.direction_from_deg, tide: c.tide_above_lat_m, wrapped: V.SWELL.file_data.meta.mode === 'WRAPPED' }, { draw: false });
    V.buildSwell(V.SWELL.file_data); };
  pr.appendChild(f); box.appendChild(pr);
  const pn = document.createElement('div'); pn.className = 'hint play-storms';   // one line on the two storm presets
  pn.textContent = 'The two storms differ only in direction: from 300° the swell reaches Porto Batel, from 315° the Peniche headland blocks most of it. Coastline angle filters swell.';
  box.appendChild(pn);
  const rd = document.createElement('div'); rd.id = 'play-read'; rd.className = 'hint'; rd.textContent = 'Move a slider to run the model in your browser.';
  box.appendChild(rd);
  const sp = swl.querySelector('#swl-speed-row'); if (sp) sp.after(box); else swl.appendChild(box);   // after the swell checkboxes, below the breaking-wave row
}

// Check: JS model at the shipped file's settings vs swell_sim.json (run from the console: await __play.validate()).
async function validate() {
  if (!(await ensureSwellOn())) return null;
  await loadModel();
  const d = viewer().SWELL.file_data, c = d.meta.config;
  const t0 = performance.now();
  const r = model.run({ H0: c.H0_m, T: c.T_s, dir: c.direction_from_deg, tide: c.tide_above_lat_m, wrapped: d.meta.mode === 'WRAPPED' });
  const ms = performance.now() - t0;
  let max = 0, sum = 0, n = 0, state = 0, broken = 0;
  for (let j = 0; j < d.H.length; j++) {
    if (d.state[j] !== r.points.state[j]) state++;
    if (d.broken[j] !== r.points.broken[j]) broken++;
    if (d.H[j] >= 0 && r.points.H[j] >= 0) { const e = Math.abs(d.H[j] - r.points.H[j]); max = Math.max(max, e); sum += e; n++; }
  }
  return { ms: +ms.toFixed(1), points: d.H.length, compared: n, maxH: +max.toFixed(3), meanH: +(sum / n).toFixed(5), stateMismatch: state, brokenMismatch: broken };
}

const CSS = `
#play { margin: 8px 0; padding-top: 6px; border-top: 1px solid #16303a; }
#play .play-h { color: #7fe3f0; margin-bottom: 4px; }
.play-row { display: grid; grid-template-columns: 52px 1fr; column-gap: 6px; align-items: center; margin: 2px 0; }
.play-row output { text-align: right; color: #cfe8ee; font-variant-numeric: tabular-nums; }
.play-row input[type=range] { grid-column: 1 / -1; width: 100%; height: 26px; margin: 0; touch-action: pan-y; }
.play-check { display: flex; gap: 6px; align-items: center; margin: 4px 0; }
.play-check input { width: 18px; height: 18px; }
.play-presets { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0; }
.play-presets button { padding: 5px 8px; }
#play-read { color: #9ab; }
.play-ms { color: #678; font-size: 11px; }
.play-dirnote { color: #9ab; font-size: 11px; }
.play-storms { color: #9ab; font-size: 11px; margin-bottom: 4px; }
`;
function init() {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  buildPanel();
}
init();

window.__play = {
  get params() { return { ...params }; }, get last() { return last; }, set, compute, redraw, validate, slider, wrappedToggle,
  onUpdate(f) { listeners.add(f); return () => listeners.delete(f); }, ensureSwellOn, loadModel, PRESETS, FILM, TAKEOFF,
  // Direction (strict mode, 180-360) that sends the biggest waves into Porto Batel, for the direction challenge.
  async bestDirection(p = params) {
    await loadModel(); let best = { dir: null, size: -1 };
    for (let dir = 180; dir <= 360; dir += 5) {
      const { stats: s } = await compute({ ...p, dir, wrapped: false });
      if (s.size > best.size) best = { dir, size: s.size, cover: s.cover };
      await new Promise(r => setTimeout(r, 0));
    }
    return best;
  },
};
