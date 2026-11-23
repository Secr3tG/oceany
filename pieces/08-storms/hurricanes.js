// Hurricane / tropical cyclone layer for the Oceany globe, all dots. Data: NOAA IBTrACS v04r01, see SOURCES.md.
//
//   const layer = await createLayer({ THREE, radius: 1, makeDotMaterial, palette });
//   scene.add(layer);  layer.update(t, camera) every frame
//   layer.getFocusTargets()   // active storms, best to watch first: [{lat, lon, rating, name, id, wind, timeLeft, fade}]
//                             // order: storms of at least 34 kt (tropical storm strength) before weaker ones; then storms with
//                             // time left (ENDING_H) before storms about to end; then by wind, and an unnamed storm never ranks
//                             // above a stronger named one in the same group. name is readable, e.g. "Melissa (North Atlantic, 2025), category 5, 150 kt"
//                             // or "Unnamed storm, South Indian Ocean, tropical storm, 39 kt" (never a raw IBTrACS id).
//                             // timeLeft: display seconds until the storm's record ends, in WATCHED seconds: for a storm not yet
//                             // watched, what it will have once flown to (the watch hold slows the clock; see watchedLeft);
//                             // fade: 0..1 how visible it is drawn now (it fades in and out over FADE_H recorded hours, ~2.5 s),
//                             // so a follow can ease out before the storm leaves the list.
//   layer.setDim(k)           // 0..1 brightness multiplier
//   layer.setShowPaths(bool)  // every recorded track since 1980 on/off (off: only the wake behind each moving storm)
//   layer.label / layer.status
//
// Replay: the last 12 months of IBTrACS records play at one clock speed (HOURS_PER_S), in recorded time, with storms
// moving along their recorded 6-hourly positions (smoothed between them). When no storm is active anywhere the clock
// skips ahead faster, and the status says so. Watch hold: while the camera is close to a storm near the middle of the view
// (within WATCH_NEAR globe radii) or flies towards it fast (a fly-in), the clock slows so that storm lasts at least WATCH_S
// display seconds from then (never below WATCH_MIN_RATE of normal speed); userData.replayRate and .watching show it.
// Per storm: centre, wind, gale radius (R34) and radius of maximum wind (RMW) are recorded (R34/RMW only where IBTrACS
// has them; elsewhere filled from the storm's own nearest records, else estimated from wind). The cloud bands, eye wall,
// eye, outflow and all air motion are an illustration built on those numbers, with rotation slowed for display.
//
// GPU: one Points buffer of MAX_STORMS x DOTS dots; each dot stores only its slot and random numbers. The vertex shader
// builds the storm from per-slot uniforms. Per frame JS only sets those uniforms for the few active storms.

import { toXYZ, dotMaterial, densityPoints, makeRamp, dimMaterial, D2R } from './dots_common.js';

const SPACING_DEG = 1.0;        // even dot spacing along the history tracks (about 110 km)
const WAKE_DEG = 0.25;          // dot spacing of the wake left behind a moving storm (about 28 km): a row of separate dots that fade with age, not a line
const MAX_LIFT = 0.03;          // density relief cap, fraction of radius
const HOURS_PER_S = 12;         // replay clock: 1 display second = 12 recorded hours
const SKIP_HOURS_PER_S = 240;   // clock while no storm is active anywhere
const WINDOW_H = 8760;          // replay the last 12 months of records
const WAKE_H = 96;              // wake fades over 4 recorded days (8 display seconds)
const MAX_STORMS = 16;
const ENDING_H = 36;            // a storm with under 36 recorded hours (3 display s) left ranks after storms that still have time
const FADE_H = 30;              // a storm fades in over its first and out over its last 30 recorded hours (2.5 display s), never pops
const WATCH_S = 24, WATCH_NEAR = 0.6, WATCH_MIN_RATE = 0.12;   // watch hold: a storm watched up close lasts >= 20 s plus its fade-out
const WEAK_KT = 34;             // below tropical storm strength: still drawn, but never offered first while a stronger storm is active
const BASIN = { NA: 'North Atlantic', EP: 'East Pacific', WP: 'West Pacific', NI: 'North Indian Ocean', SI: 'South Indian Ocean', SP: 'South Pacific', SA: 'South Atlantic', MM: 'mixed basins' };
const HEIGHT_EXAG = 12;         // storm column drawn 12x taller than its ~15 km so it reads in 3D from the side
const STORM_TOP_KM = 15;
const CLOUD_OF_R34 = 1.5;       // cloud bands drawn out to 1.5 x the gale radius (illustrative)
// dots per storm: bands 9000 (4 arms), eye wall 1200, eye 60, cloud shield 2400, outflow 360: many small dim dots, density carries brightness
const PARTS = [[0, 9000], [1, 1200], [2, 60], [3, 2400], [4, 360]];
const DOTS = PARTS.reduce((a, p) => a + p[1], 0);
const KM = 1 / 6371;

const catOf = (w) => (w >= 137 ? 5 : w >= 113 ? 4 : w >= 96 ? 3 : w >= 83 ? 2 : w >= 64 ? 1 : 0);
const estR34 = (w) => 120 + 0.8 * Math.max(0, w - 34);          // km, typical gale radius for this wind (estimate)
const estRMW = (w) => Math.max(15, 90 - 0.45 * w);              // km, typical radius of maximum wind (estimate)

// category ramp from the palette: weak = mid, strong = shallow, category 5 nearly white (intensity reads as brightness)
const RAMP_GLSL = /* glsl */`
  uniform vec3 uCore, uMid, uDeep;
  vec3 catColor(float c) {   // c = category 0..5 (fractional ok)
    return c < 3.0 ? mix(uMid, uCore, c / 3.0) : mix(uCore, vec3(1.0), 0.6 * (c - 3.0) / 2.0);
  }`;
const FRAG = /* glsl */`   // the globe's dot: round, soft, additive (same as makeDotMaterial)
  varying vec3 vColor; varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    gl_FragColor = vec4(vColor, pow(1.0 - r, 2.0) * 0.85 * vAlpha);
  }`;
const HIDE = 'gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; return;';

const VERT_STORM = /* glsl */`
  uniform vec4 uC[${MAX_STORMS}];   // xyz centre on the surface, w = +1 north / -1 south (0 = off)
  uniform vec4 uS[${MAX_STORMS}];   // x gale radius R34, y RMW (globe radii), z category 0..5 (fractional), w brightness
  uniform float uTime, uSize, uScale, uH, uMaxPx, uDimK, uBudget;
  attribute float aSlot; attribute vec4 aP;   // x stratified 0..1, y z random, w part
  varying vec3 vColor; varying float vAlpha;
  ${RAMP_GLSL}
  void main() {
    int i = int(aSlot + 0.5);
    vec4 c = uC[i]; vec4 s = uS[i];
    if (c.w == 0.0) { ${HIDE} }
    float hemi = c.w, R34 = s.x, Rm = s.y, cat = s.z, I = clamp(cat / 5.0, 0.0, 1.0), eye = smoothstep(0.6, 1.0, cat);
    float Rout = ${CLOUD_OF_R34} * R34;
    vec3 n = normalize(c.xyz);
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), n) + vec3(1e-5, 0.0, 0.0)), north = cross(n, east);  // +angle = counter-clockwise from above
    // level of detail: fewer dots for a storm that is small on screen, and when many storms are active
    float dist = distance(cameraPosition, (modelMatrix * vec4(c.xyz, 1.0)).xyz);
    float rpx = Rout * uScale / dist;
    float keep = clamp(rpx * rpx / 22500.0, 0.12, 1.0) * uBudget;   // full count once the storm is ~150 px across (radius)
    float far = clamp(110.0 / max(rpx, 1.0), 1.0, 3.5);           // small on screen: fewer dots, each brighter and larger, so it still reads
    if (fract(aP.y * 7.13 + aP.z * 3.71) > keep) { ${HIDE} }
    float kind = aP.w, a = aP.x, r1 = aP.y, r2 = aP.z, seed = float(i) * 2.399;
    float wE = 0.5 + 1.1 * I;                 // eye-wall turn rate, rad per display second (real air turns far faster)
    float r = 0.0, th = 0.0, h = 0.0, alpha = 0.0, sz = 1.0; vec3 col = uMid;
    if (kind < 0.5) {            // SPIRAL BANDS: 4 arms, dots flow inward along them and speed up as they wind in
      float arm = floor(r1 * 4.0);
      float tcb = a + uTime * 0.0125 * (0.7 + 0.6 * fract(r2 * 17.1)) + arm * 0.37, cyb = floor(tcb);   // slow: the bands evolve, they do not jump   // own speed per dot
      float u = fract(tcb);
      r2 = fract(sin((r2 * 91.3 + cyb * 1.618) * 12.9898) * 43758.5453);                           // re-seeded every trip in
      float r0 = 1.05 * Rm;
      r = r0 + (Rout - r0) * (1.0 - u) * (1.0 - u * 0.25);
      r *= 1.0 + ((r2 - 0.5) + (fract(r2 * 7.77 + a * 3.1) - 0.5)) * 0.5;   // wide soft band (triangular falloff)
      th = arm * 1.5708 + seed + 0.35 * sin(uTime * 0.021 + arm * 2.1) + 0.2 * sin(uTime * 0.008 + arm * 4.7 + u * 3.0) +   // arms drift and wander
            hemi * (1.3 * log(Rout / max(r, 1e-5)) + 0.4 * uTime) + (fract(r2 * 31.7) - 0.5) * (0.5 - 0.3 * u);
      h = uH * (0.08 + 0.15 * (1.0 - u) + 0.45 * pow(u, 3.0));   // bands rise into the eye wall
      float bandA = smoothstep(0.0, 0.12, u) * (0.25 + 0.75 * u);
      alpha = (0.13 + 0.13 * I) * bandA; col = mix(mix(uMid, vec3(1.0), 0.35), mix(catColor(cat), vec3(1.0), 0.45), u); sz = 0.9 + 0.4 * u;   // clouds: whiter than the sea dots
    } else if (kind < 1.5) {     // EYE WALL: dense bright ring at the radius of maximum wind, turning fast, dots rising
      float hn = fract(a + uTime * 0.16);
      float spread = mix(1.3, 0.28, eye);      // a tropical storm has no clean ring: ragged, filled centre
      r = Rm * (1.0 + (r2 - 0.5) * spread) * (1.0 + 0.9 * hn * eye);   // eye wall slopes outward with height: a stadium
      if (eye < 0.5) r = Rm * (0.15 + 1.2 * r2);
      th = r1 * 6.2831853 + hemi * uTime * wE;
      h = uH * (0.1 + 0.85 * hn);
      alpha = (0.1 + 0.1 * I) * sin(3.14159 * hn) * mix(0.55, 1.0, eye);
      col = mix(catColor(cat), vec3(1.0), 0.4 + 0.4 * eye * (1.0 - hn)); sz = 0.75;
    } else if (kind < 2.5) {     // EYE: a few faint dots sinking slowly in the calm centre (hurricanes only)
      if (eye < 0.05) { ${HIDE} }
      r = 0.7 * Rm * sqrt(a);
      th = r1 * 6.2831853 + hemi * uTime * 0.25;
      h = uH * (0.9 - 0.8 * fract(r2 + uTime * 0.04));
      alpha = 0.18 * eye; col = uMid; sz = 0.8;
    } else if (kind < 3.5) {     // CLOUD SHIELD: faint dots over the whole disc, turning slower further out
      r = Rm * 1.6 + (Rout - Rm * 1.6) * pow(a, 0.8);   // keeps the eye and its wall clear
      th = r1 * 6.2831853 + hemi * uTime * wE * 0.55 * pow(Rm / r, 0.6);
      h = uH * (0.55 + 0.35 * r2);
      float q = (r - Rm) / (Rout - Rm);
      alpha = (0.07 + 0.05 * I) * (1.0 - q * q); col = mix(mix(uMid, vec3(1.0), 0.3), uDeep * 1.8, q); sz = 1.1;
    } else {                     // OUTFLOW at the top: spreading out and turning the other way
      float u = fract(a + uTime * 0.07);
      r = Rm * 1.2 + (Rout * 1.15 - Rm * 1.2) * u;
      th = r1 * 6.2831853 - hemi * (0.9 * u + 0.12 * uTime);
      h = uH * (0.98 - 0.12 * u);
      alpha = 0.16 * sin(3.14159 * u) * (0.5 + 0.5 * I); col = mix(uCore, uMid, u); sz = 0.9;
    }
    vec3 dirR = east * cos(th) + north * sin(th);
    vec3 p = c.xyz + dirR * r;
    p = normalize(p) * (length(c.xyz) + h);
    vec3 toCam = cameraPosition - c.xyz; toCam -= n * dot(toCam, n);   // depth cue: the near side brighter than the far side
    float depthK = length(toCam) > 1e-7 ? 0.5 + 0.5 * dot(dirR, normalize(toCam)) : 0.5;
    alpha *= 0.5 + 0.5 * depthK; sz *= 0.85 + 0.3 * depthK;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * sz * sqrt(far) * uScale / -mv.z, 1.5, uMaxPx);
    vColor = col; vAlpha = min(1.0, alpha * far) * s.w * uDimK;
  }`;
const VERT_WAKE = /* glsl */`   // dots along each replayed track: appear as the storm passes, fade over uWake hours
  uniform float uNow, uWake, uSize, uScale, uMaxPx, uDimK; attribute float aHour; attribute float aCat;
  varying vec3 vColor; varying float vAlpha;
  ${RAMP_GLSL}
  void main() {
    float age = uNow - aHour;
    if (age < 0.0 || age > uWake) { ${HIDE} }
    float k = 1.0 - age / uWake;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * (0.35 + 0.65 * k) * uScale / -mv.z, 1.5, uMaxPx);   // dots shrink and dim as they age
    vColor = mix(catColor(aCat), vec3(1.0), 0.25 + 0.3 * k); vAlpha = 0.8 * pow(k, 1.5) * smoothstep(0.0, 9.0, age) * uDimK;   // starts behind the storm (not through its eye), a faint fading trail
  }`;
const VERT_TRACKS = /* glsl */`  // every recorded track since 1980, coloured by category
  uniform float uSize, uScale, uMaxPx, uDimK; attribute float aCat; varying vec3 vColor; varying float vAlpha;
  ${RAMP_GLSL}
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * uScale / -mv.z, 1.5, uMaxPx);
    vColor = catColor(aCat); vAlpha = 0.55 * uDimK;
  }`;

export async function createLayer({ THREE, radius = 1.0, makeDotMaterial, palette } = {}) {
  const url = (f) => new URL('./data/' + f, import.meta.url);
  const get = (f, kind) => fetch(url(f)).then((r) => { if (!r.ok) throw new Error(f + ' ' + r.status); return r[kind](); });
  const [meta, buf, dbuf, rbuf] = await Promise.all([get('tracks.json', 'json'), get('tracks.bin', 'arrayBuffer'),
    get('density_points.bin', 'arrayBuffer'), get('track_radii.bin', 'arrayBuffer').catch(() => null)]);
  const N = meta.meta.points, M = meta.meta.densityPoints, storms = meta.storms;
  const lat = new Int16Array(buf, 0, N), lon = new Int16Array(buf, 2 * N, N);
  const dt = new Uint16Array(buf, 4 * N, N), wind = new Uint8Array(buf, 6 * N, N);
  // IBTrACS leaves some wind values blank (stored as 0): fill each from the storm's own neighbouring records (linear between
  // the nearest recorded values, the nearest one at the ends), so a storm never reads as "0 kt" and never drops out of view
  for (const s of storms) {
    const i0 = s.offset, i1 = s.offset + s.count; let prev = -1;
    for (let i = i0; i < i1; i++) if (wind[i]) {
      if (prev < 0) for (let k = i0; k < i; k++) wind[k] = wind[i];
      else for (let k = prev + 1; k < i; k++) wind[k] = Math.round(wind[prev] + (wind[i] - wind[prev]) * (k - prev) / (i - prev));
      prev = i;
    }
    if (prev >= 0) for (let k = prev + 1; k < i1; k++) wind[k] = wind[prev];
  }
  const r34 = rbuf ? new Uint16Array(rbuf, 0, N) : new Uint16Array(N), rmw = rbuf ? new Uint16Array(rbuf, 2 * N, N) : new Uint16Array(N);
  const unit = (i) => { const la = lat[i] / 100 * D2R, lo = lon[i] / 100 * D2R; return [Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)]; };
  const angle = (a, b) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const R = radius * 1.006;
  const pal = palette || { shallow: [0.35, 1, 0.95], mid: [0.1, 0.5, 0.95], deep: [0.03, 0.08, 0.45] };
  let uScale = { value: 450 };
  if (makeDotMaterial) { const probe = makeDotMaterial({ size: 0.001 }); if (probe.uniforms?.uScale) uScale = probe.uniforms.uScale; probe.dispose?.(); }
  const colU = { uCore: { value: new THREE.Vector3(...pal.shallow) }, uMid: { value: new THREE.Vector3(...pal.mid) }, uDeep: { value: new THREE.Vector3(...pal.deep) } };
  const uDimK = { value: 1 }, uMaxPx = { value: 12 * (globalThis.devicePixelRatio || 1) };   // dot size cap, drawing-buffer px
  const mkMat = (vertexShader, uniforms) => new THREE.ShaderMaterial({
    uniforms: { uScale, uDimK, uMaxPx, ...colU, ...uniforms }, vertexShader, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  // ---- every recorded track since 1980 (shown with "show all paths")
  const nSeg = (i, deg) => Math.max(1, Math.round(angle(unit(i), unit(i + 1)) / (deg * D2R)));
  const along = (si, deg, emit) => {   // even dots along storm si's track: emit(unit vector, point index, fraction)
    const s = storms[si], last = s.offset + s.count - 1, tmp = [0, 0, 0];
    for (let i = s.offset; i < last; i++) {
      const a = unit(i), b = unit(i + 1), n = nSeg(i, deg);
      for (let k = 0; k < n; k++) {
        const f = k / n; tmp[0] = a[0] + (b[0] - a[0]) * f; tmp[1] = a[1] + (b[1] - a[1]) * f; tmp[2] = a[2] + (b[2] - a[2]) * f;
        const l = Math.hypot(tmp[0], tmp[1], tmp[2]); emit([tmp[0] / l, tmp[1] / l, tmp[2] / l], i, f);
      }
    }
    emit(unit(last), last, 0);
  };
  const build = (list, deg, extra) => {
    let total = 0; for (const si of list) along(si, deg, () => total++);
    const pos = new Float32Array(total * 3), cat = new Float32Array(total), hour = extra ? new Float32Array(total) : null;
    let d = 0;
    for (const si of list) along(si, deg, (u, i, f) => {
      pos[d * 3] = u[0] * R; pos[d * 3 + 1] = u[1] * R; pos[d * 3 + 2] = u[2] * R;
      const w = i + 1 < N ? wind[i] + (wind[i + 1] - wind[i]) * f : wind[i]; cat[d] = catOf(w);
      if (hour) hour[d] = storms[si].t0 + dt[i] + (i + 1 < storms[si].offset + storms[si].count ? (dt[i + 1] - dt[i]) * f : 0);
      d++;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('aCat', new THREE.BufferAttribute(cat, 1));
    if (hour) g.setAttribute('aHour', new THREE.BufferAttribute(hour, 1));
    return [g, total];
  };
  const [tg, trackDots] = build(storms.map((_, i) => i), SPACING_DEG, false);
  const tracks = new THREE.Points(tg, mkMat(VERT_TRACKS, { uSize: { value: 0.0030 } }));
  tracks.name = 'hurricane-track-dots'; tracks.frustumCulled = false;

  // ---- density (climatology): one dot per 1 degree cell hit by at least 3 storms since 1980
  const ramp = () => makeRamp([[0, pal.deep.map((x) => x * 1.6)], [0.5, pal.mid], [1, pal.shallow]]);
  const density = densityPoints(THREE, dbuf, M, radius, MAX_LIFT, ramp(), dotMaterial(THREE, makeDotMaterial, { size: 0.0014, opacity: 0.28 }));
  density.name = 'hurricane-density-dots';
  const recolorDensity = () => {   // only when the globe's palette changes
    const v = density.geometry.attributes.aValue.array, c = density.geometry.attributes.color, rp = ramp();
    for (let i = 0; i < v.length; i++) { const q = rp(v[i]); c.array[i * 3] = q[0]; c.array[i * 3 + 1] = q[1]; c.array[i * 3 + 2] = q[2]; }
    c.needsUpdate = true;
  };

  // ---- the replay window: storms active during the last 12 months of records
  let tEnd = 0; for (const s of storms) tEnd = Math.max(tEnd, s.t0 + dt[s.offset + s.count - 1]);
  const tStart = tEnd - WINDOW_H;
  const win = []; storms.forEach((s, si) => { if (s.t0 + dt[s.offset + s.count - 1] >= tStart && s.t0 <= tEnd) win.push(si); });
  // per point of those storms: recorded size, gaps filled from the storm's own nearest records, else estimated from wind
  const R34K = new Float32Array(N), RMWK = new Float32Array(N), REC = new Uint8Array(N);   // REC bit 1: r34 recorded, bit 2: rmw recorded
  const fill = (src, dst, est, bit, s) => {
    const i0 = s.offset, i1 = s.offset + s.count; let prev = -1;
    for (let i = i0; i < i1; i++) if (src[i]) {
      REC[i] |= bit; dst[i] = src[i];
      if (prev < 0) for (let k = i0; k < i; k++) dst[k] = src[i];
      else for (let k = prev + 1; k < i; k++) dst[k] = src[prev] + (src[i] - src[prev]) * (k - prev) / (i - prev);
      prev = i;
    }
    if (prev < 0) for (let i = i0; i < i1; i++) dst[i] = est(wind[i]);
    else for (let k = prev + 1; k < i1; k++) dst[k] = src[prev];
  };
  for (const si of win) { const s = storms[si]; fill(r34, R34K, estR34, 1, s); fill(rmw, RMWK, estRMW, 2, s); }
  for (let i = 0; i < N; i++) if (RMWK[i] && R34K[i] && RMWK[i] > 0.6 * R34K[i]) RMWK[i] = 0.6 * R34K[i];   // keep the eye inside the gale disc
  const winStart = win.map((si) => storms[si].t0), winEnd = win.map((si) => storms[si].t0 + dt[storms[si].offset + storms[si].count - 1]);
  const activeAt = (h) => { let n = 0; for (let k = 0; k < win.length; k++) if (h >= winStart[k] && h <= winEnd[k]) n++; return n; };
  let busiest = tStart, most = -1;
  for (let h = tStart; h <= tEnd; h += 6) { const n = activeAt(h); if (n > most) { most = n; busiest = h; } }

  const [wg, wakeDots] = build(win, WAKE_DEG, true);
  const wakeMat = mkMat(VERT_WAKE, { uNow: { value: -1e9 }, uWake: { value: WAKE_H }, uSize: { value: 0.0045 } });
  const wake = new THREE.Points(wg, wakeMat);
  wake.name = 'hurricane-wake-dots'; wake.frustumCulled = false;

  // ---- moving storms
  const total = MAX_STORMS * DOTS;
  const aSlot = new Float32Array(total), aP = new Float32Array(total * 4);
  for (let f = 0; f < MAX_STORMS; f++) {
    let k0 = 0;
    for (const [kind, n] of PARTS) {
      for (let k = 0; k < n; k++) {
        const i = f * DOTS + k0 + k; aSlot[i] = f;
        aP[i * 4] = (k + Math.random()) / n; aP[i * 4 + 1] = Math.random(); aP[i * 4 + 2] = Math.random(); aP[i * 4 + 3] = kind;
      }
      k0 += n;
    }
  }
  const sg = new THREE.BufferGeometry();
  sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(total * 3), 3));
  sg.setAttribute('aSlot', new THREE.BufferAttribute(aSlot, 1));
  sg.setAttribute('aP', new THREE.BufferAttribute(aP, 4));
  sg.setDrawRange(0, 0);
  const uC = Array.from({ length: MAX_STORMS }, () => new THREE.Vector4());
  const uS = Array.from({ length: MAX_STORMS }, () => new THREE.Vector4());
  const H = STORM_TOP_KM * HEIGHT_EXAG * KM * radius;
  const stormMat = mkMat(VERT_STORM, { uC: { value: uC }, uS: { value: uS }, uTime: { value: 0 }, uSize: { value: 0.0017 }, uH: { value: H }, uBudget: { value: 1 } });
  const stormDots = new THREE.Points(sg, stormMat);
  stormDots.name = 'hurricane-storm-dots'; stormDots.frustumCulled = false; stormDots.renderOrder = 4;

  const group = new THREE.Group();
  group.name = 'hurricanes';
  group.add(density, tracks, wake, stormDots);
  tracks.visible = false;

  // ---- per frame (no allocation: fixed scratch arrays, focus objects reused)
  const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], out = [0, 0, 0];
  const pt = (i, o) => { const la = lat[i] / 100 * D2R, lo = lon[i] / 100 * D2R; o[0] = Math.cos(la) * Math.cos(lo); o[1] = Math.sin(la); o[2] = -Math.cos(la) * Math.sin(lo); };
  const focus = Array.from({ length: MAX_STORMS }, () => ({ lat: 0, lon: 0, rating: 0, name: '', id: '', wind: 0, left: 0, r34: 0, rmw: 0, rec: 0, named: false, fade: 1 }));
  // readable names (the globe follows by id, so two unnamed storms in one basin may share a name)
  const names = win.map((si) => { const s = storms[si], b = BASIN[s.basin] || 'open ocean'; return s.name ? `${s.name} (${b}, ${s.year})` : `Unnamed storm, ${b}`; });
  let peakH = busiest, peakW = -1;   // replay opens 2 recorded days before the strongest storm of the window peaks
  for (const si of win) { const s = storms[si]; for (let i = s.offset; i < s.offset + s.count; i++) if (wind[i] > peakW) { peakW = wind[i]; peakH = s.t0 + dt[i]; } }
  let nFocus = 0, clockH = Math.max(tStart, peakH - 48), lastT = null, skipping = false;
  let rate = 1, watchId = '', watchT0 = 0, watchAway = 0, prevLitId = '', prevLitD = 1e9;   // watch hold (see the header)
  const camW = new THREE.Vector3(), camF = new THREE.Vector3(), sp = new THREE.Vector3();
  const hazeReach = [0.03, 0.035, 0.04, 0.045, 0.05, 0.055];   // drawn storm radius per category (globe radii), updated with the storms on screen
  const order = Array.from({ length: MAX_STORMS }, (_, i) => i);
  const placeStorm = (slot, k, h) => {
    const s = storms[win[k]], i0 = s.offset, last = s.offset + s.count - 1, rel = h - s.t0;
    let i = i0; while (i < last - 1 && dt[i + 1] <= rel) i++;
    const f = last === i0 ? 0 : Math.max(0, Math.min(1, (rel - dt[i]) / Math.max(1, dt[i + 1] - dt[i])));
    const j1 = Math.min(last, i + 1);
    pt(Math.max(i0, i - 1), P[0]); pt(i, P[1]); pt(j1, P[2]); pt(Math.min(last, i + 2), P[3]);
    const f2 = f * f, f3 = f2 * f;   // Catmull-Rom through the recorded positions, then back onto the sphere
    for (let c = 0; c < 3; c++) out[c] = 0.5 * (2 * P[1][c] + (-P[0][c] + P[2][c]) * f + (2 * P[0][c] - 5 * P[1][c] + 4 * P[2][c] - P[3][c]) * f2 + (-P[0][c] + 3 * P[1][c] - 3 * P[2][c] + P[3][c]) * f3);
    const l = Math.hypot(out[0], out[1], out[2]); out[0] /= l; out[1] /= l; out[2] /= l;
    const w = wind[i] + (wind[j1] - wind[i]) * f, rr = R34K[i] + (R34K[j1] - R34K[i]) * f, rm = RMWK[i] + (RMWK[j1] - RMWK[i]) * f;
    const la = Math.asin(out[1]) / D2R;
    // category as a smooth number for the shader: tropical storm 0, then Saffir-Simpson thresholds
    const cs = w < 64 ? Math.max(0, (w - 34) / 30) * 0.6 : w < 83 ? 1 + (w - 64) / 19 : w < 96 ? 2 + (w - 83) / 13 : w < 113 ? 3 + (w - 96) / 17 : w < 137 ? 4 + (w - 113) / 24 : 5;
    const life = Math.max(0, Math.min(1, rel / FADE_H, (dt[last] - rel) / FADE_H));   // fade in / out over the first and last FADE_H recorded hours
    const bright = (0.45 + 0.55 * Math.max(0, Math.min(1, (w - 20) / 45))) * life * life * (3 - 2 * life);   // a weakening storm stays visible (faint spiral), ends by fading
    uC[slot].set(out[0] * R, out[1] * R, out[2] * R, la >= 0 ? 1 : -1);
    uS[slot].set(rr * KM * radius, rm * KM * radius, cs, bright);
    const fo = focus[slot]; fo.lat = la; fo.lon = Math.atan2(-out[2], out[0]) / D2R; fo.rating = catOf(w); fo.name = names[k]; fo.id = storms[win[k]].id;
    fo.wind = Math.round(w); fo.left = dt[last] - rel; fo.r34 = Math.round(rr); fo.rmw = Math.round(rm); fo.rec = REC[i] & REC[j1];
    fo.named = !!s.name; fo.fade = life;
  };
  const before = (x, y) => {   // should x be offered before y?
    const sx = x.wind >= WEAK_KT, sy = y.wind >= WEAK_KT;
    if (sx !== sy) return sx;
    const lx = x.left >= ENDING_H, ly = y.left >= ENDING_H;
    if (lx !== ly) return lx;   // a storm about to end would end during the fly-in (it ended mid-flight in testing)
    if (x.named !== y.named && (x.named ? x.wind > y.wind : y.wind > x.wind)) return x.named;
    return x.wind > y.wind;
  };
  const fmt = (h) => new Date(Date.UTC(1980, 0, 1) + h * 3600e3).toISOString().slice(0, 13).replace('T', ' ') + ' UTC';
  const fmtDay = (h) => new Date(Date.UTC(1980, 0, 1) + h * 3600e3).toISOString().slice(0, 10);
  let palKey = NaN;
  const syncPalette = () => {
    colU.uCore.value.set(...pal.shallow); colU.uMid.value.set(...pal.mid); colU.uDeep.value.set(...pal.deep);
    recolorDensity();
  };

  group.update = (timeSeconds, camera) => {
    if (!group.visible) { lastT = timeSeconds; return; }
    const step = lastT === null ? 0 : Math.min(0.25, Math.max(0, timeSeconds - lastT)); lastT = timeSeconds;
    const pk = pal.shallow[0] + 3 * pal.shallow[1] + 5 * pal.mid[0] + 7 * pal.mid[2] + 11 * pal.deep[0] + 13 * pal.deep[1];   // palette changed?
    if (pk !== palKey) { palKey = pk; syncPalette(); }
    clockH += step * (skipping ? SKIP_HOURS_PER_S : HOURS_PER_S * rate);
    if (clockH > tEnd) clockH = tStart;
    let slot = 0;
    for (let k = 0; k < win.length && slot < MAX_STORMS; k++) if (clockH >= winStart[k] && clockH <= winEnd[k]) placeStorm(slot++, k, clockH);
    skipping = slot === 0;
    for (let s = slot; s < MAX_STORMS; s++) uC[s].w = 0;
    sg.setDrawRange(0, slot * DOTS);
    stormMat.uniforms.uTime.value = timeSeconds;
    stormMat.uniforms.uBudget.value = Math.min(1, Math.max(0.8, 6 / Math.max(1, slot)));
    wakeMat.uniforms.uNow.value = clockH;
    nFocus = slot;
    // watch hold: the storm watched up close (or being flown to fast) sets the replay speed for the next frame
    rate = 1;
    if (camera && slot) {
      camW.copy(camera.position); camera.getWorldDirection(camF);
      let litK = -1, litD = 1e9, litDD = 1e9;
      for (let k = 0; k < slot; k++) {
        const fo = focus[k], la = fo.lat * D2R, lo = fo.lon * D2R;
        sp.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).multiplyScalar(radius).applyMatrix4(group.matrixWorld);
        const d = sp.distanceTo(camW); sp.sub(camW).normalize();
        const dd = 1 - sp.dot(camF);                  // 0 when the storm is dead ahead
        if (d * (1 + 4 * dd) < litD * (1 + 4 * litDD)) { litK = k; litD = d; litDD = dd; }
      }
      const step2 = step || 1e-3, id = litK >= 0 ? focus[litK].id : '';
      const approaching = litK >= 0 && id === prevLitId && step > 0 && (prevLitD - litD) / step2 > 0.4 && litD < 3.2;
      prevLitId = id; prevLitD = litD;
      if ((litK >= 0 && litD < WATCH_NEAR && litDD < 0.15) || approaching) {
        if (id !== watchId) { watchId = id; watchT0 = timeSeconds; }
        watchAway = 0;
      } else if (watchId && (watchAway += step) > 2) watchId = '';
      if (watchId) {
        let k = 0; while (k < slot && focus[k].id !== watchId) k++;
        if (k < slot) {
          const L = focus[k].left / HOURS_PER_S, W = WATCH_S - (timeSeconds - watchT0);
          if (W > 0 && L < W) rate = Math.max(WATCH_MIN_RATE, L / W);
        }
      }
    }
    for (let s = 0; s < slot; s++) order[s] = s;
    // strongest first (insertion sort on the few active slots). A storm with less than ENDING_H recorded hours left ranks
    // after every storm that still has time, so "Fly to strongest storm" never picks one that ends a moment after arriving.
    // Storms under WEAK_KT come after all others, storms about to end after those with time, and an unnamed storm never ranks
    // above a stronger named one in the same group.
    for (let a = 1; a < slot; a++) { const v = order[a]; let b = a - 1; while (b >= 0 && before(focus[v], focus[order[b]])) { order[b + 1] = order[b]; b--; } order[b + 1] = v; }
    for (let c = 0; c < 6; c++) hazeReach[c] = 0.03 + 0.005 * c;
    for (let s = slot - 1; s >= 0; s--) { const fo = focus[order[s]]; hazeReach[fo.rating] = CLOUD_OF_R34 * fo.r34 * KM * radius; }
    group.status = statusText();
  };
  let lastStatus = '', lastStatusH = -1e9;
  const statusText = () => {
    if (Math.abs(clockH - lastStatusH) < 3 && lastStatus) return lastStatus;   // the globe re-reads this once a second
    lastStatusH = clockH;
    if (!nFocus) return (lastStatus = `Replay of recorded tracks, ${fmtDay(clockH)}: no storm active anywhere, skipping ahead`);
    const s = focus[order[0]], how = (b) => (s.rec & b ? 'recorded' : 'estimated');
    return (lastStatus = `Replay of recorded tracks, ${fmt(clockH)}, ${nFocus} storm${nFocus > 1 ? 's' : ''} active; strongest: ${s.name}, ${s.wind} kt, ${strength(s)}, gale radius ${s.r34} km (${how(1)}), radius of maximum wind ${s.rmw} km (${how(2)})`);
  };
  const strength = (f) => (f.rating ? 'category ' + f.rating : f.wind >= WEAK_KT ? 'tropical storm' : 'tropical depression');
  // timeLeft in WATCHED seconds: a storm that is not being watched yet reports what it will have once Fly picks it and the watch
  // hold engages (the hold slows the clock so it lasts WATCH_S, down to WATCH_MIN_RATE), so the strongest storm stays pickable
  // (round 3: Champi, cat 4, at 11.8 s was skipped for a 22 kt depression). Under HOLD_MARGIN_S (ENDING_H) display seconds left it reports
  // the plain value (too close to its end to fly to). The watched storm reports its real value at the held rate, so the
  // globe's ending logic (timeLeft < 2 / < 4) still sees the real end.
  const HOLD_MARGIN_S = ENDING_H / HOURS_PER_S;   // 3 s: the same line the ranking uses
  const watchedLeft = (f) => {
    const L = f.left / HOURS_PER_S, now = L / rate;
    if (f.id === watchId || L < HOLD_MARGIN_S) return now;
    return Math.max(now, Math.min(L / WATCH_MIN_RATE, WATCH_S));
  };
  group.getFocusTargets = () => { const r = []; for (let a = 0; a < nFocus; a++) { const f = focus[order[a]]; r.push({ lat: f.lat, lon: f.lon, rating: f.rating, name: `${f.name}, ${strength(f)}, ${f.wind} kt`, id: f.id, wind: f.wind, timeLeft: watchedLeft(f), fade: f.fade }); } return r; };
  group.setDim = (k) => { uDimK.value = Math.max(0, Math.min(1, k)); dimMaterial(density.material, k); };
  group.setShowPaths = (on) => { tracks.visible = !!on; };
  group.label = `Replay of recorded tropical cyclones (IBTrACS), last 12 months, ${HOURS_PER_S} h per second. True width, height x${HEIGHT_EXAG}; bands, eye and air motion illustrative.`;
  group.details = `Tropical cyclones from NOAA IBTrACS. Replay of the last 12 months of records (${fmtDay(tStart)} to ${fmtDay(tEnd)}; the newest are provisional) ` +
    `at ${HOURS_PER_S} recorded hours per second, faster while no storm is active. Recorded: each storm's 6-hourly centre (smoothed between fixes), wind, ` +
    `and where IBTrACS has them the gale radius (34 kt wind) and radius of maximum wind; gaps use the storm's own nearest record, else a typical value for its wind. ` +
    `Drawn at true horizontal scale; height x${HEIGHT_EXAG}. Illustrative: cloud bands out to ${CLOUD_OF_R34} x the gale radius, eye wall, eye, outflow and all air motion; ` +
    `rotation is counter-clockwise in the north and clockwise in the south, slowed for display. While you watch one storm up close the replay slows so it lasts at least 20 s (pacing for display, not recorded speed). Dots behind each storm are its recorded track. Where a record leaves the wind blank it is filled from the storm's neighbouring records. ` +
    `Faint background dots: where storms passed most often since 1980. Categories: Saffir-Simpson on 1-minute wind (approximate outside the Atlantic and East Pacific).`;
  group.status = '';
  group.userData = {
    tracks, density, wake, storms: stormDots, meta: meta.meta, dots: { tracks: trackDots, density: M, wake: wakeDots, perStorm: DOTS },
    replay: { start: tStart, end: tEnd, storms: win.length, busiest, hoursPerSecond: HOURS_PER_S },
    get clockHour() { return clockH; }, setClockHour: (h) => { clockH = h; }, get replayRate() { return rate; }, get watching() { return watchId; },
    hazeReach, systemHeightR: H, exaggeration: { height: 1 },
    showDensity: (on) => { density.visible = on; },
  };
  group.update(0);
  return group;
}
