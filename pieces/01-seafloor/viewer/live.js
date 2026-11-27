// live.js: the "Live forecast" panel, on every map. One spot table (live_core.js LIVE_SPOTS, mirroring live-data/spots.py).
//
// Data flow, per spot (the browser calls no outside host; since 2026-11-23 there is no Open-Meteo call):
//   1. live/<spot>.json at the site root (same origin), written by live-data/build_snapshot.py --public: NOAA GFS-Wave
//      (waves, wind; public domain), Copernicus / DMI wave models where they cover the spot, sea level (Copernicus regional
//      model, tide + surge; NOAA CO-OPS tide for Pipeline), buoy values, model-vs-buoy bias. Used if under 48 h old.
//   2. Sea level is relative to mean sea level; each spot's table entry says how it becomes "tide on this map"
//      (Peniche: + 1.66 m to LAT; elsewhere no offset is known and none is applied). No tide: shown as not available.
//   3. Spots with a reef model (LIVE_SPOTS stageA: Porto Batel, Pipeline): Stage A for each hour, exact from the snapshot or
//      interpolated from that spot's table, and the modelled break line on its reef map. Other spots show forecast numbers only.
//   4. "Generate swell from the forecast": the hour's swell goes into that map's swell visual, by the mechanism the map
//      already has (Porto Batel: the Play sliders; the other reef maps: the same swell model run in the browser on that
//      map's grid). A line says what the swell on screen is: a forecast hour, your slider values, or the fixed file.
// WHAT YOU SHOULD UNDERSTAND: live_core.js LIVE_SPOTS, swellHandoff(), periodFor() and readout(). PLUMBING: this file.
// It is a model driven by forecast input: a representative regular wave, not a prediction of each wave.

import * as THREE from 'three';
import { createLookup, breakLinePoints } from './live_lookup.js?v=l4';
import { DATUM_UNC, LIVE_SPOTS, spotsForLayer, snapshotPath, loadModels, exactResult, readout, forecastLines, windLine, buoyLines,
  swellHandoff, swellStateText, sameInputs, outsideRange, runLine, DISCLAIMER } from './live_core.js?v=n2';
import { SPOT_GRIDS } from './swell_model.js?v=c4';
import { makeModelAsync } from './swell_client.js?v=w2';   // run() happens in a worker (swell_worker.js)

const SITE_ROOT = '../../../';                         // pieces/01-seafloor/viewer -> site root (live/<spot>.json)
const M = 111195.0;
const lookups = {};                                   // lookup folder -> createLookup() (Porto Batel: ../../06-live-wave/lookup/)
function lookupFor(sp) {
  const dir = sp.stageA.lookup;
  if (!lookups[dir]) lookups[dir] = createLookup({
    loadJSON: f => fetch(dir + f).then(r => { if (!r.ok) throw new Error(f + ' ' + r.status); return r.json(); }),
    loadBin: f => fetch(dir + f).then(r => { if (!r.ok) throw new Error(f + ' ' + r.status); return r.arrayBuffer(); }),
  });
  return lookups[dir];
}
// data: spot key -> loadModels() result (or a Promise while loading). onScreen: layer label -> what its swell picture is.
const S = { data: {}, spotKey: null, layer: null, key: null, i: 0, res: null, p: null, lineOn: true, seq: 0, onScreen: {}, playHand: null, models: {}, stateHtml: '' };
const V = () => window.__viewer;
const spot = () => LIVE_SPOTS[S.spotKey];
const cur = () => S.models[S.key];

// ---------- panel ----------
const el = {};
function buildPanel() {
  const box = document.createElement('div'); box.id = 'live'; box.style.display = 'none';
  box.innerHTML = `
    <div class="live-h">Live forecast <span id="live-sub" class="hint"></span></div>
    <div class="row" id="live-spot-row" style="display:none"><span class="hint">Spot</span><select id="live-spot"></select></div>
    <div id="live-status" class="hint">loading the forecast...</div>
    <div id="live-ctl" style="display:none">
      <div class="row"><select id="live-model"></select><button id="live-now">Now</button></div>
      <div class="row"><button id="live-prev" title="One hour back">&lsaquo;</button><input id="live-hour" type="range" min="0" max="0" step="1" style="flex:1"><button id="live-next" title="One hour on">&rsaquo;</button></div>
      <div id="live-time" class="hint"></div>
      <div id="live-read" class="live-read"></div>
      <div id="live-buoy" class="live-read"></div>
      <label class="row" id="live-line-row"><input id="live-line" type="checkbox" checked> Show the modelled break line on the reef</label>
      <div class="row"><button id="live-play"></button><button id="live-back" style="display:none">Back to the map's typical swell</button></div>
      <div id="live-play-note" class="hint"></div>
      <div id="live-swell-state" class="hint live-state"></div>
    </div>
    <details class="live-notes"><summary>What this is</summary><ul id="live-notes"></ul></details>
    <div id="live-attr" class="hint live-attr"></div>
    <div id="live-disc" class="hint live-disc">${DISCLAIMER.join('<br>')}</div>`;
  const swl = document.getElementById('swl');
  (swl ? swl.parentNode : document.getElementById('panel')).insertBefore(box, swl ? swl.nextSibling : null);
  ['sub', 'spot-row', 'spot', 'status', 'ctl', 'model', 'now', 'prev', 'next', 'hour', 'time', 'read', 'buoy', 'line-row', 'line', 'play', 'back',
    'play-note', 'swell-state', 'notes', 'attr'].forEach(k => { el[k] = document.getElementById('live-' + k); });
  el.box = box;
  const st = document.createElement('style');
  st.textContent = `#live{margin-top:8px;border-top:1px solid #1d3b47;padding-top:6px}#live .live-h{font-weight:600;color:#ffd0f2}
    #live select{background:#0b1a22;color:#cfe8ee;border:1px solid #1d3b47;border-radius:5px;flex:1}
    #live .live-read{font-size:12px;line-height:1.45;margin-top:4px}#live .live-read b{color:#fff}#live .flag{color:#ffb35c}
    #live .live-notes{font-size:11px;color:#9ab;margin-top:4px}#live .live-notes ul{padding-left:16px;margin:4px 0}#live .live-attr{font-size:10px;margin-top:4px}
    #live .live-attr a{color:#9cd}#live .src{color:#9fd8ff}#live .live-state{color:#cfe8ee;margin-top:3px}#live .live-state b{color:#ffd0f2}
    #live .live-run{color:#9fd8ff;font-size:11px}#live .live-disc{font-size:10px;margin-top:4px;color:#cfe8ee}`;
  document.head.appendChild(st);
  el.spot.onchange = () => selectSpot(el.spot.value);
  el.model.onchange = () => { const t = cur().t[S.i]; S.key = el.model.value; S.i = nearestIndex(cur().t, t); syncHour(); update(); };
  el.hour.oninput = () => { S.i = +el.hour.value; update(); };
  el.prev.onclick = () => { S.i = Math.max(0, S.i - 1); syncHour(); update(); };
  el.next.onclick = () => { S.i = Math.min(cur().t.length - 1, S.i + 1); syncHour(); update(); };
  el.now.onclick = () => { S.i = nowIndex(cur()); syncHour(); update(); };
  el.line.onchange = () => { S.lineOn = el.line.checked; };
  el.play.onclick = () => handOff().catch(e => { el['play-note'].innerHTML = `<span class="flag">Could not draw the swell (${e.message}).</span>`; });
  el.back.onclick = backToFile;
}
const nowIndex = m => nearestIndex(m.t, new Date().toISOString().slice(0, 16));
function nearestIndex(ts, t) { let b = 0, bd = Infinity; ts.forEach((x, i) => { const d = Math.abs(Date.parse(x + 'Z') - Date.parse(t + 'Z')); if (d < bd) { bd = d; b = i; } }); return b; }
function syncHour() { el.hour.max = cur().t.length - 1; el.hour.value = S.i; }
const fmtTime = t => { const d = new Date(t + 'Z');
  return `${t.replace('T', ' ')} UTC (${d.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' })} your time)`; };

// Per-spot "What this is" list.
function notesFor(sp) {
  if (sp.stageA && sp.key === 'pipeline') return [
    'A model driven by forecast input: one representative regular wave per hour, not a prediction of each wave or set.',
    'Same reef model as Porto Batel (Stage A: refraction over the 2013 lidar, shoaling, break where height reaches 0.78 x depth; nothing tuned), on a 10 m grid turned to the shore.',
    'Forecast swell height is applied at the seaward edge of the lidar, about 1.2 km out and 14-35 m deep (17 m straight off Pipeline): no deep-water to edge step, and no refraction outside the survey.',
    'Distances are along a line straight out from the published take-off (314&deg;), from the 0 m (LMSL) shoreline on that line. Reef names: bands around the published First / Second / Third Reef distances (61 / 122 / 305 m from shore).',
    sp.tide.how,
    'Checked against Sentinel-2 satellite whitewater on dated days with the Waimea buoy (pieces/05-pipeline/VALIDATION.md): read that before trusting a number.',
    'Known limits from that check: at 2-3 m the reef name tends to read one reef too far out; long-period (16-20 s) WNW swell results are not supported by the evidence; nothing above about 4 m was checked.',
    'Hours in the model-run snapshot are full model runs; other hours are interpolated from a precomputed table, which is flagged where the break jumps between reefs (often above ~5 m).',
    sp.also];
  if (sp.stageA) return [
    'A model driven by forecast input: one representative regular wave per hour, not a prediction of each wave or set.',
    'Forecast swell height is applied at the edge of the 2.4 km reef model, about 14 m deep (no deep-water to 14 m step).',
    `Tide above lowest tide (LAT) = forecast sea level + 1.66 m. That offset is uncertain by ${DATUM_UNC}; at low tide 0.25 m moves the break tens of metres.`,
    'Tide: Copernicus IBI sea level (tide + surge), put on approximate mean sea level by removing its mean over the snapshot window (about 0.1-0.2 m uncertain). Hours without a tide are not run through the reef model.',
    'Period: the swell peak period. NOAA GFS-Wave gives the swell partition\'s peak period for the whole run. Copernicus gives no swell peak: the whole-sea peak period is used when the swell carries more energy than the wind sea, else the swell mean period (marked).',
    'Break rule H = 0.78 x depth, not tuned. The model breaks 10-50 m further out than the 17 Sep 2026 footage (an open question, left as is).',
    'Hours in the published snapshot are full model runs. Any other hour is interpolated from a precomputed table; where neighbouring table cases disagree a lot (the break jumps between reef sections) the readout says so and shows their range.',
    'NOAA GFS-Wave is a 0.25&deg; (about 25 km) global model, 3-hourly to 5 days then 6-hourly: coarser than Copernicus IBI (about 3 km, hourly).',
    '"Use this hour\'s swell" puts the hour into the Play with the swell sliders (a simpler model, strict direction); its picture is illustrative.',
    sp.also];
  const L = ['Forecast numbers at the models\' grid points (listed in the model menu), not at the break. No reef model here: break distance, breaker height and peel are modelled for Porto Batel only.',
    sp.tide.how,
    'Period: NOAA GFS-Wave gives the swell partition\'s peak period; Copernicus and DMI give mean periods for the swell partition. Mean periods are marked.',
    'NOAA GFS-Wave is a 0.25&deg; (about 25 km) global model, 3-hourly to 5 days then 6-hourly; its grid point can sit well offshore.'];
  if (sp.swell && sp.swell.mode === 'model') L.push('"Draw this hour\'s swell" runs the map\'s own swell model (the one that made its typical-swell picture: shoaling, refraction on the smoothed shore, breaking at 0.78 x depth) in your browser with this hour\'s height, period, direction (strict) and tide. Illustrative, not a prediction of each wave. The breaking-wave slice stays the fixed typical-swell illustration.');
  else L.push(sp.layers.length ? 'This map has no swell model, so the forecast is shown as numbers only.' : `There is no sea-floor map of ${sp.name} in the viewer yet, so the forecast is shown as numbers only.`);
  L.push('Buoy values and model-minus-buoy numbers come from the published snapshot. The bias is for total-sea height over the last 48 h; a buoy far from the model point makes it a regional check only.');
  return L;
}

// ---------- spot selection (follows the map on screen) ----------
function onLayer(label) {
  S.layer = label;
  const { on, other } = spotsForLayer(label);
  el.spot.innerHTML = '';
  const add = (parent, s, extra = '') => { const o = document.createElement('option'); o.value = s.key; o.textContent = s.name + extra; parent.appendChild(o); };
  on.forEach(s => add(el.spot, s));
  if (other.length) { const g = document.createElement('optgroup'); g.label = 'Forecast only (no map in the viewer yet)'; other.forEach(s => add(g, s)); el.spot.appendChild(g); }
  el['spot-row'].style.display = on.length + other.length > 1 ? '' : 'none';
  const keep = S.spotKey && on.some(s => s.key === S.spotKey);
  selectSpot(keep ? S.spotKey : (on[0] || other[0]).key);
}
async function selectSpot(key) {
  S.spotKey = key; el.spot.value = key;
  const sp = spot();
  el.sub.textContent = sp.name + (sp.stageA ? ', modelled from forecast input' : ', forecast input');
  el.notes.innerHTML = notesFor(sp).filter(Boolean).map(t => `<li>${t}</li>`).join('');
  el['line-row'].style.display = sp.stageA ? '' : 'none';
  el.ctl.style.display = 'none'; el.status.textContent = 'loading the forecast...'; el.attr.innerHTML = ''; el['play-note'].textContent = '';
  S.res = null;
  if (!S.data[key]) S.data[key] = loadModels({ fetchFn: (u, o) => fetch(u, o), snapshotUrl: SITE_ROOT + snapshotPath(key), nowMs: Date.now(), spot: sp });
  const L = await S.data[key];
  if (S.spotKey !== key) return;                      // another spot was picked while this one loaded
  S.models = L.models; S.L = L;
  if (!L.ok) { el.status.innerHTML = '<span class="flag">Forecast unavailable right now.</span> ' + L.notes.join(' '); return; }
  el.model.innerHTML = '';
  for (const [k, m] of Object.entries(S.models)) { const o = document.createElement('option'); o.value = k; o.textContent = `${m.name}${m.point ? ` (grid point ${m.point})` : ''}`; el.model.appendChild(o); }
  S.key = Object.keys(S.models)[0]; el.model.value = S.key;
  S.i = nowIndex(cur()); syncHour();
  el.status.textContent = L.notes.join(' ');
  el.attr.innerHTML = L.credits.join('<br>');
  el.ctl.style.display = '';
  setHandoffButton();
  update();
}
function setHandoffButton() {
  const sp = spot(), mode = sp.swell && sp.swell.mode;
  el.play.textContent = mode === 'play' ? 'Use this hour\'s swell in "Play with the swell"' : 'Draw this hour\'s swell on the map';
  el.play.title = mode === 'play' ? 'Put this hour\'s swell and tide into the Play with the swell sliders' : 'Run this map\'s swell model in your browser with this hour\'s swell and tide';
  const h = swellHandoff(sp, { hs: 0, tp: 0, dir: 0, tide: 0 }, '', '', S.layer);
  el.play.style.display = h.ok ? '' : 'none';
  el['play-note'].textContent = h.ok ? '' : h.why;
}

async function update() {
  const m = cur(), i = S.i, seq = ++S.seq, sp = spot();
  const p = { hs: m.hs[i], tp: m.tp[i], dir: m.dir[i], tide: m.tide[i], kind: m.kind[i], wind: m.wind ? m.wind[i] : null, total: m.total ? m.total[i] : null,
    w10: m.w10 ? m.w10[i] : null };
  el.time.innerHTML = fmtTime(m.t[i]) + (m.t[i] < new Date().toISOString().slice(0, 13) ? ' (past hour)' : '') +
    `<br><span class="live-run">${runLine(m, m.t[i], S.L.built)}</span>`;
  el.buoy.innerHTML = buoyLines(S.L.observations, S.L.comparison, m, Date.now()).join('<br>');
  if (!sp.stageA) { S.p = p; S.res = null; el.read.innerHTML = forecastLines(p, sp).join('<br>'); return; }
  if (p.tide == null) {                              // no tide for this hour: the reef model needs one, and none is guessed
    S.p = p; S.res = null;
    el.read.innerHTML = [...forecastLines(p, sp), '<span class="hint">The reef model needs the tide, so it is not run for this hour.</span>'].join('<br>');
    return;
  }
  let r;
  const lk = lookupFor(sp);
  if (m.exact && m.exact[i]) {                                // the snapshot ran Stage A for exactly this hour
    try { const ix = await lk.ready; r = exactResult(m.exact[i], ix); r.clamped = outsideRange(p, ix); }
    catch (e) { r = exactResult(m.exact[i]); }
  } else {
    try { r = await lk.interpolate(p.hs, p.tp, p.dir, p.tide); r.source = 'table'; }
    catch (e) { el.read.innerHTML = `<span class="flag">Model table unavailable (${e.message}).</span>`; S.res = null; return; }
  }
  if (seq !== S.seq) return;                         // a newer hour was picked meanwhile
  S.res = r; S.p = p; S.dirty = true;
  const lines = readout(p, r), w = windLine(p);
  if (w) lines.splice(1, 0, w);
  el.read.innerHTML = lines.join('<br>');
}

// ---------- break line in the 3D scene (spots with a reef model, on their own map) ----------
const lineMat = new THREE.LineBasicMaterial({ color: 0xff4fd8, transparent: true, opacity: 0.95, depthTest: false });
const ptsMat = new THREE.PointsMaterial({ color: 0xffd0f2, size: 5, sizeAttenuation: false, depthTest: false, transparent: true });
const group = new THREE.Group(); group.visible = false; group.renderOrder = 11;
const lineObj = new THREE.LineSegments(new THREE.BufferGeometry(), lineMat); lineObj.renderOrder = 11; lineObj.frustumCulled = false;
const ptsObj = new THREE.Points(new THREE.BufferGeometry(), ptsMat); ptsObj.renderOrder = 11; ptsObj.frustumCulled = false;
group.add(lineObj, ptsObj);
const tagEl = document.createElement('div'); tagEl.className = 'tag'; tagEl.style.cssText = 'color:#ffd0f2;font-size:11px;display:none';
document.body.appendChild(tagEl);
let houseXZ = null;
const PB_HOUSE = { lat: 39.319506, lon: -9.355772 };  // Porto Batel's Stage A origin, for results that do not carry their own
function toScene(east, north, o, H) {                  // Stage A metres from its origin -> lat/lon -> reef layer x (east), z (south)
  const lat = H.lat + north / M, lon = H.lon + east / (M * Math.cos(H.lat * Math.PI / 180));
  return [(lon - o.lon) * M * Math.cos(o.lat * Math.PI / 180), -(lat - o.lat) * M];
}
function rebuildLine(o) {
  const pts = breakLinePoints(S.res), P = [], Lseg = [];
  const H = S.res.house || PB_HOUSE;
  const byP = new Map(pts.map(q => [q.p, toScene(q.east, q.north, o, H)]));
  for (const [, xz] of byP) P.push(xz[0], 0, xz[1]);
  for (const [p, xz] of byP) { const n = byP.get(p + 1); if (n) Lseg.push(xz[0], 0, xz[1], n[0], 0, n[1]); }
  ptsObj.geometry.dispose(); ptsObj.geometry = new THREE.BufferGeometry(); ptsObj.geometry.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  lineObj.geometry.dispose(); lineObj.geometry = new THREE.BufferGeometry(); lineObj.geometry.setAttribute('position', new THREE.Float32BufferAttribute(Lseg, 3));
  const hp = pts.find(q => q.p === Math.floor(S.res.profileOffsets.length / 2));
  houseXZ = hp ? byP.get(hp.p) : null;
}
function frame() {
  requestAnimationFrame(frame);
  const v = V(); if (!v || !v.cur || !v.SWELL.layer) return;
  if (v.SWELL.layer !== S.layer) { el.box.style.display = ''; onLayer(v.SWELL.layer); }
  showSwellState(v);
  const sp = spot();
  const show = !!(sp && sp.stageA && sp.layers.includes(v.SWELL.layer) && v.cur.cfg === v.LAYERS[sp.layers[0]] && S.lineOn && S.res && !v.BEACH.active);
  group.visible = show;
  if (!show) { tagEl.style.display = 'none'; return; }
  if (!group.parent) v.scene.add(group);
  if (S.dirty) { rebuildLine(v.cur.meta.origin); S.dirty = false; }
  const y = S.p.tide * v.material.uniforms.uExag.value + 0.5;
  group.position.y = y;
  if (houseXZ && S.res.status === 'reef') {
    const p = new THREE.Vector3(houseXZ[0], y + 20, houseXZ[1]).project(v.camera);
    const dist = S.res.site === 'pipeline' ? `${Math.round(S.res.breakHouse - S.res.shoreS)} m from shore` : `${Math.round(S.res.breakHouse)} m`;
    if (p.z < 1) { tagEl.style.display = ''; tagEl.textContent = `modelled break (forecast ${S.p.hs.toFixed(1)} m, ${S.p.tp.toFixed(0)} s): ${dist}`;
      tagEl.style.left = ((p.x + 1) / 2 * innerWidth) + 'px'; tagEl.style.top = ((1 - p.y) / 2 * innerHeight) + 'px';
      if (v.tagFree) v.tagFree(tagEl); }   // hidden this frame if it would sit on a reef label (main.js declutter)
    else tagEl.style.display = 'none';
  } else tagEl.style.display = 'none';
}

// ---------- what the swell on screen is ----------
// main.js draws the swell through V.buildSwell (play.js and this file call it). Wrap it once to record, per layer, whether
// the picture is a forecast hour, the Play sliders, or the map's own file.
function watchBuildSwell(v) {
  if (v.buildSwell.__live) return;
  const orig = v.buildSwell;
  const wrapped = d => {
    const out = orig(d), layer = v.SWELL.layer;
    if (d && d.meta && d.meta.live_forecast) S.onScreen[layer] = { kind: 'forecast', label: d.meta.live_forecast };
    else if (d === v.SWELL.file_data) S.onScreen[layer] = { kind: 'file' };
    else {   // play.js redraw: still "forecast" while the sliders hold exactly what the hand-off put there
      const P = window.__play && window.__play.params, h = S.playHand;
      S.onScreen[layer] = h && sameInputs(P, h.inputs) ? { kind: 'forecast', label: h.label } : { kind: 'sliders' };
    }
    return out;
  };
  wrapped.__live = true; v.buildSwell = wrapped;
}
function showSwellState(v) {
  watchBuildSwell(v);
  const L = v.LAYERS[v.SWELL.layer], has = !!(L && L.swellFile);
  let html = '';
  if (has) {
    const st = v.SWELL.on && v.SWELL.data ? (S.onScreen[v.SWELL.layer] || { kind: 'file' }) : null;
    html = swellStateText(st && st.kind === 'file' ? { kind: 'file', label: v.SWELL.file_data && v.SWELL.file_data.meta && v.SWELL.file_data.meta.case } : st);
    el.back.style.display = st && st.kind !== 'file' && spot() && spot().swell && spot().swell.mode === 'model' ? '' : 'none';
    const txt = document.getElementById('swl-on-text');
    if (txt && !L.portugal) txt.textContent = st && st.kind === 'forecast' ? 'Simulated swell, driven by a forecast hour (illustrative)' : 'Simulated swell (illustrative, not a forecast)';
  } else el.back.style.display = 'none';
  if (html !== S.stateHtml) { S.stateHtml = html; el['swell-state'].innerHTML = html; }
}

// ---------- "Generate swell from the forecast" ----------
async function ensureSwellOn(v) {
  if (!v.SWELL.on) { const cb = document.getElementById('swl-on'); cb.checked = true; cb.dispatchEvent(new Event('change')); }
  await v.loadSwell();
  for (let i = 0; i < 200 && !v.SWELL.data; i++) await new Promise(r => setTimeout(r, 50));   // another call may be loading it
  return !!v.SWELL.data;
}
const models = {};                                    // spot key -> Promise of makeModel() on that map's points (float64 JSON)
function mapModel(sp, v) {
  // The points come from main.js's loader as float64 (the same doubles as the JSON): its Float32 drawing copy would flip
  // wet/dry ties and not reproduce the shipped file (validate_spot_swell.mjs --f32). No second download.
  // One model at a time here (the worker keeps at most two): a Guéthary model with its cached normals is ~100 MB.
  for (const k of Object.keys(models)) if (k !== sp.key) delete models[k];
  if (!models[sp.key]) models[sp.key] = v.loadPoints(sp.swell.file, sp.name + ' points')
    .then(pts => makeModelAsync(pts, SPOT_GRIDS[sp.swell.grid], sp.key))
    .catch(err => { delete models[sp.key]; throw err; });
  return models[sp.key];
}
let handSeq = 0;
async function handOff() {
  const v = V(), sp = spot(), m = cur(), t = m.t[S.i];
  const fileTide = v.SWELL.file_data ? (v.SWELL.file_data.meta.config.tide_above_datum_m ?? v.SWELL.file_data.meta.config.tide_above_lat_m ?? 0) : 0;
  const h = swellHandoff(sp, S.p, m.name, t, S.layer, fileTide);
  if (!h.ok) { el['play-note'].textContent = h.why; return; }
  const q = h.inputs, extra = (h.clamped.length ? ` Clamped to the model's range: ${h.clamped.join(', ')}.` : '') +
    (h.noTide ? ` No forecast sea level for this hour: the map's own tide (${fileTide} m) is used.` : '');
  if (h.mode === 'play') {
    const P = window.__play;
    if (!P) { el['play-note'].textContent = 'The Play box is not loaded.'; return; }
    S.playHand = h;
    await P.set(q);
    el['play-note'].textContent = `Play box set to ${q.H0} m, ${q.T} s, from ${q.dir}°, tide ${q.tide} m (strict). It runs the simpler swell model, so its picture is illustrative.${extra}`;
    return;
  }
  el['play-note'].textContent = 'Running the swell model in your browser...';
  const mine = ++handSeq, layer0 = v.SWELL.layer;
  const stale = () => mine !== handSeq || spot() !== sp || v.SWELL.layer !== layer0 || !sp.layers.includes(v.SWELL.layer);   // another hand-off, a new spot or a new map since this one started
  if (!(await ensureSwellOn(v))) throw new Error('swell layer did not load');
  if (stale()) return;
  const model = await mapModel(sp, v);
  if (stale()) return;
  const t0 = performance.now(), res = await model.run(q), ms = performance.now() - t0;   // ms: wall time in the worker round trip; the page stays responsive
  if (stale()) return;                               // a result for the spot or hour that is no longer on screen is dropped
  const base = v.SWELL.file_data.meta, c = base.config;
  const meta = { ...base, mode: 'STRICT', label: '', live_forecast: h.label,
    config: { ...c, H0_m: q.H0, T_s: q.T, direction_from_deg: q.dir, tide_above_datum_m: q.tide, omega_rad_s: 2 * Math.PI / q.T },
    viewer_note: `Swell from the ${h.label}: ${q.H0} m, ${q.T} s, from ${q.dir}°, computed in your browser by the same model as this map's typical swell. Model driven by forecast input, illustrative, not a prediction of each wave.` };
  v.buildSwell({ meta, ...res.points });
  el['play-note'].textContent = `Drawn: ${q.H0} m, ${q.T} s, from ${q.dir}° (strict), water level ${q.tide} m ${sp.tide.words}. Model ${ms.toFixed(0)} ms.${extra}`;
}
function backToFile() {
  const v = V(); if (!v.SWELL.file_data) return;
  v.buildSwell(v.SWELL.file_data);
  el['play-note'].textContent = '';
}

// ---------- start ----------
buildPanel();
requestAnimationFrame(frame);
window.__live = { S, lookups, lookupFor, update, selectSpot, handOff, backToFile };
