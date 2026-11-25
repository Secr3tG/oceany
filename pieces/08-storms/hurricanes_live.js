// Hurricanes live: tropical cyclones active right now, from NHC's advisories (Atlantic, East and Central Pacific), plus
// the recent tracks of storms in other basins from NOAA IBTrACS ACTIVE (provisional, days behind; never called live).
// For research and play only. Not a forecast or warning service. Not an official product. Do not use for safety decisions.
//
//   const layer = await createLayer({ THREE, radius: 1, makeDotMaterial, palette });
//   layer.getFocusTargets()   // [{lat, lon, rating, name, id, wind}] strongest first (a storm picked on its card comes first)
//   layer.label / layer.status / layer.details
//
// Data: data/live_storms.json, built by build_hurricanes_live.py at NHC's advisory times (refresh-layers workflow) and
// read through ../07-globe/data-source.js (layer "hurricanes-live"); ?storms_live=test loads data/live_storms_test.json,
// an archived advisory (Milton, advisory 12, 8 Oct 2024) marked TEST on its card.
//
// What is drawn, all as the globe's dots in the current palette:
//   past track    the best track so far (NHC), coloured by recorded wind; brightness = category, as in the replay layer
//   now           a small turning ring of dots at the advisory position (counter-clockwise north, clockwise south)
//   forecast      NHC's forecast centre positions to 5 days, fainter dots (a forecast, not a record)
//   cone          NHC's cone: a faint outline and a sparse, still fill. It is where the CENTRE will probably be (NHC sizes it
//                 so about two thirds of its past 5-year forecast errors fall inside); it says nothing about the storm's size.
// Cards: one per storm (name, kind and category, wind, pressure, advisory time, "Advisory from NHC" link, Fly), a calm
// "No active storms" card when there are none, and the two safety lines on every card stack.
// Plumbing for Benn: the DOM and geometry code; the parts worth reading are catColor, the cone note and the card text.
import { layerFile, onLayerUpdate, USE_R2 } from '../07-globe/data-source.js';
import { D2R, toXYZ } from './dots_common.js';

export const LAYER_ID = 'hurricanes-live';
export const SAFETY = ['For research and play only. Not a forecast or warning service.', 'Not an official product. Do not use for safety decisions.'];
const TEST = new URLSearchParams(location.search).get('storms_live') === 'test';
const KM = 1 / 6371;
const catOf = (w) => (w >= 137 ? 5 : w >= 113 ? 4 : w >= 96 ? 3 : w >= 83 ? 2 : w >= 64 ? 1 : 0);

// The live list (also used by the replay layer for its "live storms exist" hint). Never throws: null when unreadable.
export async function loadLiveStorms() {
  try {
    const local = new URL(TEST ? './data/live_storms_test.json' : './data/live_storms.json', import.meta.url);
    const u = TEST ? local : await layerFile(LAYER_ID, 'live_storms.json', local);
    if (USE_R2 && !TEST && String(u) === String(local)) return null;   // hosted page, R2 unreadable: the bundled copy is not live
    const r = await fetch(u, { cache: 'no-cache' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && Array.isArray(j.storms) ? j : null;
  } catch (e) { return null; }
}

// the replay layer's colour rule (hurricanes.js catColor): weak = palette mid, category 3 = shallow, 5 = toward white
function catColor(pal, c) {
  const m = pal.mid, s = pal.shallow;
  if (c < 3) { const f = c / 3; return [m[0] + (s[0] - m[0]) * f, m[1] + (s[1] - m[1]) * f, m[2] + (s[2] - m[2]) * f]; }
  const f = 0.6 * (c - 3) / 2; return [s[0] + (1 - s[0]) * f, s[1] + (1 - s[1]) * f, s[2] + (1 - s[2]) * f];
}
// continuous category from wind (so a 60 kt storm is a little brighter than a 35 kt one): 34 kt = 0, then Saffir-Simpson
const catF = (w) => (w == null ? 0 : w < 64 ? Math.max(0, (w - 34) / 30) * 0.9 : w < 83 ? 1 + (w - 64) / 19 : w < 96 ? 2 + (w - 83) / 13 : w < 113 ? 3 + (w - 96) / 17 : w < 137 ? 4 + (w - 113) / 24 : 5);

// great-circle steps between two [lat, lon] points, every ~stepKm (the end point excluded)
function along(a, b, stepKm, cb) {
  const p = [0, 0, 0], q = [0, 0, 0]; toXYZ(a[0], a[1], 1, p, 0); toXYZ(b[0], b[1], 1, q, 0);
  const ang = Math.acos(Math.max(-1, Math.min(1, p[0] * q[0] + p[1] * q[1] + p[2] * q[2])));
  const n = Math.max(1, Math.round(ang / (stepKm * KM)));
  for (let i = 0; i < n; i++) {
    const f = i / n, s0 = ang > 1e-9 ? Math.sin((1 - f) * ang) / Math.sin(ang) : 1 - f, s1 = ang > 1e-9 ? Math.sin(f * ang) / Math.sin(ang) : f;
    const x = s0 * p[0] + s1 * q[0], y = s0 * p[1] + s1 * q[1], z = s0 * p[2] + s1 * q[2], L = Math.hypot(x, y, z);
    cb(x / L, y / L, z / L, f);
  }
}
// point in a [lat, lon] ring (ray casting in lon/lat; cones are small, so the flat test is fine)
function inRing(ring, la, lo) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ya, xa] = ring[i], [yb, xb] = ring[j];
    if ((ya > la) !== (yb > la) && lo < ((xb - xa) * (la - ya)) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}
const fmtUTC = (iso) => {
  const d = new Date(iso); if (isNaN(d)) return '';
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
};
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const kindLine = (s) => (s.source === 'NHC'
  ? (s.cat ? `${s.kind === 'Major hurricane' ? 'Major hurricane' : 'Hurricane'}, category ${s.cat}` : s.kind || 'Tropical cyclone')
  : (s.cat ? `Category ${s.cat} equivalent` : (s.windKt >= 34 ? 'Tropical storm strength' : 'Tropical depression strength')));

export async function createLayer({ THREE, radius = 1.0, makeDotMaterial, palette } = {}) {
  const pal = palette || { shallow: [0.35, 1, 0.95], mid: [0.1, 0.5, 0.95], deep: [0.03, 0.08, 0.45], dim: [0.42, 0.53, 0.59] };
  const group = new THREE.Group();
  const mat = (size, opacity, maxPx = 18) => (makeDotMaterial
    ? makeDotMaterial({ size, vertexColors: true, opacity, maxPx })
    : new THREE.PointsMaterial({ size, vertexColors: true, opacity, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  // review 2026-11-24 (headless, 1440x900): too faint at whole globe and mid zoom; raised, and the track dots grow with distance (update)
  const BASE = { past: 0.0036, fc: 0.003, fcPt: 0.0055, cone: 0.0028, fill: 0.003 };
  const mats = { past: mat(BASE.past, 0.9, 12), fc: mat(BASE.fc, 0.6, 10), fcPt: mat(BASE.fcPt, 0.8, 14), cone: mat(BASE.cone, 0.5, 8),
    fill: mat(BASE.fill, 0.18, 8), ring: mat(0.005, 0.95, 18), core: mat(0.012, 0.6, 30) };
  let data = null, parts = [], markers = [], prefer = null, preferT = 0, palKey = '';

  const points = (pos, col, m) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const p = new THREE.Points(g, m); p.frustumCulled = false; return p;
  };
  const dimTo = (c, k) => c.map((x) => x * k);

  function build() {
    for (const o of parts) { group.remove(o); o.geometry.dispose(); }
    parts = []; markers = [];
    if (!data) return;
    const all = [...data.storms, ...(data.recent || [])];
    const P = { past: [[], []], fc: [[], []], fcPt: [[], []], cone: [[], []], fill: [[], []] };
    const put = (key, x, y, z, r, c) => { P[key][0].push(x * r, y * r, z * r); P[key][1].push(c[0], c[1], c[2]); };
    for (const s of all) {
      const live = s.source === 'NHC', k = live ? 1 : 0.6;   // recent (IBTrACS) tracks: dimmer, no forecast, no cone
      // past track: every ~25 km, colour by the recorded wind between fixes
      const past = s.past || [];
      for (let i = 0; i + 1 < past.length; i++) {
        const a = past[i], b = past[i + 1];
        along(a, b, 25, (x, y, z, f) => put('past', x, y, z, radius * 1.003, dimTo(catColor(pal, catF(a[2] + (b[2] - a[2]) * f)), k)));
      }
      if (past.length) { const e = past[past.length - 1], v = [0, 0, 0]; toXYZ(e[0], e[1], 1, v, 0); put('past', v[0], v[1], v[2], radius * 1.003, dimTo(catColor(pal, catF(e[2])), k)); }
      // forecast: a fainter dotted line through the forecast points, a slightly larger dot at each forecast time
      const fc = s.forecast || [];
      for (let i = 0; i + 1 < fc.length; i++) along(fc[i], fc[i + 1], 45, (x, y, z, f) => {
        if (f > 0) put('fc', x, y, z, radius * 1.003, dimTo(catColor(pal, catF(fc[i][2] + (fc[i + 1][2] - fc[i][2]) * f)), 0.7));
      });
      for (const p of fc.slice(1)) { const v = [0, 0, 0]; toXYZ(p[0], p[1], 1, v, 0); put('fcPt', v[0], v[1], v[2], radius * 1.0032, dimTo(catColor(pal, catF(p[2])), 0.8)); }
      // cone: outline every ~20 km, fill on a ~45 km lattice (still, faint): palette mid, a little grey
      const coneC = [pal.mid[0] * 0.7 + 0.12, pal.mid[1] * 0.7 + 0.12, pal.mid[2] * 0.7 + 0.12];
      for (const ring of s.cone || []) {
        for (let i = 0; i + 1 < ring.length; i++) along(ring[i], ring[i + 1], 20, (x, y, z) => put('cone', x, y, z, radius * 1.0025, coneC));
        let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
        for (const [la, lo] of ring) { la0 = Math.min(la0, la); la1 = Math.max(la1, la); lo0 = Math.min(lo0, lo); lo1 = Math.max(lo1, lo); }
        const dLa = 45 / 111;
        for (let la = la0 + dLa / 2, row = 0; la < la1; la += dLa, row++) {
          const dLo = dLa / Math.max(0.2, Math.cos(la * D2R));
          for (let lo = lo0 + (row % 2 ? dLo / 2 : 0); lo < lo1; lo += dLo) {
            if (!inRing(ring, la, lo)) continue;
            const v = [0, 0, 0]; toXYZ(la, lo, 1, v, 0); put('fill', v[0], v[1], v[2], radius * 1.002, coneC);
          }
        }
      }
      // now: a turning ring (12 dots) + 2 short arms + a soft core, built flat in the local tangent plane
      const pos = [], col = [], cc = catColor(pal, catF(s.windKt));
      for (let i = 0; i < 12; i++) { const a = (i / 12) * 2 * Math.PI; pos.push(Math.cos(a), Math.sin(a), 0); col.push(...dimTo(cc, k)); }
      for (let arm = 0; arm < 2; arm++) for (let i = 1; i <= 5; i++) {
        const r = 1 + i * 0.28, a = arm * Math.PI + i * 0.5;           // arms trail outward like rain bands (illustrative)
        pos.push(r * Math.cos(a), r * Math.sin(a), 0); col.push(...dimTo(cc, k * (1 - i * 0.14)));
      }
      const ring = points(pos, col, mats.ring), core = points([0, 0, 0], dimTo(cc, k * 0.8), mats.core);
      const mk = new THREE.Group(); mk.add(ring, core);
      const n = new THREE.Vector3(), v = [0, 0, 0]; toXYZ(s.lat, s.lon, 1, v, 0); n.set(v[0], v[1], v[2]);
      mk.position.copy(n).multiplyScalar(radius * 1.004);
      mk.userData.q0 = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      mk.userData.spin = s.lat >= 0 ? 1 : -1;                        // counter-clockwise seen from above in the north
      mk.quaternion.copy(mk.userData.q0);
      group.add(mk); markers.push(mk); parts.push(ring, core);
    }
    for (const key of Object.keys(P)) if (P[key][0].length) { const p = points(P[key][0], P[key][1], mats[key]); p.renderOrder = key === 'fill' ? 0 : 1; group.add(p); parts.push(p); }
  }

  // ---- cards (DOM). One stack, bottom left, shown with the layer. Calm: no motion, no colour alarms.
  injectCss();
  const box = document.createElement('section'); box.id = 'storms-live'; box.hidden = true; box.setAttribute('aria-label', 'Hurricanes live');
  document.body.appendChild(box);
  let collapsed = matchMedia('(max-width: 600px)').matches;
  const el = (tag, cls, txt, parent) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; if (parent) parent.appendChild(e); return e; };

  function fly(s) {
    prefer = s.id; preferT = performance.now();
    const ev = new CustomEvent('oceany:fly-storm', { detail: { layerId: (group.userData && group.userData.layerId) || LAYER_ID, id: s.id, handled: false } });
    dispatchEvent(ev);
    if (!ev.detail.handled) { note.textContent = `Use "Fly to strongest storm" under the layer: ${s.name} is now first in line.`; note.scrollIntoView({ block: 'nearest' }); }
  }
  let note = null;
  function render() {
    box.textContent = '';
    const head = el('button', 'sl-head', null, box); head.type = 'button'; head.setAttribute('aria-expanded', String(!collapsed));
    const n = data ? data.storms.length : 0, nr = data && data.recent ? data.recent.length : 0;
    el('span', 'sl-title', 'Hurricanes live', head);
    el('span', 'sl-count', !data ? 'not available' : n ? `${n} active` : 'none active', head);
    head.onclick = () => { collapsed = !collapsed; render(); };
    if (collapsed) return;
    const list = el('div', 'sl-list', null, box);
    if (!data) el('div', 'sl-card sl-empty', 'The live storm list is not available right now. Nothing is shown rather than an old list.', list);
    else {
      if (!n) {
        const c = el('div', 'sl-card sl-empty', null, list);
        el('div', 'sl-name', 'No active storms', c);
        el('div', null, 'NHC lists no tropical cyclone in the Atlantic or the East and Central Pacific right now.', c);
        el('div', 'sl-dim', `Checked at each advisory time (03, 09, 15, 21 UTC). Last change ${fmtUTC(data.built)}.`, c);
      }
      for (const s of [...data.storms, ...(data.recent || [])]) {
        const live = s.source === 'NHC', c = el('div', 'sl-card' + (live ? '' : ' sl-recent'), null, list);
        if (data.test && live) el('div', 'sl-tag', `TEST · archived advisory, ${fmtUTC(s.advisoryTime)}`, c);
        if (!live) el('div', 'sl-tag', 'Recent track, not live', c);
        el('div', 'sl-name', `${live ? (s.cat ? 'Hurricane' : s.kind || '') : ''} ${s.name}`.trim(), c);
        if (!live || s.cat) el('div', null, kindLine(s), c);
        const w = s.windKt != null ? `${Math.round(s.windKt)} kt (${Math.round(s.windKt * 1.15078 / 5) * 5} mph)` : 'wind not given';
        el('div', null, `Wind ${w}` + (s.pressureMb ? ` · ${Math.round(s.pressureMb)} mb` : ''), c);
        if (live && s.moveKt != null && s.moveDir != null) el('div', 'sl-dim', `Moving ${COMPASS[Math.round(s.moveDir / 22.5) % 16]} at ${Math.round(s.moveKt)} kt`, c);
        if (live) el('div', 'sl-dim', `Advisory ${s.advisory || ''} · ${fmtUTC(s.advisoryTime)} · position ${fmtUTC(s.positionTime)}`, c);
        const ageH = (Date.now() - new Date(s.advisoryTime).getTime()) / 36e5;
        if (live && !data.test && ageH > 12) el('div', 'sl-dim', `This advisory is ${Math.round(ageH)} h old (NHC issues one every 6 h): this list may be out of date. See nhc.noaa.gov.`, c);
        if (!live) el('div', 'sl-dim', `Last record ${fmtUTC(s.positionTime)} (IBTrACS, provisional; no forecast)`, c);
        const row = el('div', 'sl-row', null, c);
        const a = el('a', 'sl-link', live ? 'Advisory from NHC ↗' : 'IBTrACS ↗', row); a.href = s.link; a.target = '_blank'; a.rel = 'noopener';
        const b = el('button', 'sl-fly', 'Fly', row); b.type = 'button'; b.onclick = () => fly(s);
      }
      if (!nr && !data.test) el('div', 'sl-dim sl-pad', 'Other basins: no recent storm in IBTrACS (provisional, updated about three times a week).', list);
      if (n) el('div', 'sl-dim sl-pad', 'Cone: where the centre will probably be (about 2 in 3 of NHC\'s past forecast errors fell inside). It does not show the storm\'s size: wind, rain and surge reach well outside it.', list);
    }
    note = el('div', 'sl-dim sl-pad', '', list);
    const f = el('div', 'sl-foot', null, list);
    for (const t of SAFETY) el('div', null, t, f);
    el('div', 'sl-dim', 'Source: NOAA National Hurricane Center; other basins NOAA IBTrACS. Redrawn by Oceany; not official, not endorsed by NOAA/NWS.', f);
  }

  // b58 (Benn's phone): the box shows only while NHC lists an active storm. "None active" / "not available" stays in the
  // layer's own line in the Layers panel (group.status) instead of a box always on screen.
  const syncDom = () => { const on = !!group.visible && !!data && data.storms.length > 0; if (box.hidden === on) box.hidden = !on; };
  setInterval(syncDom, 400);

  function statusLine() {
    if (!data) return 'Live storm list not available.';
    const n = data.storms.length, nr = (data.recent || []).length;
    const t = data.test ? 'TEST (archived advisory). ' : '';
    if (!n) return `${t}No active storms (NHC).` + (nr ? ` ${nr} recent track${nr > 1 ? 's' : ''} in other basins (IBTrACS, not live).` : '');
    const s = [...data.storms].sort((a, b) => (b.windKt || 0) - (a.windKt || 0))[0];
    return `${t}${n} active storm${n > 1 ? 's' : ''} (NHC); strongest: ${s.name}, ${Math.round(s.windKt)} kt, advisory ${fmtUTC(s.advisoryTime)}.`;
  }
  async function reload() {
    data = await loadLiveStorms();
    build(); render(); group.status = statusLine();
  }
  await reload();
  if (USE_R2 && !TEST) onLayerUpdate(LAYER_ID, () => { reload(); });

  // ---- per frame: turn the markers, size them for the camera distance, follow palette changes
  const qs = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1);
  group.update = (t, camera) => {
    const key = pal.mid.join() + pal.shallow.join();
    if (key !== palKey) { if (palKey) build(); palKey = key; }
    const d = camera ? Math.max(0.02, camera.position.length() - radius) : 2;
    const R = Math.min(0.05, Math.max(0.012, 0.03 * d));             // ring radius in globe radii: ~40 km close, ~320 km far
    const sz = R / 0.02;
    mats.ring.uniforms ? (mats.ring.uniforms.uSize.value = 0.004 * Math.sqrt(sz)) : null;
    mats.core.uniforms ? (mats.core.uniforms.uSize.value = 0.012 * sz) : null;
    const grow = Math.min(4, Math.max(1, d / 0.5));                    // track and cone dots: same on screen from mid zoom out
    for (const k of Object.keys(BASE)) if (mats[k].uniforms) mats[k].uniforms.uSize.value = BASE[k] * grow;
    for (const mk of markers) {
      qs.setFromAxisAngle(Z, mk.userData.spin * t * (2 * Math.PI / 14));   // one slow turn every 14 s (display, not wind)
      mk.quaternion.copy(mk.userData.q0).multiply(qs);
      mk.scale.setScalar(R);
    }
    if (prefer && performance.now() - preferT > 8000) prefer = null;
  };
  group.getFocusTargets = () => {
    if (!data) return [];
    const all = [...data.storms, ...(data.recent || [])].map((s) => ({
      lat: s.lat, lon: s.lon, rating: s.cat || catOf(s.windKt || 0), id: s.id, wind: s.windKt || 0,
      name: `${s.name}, ${kindLine(s).toLowerCase()}, ${Math.round(s.windKt || 0)} kt${s.source === 'NHC' ? '' : ' (recent track)'}`,
      live: s.source === 'NHC',
    }));
    all.sort((a, b) => (b.id === prefer) - (a.id === prefer) || b.live - a.live || b.wind - a.wind);
    return all;
  };
  const hazeReach = [0, 1, 2, 3, 4, 5].map((c) => (260 + 60 * c) * KM * radius);   // follow framing: a typical storm's gale reach
  group.label = 'Active tropical cyclones from NHC advisories (Atlantic, East and Central Pacific): position, wind, track, forecast and cone. Other basins: recent IBTrACS tracks, not live.';
  group.details = 'Live storms: NOAA National Hurricane Center CurrentStorms.json and each advisory\'s GIS files (forecast points to 5 days, cone, best track), ' +
    'refreshed at NHC\'s advisory times (03, 09, 15, 21 UTC) and hourly while a storm is active. The cone is NHC\'s: the probable track of the centre, ' +
    'not the storm\'s size. Other basins: NOAA IBTrACS ACTIVE, provisional and days behind, shown as recent tracks without forecast. ' +
    'The turning ring marks the position; its size and turning are for display. ' + SAFETY.join(' ');
  group.userData = { hazeReach, systemHeightR: 0, exaggeration: { height: 1 }, get data() { return data; }, reload, render };
  return group;
}

// once per page: the card stack's look, from the globe's CSS palette variables (dots.js applyCssPalette)
function injectCss() {
  if (document.getElementById('storms-live-css')) return;
  const st = document.createElement('style'); st.id = 'storms-live-css';
  st.textContent = `
  #storms-live { position: fixed; left: 16px; bottom: 16px; width: 272px; max-width: calc(100vw - 32px); z-index: 4; font-size: 12px; line-height: 1.4;
    color: var(--ink, #cfe5f2); background: color-mix(in srgb, var(--panel, #06101a) 84%, transparent); border: 1px solid color-mix(in srgb, var(--dim, #6b8796) 30%, transparent);
    border-radius: 12px; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); box-sizing: border-box; margin-bottom: env(safe-area-inset-bottom, 0px); }
  #storms-live[hidden] { display: none; }
  #storms-live .sl-head { all: unset; box-sizing: border-box; display: flex; justify-content: space-between; align-items: baseline; width: 100%; padding: 9px 12px; cursor: pointer; }
  #storms-live .sl-head:focus-visible { outline: 1px solid var(--open, #5ef2ff); border-radius: 12px; }
  #storms-live .sl-title { font-weight: 600; letter-spacing: .02em; }
  #storms-live .sl-count { color: var(--dim, #6b8796); }
  #storms-live .sl-list { max-height: 30vh; overflow-y: auto; padding: 0 12px 10px; }
  #storms-live .sl-card { padding: 8px 0; border-top: 1px solid color-mix(in srgb, var(--dim, #6b8796) 22%, transparent); }
  #storms-live .sl-recent { opacity: .82; }
  #storms-live .sl-name { font-size: 13px; font-weight: 600; margin-bottom: 1px; }
  #storms-live .sl-tag { font-size: 10.5px; letter-spacing: .05em; text-transform: uppercase; color: var(--dim, #6b8796); margin-bottom: 2px; }
  #storms-live .sl-dim { color: var(--dim, #6b8796); }
  #storms-live .sl-pad { padding-top: 6px; }
  #storms-live .sl-row { display: flex; align-items: center; justify-content: space-between; margin-top: 5px; }
  #storms-live .sl-link { color: var(--open, #5ef2ff); text-decoration: none; }
  #storms-live .sl-link:hover { text-decoration: underline; }
  #storms-live .sl-fly { all: unset; cursor: pointer; padding: 2px 12px; min-height: 24px; border-radius: 12px; color: var(--open, #5ef2ff);
    border: 1px solid color-mix(in srgb, var(--open, #5ef2ff) 45%, transparent); }
  #storms-live .sl-fly:focus-visible { outline: 1px solid var(--open, #5ef2ff); }
  #storms-live .sl-foot { margin-top: 8px; padding-top: 7px; border-top: 1px solid color-mix(in srgb, var(--dim, #6b8796) 22%, transparent); font-size: 11px; }
  @media (max-width: 600px) { #storms-live { left: 8px; right: 70px; width: auto; bottom: 40px; } #storms-live .sl-list { max-height: 26vh; } }`;
  document.head.appendChild(st);
}
