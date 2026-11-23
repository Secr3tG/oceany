// Live earthquake layer for the Oceany globe: USGS real-time feed, magnitude 2.5 and up, past 7 days, as dots.
// Data: USGS Earthquake Hazards Program GeoJSON summary feeds (public domain, updated every minute); see SOURCES.md.
//
//   const layer = await createLayer({ THREE, radius: 1, makeDotMaterial, palette });
//   layer.update(t)                   every frame: animation time; fetches only while the layer is visible
//   layer.label / .details / .status short honest strings for the panel (status says "feed unavailable" when it is)
//   layer.setDim(k), layer.setPalette(name)
//
// What is data: each dot is one earthquake in the feed: epicentre, magnitude (dot size), depth (colour, same ramp as the
// history layer) and time (older quakes are dimmer). What is ours: the slow ring round quakes of the past 6 hours. It is
// a marker that says "recent", nothing more; it does not show shaking or reach, and its size is set in screen pixels.
// Calm on purpose: no flashing, no red, no sound, no alerts of any kind.
//
// GPU: one Points buffer, rebuilt only when the feed brings new data (every 5 minutes at most). Age, fade and ring are
// worked out in the vertex shader from a clock uniform, so nothing loops over the dots per frame.

import { LIFT, toXYZ, DEPTH_GLSL, DOT_FRAG, depthUniforms, setDepthUniforms, paletteName, borrowScale, fmtUTC, fmtDay } from './quakes_common.js';

const FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/';
const DAY_URL = FEED + '2.5_day.geojson';     // ~50 quakes, a few tens of KB: polled
const WEEK_URL = FEED + '2.5_week.geojson';   // ~350 quakes, ~300 KB: at start and every 30 minutes
const DAY_MS = 5 * 60e3, WEEK_MS = 30 * 60e3, RETRY_MS = 2 * 60e3;
const KEEP_H = 7 * 24;        // drop quakes older than the week feed covers
const RING_H = 6;             // quakes younger than this get the slow ring
const RING_DOTS = 18;          // review 2026-11-23: 14 dots at 1.7 px left a ring too sparse to read
const RING_PERIOD = 11.0;     // seconds per ring; each quake starts at its own phase, so rings never pulse together

const VERT = /* glsl */`
  uniform float uTime, uNowH, uScale, uDim, uPx, uRingH, uPeriod;
  attribute vec4 aQ;          // x magnitude, y depth km, z event time (hours from the build clock), w seed 0..1
  attribute float aRing;      // -1: the quake's dot; 0..1: a ring dot's angle
  varying vec3 vColor; varying float vAlpha;
  ${DEPTH_GLSL}
  void main() {
    float m = aQ.x, age = uNowH - aQ.z;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float facing = dot(normalize(-mv.xyz), normalize(normalMatrix * normalize(position)));
    float limb = smoothstep(0.0, 0.25, facing);
    float dm = max(0.0, m - 2.5);
    vColor = depthColour(aQ.y);
    if (aRing < 0.0) {        // THE QUAKE: size by magnitude (world size, held between a floor and a cap in pixels)
      float s = 0.0062 * pow(1.5, dm);                 // review: M2.5 now the size of a globe dot (0.0058), M4.5 ~2.2x, M6.5 ~5x
      vAlpha = uDim * limb * mix(1.0, 0.45, smoothstep(24.0, 168.0, age));
      gl_PointSize = clamp(s * uScale / -mv.z, (2.4 + 1.2 * dm) * uPx, (5.0 + 4.5 * dm) * uPx);
      gl_Position = vAlpha < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
      return;
    }
    // RING (recent quakes only): a few dots on a circle that widens slowly and fades, then starts again
    float ph = fract(uTime / uPeriod + aQ.w);
    float fade = 1.0 - smoothstep(0.5 * uRingH, uRingH, age);
    vAlpha = uDim * limb * fade * 0.8 * pow(1.0 - ph, 1.5) * smoothstep(0.0, 0.08, ph);
    float rPx = ((4.0 + 1.5 * dm) + ph * (14.0 + 4.0 * dm)) * uPx;   // review: starts just outside the dot, ends ~26-36 px out
    vec3 n = normalize(position);
    vec3 e1 = normalize(abs(n.y) > 0.99 ? cross(n, vec3(1.0, 0.0, 0.0)) : cross(n, vec3(0.0, 1.0, 0.0)));
    vec3 e2 = cross(n, e1);
    float th = 6.2831853 * (aRing + uTime * 0.008);          // turns very slowly
    float rW = rPx * -mv.z / uScale;                           // pixels -> world units at this distance
    vec4 mv2 = modelViewMatrix * vec4(position + (e1 * cos(th) + e2 * sin(th)) * rW, 1.0);
    gl_PointSize = 2.6 * uPx;
    gl_Position = vAlpha < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv2;
  }`;

export async function createLayer({ THREE, radius = 1.0, makeDotMaterial, palette } = {}) {
  const group = new THREE.Group();
  group.name = 'quakes-live';
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  let clock0 = Date.now();      // shader time base, reset on each rebuild (keeps float precision)
  const uniforms = { uTime: { value: 0 }, uNowH: { value: 0 }, uScale: borrowScale(makeDotMaterial), uDim: { value: 1 }, uPx: { value: dpr },
    uRingH: { value: RING_H }, uPeriod: { value: RING_PERIOD }, ...depthUniforms(THREE) };
  const mat = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: DOT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
  const points = new THREE.Points(new THREE.BufferGeometry(), mat);
  points.frustumCulled = false; points.visible = false; points.name = 'quake-live-dots';
  group.add(points);

  let pal = '';
  const setPalette = (name) => { if (name !== pal) { pal = name; setDepthUniforms(uniforms, name); } };
  setPalette(paletteName(palette));

  const quakes = new Map();   // id -> { lat, lon, depth, mag, time, place }
  let built = null;
  function build() {
    const now = Date.now(), list = [];
    for (const [id, e] of quakes) { if ((now - e.time) / 3.6e6 > KEEP_H) quakes.delete(id); else list.push(e); }
    list.sort((a, b) => a.mag - b.mag);            // strongest drawn last
    clock0 = now;
    const nRing = list.filter((e) => (now - e.time) / 3.6e6 < RING_H).length;
    const n = list.length + nRing * RING_DOTS;
    const pos = new Float32Array(n * 3), q = new Float32Array(n * 4), ring = new Float32Array(n);
    let d = 0;
    const seedOf = (e) => { const x = Math.sin(e.time * 1e-5 + e.lat * 12.9898 + e.lon * 78.233) * 43758.5453; return x - Math.floor(x); };
    const put = (e, r) => {
      toXYZ(e.lat, e.lon, radius * LIFT, pos, d * 3);
      q[d * 4] = e.mag; q[d * 4 + 1] = Math.max(0, e.depth); q[d * 4 + 2] = (e.time - clock0) / 3.6e6; q[d * 4 + 3] = seedOf(e);
      ring[d] = r; d++;
    };
    for (const e of list) {
      put(e, -1);
      if ((now - e.time) / 3.6e6 < RING_H) for (let k = 0; k < RING_DOTS; k++) put(e, k / RING_DOTS);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aQ', new THREE.BufferAttribute(q, 4));
    g.setAttribute('aRing', new THREE.BufferAttribute(ring, 1));
    points.geometry.dispose(); points.geometry = g;
    const day = list.filter((e) => now - e.time < 864e5);
    const top = list.length ? list[list.length - 1] : null;
    built = { total: list.length, day: day.length, recent: nRing, deep: list.filter((e) => e.depth >= 300).length, top };
  }

  // ---- fetching: only while the layer is visible
  let state = 'waiting', err = '', busy = false, lastDay = -1e12, lastWeek = -1e12, lastOk = null;
  const getJSON = async (url) => {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20e3);
    try { const r = await fetch(url, { signal: ctl.signal, cache: 'no-cache' }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(to); }
  };
  const ingest = (fc) => {
    if (!fc || !Array.isArray(fc.features)) throw new Error('unexpected format');
    for (const f of fc.features) {
      const p = f && f.properties, c = f && f.geometry && f.geometry.coordinates;
      if (!p || !Array.isArray(c) || p.type !== 'earthquake') continue;     // the feed also lists quarry blasts and explosions
      const mag = Number(p.mag), lon = Number(c[0]), lat = Number(c[1]), depth = Number(c[2]), time = Number(p.time);
      if (![mag, lon, lat, time].every(isFinite)) continue;
      quakes.set(String(f.id), { lat, lon, depth: isFinite(depth) ? depth : 0, mag, time, place: typeof p.place === 'string' ? p.place : '' });
    }
  };
  async function refresh(week) {
    busy = true;
    const t = Date.now(); lastDay = t; if (week) lastWeek = t;
    try {
      ingest(await getJSON(week ? WEEK_URL : DAY_URL));
      build(); state = 'ok'; err = ''; lastOk = new Date();
    } catch (e) {
      err = e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'network error';
      state = built ? 'refresh-failed' : 'failed';   // with nothing built, update() retries the week feed after RETRY_MS
    } finally { busy = false; text(); }
  }

  const DETAILS =
    `Earthquakes of magnitude 2.5 and up from the USGS real-time feeds (past day, polled every 5 minutes while this layer is on, ` +
    `and past 7 days, every 30 minutes). One dot per quake at its epicentre: size grows with magnitude, colour is depth ` +
    `(pale for shallow, the accent at 70 km, cooler down to violet for deep quakes, 300-700 km), older quakes are dimmer. ` +
    `A slow ring of dots marks quakes from the past ${RING_H} hours; it means "recent" only, not shaking or reach. ` +
    `Outside the United States the feed is complete only from about magnitude 4.5, so many smaller quakes elsewhere are missing. ` +
    `Magnitudes and locations are first estimates and are revised by USGS for hours to days. ` +
    `For official earthquake information use earthquake.usgs.gov or your national service. Not an official USGS product. Do not use for safety decisions. ` +
    `U.S. Geological Survey data, public domain.`;
  function text() {
    group.label = state === 'failed' ? 'Earthquakes live (USGS): feed unavailable' : 'Earthquakes live (USGS, M2.5+, past 7 days)';
    group.details = DETAILS;
    const b = built, top = b && b.top;
    const topTxt = top ? ` Strongest: M${top.mag.toFixed(1)}${top.place ? ', ' + top.place : ''}, ${fmtDay(new Date(top.time))}.` : '';
    group.status =
      state === 'waiting' ? 'Loading the USGS earthquake feed…'
      : state === 'failed' ? `USGS earthquake feed unavailable (${err}); nothing drawn. Retrying in 2 minutes.`
      : `${b.total} quakes in the past 7 days, ${b.day} in the past day; ${b.deep} deeper than 300 km.${topTxt}` +
        (b.recent ? ` Rings: ${b.recent} in the past ${RING_H} h.` : '') +
        ` Updated ${fmtUTC(lastOk)}.` +
        (state === 'refresh-failed' ? ` Last refresh failed (${err}); showing the data from ${fmtUTC(lastOk)}.` : '');
    points.visible = !!built;
    group.userData.onChange?.(group);
  }

  group.update = (t) => {
    if (!group.visible) return;            // hidden: no fetch, no work
    setPalette(paletteName(palette));
    uniforms.uTime.value = t;
    uniforms.uNowH.value = (Date.now() - clock0) / 3.6e6;
    if (busy || document.hidden) return;
    const now = Date.now(), okGap = state === 'ok' || state === 'refresh-failed';
    if (now - lastWeek > (okGap ? WEEK_MS : RETRY_MS)) refresh(true);
    else if (built && now - lastDay > (state === 'ok' ? DAY_MS : RETRY_MS)) refresh(false);
  };
  group.setDim = (k) => { uniforms.uDim.value = Math.max(0, Math.min(1, k)); };
  group.setPalette = (name) => setPalette(name);
  group.userData = { points, urls: { DAY_URL, WEEK_URL }, get stats() { return built; }, get state() { return state; }, quakes, refresh };
  text();
  return group;
}
