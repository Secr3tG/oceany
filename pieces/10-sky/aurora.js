// Aurora layer for the Oceany globe, all dots. Data: NOAA SWPC OVATION Prime aurora forecast + estimated Kp (see SOURCES.md).
//
//   const layer = await createLayer({ THREE, radius: 1, makeDotMaterial, palette });
//   scene.add(layer);  layer.update(t, camera) every frame
//   layer.label / .details / .status, layer.setDim(k), layer.setPalette(name, palette)
//
// What is data: OVATION gives a 1-degree global grid (360 x 181) of forecast aurora intensity, 0..~100, for one
// "Forecast Time" about 30-90 minutes ahead (solar wind travel time from the L1 monitor to Earth). SWPC says the chance
// of seeing aurora can be taken as roughly proportional to that number. We draw one cell's worth of dots per grid cell:
// how many (density) and how bright both follow the cell's value, and the count is scaled by the cell's true area
// (cos latitude), so the poles are not over-filled.
// What is physics, not this feed: aurora sits about 100-300 km up (SWPC: 80-500 km); we draw rays from 100 to 300 km at
// TRUE height (no vertical exaggeration). Aurora cannot be seen in daylight, so dots where the Sun is above the horizon
// at the forecast time are drawn dim (Sun position computed here, not part of the feed).
// Illustrative: the rays (vertical columns of dots, placed at random inside each 1-degree cell), the colour by height
// (green low, red/violet high: physically reasonable, oxygen green near 100-200 km and red higher, but not in the feed)
// and the slow shimmer. The feed says where and how strong, never the curtain shapes.
//
// GPU: one static Points buffer, rebuilt only when a new forecast arrives (every 5 minutes at most, only while visible).
// The vertex shader does colour, brightness and shimmer from a time uniform; no per-frame loop over dots.

const OVATION_URL = 'https://services.swpc.noaa.gov/json/ovation_aurora_latest.json';
const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
const REFRESH_MS = 5 * 60e3;       // the feed's file changes about every 5 minutes (Cache-Control 60 s); never poll faster
const RETRY_MS = 2 * 60e3;         // after a failure: wait 2 minutes (NWS asks for at least 1)
const STALE_MIN = 60;              // forecast time more than 60 min in the past: say "stale"
const DROP_MIN = 180;              // more than 3 h in the past: draw nothing
const MIN_VALUE = 4;               // cells below 4 (of ~100) are left empty
const H_LOW_KM = 100, H_TOP_KM = 300, EXAG = 1;   // ray bottom and top, true height
const RAYS_AT_100 = 10;            // rays in a cell at value 100 on the equator-sized cell (scaled by cos latitude)
const DOTS_PER_RAY = 8;            // dots up each column
const COLS_PER_RAY = 3;            // a ray is a short east-west sheet of 3 columns (illustrative curtain fragment)
const SHEET_DEG = 0.6;             // its east-west width, kept inside the 1-degree cell
const DOT_SIZE = 0.005;            // world units (globe radius 1); the Earth's dots are 0.0058
const ACTIVE_KP = 5;               // checkActivity: estimated Kp at or above G1 (minor storm) counts as active
const DAY_DIM = 0.15;              // brightness kept on the sunlit side
// Footprint (round 3 #4: at low Kp the rays alone were a few dashes, invisible from the whole globe, with no cue on the
// globe): the oval's crest also gets a faint, flat line of dots at the rays' base height, so the oval shows as a thin faint
// ring at any activity. The crest is read from the same data: for each 1-degree longitude and hemisphere, the cells whose
// value is at least FOOT_CREST x that column's highest value (and at least MIN_VALUE). Brightness still rises with the
// value. Not a claim that aurora is visible there: the rays carry that.
const FOOT_CREST = 0.75;           // share of the column's highest value that counts as the crest
const FOOT_PER_CELL = 5.0;         // footprint dots in a crest cell at the equator (scaled by cos latitude: true area)
const FOOT_ALPHA = 0.6;            // footprint brightness at value MIN_VALUE (rises to FOOT_ALPHA_TOP at 100)
const FOOT_ALPHA_TOP = 0.85;
const FOOT_DAY = 0.35;             // the footprint on the sunlit side: dimmed, not hidden (it marks where, not what you would see)
const FOOT_SIZE = 1.35;            // footprint dot size x DOT_SIZE
const EARTH_KM = 6371, D2R = Math.PI / 180;

// aurora colours per palette (low = ray bottom, top = ray top). Unknown palettes fall back to the palette's own colours.
const AURORA_COLOURS = {
  Ocean: { low: [0.30, 1.0, 0.55], top: [0.80, 0.30, 0.80] },   // green, then a little red-violet
  Ember: { low: [1.0, 0.85, 0.35], top: [0.95, 0.30, 0.10] },   // the Ember palette's gold and red
  Mono:  { low: [0.92, 0.96, 1.0], top: [0.45, 0.50, 0.55] },
};

const VERT = /* glsl */`
  uniform float uTime, uSize, uScale, uMaxPx, uDim, uFootA, uFootTop, uFootDay, uFootSize;
  uniform vec3 uLow, uTop;
  attribute vec4 aRay;          // x ray seed 0..1, y height fraction 0..1 (0 = 100 km), z value 0..1, w longitude (rad)
  attribute float aDay;         // 1 = night side, DAY_DIM = sunlit
  varying vec3 vColor; varying float vAlpha;
  void main() {
    float seed = aRay.x, u = aRay.y, v = aRay.z;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    if (u < 0.0) {              // footprint (aRay.y = -1): a faint flat line marking the forecast oval, no rays, slow wave only
      float facing = dot(normalize(-mv.xyz), normalize(normalMatrix * normalize(position)));
      float wave = 0.85 + 0.15 * sin(uTime * 0.35 + aRay.w * 9.0 + seed * 2.0);
      vAlpha = facing < 0.0 ? 0.0 : uDim * max(aDay, uFootDay) * mix(uFootA, uFootTop, sqrt(v)) * wave;   // far side dropped: no dashes over the limb
      vColor = uLow;
      gl_PointSize = clamp(uFootSize * uSize * uScale / -mv.z, 1.5, uMaxPx);
      gl_Position = vAlpha < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * mv;
      return;
    }
    // brightest just above the ray's base, fading up the ray (illustrative profile)
    float prof = smoothstep(0.0, 0.06, u + 0.02) * (1.0 - 0.75 * u);
    // shimmer (illustrative): a slow brightness wave drifting along longitude, plus a slower flicker per ray
    float wave = 0.72 + 0.28 * sin(uTime * 0.35 + aRay.w * 9.0 + seed * 2.0);
    float flick = 0.8 + 0.2 * sin(uTime * (0.6 + seed) + seed * 40.0);
    vAlpha = uDim * aDay * (0.3 + 0.7 * v) * prof * wave * flick * (0.55 + 0.45 * fract(seed * 13.7));   // per-ray variety
    vColor = mix(uLow, uTop, smoothstep(0.35, 1.0, u));
    gl_PointSize = clamp(uSize * uScale / -mv.z, 1.5, uMaxPx);
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = /* glsl */`   // the globe's dot: round, soft, additive (same as makeDotMaterial)
  varying vec3 vColor; varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    gl_FragColor = vec4(vColor, pow(1.0 - r, 2.0) * 0.85 * vAlpha);
  }`;

// small seeded random numbers, so the same forecast always gives the same dots
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// the point under the Sun (degrees) at a UTC time: low-precision solar position, good to about a degree
function subsolar(date) {
  const d = (date.getTime() / 864e5) + 2440587.5 - 2451545.0;
  const g = (357.529 + 0.98560028 * d) * D2R, q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R, e = (23.439 - 0.00000036 * d) * D2R;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / D2R;
  const gmst = (280.46061837 + 360.98564736629 * d) % 360;
  let lon = ra - gmst; lon = ((lon + 540) % 360) - 180;
  return { lat: dec / D2R, lon };
}

const fmtTime = (d) => d.toISOString().slice(11, 16) + ' UTC';
const fmtDay = (d) => d.getUTCDate() + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];

export async function createLayer({ THREE, radius = 1, makeDotMaterial, palette }) {
  const group = new THREE.Group();
  group.name = 'aurora';

  let uScale = { value: 450 };   // pixels per world unit at distance 1: borrowed from the globe's shared dot material
  if (makeDotMaterial) { const probe = makeDotMaterial({ size: 0.001 }); if (probe.uniforms?.uScale) uScale = probe.uniforms.uScale; probe.dispose?.(); }
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uSize: { value: DOT_SIZE }, uScale, uMaxPx: { value: 10 * (globalThis.devicePixelRatio || 1) },
      uDim: { value: 1 }, uFootA: { value: FOOT_ALPHA }, uFootTop: { value: FOOT_ALPHA_TOP }, uFootDay: { value: FOOT_DAY }, uFootSize: { value: FOOT_SIZE }, uLow: { value: new THREE.Vector3() }, uTop: { value: new THREE.Vector3() } },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(new THREE.BufferGeometry(), mat);
  points.frustumCulled = false; points.visible = false;
  group.add(points);

  const setPalette = (name, pal) => {
    const c = AURORA_COLOURS[name] || { low: (pal || palette || {}).shallow || [0.3, 1, 0.55], top: (pal || palette || {}).mid || [0.8, 0.3, 0.8] };
    mat.uniforms.uLow.value.set(...c.low); mat.uniforms.uTop.value.set(...c.top);
  };
  setPalette('Ocean', palette);

  // ---- build the dots for one forecast
  function build(cells, when) {
    const sun = subsolar(when), sLa = sun.lat * D2R, sLo = sun.lon * D2R;
    const sx = Math.cos(sLa) * Math.cos(sLo), sy = Math.sin(sLa), sz = -Math.cos(sLa) * Math.sin(sLo);
    const pos = [], ray = [], day = [];
    let nCells = 0, peak = 0, nFoot = 0;
    const dayK = (cx, cy, cz) => {                                       // twilight blend from the Sun's height there
      const sunUp = cx * sx + cy * sy + cz * sz;                         // > 0: Sun above the horizon there
      return sunUp > 0.05 ? DAY_DIM : sunUp > -0.1 ? DAY_DIM + (1 - DAY_DIM) * (0.05 - sunUp) / 0.15 : 1;
    };
    const Rbase = radius * (1 + EXAG * H_LOW_KM / EARTH_KM);
    const colMax = new Float32Array(720);                                // highest value per longitude (0..359) and hemisphere
    for (const [lon, lat, val] of cells) { const k = ((Math.round(lon) % 360 + 360) % 360) * 2 + (lat >= 0 ? 1 : 0); if (val > colMax[k]) colMax[k] = val; }
    for (const [lon, lat, val] of cells) {
      if (val < MIN_VALUE) continue;
      nCells++; peak = Math.max(peak, val);
      const v = Math.min(1, val / 100), r = rng((lon + 360) * 1000 + lat + 91);
      const expect = RAYS_AT_100 * Math.pow(v, 1.5) * Math.cos(lat * D2R);   // rays expected: grows faster than the value so the strong band carries the oval; x true area
      let rays = Math.floor(expect); if (r() < expect - rays) rays++;
      // footprint on the crest: FOOT_PER_CELL x cos(lat) dots at random in the cell, flat at the rays' base height
      const crest = val >= FOOT_CREST * colMax[((Math.round(lon) % 360 + 360) % 360) * 2 + (lat >= 0 ? 1 : 0)];
      const fe = crest ? FOOT_PER_CELL * Math.cos(lat * D2R) : 0;
      let nf = Math.floor(fe); if (r() < fe - nf) nf++;
      for (let k = 0; k < nf; k++) {
        const la = (lat + r() - 0.5) * D2R, lo = (lon + r() - 0.5) * D2R;
        const cx = Math.cos(la) * Math.cos(lo), cy = Math.sin(la), cz = -Math.cos(la) * Math.sin(lo);
        pos.push(Rbase * cx, Rbase * cy, Rbase * cz); ray.push(r(), -1, v, lo); day.push(dayK(cx, cy, cz)); nFoot++;
      }
      for (let k = 0; k < rays; k++) {
        // a ray at a random spot inside the 1 x 1 degree cell (cell centred on the grid point)
        const la = (lat + r() - 0.5) * D2R, lo0 = lon + (r() - 0.5) * (1 - SHEET_DEG), seed = r();
        for (let c = 0; c < COLS_PER_RAY; c++) {
          const lo = (lo0 + SHEET_DEG * (c / (COLS_PER_RAY - 1) - 0.5) + (r() - 0.5) * 0.08) * D2R;
          const cx = Math.cos(la) * Math.cos(lo), cy = Math.sin(la), cz = -Math.cos(la) * Math.sin(lo);
          const dk = dayK(cx, cy, cz);
          for (let j = 0; j < DOTS_PER_RAY; j++) {
            const u = Math.pow((j + r()) / DOTS_PER_RAY, 1.3);            // denser near the base
            const R = radius * (1 + EXAG * (H_LOW_KM + u * (H_TOP_KM - H_LOW_KM)) / EARTH_KM);
            pos.push(R * cx, R * cy, R * cz); ray.push(seed, u, v, lo); day.push(dk);
          }
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aRay', new THREE.Float32BufferAttribute(ray, 4));
    g.setAttribute('aDay', new THREE.Float32BufferAttribute(day, 1));
    points.geometry.dispose(); points.geometry = g;
    return { dots: pos.length / 3, footprint: nFoot, cells: nCells, peak };
  }

  // ---- fetching: only while the layer is visible, on the feed's cadence
  let state = 'waiting', fc = null, kp = null, built = null, lastTry = -1e12, busy = false, err = '';
  const getJSON = async (url) => {
    const ctl = new AbortController(), to = setTimeout(() => ctl.abort(), 20e3);
    try { const r = await fetch(url, { signal: ctl.signal, cache: 'no-cache' }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
    finally { clearTimeout(to); }
  };
  async function refresh() {
    busy = true; lastTry = Date.now();
    try {
      const [ov, kpRows] = await Promise.all([getJSON(OVATION_URL), getJSON(KP_URL).catch(() => null)]);
      const when = new Date(ov['Forecast Time']), obs = new Date(ov['Observation Time']);
      if (!Array.isArray(ov.coordinates) || !ov.coordinates.length || isNaN(when)) throw new Error('unexpected format');
      if (Array.isArray(kpRows) && kpRows.length) {
        const k = kpRows[kpRows.length - 1];
        kp = { value: Number(k.estimated_kp), time: new Date(k.time_tag + 'Z') };
        if (!isFinite(kp.value)) kp = null;
      }
      built = build(ov.coordinates, when);
      fc = { when, obs }; state = 'ok'; err = '';
    } catch (e) {
      err = e && e.name === 'AbortError' ? 'timed out' : (e && e.message) || 'network error';
      state = fc ? 'refresh-failed' : 'failed';
    } finally { busy = false; text(); }
  }

  // ---- what the panel says
  const DETAILS_BASE =
    `Aurora from NOAA SWPC's OVATION Prime model (30-minute forecast). Model output: a 1-degree grid of forecast aurora intensity ` +
    `(0 to about 100) for the forecast time, driven by the solar wind measured at the L1 monitor about 30-90 minutes earlier; ` +
    `SWPC says the chance of seeing aurora is roughly proportional to it. Each 1-degree cell with a value of ${MIN_VALUE} or more gets ` +
    `rays of dots in proportion to its value to the power 1.5 (so the strong band stands out from the faint edges) and to its true area, brighter for higher values; nothing finer than the 1-degree grid is in the data. ` +
    `The oval's crest also gets a faint flat line of dots at ${H_LOW_KM} km (the footprint), so the forecast oval shows as a thin ring even when activity is low: ` +
    `for each 1-degree longitude and hemisphere, the cells within ${Math.round(FOOT_CREST * 100)}% of that column's highest value (and at least ${MIN_VALUE}). ` +
    `It marks where the forecast is highest, not where aurora would be seen, and is dimmed, not hidden, on the sunlit side. ` +
    `Height: rays stand from ${H_LOW_KM} to ${H_TOP_KM} km at true height (no vertical exaggeration); aurora is typically 80-500 km up. ` +
    `Dimmed on the side where the Sun is up at the forecast time (aurora is not visible in daylight; Sun position computed here). ` +
    `Illustrative: the rays (short east-west sheets of dot columns, placed at random inside each cell), the colour by height (green low, red-violet high is physically reasonable ` +
    `but not in the feed) and the slow shimmer. Kp: NOAA's estimated planetary K index, 1-minute product (provisional). ` +
    `Refreshed every 5 minutes while this layer is on. The layer's button glows when estimated Kp is ${ACTIVE_KP} or more ` +
    `(NOAA's G1 geomagnetic storm level, when aurora usually reaches lower latitudes). Not an official NOAA product. Do not use for safety decisions.`;
  function text() {
    const age = fc ? (Date.now() - fc.when.getTime()) / 60e3 : 0;
    if (fc && age > DROP_MIN) { points.visible = false; state = 'too-old'; }
    else points.visible = !!fc;
    const kpTxt = kp ? `, Kp ${kp.value.toFixed(1)}` : '';
    group.label = fc ? `Aurora: NOAA forecast for ${fmtDay(fc.when)} ${fmtTime(fc.when)}${kpTxt}` : 'Aurora: NOAA OVATION forecast';
    group.details = DETAILS_BASE;
    const quiet = built && built.peak < 30 ? ' Activity is low.' : '';
    group.status =
      state === 'waiting' ? 'Loading the NOAA aurora forecast…'
      : state === 'failed' ? `NOAA aurora feed failed (${err}); nothing drawn. Retrying in 2 minutes.`
      : state === 'too-old' ? `The newest forecast we have is more than 3 h old (${err ? 'feed: ' + err : 'NOAA has not published a newer one'}); nothing drawn.`
      : `${built.cells} cells with aurora, peak ${built.peak} of ~100.${quiet}` +
        (age > STALE_MIN ? ` Stale: forecast time was ${Math.round(age)} min ago.` : '') +
        (state === 'refresh-failed' ? ` Last refresh failed (${err}); showing the ${fmtTime(fc.when)} forecast.` : '');
    group.userData.onChange?.(group);
  }

  group.update = (t) => {
    if (!group.visible) return;   // hidden: no fetch, no work
    mat.uniforms.uTime.value = t;
    const wait = state === 'ok' ? REFRESH_MS : RETRY_MS;
    if (!busy && Date.now() - lastTry > (state === 'waiting' ? 0 : wait) && !document.hidden) refresh();
  };
  group.setDim = (k) => { mat.uniforms.uDim.value = Math.max(0, Math.min(1, k)); };
  // For the globe's glowing button: one light request (the 1-minute Kp feed, a few KB), safe while hidden, never throws.
  group.checkActivity = async () => {
    try {
      const rows = await getJSON(KP_URL);
      const last = Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
      const k = last ? Number(last.estimated_kp) : NaN;
      if (!isFinite(k)) return { active: false, where: null, note: '' };
      const active = k >= ACTIVE_KP;
      // where: the geomagnetic pole (IGRF dipole, about 80.8 N 72.8 W / 80.8 S 107.2 E) on the side that is darker now
      const north = subsolar(new Date()).lat < 0;
      const where = active ? (north ? { lat: 80.8, lon: -72.8 } : { lat: -80.8, lon: 107.2 }) : null;
      return { active, where, note: active ? `Aurora activity high, Kp ${k.toFixed(1)}` : '' };
    } catch (e) { return { active: false, where: null, note: '' }; }
  };
  group.setPalette = setPalette;
  group.userData = { points, urls: { OVATION_URL, KP_URL }, get forecast() { return fc; }, get kp() { return kp; },
    get stats() { return built; }, get state() { return state; }, refresh, exaggeration: { height: EXAG } };
  text();
  return group;
}
