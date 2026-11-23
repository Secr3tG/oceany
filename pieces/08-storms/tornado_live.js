// Live tornado layer with 3D dot funnels for the Oceany globe (THREE.Points only).
//
//   const layer = await createLayer({ THREE, radius: 1, makeDotMaterial, palette });
//   scene.add(layer);   // add at the origin, no rotation/scale on the layer (funnel size/shrink use world positions)
//   layer.update(t[, camera])     // every frame: spins the storm systems, advances the replay clock
//   layer.setMode('auto'|'live'|'replay')   // auto = live when there are active warnings, else replay
//   layer.getFocusTargets()       // current storm systems, best to watch first: [{lat, lon, rating, name, id, timeLeft, fade}]
//                                 // order: storms with at least MIN_LEFT_S display seconds left first, then rating, then width.
//                                 // timeLeft: seconds until the storm leaves the list, in WATCHED seconds: a storm not yet watched reports
//                                 // what it will have once flown to and held (>= 4 s from its end), the watched one its real value (live: Infinity);
//                                 // fade: 0..1 how visible it is drawn now (a storm fades out over its last seconds, it never pops),
//                                 // so a follow can ease out before the storm is gone.
// Watch hold (replay): while the camera is close to a storm in the middle of the view (within WATCH_NEAR globe radii), or
// flies towards it fast (a fly-in starts far away and off-centre), the replay clock slows so that storm lasts at least WATCH_S
// seconds from then (the funnel keeps its own motion; only the walk along the recorded path slows, never below
// WATCH_MIN_RATE). The details text says so. userData.replayRate and userData.watching show it.
//   layer.label / layer.status    // short honest strings for the UI (also layer.userData.onChange(layer) callback)
//   layer.userData.refresh()      // fetch warnings now;  .live = last fetch result;  .dispose() stops the timer
//
// What is real and what is not (Oceany rule: anything illustrative is labelled):
//  - Warning polygons (live mode) are observed NWS data: the area where a tornado is expected, not where one is.
//  - No feed gives a tornado's position in real time. A funnel is an ILLUSTRATION placed at the polygon's centre.
//  - Replay mode shows recorded SPC paths and times (27 April 2011); positions between recorded points are interpolated.
//  - Sizes: tornado width = recorded SPC width x ONE exaggeration (x100) so relative widths are true; the parent storm (funnel,
//    debris ring, mesocyclone, anvil, inflow, ambient air) is about x10 real supercell size and steps with the F/EF rating.
//    Both ease down to true scale as the camera gets close. Shape, spin, inflow and air motion are an illustration.
// Live data: api.weather.gov alerts (US government, public). The request carries only the browser's default headers.
//
// Funnels: ONE shared Points buffer (MAX_FUNNELS x DOTS_PER_FUNNEL dots). Each dot only stores which funnel it belongs to
// and a few random numbers; the vertex shader builds the tapered, spinning, swaying vortex from a uniform array of funnel
// positions. Moving, adding or removing a funnel changes a uniform, never the geometry.

import { toXYZ, dotMaterial, dimMaterial, D2R } from './dots_common.js';

const ALERTS_URL = 'https://api.weather.gov/alerts/active?event=Tornado%20Warning';
const REFRESH_S = 180, MAX_BACKOFF_S = 900;
const MAX_FUNNELS = 48;          // storm systems at once
// dots per system: funnel 2200 (a strong tornado shows all, a weak one a fraction), debris skirt 240, mesocyclone 160,
// anvil 240, inflow 400 (spiral, ascent, throw-out), ground pulse ring 120, 8 converging streamers x 36 dots = 288
const PARTS = [[0, 9000], [1, 240], [2, 160], [3, 240], [4, 400], [5, 120], [6, 288], [7, 9600]];   // kind 6: 12 paths x 2 packets x 12 dots; kind 7: haze, 600 streaks x 6 dots
const GLOW_DOTS = 64;            // kind 8, own buffer and size cap: big soft sprites, the storm's dust lighting the ground round the base
const BAND_DOTS = 2400;          // kind 9, own buffer and size cap: the low dust band drawn into the base (large soft dots, so it reads as a sheet, not dots)
const CLOUD_DOTS = 1400;         // kind 10, own buffer, normal blending: dark-grey cloud base and lowered wall cloud (large soft dots)
const MARKER_DOTS = 16;          // kind 11: the small calm marker that replaces the storm at whole-globe zoom
const DOTS_PER_FUNNEL = PARTS.reduce((a, p) => a + p[1], 0);
const REACH_BASE = 0.04, REACH_PER_RATING = 0.02;    // how far a storm pulls from, globe radii: EF0 0.04 ... EF5 0.14 (~890 km), wider than the column is tall
const SYSTEM_HEIGHT = 0.055;     // ground to anvil of a rating-2 storm, globe radii (350 km): a column about as tall as the anvil is wide
const ANVIL_RADIUS = 0.035;      // anvil radius of a rating-2 storm (anvil spans 446 km, ~10x a real ~45 km anvil)
const EXAG_STORM = 10;           // horizontal parent-storm exaggeration at globe zoom (before the rating step below)
const EXAG_HEIGHT = 25;          // vertical exaggeration (350 km vs ~14 km real): taller than wide-scale so the column reads from any angle
const EXAG_WIDTH = 100;          // tornado width exaggeration at globe zoom: ONE factor for every tornado, true proportions between them
const SIZE_BY_RATING = [0.6, 0.8, 1.0, 1.25, 1.5, 1.8];      // storm size step per F/EF rating
const SPIN_BY_RATING = [0.7, 0.95, 1.2, 1.45, 1.7, 2.0];     // rotation / streaming speed step
const PULL_BY_RATING = [0.5, 0.75, 1.0, 1.25, 1.5, 1.8];     // inflow / ambient pull step
const DIM_BY_RATING = [0.45, 0.55, 0.7, 0.85, 1.0, 1.0];     // weak tornadoes are dimmer
const NEUTRAL = { widthM: 150 * 0.9144, rating: 2 };         // live mode: no measured size, one fixed neutral storm
const SHRINK_NEAR = 0.02, SHRINK_FAR = 0.45;  // camera-to-system distance (globe radii): true scale at 0.02 (~130 km), full exaggeration from 0.45
// replay pacing (display seconds): recorded order, strong tornadoes stay on screen longer, at most MAX_CONC at once
const SHOW_S = [1.6, 2.2, 3.2, 5, 14, 28],   // EF5 28 s, EF4 14 s: time to fly in to a strong tornado and still watch it for 20 s
      MAX_CONC = 5, GAP_S = 0.3, HOLD_S = 4, SCAR_S = 4;
const MIN_LEFT_S = 6;            // a storm with less display time left than this is offered after the others (a fly-in takes 2-5 s)
const WATCH_S = 24, WATCH_NEAR = 0.6, WATCH_MIN_RATE = 0.05;   // watch hold: 20 s to watch plus the fade-out; also starts on a fast approach (a fly-in)
const FADE_IN_S = 0.4, FADE_OUT_S = 2.5;   // display seconds; the fade-out is at most a quarter of the storm's time on screen
const OUTLINE_SPACING = 0.0015, MAX_OUTLINE_DOTS = 40000;

const PULSE_FUNC = /* glsl */`
  float hash1(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
  // a faint ring of brightness contracting from the edge of the disc to the core, now and then (irregular, never on a beat)
  float pulseBoost(float r, float reach) {
    float cyc = uTime / 6.3, tau = fract(cyc);
    if (hash1(floor(cyc) + reach * 977.0) < 0.55) return 0.0;
    float rp = reach * sqrt(max(1.0 - 0.97 * tau, 0.0));
    float x = (r - rp) / (0.07 * reach);
    return exp(-x * x) * smoothstep(0.0, 0.08, tau);
  }`;
const COMMON_FUNCS = /* glsl */`
  uniform vec3 uCore, uMid, uDim, uLand, uUnknown;   // the globe's palette (shallow, mid, deep, land) and its 'locked' grey
  vec3 ratingColor(float k) {   // F/EF 0..5 from the palette: mid (weak) to shallow (strong); 6 = rating unknown
    if (k > 5.5) return uUnknown;
    return mix(uMid * 1.2, uCore, k / 5.0);
  }`;
const VERT_FUNNEL = /* glsl */`
  uniform vec4 uFun[${MAX_FUNNELS}];        // xyz = base on the surface, w = 0 off, else rating + 1 (8 = live warning)
  uniform vec4 uDir[${MAX_FUNNELS}];        // xyz = unit vector along the ground in the storm's direction of travel, w = brightness
  uniform vec4 uSys[${MAX_FUNNELS}];        // x = tornado width (diameter, globe radii, exaggerated), y = size step, z = spin step, w = pull step
  uniform float uTime, uSize, uScale, uHeight, uAnvil, uExagS, uExagH, uExagW, uNear, uFar, uMaxPx, uOnly;   // uOnly >= 0: draw only that part (checking)
  const float REACH_BASE_ = ${REACH_BASE}, REACH_PER_ = ${REACH_PER_RATING};
  attribute float aFun; attribute vec4 aP;   // aP: random 0..1 (spread, angle, random), kind 0 funnel, 1 debris, 2 meso, 3 anvil, 4 inflow, 5 ground pulse, 6 bright inflow streak
  varying vec3 vColor; varying float vAlpha;
  ${COMMON_FUNCS}
  ${PULSE_FUNC}
  void main() {
    int i = int(aFun + 0.5);
    vec4 f = uFun[i];
    if (f.w < 0.5 || (uOnly >= 0.0 && abs(aP.w - uOnly) > 0.5)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; return; }
    vec3 base = f.xyz, n = normalize(base), wd = uDir[i].xyz;
    vec4 sys = uSys[i];
    float rk = f.w - 1.0; if (rk > 5.5) rk = 2.0;                // rating 0..5 (unknown / live-neutral = 2)
    float bright = uDir[i].w;
    vec3 up = abs(n.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 e1 = normalize(cross(n, up)), e2 = cross(n, e1);   // (e1, e2, n) right-handed: +angle is counter-clockwise seen from above
    float d = distance(cameraPosition, (modelMatrix * vec4(base, 1.0)).xyz);
    float tz = sqrt(clamp((d - uNear) / (uFar - uNear), 0.0, 1.0));   // eases late: still well exaggerated at the follow distance, true scale only close in
    float sS = mix(1.0 / uExagS, 1.0, tz);   // horizontal storm size: true scale up close, full exaggeration far away
    float sW = mix(1.0 / uExagW, 1.0, tz);   // tornado width: same easing
    float sH = mix(1.0 / uExagH, 1.0, tz);   // height: same easing
    float H = uHeight * sys.y, A = uAnvil * sys.y, spin = sys.z, pull = sys.w;
    // funnel: the foot is the recorded (exaggerated) path width; it widens upward into the wall cloud (illustrative), so it reads
    // as a funnel with a body from the follow distance instead of a thin needle (it was half the width at the top and 0.4 of
    // that at the ground, about 5:1 tall:wide)
    float rB = max(0.5 * sys.x, 0.0004);      // ground radius = half the (exaggerated) recorded width
    float rT = max(2.4 * rB, 0.5 * 0.010 * sys.y * sS / sW);   // top: 2.4x the foot, at least half the wall cloud's radius
    const float FT = 0.6;                     // the funnel reaches the cloud base at 0.6 of the column; wall cloud and mesocyclone above
    float a = aP.x, ang = aP.y * 6.2831853, rnd = aP.z, kind = aP.w, ph = float(i) * 1.7;
    float hn = 0.0, rad = 0.0, th = ang, alpha = 0.9, sz = 1.0, sR = sW;   // hn: height as a fraction of H
    vec3 hor = vec3(0.0), col = vec3(1.0);
    vec3 rc = ratingColor(rk);
    bool useRing = true;
    float worldD = -1.0;         // > 0: dot size given as a world diameter (ground glow sprites)
    // whole-globe zoom: the exaggerated storm would be a bright puff, so it fades out with distance and a small calm marker
    // (kind 11, a ring of a few dots, constant size on screen) takes its place
    float farK = smoothstep(0.9, 1.6, d);
    bool isMarker = kind > 10.5;
    if (isMarker ? farK < 0.001 : farK > 0.999) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; return; }
    if (isMarker) {              // MARKER: 12 dots on a ring ~6 px across the screen plus a soft centre, slowly turning and breathing
      bool centre = a > 12.0 / 16.0;
      float pxW = d / uScale;    // world size of one pixel at this distance
      th = a * 16.0 / 12.0 * 6.2831853 + uTime * 0.05;
      rad = centre ? 0.0 : (2.0 + 0.75 * rk) * pxW;   // EF5 a ~11 px ring, EF0 almost a single dot sR = 1.0;
      hn = 0.03;
      col = mix(uCore, vec3(0.9), 0.35);
      alpha = (centre ? 0.3 : 0.45 + 0.13 * rk) * (0.85 + 0.15 * sin(uTime * 0.5 + ph));
      worldD = (centre ? 3.0 + 0.6 * rk : 3.0) * pxW;
    } else if (kind > 9.5) {     // CLOUD BASE: a broad dark-grey base with a lowered, slowly turning wall cloud the funnel hangs from.
                                 // Own buffer, normal blending: it darkens what is behind it instead of adding light.
      bool wall = rnd < 0.42;
      float q = fract(a * 7.31 + rnd * 3.7);
      float wallR = max(2.2 * rT * sW, 0.006 * sys.y * sS), baseR = max(0.95 * A * sS, 2.2 * wallR);
      float r0 = wall ? wallR * (0.15 + 0.85 * sqrt(q)) : mix(wallR * 0.8, baseR, sqrt(q));
      float rn = r0 / baseR;
      float w = wall ? 0.35 : 0.12 * (wallR / max(r0, 1e-6)) + 0.04;   // slow turn: the wall cloud visibly, the base barely
      th = ang + uTime * w * (0.7 + 0.2 * spin);
      rad = r0 * (1.0 + 0.10 * sin(3.0 * th + uTime * 0.07 + ph) + 0.06 * sin(7.0 * th - uTime * 0.05));   // lumpy edge
      sR = 1.0;
      float wq = r0 / wallR;
      hn = wall ? FT - 0.10 * (1.0 - wq * wq) + 0.03 * fract(rnd * 17.3) : FT + 0.02 + 0.04 * fract(rnd * 17.3) - 0.03 * (1.0 - smoothstep(0.0, 0.5, rn));
      float shade = 0.85 + 0.3 * fract(rnd * 5.1);
      col = wall ? vec3(0.13, 0.13, 0.14) * shade : mix(vec3(0.15, 0.15, 0.16), vec3(0.27, 0.27, 0.28), smoothstep(FT + 0.01, FT + 0.06, hn)) * shade;   // dark underside, a little lighter on top
      alpha = (wall ? 0.55 : 0.42) * (1.0 - smoothstep(0.65, 1.0, rn));
      worldD = wall ? 0.45 * wallR : 0.16 * baseR;
    } else if (kind > 8.5) {            // DUST BAND: the atmosphere drawn in. A broad, low sheet of soft dust spiralling into the base along
                                 // 3 drifting arms, slow far out and accelerating close in (r ~ (1-v)^0.42), then lifted up the funnel.
                                 // Each dot has its own rate and starts every trip at a new azimuth and radius, so the sheet never repeats.
      float reachB = (REACH_BASE_ + REACH_PER_ * rk) * sS;
      if (rnd > 0.55 + 0.09 * rk) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; return; }   // weak storm: thinner sheet
      float rate = 0.05 * (0.7 + 0.6 * pull) * (0.6 + 0.8 * fract(rnd * 7.13 + a * 3.1));
      float tcb = a * 5.0 + rnd * 3.0 + uTime * rate, cyb = floor(tcb), u = fract(tcb);
      float hA = hash1(cyb * 1.618 + rnd * 77.7), hB = hash1(cyb * 2.414 + a * 31.3), hC = hash1(cyb * 0.731 + rnd * 13.1);
      float armI = floor(hA * 3.0);
      float armPh = armI * 2.0943951 + 0.7 * sin(uTime * 0.041 + armI * 2.3 + ph) + 0.4 * sin(uTime * 0.017 + armI * 4.1);
      float th0 = armPh + (hB - 0.5) * (hC < 0.18 ? 6.2831853 : 0.85);   // ~85% in the arms, the rest anywhere
      float R0 = reachB * (0.3 + 0.6 * hC * hC);   // most start in the inner half: denser sheet near the funnel
      float rIn = rB * sW * 1.15;
      float sweep = pull * 1.15 * log(max(reachB / rIn, 1.0));
      vec3 dust = mix(uLand * 2.6 + 0.16, uMid + 0.12, 0.4);
      if (u < 0.86) {
        float v = u / 0.86, q = pow(1.0 - v, 0.42);
        float rr = rIn + (R0 - rIn) * q;
        float tt = th0 + pull * 1.15 * log(max(reachB / rr, 1.0));   // log spiral on a fixed frame (angle depends on radius only), so the arms stay coherent
        hn = 0.0015 + 0.018 * pow(1.0 - v, 0.8) * (0.3 + 0.7 * hB);  // thick and low far out, hugging the ground near the base
        float near = 1.0 - q;                                         // 0 far out, 1 at the foot
        alpha = 0.095 * smoothstep(0.0, 0.15, v) * (0.5 + 0.5 * near) * (0.6 + 0.4 * smoothstep(rIn, rIn * 4.0, rr));   // dense close in: cap the pile-up
        col = mix(dust, vec3(0.86, 0.83, 0.77), 0.55 * near * near);   // dust paling as it nears the foot (warm, not the palette's cyan)
        sz = 4.8 - 3.0 * near;
        hor = (e1 * cos(tt) + e2 * sin(tt)) * rr;
      } else {
        float w = (u - 0.86) / 0.14;
        hn = w * FT * 0.75;
        float rr = (0.7 * rB + (rT - 0.7 * rB) * pow(w * 0.75, 2.2)) * sW * (1.15 - 0.1 * w);
        float tt = th0 + sweep + w * (6.0 + 2.0 * spin);
        alpha = 0.09 * (1.0 - w) * (1.0 - w); col = mix(vec3(0.86, 0.83, 0.77), vec3(0.72, 0.72, 0.70), w); sz = 0.8;
        hor = (e1 * cos(tt) + e2 * sin(tt)) * rr;
      }
      useRing = false;
    } else if (kind > 7.5) {     // GROUND GLOW: the dust skirt lighting the ground round the base (big soft sprites, own buffer)
      float inner = step(a, 0.62);
      float rr = inner > 0.5 ? rB * sW * (0.3 + 3.2 * sqrt(a / 0.62)) : rB * sW * 3.0 + 0.45 * (REACH_BASE_ + REACH_PER_ * rk) * sS * sqrt((a - 0.62) / 0.38);
      th = ang + uTime * spin * (inner > 0.5 ? 0.35 : 0.12) * (0.8 + 0.4 * rnd);
      hor = (e1 * cos(th) + e2 * sin(th)) * rr; useRing = false;
      hn = 0.0008;
      float reachG = (REACH_BASE_ + REACH_PER_ * rk) * sS;
      worldD = inner > 0.5 ? rB * sW * (4.5 + 2.0 * rnd) : max(rr * 0.9, 0.16 * reachG) * (0.9 + 0.4 * rnd);   // wide overlap: a wash, not blobs
      if (a < 1.0 / ${GLOW_DOTS}.0) { hor = vec3(0.0); worldD = rB * sW * 10.0; }   // one broad wash centred on the foot
      float flick = 0.8 + 0.2 * sin(uTime * (0.31 + 0.2 * rnd) + rnd * 40.0);
      col = mix(uLand * 2.6 + 0.08, mix(rc, vec3(0.9), 0.5), 0.25);
      alpha = (inner > 0.5 ? 0.07 : 0.035) * flick * (0.5 + 0.1 * rk);
    } else if (kind < 0.5) {            // FUNNEL: the subject. Dots stream UP in helical strands; hot white core fading to the rating colour
      // a dense volume of many small dim dots: a wall with faint helical striations and a thinner inner core; density, not dot
      // size, carries the brightness. Every dot rises and turns, faster closer to the axis, so the whole mass streams up and around
      if (rnd > 0.5 + 0.1 * rk) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; return; }   // weak: fewer dots
      float strands = 3.0 + floor(rk * 0.45);                 // 3 to 5 helical density lanes
      float sIdx = floor(aP.y * strands);
      // no shared period: each dot has its own rise speed, and each trip up the column re-seeds its radius, azimuth and spread
      float tc = a + uTime * 0.28 * (0.6 + 0.8 * fract(rnd * 13.7));
      float cyc = floor(tc), hc = hash1(cyc * 1.37 + rnd * 91.7), hd = hash1(cyc * 2.11 + rnd * 47.3);
      // three populations: 45% in spiral lanes on the wall, 40% between lanes on the wall, 15% faint interior fill
      // (so from above the core is darker than the wall), plus a soft fringe outside the wall (the outline fades, no hard cone)
      bool lane = hd < 0.42, fill = hd > 0.88;
      // each lane has its own slowly changing strength (two incommensurate slow waves): lanes strengthen, fade and widen as
      // they fade, so the barber-pole pattern never repeats (with equal lanes it repeated every turn / lanes, ~0.5 s)
      float sphL = fract(sin((sIdx + 1.0) * 91.17 + ph * 5.3) * 43758.5453);
      float laneA = (0.5 + 0.5 * sin(uTime * (0.11 + 0.07 * sphL) + sphL * 20.0)) * (0.55 + 0.45 * sin(uTime * (0.037 + 0.02 * sphL) + sIdx * 2.3));
      float spread = lane ? (hc + hash1(cyc * 3.7 + rnd * 19.3) - 1.0) * mix(1.3, 0.85, laneA) * (1.0 + 0.9 * smoothstep(0.45, 1.0, fract(tc))) : hc - 0.5;   // lanes: soft triangular profile; they blur into one body near the cloud base (no forked arms)
      float rq = fract(rnd * 53.1 + hd + hc);
      float rr = fill ? 0.7 * sqrt(rq) : (rq < 0.82 ? 0.5 + 0.5 * pow(rq / 0.82, 0.5) : 1.0 + 0.4 * pow((rq - 0.82) / 0.18, 1.5));
      float hp = fract(tc);
      hn = hp * FT;
      float breathe = 1.0 + 0.14 * sin(uTime * 0.131 + ph) + 0.08 * sin(uTime * 0.293 + ph * 2.3) + 0.05 * sin(uTime * 0.717 + hp * 4.0);
      // narrow at the ground, widening slowly, then flaring out into the wall cloud's underside (a condensation funnel, not a wedge)
      rad = (0.7 * rB + (rT - 0.7 * rB) * pow(hp, 2.2) + 0.9 * rT * pow(hp, 7.0)) * rr * breathe;
      float sph = fract(sin((sIdx + 1.0) * 91.17 + ph * 5.3) * 43758.5453);
      float wander = 0.7 * sin(uTime * 0.113 + sIdx * 1.31 + hp * 2.7) + 0.45 * sin(uTime * 0.071 + sIdx * 2.9 - hp * 4.1);   // strands drift, merge, split
      // the lane PATTERN turns at one shared rate (so lanes keep their shape instead of shearing into an even stipple), while each dot
      // climbs along its lane's helix: that climb is the visible rising, spiralling air. Interior fill turns faster and is not banded.
      float omega = 0.9 * (0.8 + 0.12 * spin);   // slow, readable turn of the texture (~6 s a turn at EF5); the rising climb carries the motion
      // lanes turn at slightly different rates (+-9%), so they drift past each other, merge and split over ~10-20 s
      th = (sIdx + spread + 0.6 * sph + wander) / strands * 6.2831853 + hp * (4.5 + 1.5 * sin(uTime * 0.047 + ph)) + uTime * omega * (fill ? 1.6 : 1.0 + 0.18 * (sph - 0.5));
      // rising clumps: brighter knots that travel up each lane at a speed the eye can follow (per-lane rate, drifting phase)
      float cr = 0.22 + 0.12 * sph;
      float knot = lane ? pow(0.5 + 0.5 * sin(6.2831853 * (hp * 1.6 - uTime * cr) + sIdx * 2.1 + ph + 1.5 * sin(uTime * 0.09 + sIdx)), 4.0) : 0.0;
      // condensation: warm grey-white, not the palette's cyan; paler low down (lit from below), greying as it merges into the cloud
      vec3 rcF = vec3(0.74, 0.73, 0.70);
      col = mix(vec3(0.86, 0.85, 0.82), rcF * 0.8, smoothstep(0.2, 1.0, hp)); col = mix(col, rcF * 0.6, fill ? 1.0 : 0.0);
      col = mix(col, vec3(0.95, 0.94, 0.91), 0.3 * knot);
      float fringe = rr > 1.0 ? 1.0 - smoothstep(1.0, 1.4, rr) : 1.0;
      alpha = (lane ? 0.07 * mix(0.45, 1.35, laneA) : (fill ? 0.035 : 0.065)) * (0.7 + 1.0 * knot) * fringe * (1.0 - smoothstep(0.85, 1.0, hp)) * smoothstep(0.0, 0.03, hp);
      alpha *= 0.55 + 0.45 * smoothstep(0.0, 0.45, hp);   // the narrow foot packs the same dots per height into a small ring: dim it, no white-hot foot
      sz = (0.4 + 0.2 * hp) * (1.0 + 0.5 * knot);   // larger than before: the wider funnel spreads its dots over ~2.5x the area
    } else if (kind < 1.5) {     // DEBRIS SKIRT whirling and rising at the foot
      float rp = fract(rnd + uTime * 0.25 * spin);
      hn = 0.002 + 0.07 * rp;
      rad = rB * (1.1 + 1.6 * a) + 0.002 * rp * sys.y;   // the foot is now the full recorded width: the skirt sits just outside it
      th = ang + uTime * spin * (6.0 - 3.0 * a);
      col = mix(uLand * 2.2 + 0.08, rc, 0.3 * rp); alpha = 0.26 * (1.0 - rp); sz = 0.7;   // softer: no saturated white foot   // earth thrown up: the palette's land colour
    } else if (kind < 2.5) {     // mesocyclone: faint wide column, turning slower
      hn = FT - 0.03 + (0.92 - FT) * a;   // from the wall cloud at the funnel top up to the anvil
      rad = (0.010 + 0.004 * sin(a * 3.14159)) * sys.y * (0.55 + 0.45 * sqrt(rnd)) * (1.0 + 0.6 * a); sR = sS;
      th = ang + uTime * spin * (1.6 + 0.8 * (1.0 - a));
      col = mix(vec3(0.42, 0.42, 0.44), vec3(0.26, 0.27, 0.30), a); alpha = (0.12 - 0.05 * a) * (0.6 + 0.8 * (1.0 - smoothstep(0.0, 0.15, a))); sz = 0.5;   // wall cloud (bottom) brightest
    } else if (kind < 3.5) {     // anvil: faint flat disc, stretched downwind, fading at its edge
      float rho = sqrt(a) * A, ra = rho / A, phi = ang + uTime * 0.12 * spin;
      vec3 perp = cross(n, wd);
      hn = 0.93 + 0.05 * rnd + 0.04 * (1.0 - ra * ra);
      hor = (wd * (rho * cos(phi) * 1.35 + 0.275 * A) + perp * (rho * sin(phi) * 0.75)) * sS;
      useRing = false; col = mix(vec3(0.22, 0.23, 0.26), vec3(0.40, 0.40, 0.42), 1.0 - ra); alpha = 0.22 * (1.0 - ra * ra * ra); sz = 1.0;
    } else if (kind < 4.5) {     // INFLOW drain loop: spiral in (speeding up as radius falls), up the funnel, thrown out at the top
      float u = fract(a + uTime * 0.075 * (0.6 + 0.6 * pull));
      float reach = REACH_BASE_ + REACH_PER_ * rk;
      float R0 = max(1.5 * A, 0.35 * reach);
      float tt, rr;
      if (u < 0.7) {
        float v = u / 0.7;
        rr = max(rB * sW * 1.2, R0 * sS * sqrt(max(1.0 - v, 0.0004)));
        tt = ang + pull * 1.3 * (-log(max(1.0 - v * 0.999, 0.001)));
        hn = 0.008 + 0.012 * v;
        alpha = 0.22 * smoothstep(0.0, 0.1, v) * (0.15 + 0.85 * v * v); col = mix(uDim, mix(uMid, uCore, v), v) * 1.5; sz = 0.4 + 0.3 * v;   // faint far out, brightening as it nears the foot
      } else if (u < 0.9) {
        float w = (u - 0.7) / 0.2;
        hn = w * FT;
        rr = (0.7 * rB + (rT - 0.7 * rB) * pow(w, 2.2)) * sW;
        tt = ang + pull * 5.0 + uTime * spin * 8.0 * (1.0 - 0.5 * w) + w * 7.0;
        alpha = 0.15; col = mix(vec3(0.85, 0.84, 0.80), vec3(0.6, 0.6, 0.6), w); sz = 0.5;
      } else {
        float w = (u - 0.9) / 0.1;
        rr = rT * sW + 0.55 * reach * sS * w * (2.0 - w);          // flung out at the top, then drifts back out and down to the haze
        tt = ang + pull * 5.0 + uTime * spin * 3.0 + w * 2.5;
        hn = FT + 0.3 * w * (1.0 - w) * 4.0 - (FT - 0.23) * w * w;
        alpha = 0.18 * (1.0 - w * w); col = mix(uMid, uCore, 0.5 * (1.0 - w)); sz = 0.5;
      }
      hor = (e1 * cos(tt) + e2 * sin(tt)) * rr; useRing = false;
    } else if (kind < 5.5) {     // GROUND PULSE: a bright ring expanding from the foot, repeating
      float t = fract(uTime * (0.3 + 0.1 * rk) + ph * 0.137);
      rad = rB * 1.5 + t * (0.12 * A + 2.0 * rT); sR = sS * 0.5 + sW * 0.5;
      hn = 0.003; th = a * 6.2831853;
      col = mix(uCore, rc, t); alpha = 0.1 * pow(1.0 - t, 1.5); sz = 0.6;
    } else if (kind > 6.5) {     // HAZE around each storm: 600 faint streaks drawn in along tightening spirals. r ~ (1-t)^0.36, so a
                                 // streak moves slowly far out and very fast close in (speed ~ r^-1.8): the inner ring stays sparse and
                                 // its streaks are long. Each streak is 6 dots a fixed time apart on one path, so its length shows its speed.
      float idx = floor(a * 9600.0), grp = floor(idx / 6.0), di = idx - grp * 6.0;
      float h1 = fract(sin(grp * 12.9898 + ph * 7.7) * 43758.5453), h2 = fract(sin(grp * 78.233 + ph * 3.3) * 43758.5453), h3 = fract(sin(grp * 39.425 + 1.7) * 24634.6345);
      if (h3 > 0.3 + 0.14 * rk) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; return; }   // weak storm: less haze
      float reachH = (REACH_BASE_ + REACH_PER_ * rk) * sS;
      float rate = 0.10 * (0.7 + 0.6 * pull) * (0.65 + 0.7 * h3);
      float tch = h1 * 7.31 + h2 * 3.1 + uTime * rate, cych = floor(tch);
      h1 = hash1(h1 * 31.1 + cych * 1.618); h2 = hash1(h2 * 17.7 + cych * 2.414);   // each trip starts somewhere new
      float dd = reachH * (0.45 + 0.55 * sqrt(h1)) * (1.0 + 0.3 * (hash1(grp * 0.73 + cych) - 0.5));   // radial jitter: sheets, not lines
      float t = fract(tch) - di * 0.014;
      if (t < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; return; }
      float pk = pow(1.0 - 0.985 * t, 0.36);
      float rr = max(rB * sW * 1.2, dd * pk);
      float sp = 1.0 - pk;
      float tt = h2 * 6.2831853 + pull * (0.9 * log(1.0 / max(pk, 0.03)) + 1.2 * pow(sp, 6.0));   // log spiral: a steady ~30-50 degree inflow angle, so the swirl reads all the way out
      hn = (0.02 + 0.28 * fract(h3 * 17.0)) * pow(1.0 - t, 1.3) + 0.003;     // dipping to the base as it closes in
      float env = smoothstep(0.0, 0.12, t) * (1.0 - smoothstep(0.97, 1.0, t));
      float sector = 1.0 + 0.7 * sin(h2 * 6.2831853 - uTime * 0.061 + ph) * (0.5 + 0.5 * sin(uTime * 0.023 + ph * 3.0));   // inflow bursts from one side, drifting
      alpha = 0.08 * sector * env * (0.5 + 1.0 * sp) * (1.0 - 0.13 * di) * (1.0 + 0.8 * pulseBoost(rr, reachH));
      col = mix(uDim * 1.4 + uMid * 0.2, mix(uMid * 1.2, uCore, sp), 0.5 + 0.5 * sp); sz = (0.38 + 0.2 * sp);
      hor = (e1 * cos(tt) + e2 * sin(tt)) * rr; useRing = false;
    } else {                     // INFLOW PACKETS: 12 curved paths from the edge of the disc into the base. On each path 2 separate
                                 // packets travel inward (a big bright head, 11 fading dots behind it in time, then a long empty gap),
                                 // speeding up and swirling as they close in, and lifting into the funnel foot at the end
      float idx = floor(a * 288.0), si = floor(idx / 24.0), rem = idx - si * 24.0, pk = floor(rem / 12.0), di = rem - pk * 12.0;
      float hs = fract(sin(si * 12.9898 + ph * 4.1) * 43758.5453);
      float phS = si / 12.0 * 6.2831853 + 0.35 * hs + 0.2 * sin(uTime * 0.13 + si * 2.1) + ph;
      float rate = 0.2 * (0.6 + 0.6 * pull) * (0.7 + 0.6 * hs);              // each path its own speed (EF5 about 3 s a trip)
      float tcp = pk * 0.5 + hs + uTime * rate;
      phS += 0.5 * (hash1(floor(tcp) * 3.3 + si) - 0.5);                    // each trip comes in at a slightly different azimuth
      float uu = fract(tcp) - di * 0.011;                                    // di = 0 is the head; the trail spans 0.12 of a trip
      if (uu < 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; return; }
      float reachS = (REACH_BASE_ + REACH_PER_ * rk) * sS;
      float q = pow(max(1.0 - uu, 0.0), 0.7);                                // radius: steady far out, accelerating close in
      float rr = rB * sW * 1.2 + reachS * q;
      float sp = 1.0 - q;                                                    // fraction of the way in
      float tt = phS + pull * (0.3 * sp + 2.6 * pow(sp, 3.0));               // mostly radial far out, swirling in close (counter-clockwise)
      hn = 0.004 + 0.22 * pow(1.0 - sp, 1.6) + 0.18 * pow(sp, 6.0);          // 3D: come in high far out, sink to the ground, lift into the funnel
      float pb = pulseBoost(rr, reachS);
      float tail = pow(1.0 - di / 12.0, 2.0);
      alpha = (di < 0.5 ? 0.2 : 0.14 * tail) * smoothstep(0.0, 0.08, uu) * (1.0 - smoothstep(0.97, 1.0, uu)) * (0.5 + 0.5 * sp) * (1.0 + 0.6 * pb);
      col = mix(mix(uCore, vec3(1.0), 0.4), vec3(1.0), sp); if (di < 0.5) col = vec3(1.0);   // packets white, haze in the palette's blues
      sz = (0.6 + 0.4 * sp) * (di < 0.5 ? 1.4 : 1.0);
      hor = (e1 * cos(tt) + e2 * sin(tt)) * rr; useRing = false;
    }
    if (useRing) hor = (e1 * cos(th) + e2 * sin(th)) * rad * sR;
    // slight lean along the direction of travel, growing with height, plus a gentle sway
    float lean = 0.12 * hn * H * sS;                            // slight, straight lean (~10 degrees)
    float sway = (sin(uTime * 0.8 + ph) * 0.35 + cos(uTime * 0.6 + ph) * 0.25) * 0.02 * hn * hn * H * sS;
    // the centreline snakes: three incommensurate periods (3.7, 5.3, 8.1 s), phase shifting with height, growing with height
    float wA = 0.16 * rT * sW * hn;
    vec3 wob = e1 * (sin(uTime * 1.698 + ph + hn * 3.0) + 0.6 * sin(uTime * 0.776 + ph * 2.0 - hn * 2.0)) * wA + e2 * sin(uTime * 1.186 + ph * 1.3 + hn * 4.0) * wA;
    vec3 p = base + n * (hn * H * sH) + hor + wd * lean + e1 * sway + wob;
    // depth cue: dots on the side of the vortex facing the camera are brighter and larger than those behind the axis
    vec3 toCam = cameraPosition - base; toCam -= n * dot(toCam, n);
    vec3 off = hor; float lo = length(off), lc = length(toCam);
    float facing = (lo > 1e-7 && lc > 1e-7) ? dot(off / lo, toCam / lc) : 0.0;
    float depthK = 0.5 + 0.5 * facing;
    alpha *= kind < 0.5 ? 0.8 + 0.35 * depthK : 0.7 + 0.8 * depthK; sz *= 0.85 + 0.25 * depthK;   // the funnel's shell: a softer cue (a strong one drew a bright one-sided edge, a 'flame')     // lit by viewing angle: near side x1.5, far side x0.7
    // seen from above, the flat inflow disc is not foreshortened, so its dots spread over ~3x the screen area of an oblique view
    // and the haze vanished; brighten and enlarge the inflow (haze, packets) as the view turns towards straight down
    if (kind > 5.5 && kind < 7.5 || kind > 8.5) {
      float topK = smoothstep(0.55, 0.95, dot(normalize(cameraPosition - base), n));
      alpha *= 1.0 + (kind > 8.5 ? 0.0 : kind > 6.5 ? 1.8 : 0.8) * topK; sz *= 1.0 + 0.35 * topK;
    }
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp((worldD > 0.0 ? worldD : uSize * sz * (0.5 + 0.5 * sS) * (0.6 + 0.4 * bright)) * uScale / -mv.z, 1.5, uMaxPx);
    vColor = col; vAlpha = alpha * (isMarker ? 1.0 : bright) * (isMarker ? farK : 1.0 - farK);
  }`;
const VERT_TRAIL = /* glsl */`
  uniform float uSize, uScale, uNow, uFade, uMaxPx; attribute float aT; attribute float aR; varying vec3 vColor; varying float vAlpha;
  ${COMMON_FUNCS}
  float hashT(float x) { return fract(sin(x * 12.9898) * 43758.5453); }
  void main() {   // the scar: dots appear as the funnel passes (aT = display seconds) and fade over uFade seconds
    float age = uNow - aT;
    if (age < 0.0 || age > uFade) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vAlpha = 0.0; return; }
    float k = 1.0 - age / uFade;
    // scattered across a swath, not a line: each dot sits a fixed random distance off the recorded centreline (static per dot)
    vec3 nn = normalize(position), ax = abs(nn.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 t1 = normalize(cross(nn, ax)), t2 = cross(nn, t1);
    float ja = hashT(aT * 17.31 + aR) * 6.2831853, jr = (0.0003 + 0.00012 * clamp(aR, 0.0, 5.0)) * sqrt(hashT(aT * 5.77 + 1.3));
    vec4 mv = modelViewMatrix * vec4(position + (t1 * cos(ja) + t2 * sin(ja)) * jr * length(position), 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(uSize * (0.8 + 0.25 * min(aR, 2.0 + step(aR, 5.5) * 3.0)) * (0.6 + 0.4 * k) * uScale / -mv.z, 1.5, uMaxPx);
    vColor = mix(ratingColor(aR), vec3(1.0), 0.3 * k * k) * (0.6 + 0.6 * k); vAlpha = 0.2 * k * k;   // the recorded path: a scattered swath that fades, not a laser
  }`;
const FRAG = /* glsl */`
  uniform float uDimK; varying vec3 vColor; varying float vAlpha;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    gl_FragColor = vec4(vColor, pow(1.0 - r, 2.0) * 0.85 * vAlpha * uDimK);
  }`;

export async function createLayer({ THREE, radius = 1.0, makeDotMaterial, palette } = {}) {
  const R = radius * 1.004;
  // share the globe's pixel-scale uniform (pixels per world unit at distance 1) through its material factory
  let uScale = { value: 450 };
  if (makeDotMaterial) { const probe = makeDotMaterial({ size: 0.001 }); if (probe.uniforms && probe.uniforms.uScale) uScale = probe.uniforms.uScale; probe.dispose?.(); }
  // palette: shared uniforms, re-read from the globe's palette object when it changes (palette buttons)
  const pal = palette || { shallow: [0.35, 1.0, 0.95], mid: [0.1, 0.5, 0.95], deep: [0.03, 0.08, 0.45], land: [0.30, 0.26, 0.22], locked: [0.29, 0.35, 0.40] };
  const colU = { uCore: { value: new THREE.Vector3() }, uMid: { value: new THREE.Vector3() }, uDim: { value: new THREE.Vector3() },
    uLand: { value: new THREE.Vector3() }, uUnknown: { value: new THREE.Vector3() } };
  let palKey = NaN;
  const syncPalette = () => {
    const k = pal.shallow[0] + 3 * pal.shallow[1] + 5 * pal.mid[0] + 7 * pal.mid[2] + 11 * pal.deep[0] + 13 * pal.deep[1] + 17 * (pal.land || [0])[0];
    if (k === palKey) return; palKey = k;
    colU.uCore.value.set(...pal.shallow); colU.uMid.value.set(...pal.mid);
    colU.uDim.value.set(Math.max(pal.deep[0], 0.45), Math.max(pal.deep[1], 0.45), Math.max(pal.deep[2], 0.45));
    const land = pal.land || [0.3, 0.26, 0.22], lk = pal.locked || [0.29, 0.35, 0.4];
    colU.uLand.value.set(...land); colU.uUnknown.value.set(lk[0] * 2, lk[1] * 2, lk[2] * 2);
  };
  syncPalette();
  const uDimK = { value: 1 };   // setDim: 0..1 on every dot of the layer (fade in / out)
  const uMaxPx = { value: 16 * (globalThis.devicePixelRatio || 1) };   // dot size cap in drawing-buffer pixels (keeps additive overdraw bounded up close)
  const mkMat = (vertexShader, uniforms, extra = {}) => new THREE.ShaderMaterial({
    uniforms: { uScale, uMaxPx, uDimK, ...colU, ...uniforms }, vertexShader, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, ...extra,
  });

  // ---- funnels: one buffer for all
  const total = MAX_FUNNELS * DOTS_PER_FUNNEL;
  const fPos = new Float32Array(total * 3), aFun = new Float32Array(total), aP = new Float32Array(total * 4);
  for (let f = 0; f < MAX_FUNNELS; f++) {
    let k0 = 0;
    for (const [kind, n] of PARTS) {
      for (let k = 0; k < n; k++) {
        const i = f * DOTS_PER_FUNNEL + k0 + k;
        aFun[i] = f;
        aP[i * 4] = (k + Math.random()) / n;        // stratified, so dots spread evenly along height / radius
        aP[i * 4 + 1] = Math.random(); aP[i * 4 + 2] = Math.random(); aP[i * 4 + 3] = kind;
      }
      k0 += n;
    }
  }
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.BufferAttribute(fPos, 3));
  fg.setAttribute('aFun', new THREE.BufferAttribute(aFun, 1));
  fg.setAttribute('aP', new THREE.BufferAttribute(aP, 4));
  const uFun = Array.from({ length: MAX_FUNNELS }, () => new THREE.Vector4(0, 0, 0, 0));
  const uDir = Array.from({ length: MAX_FUNNELS }, () => new THREE.Vector4(0, 0, 1, 0));
  const uSys = Array.from({ length: MAX_FUNNELS }, () => new THREE.Vector4(0.003, 1, 1, 1));
  const funnelMat = mkMat(VERT_FUNNEL, {
    uFun: { value: uFun }, uDir: { value: uDir }, uSys: { value: uSys }, uTime: { value: 0 }, uSize: { value: 0.0036 }, uHeight: { value: SYSTEM_HEIGHT },
    uAnvil: { value: ANVIL_RADIUS }, uExagS: { value: EXAG_STORM }, uExagH: { value: EXAG_HEIGHT }, uExagW: { value: EXAG_WIDTH }, uNear: { value: SHRINK_NEAR }, uFar: { value: SHRINK_FAR }, uOnly: { value: -1 },
  });
  const funnels = new THREE.Points(fg, funnelMat);
  funnels.name = 'tornado-funnel-dots'; funnels.frustumCulled = false; funnels.renderOrder = 5;
  // ground glow: a few big soft sprites per storm in their own buffer with a higher size cap (the funnel's 16 px cap keeps additive
  // overdraw bounded for 20k-dot storms; 36 sprites per storm can be large). Same shader and uniforms, kind 8.
  const partBuffer = (kind, n, maxPx, name, order, extra = {}) => {
    const tot = MAX_FUNNELS * n, af = new Float32Array(tot), ap = new Float32Array(tot * 4);
    for (let f = 0; f < MAX_FUNNELS; f++) for (let k = 0; k < n; k++) {
      const i = f * n + k; af[i] = f;
      ap[i * 4] = (k + Math.random()) / n; ap[i * 4 + 1] = Math.random(); ap[i * 4 + 2] = Math.random(); ap[i * 4 + 3] = kind;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tot * 3), 3));
    g.setAttribute('aFun', new THREE.BufferAttribute(af, 1));
    g.setAttribute('aP', new THREE.BufferAttribute(ap, 4));
    const pts = new THREE.Points(g, mkMat(VERT_FUNNEL, { ...funnelMat.uniforms, uMaxPx: { value: maxPx * (globalThis.devicePixelRatio || 1) } }, extra));
    pts.name = name; pts.frustumCulled = false; pts.renderOrder = order;
    return pts;
  };
  const glow = partBuffer(8, GLOW_DOTS, 260, 'tornado-ground-glow', 4);
  const band = partBuffer(9, BAND_DOTS, 44, 'tornado-dust-band', 4);
  const cloud = partBuffer(10, CLOUD_DOTS, 90, 'tornado-cloud-base', 3, { blending: THREE.NormalBlending });
  const marker = partBuffer(11, MARKER_DOTS, 12, 'tornado-marker', 6);


  // ---- warning outlines (live): preallocated, filled when a fetch returns
  const oPos = new Float32Array(MAX_OUTLINE_DOTS * 3), oCol = new Float32Array(MAX_OUTLINE_DOTS * 3);
  const og = new THREE.BufferGeometry();
  og.setAttribute('position', new THREE.BufferAttribute(oPos, 3));
  og.setAttribute('color', new THREE.BufferAttribute(oCol, 3));
  og.setDrawRange(0, 0);
  const outline = new THREE.Points(og, dotMaterial(THREE, makeDotMaterial, { size: 0.0034, opacity: 0.95 }));
  outline.name = 'tornado-warning-outline-dots'; outline.frustumCulled = false;

  // ---- replay trail: dots left behind along each recorded path, revealed by simulated time
  const rep = await fetch(new URL('./data/replay_outbreak.json', import.meta.url)).then((r) => { if (!r.ok) throw new Error('replay ' + r.status); return r.json(); });
  const T = rep.tornadoes; // [slat, slon, elat, elon, startMin, endMin, rating (6/-9 unknown), state, widthYd used, lengthMi, rating used]
  const unit = (la, lo) => { const a = la * D2R, b = lo * D2R; return [Math.cos(a) * Math.cos(b), Math.sin(a), -Math.cos(a) * Math.sin(b)]; };
  const ends = T.map((t) => [unit(t[0], t[1]), unit(t[2], t[3])]);
  const ang = (a, b) => Math.acos(Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  // pacing: recorded order, a strong tornado stays on screen several display seconds; at most MAX_CONC at once
  const rUsed = (t) => Math.max(0, Math.min(5, t[10]));
  const S = [], D = []; { const endsAt = []; let prev = 0;
    T.forEach((t) => { let st = prev + GAP_S; const dur = SHOW_S[rUsed(t)];
      for (;;) { for (let k = endsAt.length - 1; k >= 0; k--) if (endsAt[k] <= st) endsAt.splice(k, 1);
        if (endsAt.length < MAX_CONC) break; st = Math.min(...endsAt); }
      S.push(st); D.push(dur); endsAt.push(st + dur); prev = st; }); }
  const repEnd = Math.max(...S.map((x, i) => x + D[i])) + HOLD_S;
  // a fresh load opens the replay just before the first of the strongest tornadoes starts (the morning storms before it are
  // weaker), so "Fly to strongest storm" right after load finds one that lasts; the loop then wraps to the start of the day
  const firstTop = T.findIndex((t) => rUsed(t) === 5), REPLAY_OPEN_S = firstTop >= 0 ? Math.max(0, S[firstTop] - 0.2) : 0;
  const fadeOut = D.map((d) => Math.min(FADE_OUT_S, 0.25 * d));
  const trailN = T.map((t, i) => Math.max(1, Math.round(ang(ends[i][0], ends[i][1]) / (0.04 * D2R))) + 1);
  const tTotal = trailN.reduce((a, b) => a + b, 0);
  const tPos = new Float32Array(tTotal * 3), tT = new Float32Array(tTotal), tR = new Float32Array(tTotal);
  const nlerp = (a, b, f, out) => { let x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f, z = a[2] + (b[2] - a[2]) * f; const l = Math.hypot(x, y, z); out[0] = x / l; out[1] = y / l; out[2] = z / l; };
  let d = 0; const tmp = [0, 0, 0];
  T.forEach((t, i) => {
    for (let k = 0; k < trailN[i]; k++) {
      const f = trailN[i] === 1 ? 0 : k / (trailN[i] - 1);
      nlerp(ends[i][0], ends[i][1], f, tmp);
      tPos[d * 3] = tmp[0] * R * 1.0005; tPos[d * 3 + 1] = tmp[1] * R * 1.0005; tPos[d * 3 + 2] = tmp[2] * R * 1.0005;
      tT[d] = S[i] + D[i] * f; tR[d] = t[6] < 0 || t[6] > 5 ? 6 : rUsed(t); d++;
    }
  });
  const tg = new THREE.BufferGeometry();
  tg.setAttribute('position', new THREE.BufferAttribute(tPos, 3));
  tg.setAttribute('aT', new THREE.BufferAttribute(tT, 1));
  tg.setAttribute('aR', new THREE.BufferAttribute(tR, 1));
  const trailMat = mkMat(VERT_TRAIL, { uSize: { value: 0.0034 }, uNow: { value: -1e9 }, uFade: { value: SCAR_S } });
  const trail = new THREE.Points(tg, trailMat);
  trail.name = 'tornado-replay-trail-dots'; trail.frustumCulled = false;

  const group = new THREE.Group();
  group.name = 'tornado-live';
  group.add(outline, trail, cloud, glow, band, funnels, marker);

  // ---- state
  let mode = 'auto', lastT = null, repT = REPLAY_OPEN_S, lastStatusT = -1;
  let rate = 1, watchId = '', watchT0 = 0, watchAway = 0, prevLitId = '', prevLitD = 1e9;   // watch hold (see the header)
  const focusPool = Array.from({ length: MAX_FUNNELS }, () => ({ lat: 0, lon: 0, rating: 0, name: '', id: '', widthM: 0, measured: false, left: Infinity, fade: 1, sched: -1 }));
  const focusOrder = Array.from({ length: MAX_FUNNELS }, (_, i) => i);
  let nFocus = 0;   // storms on screen; focusPool[focusOrder[0]] is the strongest
  const live = { ok: null, count: 0, withPolygon: 0, time: null, error: null, fetches: 0, httpStatus: null };
  let liveFunnels = []; // [x, y, z, name] centres of live warnings
  const SAFETY = 'Not an official product. Do not use for safety decisions: see weather.gov for warnings.';
  const SHORT_LIVE = 'Active NWS tornado warnings. The storm drawn in each is illustrative, at one neutral size. ' + SAFETY;
  const SHORT_REPLAY = `Replay of recorded tornado paths, 27 April 2011. Size from recorded width and rating; at globe zoom width x${EXAG_WIDTH}, storm x${EXAG_STORM}, height x${EXAG_HEIGHT}. Air motion illustrative.`;
  // label: one line for the panel; details: the full account of what is recorded, exaggerated and illustrative
  const setStatus = (details, status) => { group.details = details; group.label = details === LABEL_LIVE ? SHORT_LIVE : SHORT_REPLAY; group.status = status; group.userData.onChange?.(group); };
  const effective = () => (mode === 'replay' ? 'replay' : mode === 'live' ? 'live' : (live.count > 0 ? 'live' : 'replay'));
  const wr = rep.widthYd, rr = rep.rating;
  const NOTE = `Exaggeration at globe zoom: tornado width x${EXAG_WIDTH} (one factor for all, so relative widths are true), parent storm width x${EXAG_STORM} (anvil ~${Math.round(ANVIL_RADIUS * 2 * 6371)} km across vs ~45 km real), height x${EXAG_HEIGHT} (~${Math.round(SYSTEM_HEIGHT * 6371)} km vs ~14 km real, so the column reads from any angle); all ease to true scale as you zoom in. Illustration, not measured wind: funnel shape (it meets a wall cloud at 60% of the column height), spin, spiral lanes and the bright knots rising up them; the inflow streaks and the haze drawn in along spirals (pull reaches EF0 ~${Math.round(REACH_BASE * 6371)} km to EF5 ~${Math.round((REACH_BASE + 5 * REACH_PER_RATING) * 6371)} km, far beyond a real tornado's inflow); the debris ring, ground pulse and all other air motion. Colour and size step with the rating. The funnel and cloud base are drawn in neutral greys (condensation, not data). At whole-globe zoom each storm is a small ring marker instead (ring size steps with the rating). Up close, storms away from the middle of the view are dimmed. Pacing is for display, not recorded duration: strong tornadoes stay on screen longer, and while you watch one up close the replay slows so it lasts at least 20 s, then it fades out.`;
  const LABEL_LIVE = SAFETY + ' Warning outlines are active NWS tornado warnings (bright: tornado observed, dimmer: radar indicated): the area where a tornado is expected, not where one is. The storm drawn at each warning\'s centre is an illustration: one fixed neutral size (a 137 m wide, rating-2 tornado; nothing here is measured) and a fixed north-east heading. No feed gives a tornado\'s live position. ' + NOTE;
  const LABEL_REPLAY = `Replay of recorded SPC tornado paths from ${rep.name} (${rep.count} tornadoes) in recorded order; not real time: strong tornadoes are held on screen longer and several play at once. Relative size, dot count and brightness follow each recorded width (${wr.min}-${wr.max} yd) and rating (EF${rr.min}-EF${rr.max}); ${wr.medianUsed} widths and ${rr.medianUsed} ratings were missing and use the median. The glowing scar is the recorded path, fading after a few seconds. SPC width is the maximum; the funnel narrows to a rope at the start and end of each path (illustrative profile). ` + NOTE;
  const nowRecorded = () => { // recorded clock time (minutes) of the most recently started tornado
    let m = 0; for (let i = 0; i < T.length; i++) if (S[i] <= repT) m = T[i][4]; return m;
  };
  const fmtUTC = (dt) => dt.toISOString().slice(11, 16) + ' UTC';
  const clock = (m) => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(Math.floor(m % 60)).padStart(2, '0');

  const refreshStatus = () => {
    if (effective() === 'live') {
      const n = live.count, when = live.time ? ', updated ' + fmtUTC(live.time) : '';
      if (live.ok === false) {   // offline or the feed failed: say so, never imply "no warnings"
        setStatus(LABEL_LIVE, live.time ? `Live feed unavailable; showing the last warnings received (${n}), from ${fmtUTC(live.time)}. Check weather.gov.` : 'Live feed unavailable: no warnings could be loaded. Check weather.gov.');
        return;
      }
      setStatus(LABEL_LIVE, n === 0 ? 'No active warnings' + when : `${n} active tornado warning${n > 1 ? 's' : ''}${live.withPolygon < n ? ` (${live.withPolygon} with a drawn area)` : ''}${when}; storms drawn at one neutral size, not measured`);
    } else {
      const off = live.ok === false ? ' (live feed unavailable)' : live.count === 0 && mode === 'auto' ? ' (no active warnings, so showing a replay)' : '';
      setStatus(LABEL_REPLAY, `Replay of recorded paths, ${rep.date}, now at recorded time ${clock(nowRecorded())} CST${nFocus ? ', strongest on screen: ' + focusPool[focusOrder[0]].name : ''}${off}`);
    }
  };

  // ---- live feed
  const ringsOf = (geom) => !geom ? [] : geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.type === 'MultiPolygon' ? geom.coordinates.map((p) => p[0]) : [];
  const applyWarnings = (features) => {
    let o = 0; liveFunnels = []; let withPoly = 0;
    for (const f of features) {
      const rings = ringsOf(f.geometry); if (!rings.length) continue; withPoly++;
      const nm = (f.properties?.areaDesc || 'Tornado warning').slice(0, 60);
      const sev = (f.properties?.parameters?.tornadoDetection?.[0] || '').toUpperCase();
      const col = sev.includes('OBSERVED') || sev.includes('CONFIRMED') ? pal.shallow : pal.mid;   // brighter outline: tornado observed
      for (const ring of rings) {
        const c = [0, 0, 0];
        for (let i = 0; i < ring.length; i++) {
          const a = unit(ring[i][1], ring[i][0]); c[0] += a[0]; c[1] += a[1]; c[2] += a[2];
          const b = unit(ring[(i + 1) % ring.length][1], ring[(i + 1) % ring.length][0]);
          const n = Math.max(1, Math.ceil(ang(a, b) / OUTLINE_SPACING));
          for (let k = 0; k < n && o < MAX_OUTLINE_DOTS; k++) {
            nlerp(a, b, k / n, tmp); oPos[o * 3] = tmp[0] * R; oPos[o * 3 + 1] = tmp[1] * R; oPos[o * 3 + 2] = tmp[2] * R; oCol.set(col, o * 3); o++;
          }
        }
        const l = Math.hypot(...c); if (l > 0 && liveFunnels.length < MAX_FUNNELS) liveFunnels.push([c[0] / l, c[1] / l, c[2] / l, nm]);
      }
    }
    og.attributes.position.needsUpdate = true; og.attributes.color.needsUpdate = true; og.setDrawRange(0, o);
    live.withPolygon = withPoly;
  };
  let timer = null, fails = 0, disposed = false;
  const fetchLive = async () => {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(ALERTS_URL, { signal: ctl.signal }); clearTimeout(to);
      live.httpStatus = r.status; live.fetches++;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const feats = (j.features || []).filter((f) => f.properties?.event === 'Tornado Warning');
      live.count = feats.length; live.ok = true; live.error = null; live.time = new Date(); fails = 0;
      applyWarnings(feats);
    } catch (e) { live.ok = false; live.error = String(e.message || e); fails++; }
    refreshStatus();
  };
  const schedule = () => {
    if (disposed) return;
    const wait = fails ? Math.min(MAX_BACKOFF_S, REFRESH_S * Math.pow(2, fails - 1)) : REFRESH_S; // 180 s, then doubling up to 15 min after errors
    timer = setTimeout(async () => { if (!document.hidden && group.visible) await fetchLive(); schedule(); }, wait * 1000);
  };
  await Promise.race([fetchLive(), new Promise((res) => setTimeout(res, 9000))]);
  schedule();

  // ---- per frame
  const northEast = (u, out) => {            // unit vector along the ground towards the north-east
    const cl = Math.hypot(u[0], u[2]) || 1, ex = u[2] / cl, ez = -u[0] / cl;      // east
    const nx = u[1] * ez - u[2] * 0, ny = u[2] * ex - u[0] * ez, nz = u[0] * 0 - u[1] * ex; // north = n x east
    const x = (ex + nx) * 0.7071, y = ny * 0.7071, z = (ez + nz) * 0.7071, l = Math.hypot(x, y, z);
    out.set(x / l, y / l, z / l, 0);
  };
  const setFunnel = (slot, u, code, to, widthM, rating, bright) => {
    uFun[slot].set(u[0] * R, u[1] * R, u[2] * R, code);
    const rt = Math.max(0, Math.min(5, rating));
    // tornado width: recorded metres x ONE exaggeration factor, in globe radii (diameter); size/spin/pull step with the rating
    uSys[slot].set(widthM * EXAG_WIDTH / 6371000 * radius, SIZE_BY_RATING[rt], SPIN_BY_RATING[rt], PULL_BY_RATING[rt]);
    if (to) {   // heading along the recorded path, flattened onto the ground plane
      let x = to[0] - u[0], y = to[1] - u[1], z = to[2] - u[2]; const dn = x * u[0] + y * u[1] + z * u[2];
      x -= dn * u[0]; y -= dn * u[1]; z -= dn * u[2]; const l = Math.hypot(x, y, z);
      if (l > 1e-7) { uDir[slot].set(x / l, y / l, z / l, bright); return; }
    }
    northEast(u, uDir[slot]); uDir[slot].w = bright;
  };
  // per frame: no allocation. Focus records are reused; names are built once.
  const repNames = T.map((t) => `${t[7]} ${t[6] < 0 || t[6] > 5 ? 'rating unknown' : 'EF' + t[6]}, ${clock(t[4])} CST, ${t[8]} yd wide`);   // unique per tornado
  const fillFocus = (slot, u, rating, name, widthM, measured) => {
    const fo = focusPool[slot];
    fo.lat = Math.asin(Math.max(-1, Math.min(1, u[1]))) / D2R; fo.lon = Math.atan2(-u[2], u[0]) / D2R;
    fo.rating = rating; fo.name = name; fo.id = name; fo.widthM = widthM; fo.measured = measured; fo.left = Infinity; fo.fade = 1; fo.sched = -1;
  };
  const camV = new THREE.Vector3(), pv = new THREE.Vector3();
  let litId = '';
  const FOCUS_NEAR = 1.0, FOCUS_DIM = 0.2;   // closer than this (globe radii), storms other than the one in view are dimmed
  group.update = (timeSeconds, camera) => {
    if (!group.visible) { lastT = timeSeconds; return; }
    const dt = lastT === null ? 0 : Math.min(0.25, Math.max(0, timeSeconds - lastT)); lastT = timeSeconds;
    syncPalette();
    funnelMat.uniforms.uTime.value = timeSeconds;
    const eff = effective();
    let slot = 0;
    if (eff === 'live') {
      trailMat.uniforms.uNow.value = -1e9;
      for (; slot < liveFunnels.length; slot++) {
        const u = liveFunnels[slot]; setFunnel(slot, u, 8, null, NEUTRAL.widthM, NEUTRAL.rating, 1.0);
        fillFocus(slot, u, NEUTRAL.rating, u[3], NEUTRAL.widthM, false);
      }
      outline.visible = true;
    } else {
      outline.visible = false;
      repT += dt * rate; if (repT > repEnd) repT = 0;
      trailMat.uniforms.uNow.value = repT;
      for (let i = 0; i < T.length && slot < MAX_FUNNELS; i++) {
        if (repT < S[i] || repT > S[i] + D[i]) continue;
        const t = T[i], rt = rUsed(t), f = (repT - S[i]) / D[i];
        nlerp(ends[i][0], ends[i][1], f, tmp);
        // fade the funnel in over FADE_IN_S and out over its last fadeOut seconds (ropes out and dissolves, never pops)
        const eo = Math.max(0, Math.min(1, (S[i] + D[i] - repT) / fadeOut[i])), edge = Math.min(1, (repT - S[i]) / FADE_IN_S) * eo * eo * (3 - 2 * eo);
        fillFocus(slot, tmp, rt, repNames[i], t[8] * 0.9144, true);
        { const fo = focusPool[slot]; fo.sched = i; const L = S[i] + D[i] - repT, now = L / Math.max(rate, WATCH_MIN_RATE);
          // watched seconds: a storm not yet watched reports what it will have once flown to (the hold), unless under 4 s from its end
          fo.left = fo.id === watchId || L < 4 ? now : Math.max(now, Math.min(L / WATCH_MIN_RATE, WATCH_S)); fo.fade = edge; }
        const prof = 0.35 + 0.65 * Math.pow(Math.sin(Math.PI * f), 0.6);   // illustrative: narrow rope at start and end, recorded (maximum) width mid-path
        setFunnel(slot++, tmp, (t[6] < 0 || t[6] > 5 ? 6 : t[6]) + 1, ends[i][1], t[8] * 0.9144 * prof, rt, DIM_BY_RATING[rt] * edge);
      }
    }
    for (let s2 = slot; s2 < MAX_FUNNELS; s2++) if (uFun[s2].w !== 0) uFun[s2].w = 0;
    fg.setDrawRange(0, slot * DOTS_PER_FUNNEL);
    // up close, keep the storm nearest the middle of the view bright and dim the others, so overlapping storms do not merge
    let litK = -1, litD = 1e9, litDD = 1e9;
    if (camera && slot > 0) {
      camera.getWorldPosition(camV);
      let best = -1, bd = 1e9, keepK = -1, keepD = 1e9;
      for (let k = 0; k < slot; k++) {
        pv.set(uFun[k].x, uFun[k].y, uFun[k].z).project(camera);
        if (pv.z > 1) continue;
        const dd = pv.x * pv.x + 0.5 * (pv.y + 0.3) * (pv.y + 0.3);
        if (dd < bd) { bd = dd; best = k; }
        if (focusPool[k].id === litId) { keepK = k; keepD = dd; }
      }
      if (keepK >= 0 && keepD < 0.5 && keepD < bd + 0.03) best = keepK;   // hysteresis: the lit storm stays lit unless another is clearly nearer the middle (a followed storm always wins)
      if (best >= 0) { litId = focusPool[best].id; litDD = best === keepK ? keepD : bd; }
      if (best >= 0) {
        pv.set(uFun[best].x, uFun[best].y, uFun[best].z);
        litK = best; litD = camV.distanceTo(pv);
        const near = Math.max(0, Math.min(1, (FOCUS_NEAR - litD) / 0.4));
        if (near > 0) for (let k = 0; k < slot; k++) if (k !== best) uDir[k].w *= 1 - (1 - FOCUS_DIM) * near;
      }
    }
    // watch hold: the storm watched up close sets the replay speed for the next frame
    rate = 1;
    if (eff === 'replay') {
      // watched: close and near the middle of the view, or being approached fast (a fly-in, which starts far and off-centre)
      const approaching = litK >= 0 && focusPool[litK].id === prevLitId && dt > 0 && (prevLitD - litD) / dt > 0.4 && litD < 3.2;
      prevLitId = litK >= 0 ? focusPool[litK].id : ''; prevLitD = litD;
      if ((litK >= 0 && litD < WATCH_NEAR && litDD < 0.15) || approaching) {
        if (focusPool[litK].id !== watchId) { watchId = focusPool[litK].id; watchT0 = timeSeconds; }
        watchAway = 0;
      } else if (watchId && (watchAway += dt) > 2) watchId = '';
      if (watchId) {
        let k = 0; while (k < slot && focusPool[k].id !== watchId) k++;
        if (k < slot) {
          const i = focusPool[k].sched, L = S[i] + D[i] - repT, W = WATCH_S - (timeSeconds - watchT0);
          if (W > 0 && L < W) rate = Math.max(WATCH_MIN_RATE, L / W);
        }
      }
    }
    nFocus = slot;
    for (let k = 0; k < slot; k++) focusOrder[k] = k;   // strongest first: insertion sort over the few active storms
    for (let x = 1; x < slot; x++) {
      const v = focusOrder[x], fv = focusPool[v]; let y = x - 1;
      const lv = fv.left * rate >= MIN_LEFT_S;
      while (y >= 0) { const fy = focusPool[focusOrder[y]], ly = fy.left * rate >= MIN_LEFT_S;
        if (ly !== lv ? ly : (fy.rating > fv.rating || (fy.rating === fv.rating && fy.widthM >= fv.widthM))) break; focusOrder[y + 1] = focusOrder[y]; y--; }
      focusOrder[y + 1] = v;
    }
    group.userData.activeFunnels = slot;
    if (eff === 'replay' && timeSeconds - lastStatusT > 0.5) { lastStatusT = timeSeconds; refreshStatus(); }
  };
  group.getFocusTargets = () => { const r = []; for (let k = 0; k < nFocus; k++) { const x = focusPool[focusOrder[k]]; r.push({ lat: x.lat, lon: x.lon, rating: x.rating, name: x.name, id: x.id, timeLeft: x.left, fade: x.fade }); } return r; };
  group.setDim = (k) => { uDimK.value = Math.max(0, Math.min(1, k)); dimMaterial(outline.material, k); };
  // Is anything happening now? One light request to the NWS alerts API; safe while hidden; never throws.
  group.checkActivity = async () => {
    try {
      const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(ALERTS_URL, { signal: ctl.signal }); clearTimeout(to);
      if (!r.ok) return { active: false, where: null, note: '' };
      const j = await r.json();
      const feats = (j.features || []).filter((f) => f.properties?.event === 'Tornado Warning');
      if (!feats.length) return { active: false, where: null, note: 'No active tornado warnings' };
      const pick = feats.find((f) => /OBSERVED|CONFIRMED/i.test(f.properties?.parameters?.tornadoDetection?.[0] || '') && ringsOf(f.geometry).length)
        || feats.find((f) => ringsOf(f.geometry).length);
      let where = null;
      if (pick) { const ring = ringsOf(pick.geometry)[0], c = [0, 0, 0];
        for (const p of ring) { const u = unit(p[1], p[0]); c[0] += u[0]; c[1] += u[1]; c[2] += u[2]; }
        const l = Math.hypot(...c); if (l > 0) where = { lat: Math.asin(c[1] / l) / D2R, lon: Math.atan2(-c[2] / l, c[0] / l) / D2R }; }
      return { active: true, where, note: `${feats.length} tornado warning${feats.length > 1 ? 's' : ''} active` };
    } catch (e) { return { active: false, where: null, note: '' }; }
  };
  group.setMode = (m) => { mode = m; if (m === 'replay' || effective() === 'replay') repT = REPLAY_OPEN_S; refreshStatus(); };
  group.userData = {
    live, refresh: async () => { await fetchLive(); }, dispose: () => { disposed = true; clearTimeout(timer); },
    dotScale: uScale, funnels, showOnly: (kind) => { funnelMat.uniforms.uOnly.value = kind == null ? -1 : kind; },   // checking: 0 funnel ... 6 packets, 7 haze
     outline, trail, replay: rep,
    systemHeightR: SYSTEM_HEIGHT, anvilSpanR: ANVIL_RADIUS * 2, exaggeration: { width: EXAG_WIDTH, storm: EXAG_STORM, height: EXAG_HEIGHT }, hazeDotsPerStorm: 9600, hazeReach: [0, 1, 2, 3, 4, 5].map((r) => REACH_BASE + REACH_PER_RATING * r),
    schedule: { start: S, duration: D, end: repEnd },
    maxFunnels: MAX_FUNNELS, dotsPerFunnel: DOTS_PER_FUNNEL,
    setReplaySecond: (x) => { repT = x; }, get replaySecond() { return repT; }, replaySeconds: repEnd, replayOpenSecond: REPLAY_OPEN_S,
    get replayRate() { return rate; }, get watching() { return watchId; },
    get mode() { return mode; },
  };
  refreshStatus();
  return group;
}
