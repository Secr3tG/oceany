// Terrain detail: zoomable whole-Earth relief as dot tiles on the globe.
//
// Data: Oceany's own terrarium tiles (web-mercator XYZ PNGs, elevation = R*256 + G + B/256 - 32768 m), see
// terrain-source.js and tiles-build/SOURCES.md: GEBCO_2026 seabed everywhere (463 m grid) and coarse land (z0-z8),
// Copernicus DEM land near the spots (z9-z13). z0-z7 cover the globe; finer levels exist only in boxes round the spots,
// and where they stop the tile is not split ("Detail ends here" in the readout). AWS Terrain Tiles (ETOPO1 seabed)
// only with ?terrain_src=aws.
//
// How it works:
// - A quadtree over the web-mercator tiles. Every ~120 ms, walk from the 16 zoom-2 tiles down: a visible tile is
//   split into its 4 children while its dot spacing on screen is larger than TARGET_PX and z < MAX_Z.
// - A tile is drawn only when it is loaded; a parent stays on screen until all its visible children are loaded,
//   so there is never a gap in the tile layer.
// - Tilted views: the split test uses the dot spacing as seen on screen, so a tile far off toward the horizon (far away,
//   and seen at a grazing angle that squashes it) stays at a coarse level. A tile budget keeps memory bounded: when a
//   view would need more than TILE_BUDGET tiles, the target spacing is raised until it fits, and lowered again after. Where nothing is loaded yet, the base 301k-dot globe shows through.
// - Level changes do not pop: each tile geomorphs toward its parent as its dots close up on screen (dots.js, MORPH),
//   and a tile that comes or goes cross-fades over FADE_MS with the level it replaces.
// - Each tile becomes one THREE.Points of 128 × 128 dots (each dot = the mean of 2 × 2 source pixels), positioned
//   relative to the tile's own centre (no float jitter close up) and lifted by elevation × exaggeration in the shader.
// - Tiles are kept in an LRU cache of CACHE_MAX; the least recently used tiles that are off screen are disposed.
// - While finer tiles download, the area they will cover is drawn by stand-ins: the nearest loaded coarser tile resampled
//   smoothly onto the finer grid (no added detail; see SI_PX). Requests go centre of the screen first, are cancelled when
//   they leave the view, and tiles ahead of a fly or zoom are prefetched (PF_LOOK, and prefetch() for globe.js flights).
// - ?terrain=v2: tiles come from the terrain2 packs through tilepack.js (terrain-source.js); the PNG path is the default.
import * as THREE from 'three';
import { tileUrl, covered as srcHas, coverageKnown, tileSources, SEABED, seabedOf, USE_AWS, V2_ASKED, startPacks } from './terrain-source.js?v=t5';
import { makeDotMaterial, palette, dotExag, morphT, landTone, oceanTone, SHALLOW_M, LAND_DOT_D, HUE_MAX } from './dots.js';

const R_EARTH = 6371000;
const N = 128;                 // dots per tile side
const MIN_Z = 2, MAX_Z = 13;   // z13 with 2x2 averaging ≈ 30 m per dot at Peniche, about the 30 m land data (SRTM / EU-DEM)
const TARGET_PX = 2.5;         // split a tile while its dots are further apart than this on screen (css px). 2026-11-23: 4 → 2.5
                               // (Benn: regional views of Britain / the North Sea were coarse 4 px dots, ~z6 at 1,800 km; now ~z7)
const CACHE_MAX = 220;         // tiles kept (≈ 0.3 MB each: positions, byte colours, elevations); ~70 MB at most
const MAX_WANT = 96;           // tiles queued for fetching at once, nearest-first
const MAX_INFLIGHT = 12, MAX_INFLIGHT_V2 = 24;   // v2: the pack source does its own network limiting and merges neighbours into one range, so it gets more at once          // AWS: 6 per host name, two host names; ours: same origin (HTTP/2 multiplexes when hosted)
const TILE_BUDGET = 150;       // tiles drawn + wanted in one view, at most (the target spacing adapts to stay under it)
const DEEP_AT = 6000;          // same colour ramp as the base globe
// Water deeper than SHALLOW_M: dots drawn SEA_DOT_K × wider (soft, overlapping: the sea floor here is ETOPO1 at
// ~1.85 km, filled in between, so a smooth field shows no more than the data) and SEA_K × brighter, so close-in water is
// the same deep blue as the base globe instead of black (measured: deep water ~40 blue, as the base globe). Shallow water keeps fine dots and the reef viewer's glow.
// 2026-11-23: 2.2 → 1.7 wide (the seabed is GEBCO 463 m / EMODnet 115 m now, not ETOPO1: a soft 2.2× field blurred the coast
// by a dot or two); SEA_K 2.0 → 3.2 keeps about the same light per area (additive dots: ∝ width² × colour, 2.2² × 2 ≈ 1.7² × 3.2)
// while the brightest shelf channel stays near HUE_MAX (0.92; a higher SEA_K would be clipped there and dim the shelf).
const SEA_DOT_K = 1.7, SEA_K = 3.2, COAST_M = 6;   // COAST_M: water this shallow eases from land dot size to sea dot size   // round 2: 0.85 left tile deep water at 0.4× the base globe's (2,6,24 vs 6,16,59 over Biscay)
const SEABED_B_MAX = 0.95, SEABED_EXAG = 10, SEABED_B_MIN = 0.6;   // round 3: 1.1 → 0.95 (sea-floor highlights stay under the land's)   // (round 2: 1.25 / 6 still drew bright sinuous ridges on ETOPO1 canyon walls)   // seabed hillshade cap; slope dimming (see colourTile)
// Land dots are drawn LAND_DOT_D × their spacing wide (TILE_LAND_K × the 0.9-spacing base size), the same as the base
// globe's land, so land has one brightness from whole globe to close in (dots.js landTone). Replaces LAND_FAR_K (land 2×
// wider from afar only), which made tiles 2× dimmer between 0.1 and 0.06 radii.
const TILE_LAND_K = LAND_DOT_D / 0.9;
// No tile dot is drawn wider than TILE_MAX_PX css px (the base globe's cap): a coarse parent tile standing in while its
// children load, seen close, showed ~30 px blurred discs for seconds; capped, it reads as sharp sparse dots, like the
// base globe at mid zoom (capComp brightens capped dots a little, hue kept by HUE_MAX).
const TILE_MAX_PX = 12, TILE_CAP_COMP = 3;
// b54 (2026-11-24): where our data ends coarse (a tile with no finer level built under it: outside the spot boxes, z10 in the
// Himalayas; the polar caps' last level), no finer tile is ever coming, and the camera can sit far closer than the floor
// assumes (the floor is measured from sea level; 7-8 km of drawn relief and the tilt bring the ground within a few km).
// Capped at TILE_MAX_PX there, the dots were 12 px on a 15-70 px grid: the Himalayas read 73 % black between correctly
// drawn dots. Such last-level tiles are drawn up to LEAF_MAX_PX instead: the coarse grid is stretched into a lit surface
// (soft, wide dots, the same light per area), with no more detail than the data has. Stand-ins and tiles whose finer
// level is coming keep the cap.
const LEAF_MAX_PX = 96;
const SHORE_K = 1.3;           // land next to sea, a little brighter (base globe 1.2)
// Polar caps: web-mercator tiles stop at ±85.05°. Poleward of that, POLAR tiles fill in: a quadtree over a square in
// azimuthal-equidistant coordinates round each pole (half-width POLE_S degrees of arc), drawn and refined exactly like
// the mercator tiles. Their heights come from the base globe's ETOPO1 samples (~41 km apart, `baseElev` from globe.js),
// interpolated: dots closer than that are filled in between, not measured (the readout says so). Dots outside the cap
// (the square's corners, below 85.05°) are not drawn.
const POLE_EDGE = 85.0511, POLE_S = 90 - POLE_EDGE, POLE_MAX_Z = 9;
const COL_MAX = 3;             // brightest colour value stored (bytes hold 0..COL_MAX)
const SEABED_M = SEABED.m;     // seabed grid spacing in metres at the equator (GEBCO_2026 463 m; ETOPO1 1,852 m with ?terrain_src=aws)

const SKIP_TO_Z = USE_AWS ? 10 : 99;   // AWS: from z10 every level is loaded (fillOceanVoid reads the parent). Ours have no ocean voids: only the level the view ends on
const REFINE_MAX = 4;          // cap on the adaptive target spacing (TARGET_PX × refine): past ~4 it climbed and oscillated
const FADE_MS = 400;           // round 4: 250 → 400, so a tile arriving over its parent or the base globe eases in
const BUILD_MS = 6;            // time budget per frame for building decoded tiles (ms)           // a tile that comes or goes cross-fades with the level it replaces over this long
// Stand-ins (2026-11-24 night): while finer tiles download, the part of the view they will cover is drawn from the nearest
// loaded coarser tile, resampled smoothly (Catmull-Rom, clamped: no value outside the 2 × 2 source dots it sits between)
// onto the finer tile's own dot grid, so the screen shows a smooth surface at close to the right dot density instead of
// sparse capped dots. Interpolation only: it carries no detail the coarser tile does not have, and the readout names that
// real tile, never the stand-in (status, finestM and detailEnds never count stand-ins). Built at the first level whose dots are
// SI_PX css px apart or closer (one or two levels above the level the view ends on: a quarter to a sixteenth of the tiles),
// at most SI_PER_FRAME a frame inside the BUILD_MS budget, and counted toward the tile cache. When the real tile comes in,
// its heights ease from the stand-in's to its own over FADE_MS (geomorph) while the two cross-fade as before.
const SI_PX = 6, SI_DEPTH = 10;
// Round 3: no stand-ins where frames are slow (frame interval averaging over SLOW_MS, back under FAST_MS: software GL, an
// overloaded machine). There every drawn dot costs frame time and loading is paced by frames. Measured (SwiftShader,
// Peniche, 3 runs each): stand-ins drew 1.4-1.6 M dots during loading against 0.5-0.8 M without, frames took ~210 ms
// instead of ~120, and the final level came ~1.8 s later (12.1 / 15.1 / 11.6 s vs 10.3 / 13.2 / 10.0 s; HEAD 10.2 / 8.9 /
// 10.3 s). On a GPU (Metal) the same view is readable sooner with them than HEAD (1.4-1.5 s vs 1.9 s).
const SLOW_MS = 45, FAST_MS = 35;
// Data-level balance (see select: held): at most LVL_JUMP levels between the data of neighbouring drawn tiles; a real tile
// that would break it waits at most HOLD_MS.
const LVL_JUMP = 3, HOLD_MS = 1200;
// Prefetch along a fly or zoom: the camera's ground point and viewing distance are extrapolated PF_LOOK s ahead from the
// last ~0.6 s of motion, and the tiles there are fetched at low priority (at most PF_SLOTS of the MAX_INFLIGHT slots).
const PF_LOOK = 0.75, PF_SLOTS = 8, PF_MAX = 24;
const BLOCK = [0, 4, 1024, 1028];   // byte offsets of a 2 × 2 pixel block in a 256-wide RGBA tile
const D2R = Math.PI / 180;
// b53 (terrain release 2, 2026-11-24):
// - Off the main thread: a terrain2 tile's inflate + decode + clean-up (void rule, despike, largest |height|) and every
//   mercator tile's dot geometry (positions, parent offsets, row scale: half of build()) run in terrain-worker.js. A stand-in
//   asks for its geometry when it is queued and is built once it is back (or after GEO_WAIT_MS, inline). Without workers
//   (or if one fails) everything runs here as before.
// - World base: z0-z(BASE_MAX_Z) of base.pack go into tilepack.js's persistent cache in the background (pinned; ~6.7 MB once
//   per browser, z0-z3 first), so after a jump anywhere the coarse levels under the view come from the cache in a few ms
//   and the stand-ins stretch them over the screen at once (blurry land, never bare dots) while the finer tiles arrive.
//   z5 would be another 17.9 MB: not worth it on a phone line. select() asks for those cached coarse tiles first.
// - Zoom-ahead: while the camera is zooming in (globe.js zoomAhead: zoom.target below the height, the point under the cursor or
//   pinch), the tiles the zoom will end on there are prefetched at the lowest priority; prefetches whose tiles left the screen
//   are cancelled before they arrive (flight prefetches are kept: their target is not on screen yet).
// - Phone detail cap (lite): no level is fetched whose dots would be closer than MIN_RPX rendered pixels (the canvas is drawn at
//   devicePixelRatio <= 2): the split spacing never goes below 2 × MIN_RPX / pixelRatio css px.
const GEO_WAIT_MS = 60, GEO_MAX = 64, MIN_RPX = 1.5;
// test switches (review/terrain2/ship-b53): ?tworker=0 no workers, ?tbase=<z> world base to that level (-1: none), ?tza=0 no
// zoom-ahead, ?tcap=0 no phone detail cap
const TQ = new URLSearchParams(location.search);
const BASE_MAX_Z = TQ.has('tbase') ? +TQ.get('tbase') : 4, ZOOM_AHEAD = TQ.get('tza') !== '0', CAP_ON = TQ.get('tcap') !== '0';
// a small pool of classic workers (terrain-worker.js); null where Workers or DecompressionStream are missing, or a worker
// failed to start (then the main thread does the work)
function makeWorkers() {
  try {
    if (typeof Worker !== 'function' || new URLSearchParams(location.search).get('tworker') === '0') return null;
    const n = (navigator.hardwareConcurrency || 2) >= 4 ? 2 : 1, ws = [], wait = new Map(); let id = 0, broken = false;
    const failAll = (msg) => { broken = true; for (const [, w] of wait) w.reject(new Error(msg)); wait.clear(); };
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./terrain-worker.js?v=w1', import.meta.url));
      w.busy = 0;
      w.onmessage = (ev) => { const m = ev.data, p = wait.get(m.id); if (!p) return; wait.delete(m.id); p.w.busy--; m.ok ? p.resolve(m.res) : p.reject(new Error(m.error)); };
      w.onerror = (ev) => { ev.preventDefault && ev.preventDefault(); console.warn('terrain worker failed, decoding on the main thread'); failAll('terrain worker failed'); };
      ws.push(w);
    }
    return {
      get ok() { return !broken; },
      run(msg, transfer) {
        if (broken) return Promise.reject(new Error('terrain worker failed'));
        const w = ws.reduce((a, b) => (b.busy < a.busy ? b : a)); w.busy++;
        return new Promise((resolve, reject) => { const k = ++id; wait.set(k, { resolve, reject, w }); w.postMessage(Object.assign({ id: k }, msg), transfer || []); });
      },
    };
  } catch (e) { return null; }
}
const lonOf = (px, n) => px / n * 360 - 180;                                         // px in tile units (x + frac)
const latOf = (py, n) => Math.atan(Math.sinh(Math.PI * (1 - 2 * py / n))) / D2R;
// unit() of a web-mercator point (row py of n, longitude in degrees) without the latitude: with m = π(1 − 2py/n), the
// latitude is the Gudermannian of m, so cos(lat) = 1/cosh(m) and sin(lat) = tanh(m). Same vector as
// unit(latOf(py, n), lon) to ~4e-16 (far below the float32 the positions are stored in), with one exp instead of
// atan + sinh + cos + sin (build profile 2026-11-24: positions were half of build()).
function unitM(py, n, lon, out) {
  const m = Math.PI * (1 - 2 * py / n), e = Math.exp(m), ie = 1 / e, ch = (e + ie) / 2, lo = lon * D2R;
  return out.set(Math.cos(lo) / ch, (e - ie) / (e + ie), -Math.sin(lo) / ch);
}
function unit(lat, lon, out = new THREE.Vector3()) {
  const la = lat * D2R, lo = lon * D2R;
  return out.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
}
// Geometry of one tile (cheap, not stored unless loaded)
// fixed pseudo-random value in ±0.2 from three integers (tile dot jitter)
// Round 3 (#4): ±JIT of the spacing (was ±0.2, which still read as a lattice with moiré under tilt), so close terrain reads as
// a point cloud. Fixed per dot (hashed from its global grid index and level): it never shimmers. The geomorph moves each
// keeper dot to its parent's own (jittered) dot, so a level change does not pop.
const JIT = 0.42;
function jit(a, b, c) { let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263) ^ Math.imul(c | 0, 2147483647); h = Math.imul(h ^ (h >>> 13), 1274126177); return (((h ^ (h >>> 16)) >>> 0) / 4294967296 - 0.5) * 2 * JIT; }
function desc(z, x, y) {
  const n = 2 ** z, latC = latOf(y + 0.5, n), lonC = lonOf(x + 0.5, n);
  const center = unit(latC, lonC);
  const corners = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].map(([a, b]) => unit(latOf(b, n), lonOf(a, n)));
  let radius = 0; for (const c of corners) radius = Math.max(radius, c.distanceTo(center));
  const spacingM = 2 * Math.PI * R_EARTH / n * Math.cos(latC * D2R) / N;               // metres between dots
  const latEq = Math.min(Math.abs(latOf(y, n)), Math.abs(latOf(y + 1, n))) * (latOf(y, n) * latOf(y + 1, n) < 0 ? 0 : 1);
  const spacingMaxM = 2 * Math.PI * R_EARTH / n * Math.cos(latEq * D2R) / N;          // widest rows (edge nearest the equator)
  return { z, x, y, key: `${z}/${x}/${y}`, latC, lonC, center, corners, radius, spacingM, spacingMaxM };
}

// Polar tile: z/x/y over the square [-POLE_S, POLE_S]² (degrees of arc from the pole; u toward lon 0, v toward lon 90 E)
function polarLL(s, u, v) { const c = Math.hypot(u, v); return [s * (90 - c), c < 1e-9 ? 0 : Math.atan2(s * v, u) / D2R, c]; }
function pdesc(s, z, x, y) {
  const n = 2 ** z, w = 2 * POLE_S / n, uv = (a, b) => [-POLE_S + a * w, -POLE_S + b * w];
  const [uc, vc] = uv(x + 0.5, y + 0.5), [latC, lonC] = polarLL(s, uc, vc);
  const center = unit(latC, lonC);
  const corners = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].map(([a, b]) => { const [la, lo] = polarLL(s, ...uv(a, b)); return unit(la, lo); });
  let radius = 0; for (const c of corners) radius = Math.max(radius, c.distanceTo(center));
  const spacingM = w * D2R * R_EARTH / N;
  return { z, x, y, polar: s, key: `p${s}/${z}/${x}/${y}`, latC, lonC, center, corners, radius, spacingM, spacingMaxM: spacingM };
}
const parKey = d => d.polar ? `p${d.polar}/${d.z - 1}/${d.x >> 1}/${d.y >> 1}` : `${d.z - 1}/${d.x >> 1}/${d.y >> 1}`;

// Timing probe: set window.__terrainLog = [] in the console and each tile records when it was asked for, requested,
// answered, decoded, built and first drawn (performance.now ms). Off (no cost) otherwise.
const tlog = (t, k) => { const L = globalThis.__terrainLog; if (!L || t.si) return; if (!t.tm) { t.tm = { key: t.key, z: t.z }; L.push(t.tm); } t.tm[k] ??= performance.now(); };
export function createTerrain({ scene, camera, renderer, baseElev = null, lite = false }) {
  // lite (phone / touch screen, set by globe.js). Phone 2026-11-23 late: a portrait phone keeps the desktop's 40° across
  // (globe.js fitFov), so the same stretch of coast is ~390 css px wide instead of ~1,440: at the desktop's 2.5 px split
  // (and the old ×1.25 on top) Peniche stopped at z12 (59 m dots) from 15 km where desktop reaches z13 (30 m), and read as
  // blobs. Lite now splits at a spacing scaled by the screen's short side (390/900 → ×0.45), i.e. about as many dots across
  // the view as on desktop, and gets a larger tile budget and cache to carry them (was 100 / 140).
  let TPX = TARGET_PX;
  const BUDGET = lite ? 140 : TILE_BUDGET, CACHE = lite ? 200 : CACHE_MAX;
  const liteTpx = () => TARGET_PX * Math.max(0.45, Math.min(1, Math.min(innerWidth, innerHeight) / 900));
  const group = new THREE.Group(); group.visible = false; scene.add(group);
  const cache = new Map();                // key -> tile { ...desc, state, points, elev, sources, hasOcean, used }
  const queue = [];                       // decoded tiles waiting to be built (a few per frame)
  const sic = new Map();                  // stand-ins: key -> tile (si: true, srcZ: level of the tile it was resampled from)
  const siQueue = new Map();              // stand-ins asked for by the last select passes: key -> { d, src, prio, id }
  const SI_PER_FRAME = lite ? 2 : 3, SI_MAX = Math.floor(CACHE * 0.4);
  const morphing = new Set();             // tiles whose drawn heights are easing from a stand-in's to their own
  const pf = new Map();                   // prefetch: key -> { z, x, y, until, prio }
  let pack = null; startPacks().then(p => { pack = p; if (p && p.warmBase && BASE_MAX_Z >= 0) p.warmBase(BASE_MAX_Z); });   // terrain v2 (default; ?terrain=v1 = PNGs): the pack source once it is up (null: PNG tiles); b53: then the world base in the background
  const wk = makeWorkers();
  const workOk = () => !!(wk && wk.ok);
  const geoCache = new Map(), geoPend = new Map();   // stand-in geometry from the worker: key -> { pos, sz, rs, par } / asked-at ms
  function geoWant(d) {
    if (!workOk() || d.polar || geoCache.has(d.key) || geoPend.has(d.key)) return;
    geoPend.set(d.key, performance.now());
    wk.run({ op: 'geom', geom: true, z: d.z, x: d.x, y: d.y }).then(g => {
      geoPend.delete(d.key); geoCache.set(d.key, g);
      while (geoCache.size > GEO_MAX) geoCache.delete(geoCache.keys().next().value);
    }, () => geoPend.delete(d.key));
  }
  const geoReady = key => geoCache.has(key) || !geoPend.has(key) || performance.now() - geoPend.get(key) > GEO_WAIT_MS;
  let pending = -1;                       // tiles wanted or loading at the last select (-1: not run yet)
  let enabled = false, loadedOk = 0, loadFails = 0, lastErr = '', inflight = 0, lastSelect = 0, shown = [], frameNo = 0, selectId = 0;
  let shownSI = [], measured = [], siKick = false;   // stand-ins drawn; real tiles the readout counts (drawn ones and the sources of drawn stand-ins)
  let frameEma = 16, slow = false;
  let siMs = 0, siCount = 0, lastUpd = 0, heldKeys = new Set();                // stand-in build time (siDebug)
  const frustum = new THREE.Frustum(), projView = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const camPos = new THREE.Vector3();
  const pxPerUnit = () => innerHeight / (2 * Math.tan(camera.fov * D2R / 2));

  // Elevation (m) under a point from the finest loaded tile, or null where nothing is loaded. Used to keep a low,
  // tilted camera above the ground.
  function elevationAt(lat, lon) {
    if (Math.abs(lat) > POLE_EDGE && baseElev) return baseElev(lat, lon);
    const la = Math.max(-85, Math.min(85, lat)) * D2R;
    for (let z = MAX_Z; z >= MIN_Z; z--) {
      const n = 2 ** z, fx = (lon + 180) / 360 * n, fy = (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n;
      const x = Math.floor(fx), y = Math.floor(fy), t = cache.get(`${z}/${x}/${y}`);
      if (t && t.state === 'ready' && t.elev) {
        const i = Math.min(N - 1, Math.floor((fx - x) * N)), j = Math.min(N - 1, Math.floor((fy - y) * N));
        return t.elev[j * N + i];
      }
    }
    return null;
  }

  function visible(d) {
    // horizon: some corner or the centre on the camera's side (with a margin for tile size and relief)
    // pad = how far this tile's relief can stick out (or sink in) at the current exaggeration, so peaks and deep
    // sea floor near the edge of the view still count. Uses the tile's own largest |elevation| once loaded, else its
    // parent's, else 9 km.
    const own = cache.get(d.key), par = cache.get(parKey(d));
    const relief = own && own.maxAbs != null ? own.maxAbs : par && par.maxAbs != null ? par.maxAbs : 9000;
    const c = camPos, pad = relief * dotExag.value / R_EARTH + 1e-6, margin = d.radius * 0.5 + pad;
    let front = d.center.dot(c) > 1 - margin;
    for (const k of d.corners) if (k.dot(c) > 1 - margin) { front = true; break; }
    if (!front) return false;
    sphere.center.copy(d.center); sphere.radius = d.radius + pad;
    return frustum.intersectsSphere(sphere);
  }
  let lastHoles = 1;
  let refine = 1;                         // multiplies TARGET_PX when a view would need more than TILE_BUDGET tiles
  const toCam = new THREE.Vector3();
  function spacingPx(d) {
    const dist = Math.max(1e-6, camPos.distanceTo(d.center) - d.radius * 0.7);
    // grazing angle: one screen axis of the tile is squashed by cos(incidence); use the geometric mean of both axes.
    // Only for tiles small enough to be roughly flat, and never below 0.25 so tiles near the camera stay fine.
    toCam.copy(camPos).sub(d.center).normalize();
    const cosI = d.radius < 0.05 ? Math.max(0.0625, Math.abs(toCam.dot(d.center))) : 1;
    return d.spacingMaxM / R_EARTH * pxPerUnit() / dist * Math.sqrt(cosI);
  }
  const kids = d => [0, 1].flatMap(j => [0, 1].map(i => d.polar ? pdesc(d.polar, d.z + 1, 2 * d.x + i, 2 * d.y + j) : desc(d.z + 1, 2 * d.x + i, 2 * d.y + j)));
  const maxZ = d => d.polar ? POLE_MAX_Z : MAX_Z;
  const ready = d => { const t = cache.get(d.key); return t && (t.state === 'ready' || t.state === 'failed'); };
  // Our tiles: z0-z8 everywhere, finer only round the spots (coverage.json). A tile splits only when all its children were
  // built; where they were not, detail stops at that level and the readout says "Detail ends here" (detailEnds).
  const kidsBuilt = d => d.polar || kids(d).every(k => srcHas(k.z, k.x, k.y));
  let detailEnds = false;

  // Round 5 (round-4 #2): level balance at the edge of the spot boxes. Where detail stops (a tile that wants finer dots that
  // were never built: "capped"), the tiles just inside the box went straight to 2-3 levels finer, so a fine grain met a
  // coarse one along the box's straight edge (the seams at Peniche and Egmond). A tile now splits only when it lies at least
  // 2^(its level − the capped level) − 1 of its own widths from every capped tile of the last pass: one level per ring, so the
  // grain steps up by ×2 at a time and the geomorph (dots.js MORPH) blends each step. The spots sit mid-box, several rings
  // in, so their finest level is unchanged.
  let lastCaps = [];
  function nearCap(d) {
    if (d.polar) return false;
    for (const c of lastCaps) {
      const k = d.z - c.z; if (k <= 0) continue;
      const s = 1 << k, x0 = c.x * s, x1 = x0 + s - 1, y0 = c.y * s, y1 = y0 + s - 1;
      const gx = d.x < x0 ? x0 - d.x - 1 : d.x > x1 ? d.x - x1 - 1 : 0, gy = d.y < y0 ? y0 - d.y - 1 : d.y > y1 ? d.y - y1 - 1 : 0;
      if (Math.max(gx, gy) < s - 1) return true;
    }
    return false;
  }
  const selFwd = new THREE.Vector3(), selTmp = new THREE.Vector3(), ndc = new THREE.Vector3();
  // How far a tile is from the middle of the screen: the gap between the view centre and the tile's nearest edge as seen,
  // in half screen heights (0 = it holds the centre). Tiles behind the camera count as 2.
  function scrDist(d) {
    const dist = camPos.distanceTo(d.center); if (dist <= d.radius) return 0;
    const rN = d.radius / dist / Math.tan(camera.fov * D2R / 2);
    if (selTmp.copy(d.center).sub(camPos).dot(selFwd) <= 0) return Math.max(0, 2 - rN);
    ndc.copy(d.center).project(camera);
    return Math.max(0, Math.hypot(ndc.x * camera.aspect, ndc.y) - rN);
  }
  // Walk the quadtree: returns tiles to draw (shown) and tiles to fetch (wanted, with a priority).
  function select() {
    const want = [], show = [], siShow = [], srcShown = [];
    camera.getWorldDirection(selFwd);
    // Request order (2026-11-24 night): the middle of the screen first, coarser first among tiles about as near it. One
    // level coarser is worth 3/16 of the screen height (was: coarser first everywhere, then nearest the view axis). At 0.5
    // the finest tiles under the centre came in before the middle levels round them, and stood as a raised block among
    // stand-ins smoothed from a level-3 tile.
    // Slow frames (no stand-ins, see SLOW_MS): the old order, coarser first everywhere. Without stand-ins the finest tiles
    // under the centre cannot be drawn until their siblings and the levels between are in, so centre-first left the centre
    // coarse for longer (SwiftShader Peniche: first readable 10.4-10.8 s vs 6-7 s).
    const prio = slow ? (d => d.z * 10 + (1 - selFwd.dot(selTmp.copy(d.center).sub(camPos).normalize())) * 5) : (d => scrDist(d) * 4 + d.z * 0.75);
    // Look ahead: below a tile that is still loading, ask for the tiles this view will end on too (down to the target
    // spacing), instead of one level per round trip. Coarser first (prio), so parents still arrive before their
    // children (the build waits for a loading parent: fillOceanVoid needs it). Not counted toward the tile budget.
    // Round 3: only the level this view ends on is asked for (plus every level from SKIP_TO_Z on, where fillOceanVoid needs
    // the parent), not each level in between: a real wheel zoom spent seconds loading z3, z4, z5… one round trip at a time
    // while the screen showed sparse stand-in dots. A tile whose children are not all in may be skipped over to its
    // grandchildren when those are (covered()), so the skipped levels are never needed.
    let extra = 0;
    function ahead(d, depth) {
      if (depth > 12 || d.z >= maxZ(d) || spacingPx(d) <= TPX * refine || !kidsBuilt(d) || nearCap(d)) return;
      for (const k of kids(d)) {
        if (!visible(k)) continue;
        const kt = cache.get(k.key); if (kt) kt.keep = selectId;
        const sk = spacingPx(k), last = k.z >= maxZ(k) || sk <= TPX * refine || !kidsBuilt(k) || nearCap(k);
        // 2026-11-24 night: also the level three above the last one (dots 4-8 × the target apart: a sixty-fourth as many
        // tiles), the source the stand-ins below it are smoothed from while the last level loads
        const src = !slow && !last && !k.polar && sk > TPX * refine * 4 && sk <= TPX * refine * 8;
        // round 2: source tiles ahead of the rest (as if 4 levels coarser): a few of them give the whole view stand-ins from
        // one data level, instead of a sharp centre among stand-ins from level 3 (the seam)
        // b53: a world-base level already in the persistent cache (BASE_MAX_Z and coarser): first, it costs no request and
        // the stand-ins below it come from it at once
        const local = !last && !src && !k.polar && k.z <= BASE_MAX_Z && pack && pack.inCache && pack.inCache(k.z, k.x, k.y);
        if (!ready(k) && (last || src || local || k.z >= SKIP_TO_Z)) { want.push([prio(k) - (src ? 3 : local ? 6 : 0), k, (src || local) && !last && k.z < SKIP_TO_Z]); extra++; }
        ahead(k, depth + 1);
      }
    }
    // d is drawn by itself or, all the way across, by finer tiles that are in (up to 8 levels down; a miss fails fast down one branch)
    // Data-level balance (round 2, the seam): no tile is drawn from data more than LVL_JUMP levels finer than what its
    // same-level neighbours were drawn from in the last pass (lvlNb). A real tile that would break that is held back for up
    // to HOLD_MS after it was built (its stand-in stays), and stand-ins take their source no finer than that. Without it a
    // block of fine tiles under the centre stood above stand-ins smoothed from a level-3 tile, with a dark gap along its edge.
    const allowMemo = new Map(); heldKeys = new Set();
    const allowed = d => { let a = allowMemo.get(d.key); if (a === undefined) { a = lvlNb(d) + LVL_JUMP; allowMemo.set(d.key, a); } return a; };
    const held = d => {
      if (d.polar || d.z <= MIN_Z + 1) return false; const t = cache.get(d.key);
      // only while tiles are still coming (pending, last pass): with nothing on its way the neighbours will not improve
      const h = !slow && pending > 0 && !!t && t.state === 'ready' && t.builtAt > lastNow - HOLD_MS && d.z > allowed(d);
      if (h) heldKeys.add(d.key); return h;
    };
    const covered = (d, depth = 0) => (ready(d) && !held(d)) || (depth < 8 && d.z < maxZ(d) && kidsBuilt(d) && kids(d).filter(visible).every(k => covered(k, depth + 1)));
    // Stand-ins, refined like the real quadtree: the visible children of a drawn tile (real, or a stand-in) are drawn by
    // finer real tiles where those cover them, else by stand-ins resampled from src (the finest real tile drawn above
    // them). Returns those children, or null while one is not built yet (it is asked for; the parent stays this pass).
    // the stand-in source for c: its nearest loaded real ancestor below src (kept and counted by the readout), else src
    function bestSrc(c, src) {
      const cap = allowed(c);
      for (let z = c.z - 1, x = c.x >> 1, y = c.y >> 1; z > src.z; z--, x >>= 1, y >>= 1) {
        if (z > cap) continue;
        const t = cache.get(`${z}/${x}/${y}`);
        if (t && t.state === 'ready' && t.elev) { t.keep = selectId; return t; }
      }
      return src;
    }
    function siKids(k, src) {
      const items = [], used = []; let ok = true;
      for (const c of kids(k)) {
        if (!visible(c)) continue;
        if (covered(c)) { items.push(c); continue; }
        const cs = bestSrc(c, src), s = sic.get(c.key); if (s) s.keep = selectId;
        // a better source (within the balance cap). Never a coarser one: downgrading churned rebuilds and hid the coast
        // that finer data already showed
        // Upgrades only for 2+ levels (or the parent itself), and behind new stand-ins in the queue: rebuilding every
        // stand-in for each level that landed (3, 4, 5…) starved the builds that fill the view.
        if (!s) siAsk(c, cs, prio(c));
        if (!s || s.state !== 'ready') siAhead(c, src, 0);
        if (!s) { /* asked above */ }
        else if (cs.z >= s.srcZ + 2 || (cs.z > s.srcZ && cs.z === c.z - 1)) siAsk(c, cs, prio(c) + 4);
        if (s && s.state === 'ready') { items.push(s); const st = cache.get(s.srcKey); if (st) { st.keep = selectId; used.push(st); } }
        else ok = false;
      }
      if (!ok || !items.length) return null;
      srcShown.push(...used); return items;
    }
    // b53: while a stand-in chain is still being built, its finer levels down to the one that fills the screen (dots SI_PX
    // apart) are queued at once, behind it, instead of one level per select pass: after a jump the screen used to show the
    // sparse capped dots of the first levels for ~1 s (6-7 passes) before the stand-ins dense enough to fill it were asked for.
    function siAhead(c, src, depth) {
      if (depth > 6 || c.z >= MAX_Z || !(spacingPx(c) > Math.max(SI_PX, TPX * refine)) || !kidsBuilt(c) || nearCap(c)) return;
      for (const g of kids(c)) {
        if (!visible(g) || ready(g)) continue;
        const s = sic.get(g.key);
        if (s) s.keep = selectId; else siAsk(g, bestSrc(g, src), prio(g) + 1 + depth);
        siAhead(g, src, depth + 1);
      }
    }
    // a drawn stand-in splits on down to the level whose dots are SI_PX apart (or the level the view ends on)
    function siVisit(s, src, depth) {
      s.keep = selectId;
      if (depth < SI_DEPTH && s.z < MAX_Z && spacingPx(s) > Math.max(SI_PX, TPX * refine) && kidsBuilt(s) && !nearCap(s)) {
        const items = siKids(s, src);
        if (items) { for (const it of items) if (it.si) siVisit(it, src, depth + 1); else visit(it); return; }
      }
      siShow.push(s);
    }
    let holes = 0;                        // visible roots with nothing drawn (globe.js keeps the base globe up while > 0)
    let capped = false;                   // some visible tile wanted finer dots that were never built (outside the spot boxes)
    const caps = [];
    function visit(d, root = false) {
      if (!visible(d)) return;
      const own = cache.get(d.key); if (own) own.keep = selectId;   // on the path to what is drawn: never evicted this pass
      const t = cache.get(d.key), isReady = t && t.state === 'ready';
      if (d.z < maxZ(d) && spacingPx(d) > TPX * refine && !kidsBuilt(d)) { if (coverageKnown()) capped = true; if (!d.polar) caps.push(d); }
      else if (d.z < maxZ(d) && ((spacingPx(d) > TPX * refine && !nearCap(d)) || (!isReady && !ready(d)))) {
        const ks = kids(d).filter(visible);
        for (const k of ks) { const kt = cache.get(k.key); if (kt) kt.keep = selectId; }
        if (ks.length && ks.every(k => covered(k))) { ks.forEach(k => visit(k)); return; }
        if (spacingPx(d) > TPX * refine) for (const k of ks) if (!ready(k)) { want.push([prio(k), k]); ahead(k, 0); }   // the next level (a closer stand-in soon) and, via ahead, the last one
        // stand-ins: d is drawn and too coarse here, its children are not all in: draw them smoothed from d (or from
        // stand-ins already built from a coarser tile) instead of d's sparse dots. Not from tiles coarser than the base globe.
        if (!slow && isReady && !d.polar && ks.length && spacingPx(d) > TPX * refine && !coarseStandIn(t)) {
          const items = siKids(d, t);
          if (items) { srcShown.push(t); for (const it of items) if (it.si) siVisit(it, t, 1); else visit(it); return; }
        }
      }
      if (isReady) show.push(t);
      else { if (!t || t.state === 'new' || t.state === 'loading') want.push([prio(d), d]); if (root) holes++; }   // 'loading' too: a root nobody else asks for was aborted every other pass (round 3)
    }
    for (let x = 0; x < 4; x++) for (let y = 0; y < 4; y++) visit(desc(MIN_Z, x, y), true);
    if (baseElev) { visit(pdesc(1, 0, 0, 0), true); visit(pdesc(-1, 0, 0, 0), true); }
    lastHoles = holes; detailEnds = capped; lastCaps = caps;
    want.sort((a, b) => a[0] - b[0]);
    const need = show.length + want.length - extra;
    if (need > BUDGET) refine = Math.min(REFINE_MAX, refine * 1.25);
    else if (need < BUDGET * 0.6 && refine > 1) refine = Math.max(1, refine / 1.1);
    return { show, want: want.slice(0, MAX_WANT).map(w => [w[1], w[0], !!w[2]]), siShow, measured: [...new Set([...show, ...srcShown])] };
  }

  // A polar tile: heights sampled from the base globe (no fetch), so it is ready the frame it is asked for.
  function loadPolar(d) {
    const t = Object.assign(d, { state: 'decoded', used: frameNo, sources: [], ctrl: null });
    const n = 2 ** d.z, w = 2 * POLE_S / n, elev = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const [la, lo] = polarLL(d.polar, -POLE_S + (d.x + (i + 0.5) / N) * w, -POLE_S + (d.y + (j + 0.5) / N) * w);
      elev[j * N + i] = baseElev(la, lo);
    }
    let maxAbs = 0; for (let q = 0; q < elev.length; q++) maxAbs = Math.max(maxAbs, Math.abs(elev[q]));
    t.elev = elev; t.maxAbs = maxAbs; cache.set(d.key, t); queue.push(t);
  }
  // Old format: one terrarium PNG, 256 × 256 px, each 2 × 2 block averaged to one dot. Returns the heights and whether the
  // tile is mostly an ocean void (exactly 0 m).
  async function decodePng(r) {
    const bmp = await createImageBitmap(await r.blob());
    const cv = new OffscreenCanvas(256, 256), cx = cv.getContext('2d', { willReadFrequently: true });
    cx.drawImage(bmp, 0, 0); bmp.close();
    const px = cx.getImageData(0, 0, 256, 256).data;
    const elev = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      let s = 0, sn = 0, n = 0;          // s: sum of the 4 pixels; sn/n: sum/count of the non-zero ones
      const base = (2 * j * 256 + 2 * i) * 4;
      for (let q = 0; q < 4; q++) {      // the 2 × 2 block: byte offsets 0, 4, 1024, 1028 (no per-dot arrays)
        const k = base + BLOCK[q];
        const h = px[k] * 256 + px[k + 1] + px[k + 2] / 256 - 32768;
        s += h; if (h !== 0) { sn += h; n++; }
      }
      // exactly 0 m next to sea floor is an ocean void (see fillOceanVoid), not data: leave it out of the mean
      elev[j * N + i] = n && n < 4 && sn < 0 ? sn / n : s / 4;
    }
    let zeros = 0; for (let q = 3; q < px.length; q += 4) if (px[q - 3] === 128 && px[q - 2] === 0 && px[q - 1] === 0) zeros++;
    return { elev, voidTile: zeros > 0.5 * 256 * 256 };
  }
  const NO_HEADERS = new Headers();
  async function load(d, prio = 0) {
    if (d.polar) return loadPolar(d);
    const t = Object.assign(d, { state: 'loading', used: frameNo, ctrl: new AbortController() });
    cache.set(d.key, t); inflight++; tlog(t, 'req');
    try {
      // ?terrain=v2: the pack source (tilepack.js) once it is up; PNG tiles when it is not asked for, not supported or failed
      const ps = V2_ASKED ? await startPacks() : null;
      let got;
      const useW = workOk();
      if (ps) {
        if (t.ctrl.signal.aborted) throw new Error('aborted');
        const tile = await ps.getTile(d.z, d.x, d.y, { signal: t.ctrl.signal, prio, raw: useW });
        tlog(t, 'resp');
        if (t.ctrl.signal.aborted) throw new Error('aborted');
        if (!tile) throw new Error('HTTP 404');      // absent from its pack: like a missing PNG (failed, not asked for again)
        t.sources = tileSources(d.z, NO_HEADERS);
        if (tile.body) {                              // b53: decoded, cleaned and its geometry built in terrain-worker.js
          let r;
          try { const b = tile.body.slice(); r = await wk.run({ op: 'tile', body: b.buffer, geom: true, z: d.z, x: d.x, y: d.y }, [b.buffer]); }
          catch (err) { if (tile.cached && ps.dropTile) ps.dropTile(d.z, d.x, d.y); throw err; }
          if (t.ctrl.signal.aborted) throw new Error('aborted');
          t.pre = { pos: r.pos, sz: r.sz, rs: r.rs, par: r.par };
          got = { elev: r.elev, clean: true, maxAbs: r.maxAbs };
        } else {
          const elev = new Float32Array(tile.elev);     // own copy: despike / fillOceanVoid write into it
          let zeros = 0; for (let q = 0; q < elev.length; q++) if (elev[q] === 0) zeros++;
          got = { elev, voidTile: zeros > 0.5 * N * N };
        }
      } else {
        const gp = useW ? wk.run({ op: 'geom', geom: true, z: d.z, x: d.x, y: d.y }).catch(() => null) : null;   // b53: geometry in the worker meanwhile
        const r = await fetch(tileUrl(d.z, d.x, d.y), { signal: t.ctrl.signal, mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer' });
        tlog(t, 'resp');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        t.sources = tileSources(d.z, r.headers);
        got = await decodePng(r);
        const g = gp && await gp; if (g) t.pre = g;
      }
      const elev = got.elev;
      let maxAbs = got.maxAbs || 0;
      if (!got.clean) {
        // A tile that is mostly exactly 0 m is an ocean void with at most a few stray rows of junk (seen: -5,725 and
        // -10,681 m rows in an all-zero tile): drop its sea values, so fillOceanVoid rebuilds them from the parent (land kept).
        if (got.voidTile) for (let q = 0; q < elev.length; q++) if (elev[q] < 0) elev[q] = 0;
        despike(elev);
        for (let q = 0; q < elev.length; q++) maxAbs = Math.max(maxAbs, Math.abs(elev[q]));
      }
      t.elev = elev; t.maxAbs = maxAbs; t.state = 'decoded'; tlog(t, 'dec'); queue.push(t); loadedOk++; loadFails = 0;
    } catch (e) {
      if (t.ctrl.signal.aborted) cache.delete(d.key);     // dropped: may be asked for again later
      else { t.state = 'failed'; loadFails++; lastErr = String(e && e.message || e); console.warn('terrain tile', d.key, lastErr);
        if (!/HTTP 404/.test(lastErr)) setTimeout(() => { if (cache.get(d.key) === t) cache.delete(d.key); }, 20000); }   // a network blip: asked for again later   // e.g. a missing tile: treated as empty; counted, so the readout can say so
    } finally { inflight--; t.ctrl = null; }
  }

  // Smooth resample (stand-ins and their geomorph): heights at tile d's 128 × 128 dots from a coarser (or same-level) tile
  // src, Catmull-Rom across src's dot grid, each value clamped to the lowest and highest of the 2 × 2 src dots it lies
  // between, so it never overshoots: no peak higher or trench deeper than the data. Past src's edge the neighbouring tile
  // at src's level is read (nb(z, x, y) -> heights or null), else the edge row is repeated.
  function resample(d, src, se, nb) {
    const f = 2 ** (d.z - src.z), out = new Float32Array(N * N), P = N + 4, pad = new Float32Array(P * P), pn = 2 ** src.z;
    const nbs = new Array(9);
    for (let j = -2; j < N + 2; j++) for (let i = -2; i < N + 2; i++) {   // src heights with a 2-dot border from its neighbours
      let v;
      if (i >= 0 && i < N && j >= 0 && j < N) v = se[j * N + i];
      else {
        const dx = i < 0 ? -1 : i >= N ? 1 : 0, dy = j < 0 ? -1 : j >= N ? 1 : 0, q = (dy + 1) * 3 + dx + 1;
        if (nbs[q] === undefined) nbs[q] = src.y + dy >= 0 && src.y + dy < pn ? nb(src.z, (src.x + dx + pn) % pn, src.y + dy) : null;
        v = nbs[q] ? nbs[q][(j - dy * N) * N + (i - dx * N)] : se[Math.max(0, Math.min(N - 1, j)) * N + Math.max(0, Math.min(N - 1, i))];
      }
      pad[(j + 2) * P + i + 2] = v;
    }
    const cw = (t, w, o) => { const t2 = t * t, t3 = t2 * t; w[o] = (-t3 + 2 * t2 - t) / 2; w[o + 1] = (3 * t3 - 5 * t2 + 2) / 2; w[o + 2] = (-3 * t3 + 4 * t2 + t) / 2; w[o + 3] = (t3 - t2) / 2; };
    const ix = new Int32Array(N), wx = new Float32Array(4 * N), iy = new Int32Array(N), wy = new Float32Array(4 * N);
    const ox = (d.x - src.x * f) * N, oy = (d.y - src.y * f) * N;
    for (let a = 0; a < N; a++) {
      const u = (ox + a + 0.5) / f - 0.5, i0 = Math.floor(u); ix[a] = i0 + 2; cw(u - i0, wx, 4 * a);
      const v = (oy + a + 0.5) / f - 0.5, j0 = Math.floor(v); iy[a] = j0 + 2; cw(v - j0, wy, 4 * a);
    }
    for (let j = 0; j < N; j++) {
      const r1 = iy[j] * P, w0 = wy[4 * j], w1 = wy[4 * j + 1], w2 = wy[4 * j + 2], w3 = wy[4 * j + 3];
      for (let i = 0; i < N; i++) {
        const c = r1 + ix[i], a0 = wx[4 * i], a1 = wx[4 * i + 1], a2 = wx[4 * i + 2], a3 = wx[4 * i + 3];
        const row = o => a0 * pad[o - 1] + a1 * pad[o] + a2 * pad[o + 1] + a3 * pad[o + 2];
        let h = w0 * row(c - P) + w1 * row(c) + w2 * row(c + P) + w3 * row(c + 2 * P);
        const p00 = pad[c], p01 = pad[c + 1], p10 = pad[c + P], p11 = pad[c + P + 1];
        const lo = Math.min(p00, p01, p10, p11), hi = Math.max(p00, p01, p10, p11);
        out[j * N + i] = h < lo ? lo : h > hi ? hi : h;
      }
    }
    return out;
  }
  const realNb = (z, x, y) => { const t = cache.get(`${z}/${x}/${y}`); return t && t.state === 'ready' && t.elev || null; };
  const siNb = (z, x, y) => { const t = sic.get(`${z}/${x}/${y}`); return t && t.state === 'ready' && (t.disp || t.elev) || null; };
  function siAsk(d, src, prio) {
    const e = siQueue.get(d.key);
    if (e) { e.src = src; e.d = d; e.prio = prio; e.id = selectId; return; }
    if (sic.size + siQueue.size < SI_MAX) { siQueue.set(d.key, { d, src, prio, id: selectId }); if (!sic.has(d.key)) geoWant(d); }
  }
  // Build (or, from a finer source, rebuild in place with a geomorph) one stand-in. false when it is no longer needed.
  function siBuild({ d, src }) {
    if (cache.get(src.key) !== src || src.state !== 'ready' || !src.elev) return false;
    const rt = cache.get(d.key); if (rt && rt.state === 'ready' && !(rt.builtAt > lastNow - HOLD_MS)) return false;   // in and drawable (a held one gets its stand-in)
    let s = sic.get(d.key);
    if (s && s.srcZ >= src.z) return false;
    const elev = resample(d, src, src.elev, realNb);
    let maxAbs = 0; for (let q = 0; q < elev.length; q++) maxAbs = Math.max(maxAbs, Math.abs(elev[q]));
    if (s) {
      const from = Float32Array.from(s.disp);
      s.elev = elev; s.maxAbs = maxAbs; s.srcZ = src.z; s.srcKey = src.key;
      const dk = s.points.geometry.attributes.aDotK;
      for (let k = 0; k < N * N; k++) dk.array[k] = dotK(elev[k]);
      dk.needsUpdate = true;
      // colours ease over the same morph as the heights (round 2: they switched at once)
      const ga = s.points.geometry.attributes, c0 = Uint8Array.from(ga.color.array), p0 = Uint8Array.from(ga.aParCol.array);
      colourTile(s);
      s.cTo = Uint8Array.from(ga.color.array); s.pTo = Uint8Array.from(ga.aParCol.array); s.cFrom = c0; s.pFrom = p0;
      ga.color.array.set(c0); ga.aParCol.array.set(p0);
      startMorph(s, from);
    } else {
      s = Object.assign(desc(d.z, d.x, d.y), { si: true, state: 'decoded', elev, maxAbs, srcZ: src.z, srcKey: src.key, sources: [], used: frameNo, keep: selectId, ctrl: null });
      build(s); sic.set(s.key, s);
    }
    return true;
  }
  function disposeSI(s) {
    live.delete(s); morphing.delete(s); sic.delete(s.key);
    if (s.points) { group.remove(s.points); s.points.geometry.dispose(); s.points.material.dispose(); s.points = null; }
  }
  // the drawn stand-in under a real tile that has just come in (same tile or a coarser one), to geomorph from
  function standInUnder(t) {
    if (t.polar || !sic.size) return null;
    for (let z = t.z, x = t.x, y = t.y; z >= MIN_Z && z >= t.z - 6; z--, x >>= 1, y >>= 1) {
      const s = sic.get(`${z}/${x}/${y}`); if (s && s.points && s.fade > 0) return s;
    }
    return null;
  }
  // Heights geomorph: the tile's drawn heights (t.disp, its aElev) ease from `from` to t.elev over FADE_MS from the first
  // frame it is drawn. Block means (aParElev) follow, so the level geomorph in dots.js stays consistent.
  function startMorph(t, from) { t.mFrom = from; t.mT0 = null; t.mBuilt = performance.now(); morphing.add(t); }
  function morphFrame(now) {
    for (const t of morphing) {
      if (!t.points) { morphing.delete(t); continue; }
      let a = 1;
      if (t.mT0 == null && t.shownNow) t.mT0 = now;
      if (t.mT0 != null) a = Math.max(0, Math.min(1, (now - t.mT0) / FADE_MS));
      else if (performance.now() - t.mBuilt < HOLD_MS + 500) continue;   // not drawn by then: the stand-in is gone, start at its own heights
      const w = a * a * (3 - 2 * a);
      const e = t.elev, f = t.mFrom, dp = t.disp, pel = t.pel;
      for (let k = 0; k < N * N; k++) dp[k] = f[k] + (e[k] - f[k]) * w;
      for (let j = 0; j < N; j += 2) for (let i = 0; i < N; i += 2) { const k = j * N + i; pel[k] = (dp[k] + dp[k + 1] + dp[k + N] + dp[k + N + 1]) / 4; }
      const g = t.points.geometry; g.attributes.aElev.needsUpdate = true; g.attributes.aParElev.needsUpdate = true;
      if (t.cFrom) {
        const c = g.attributes.color.array, pc = g.attributes.aParCol.array, c0 = t.cFrom, c1 = t.cTo, p0 = t.pFrom, p1 = t.pTo;
        for (let q = 0; q < c.length; q++) { c[q] = c0[q] + (c1[q] - c0[q]) * w; pc[q] = p0[q] + (p1[q] - p0[q]) * w; }
        g.attributes.color.needsUpdate = true; g.attributes.aParCol.needsUpdate = true;
      }
      if (a >= 1) { morphing.delete(t); t.mFrom = t.cFrom = t.cTo = t.pFrom = t.pTo = null; }
    }
  }

  // Spikes: some Terrarium tiles over the ocean carry a line or two of bogus pixels (e.g. -10,681 m in a -5,400 m plain).
  // Drawn, that row drops out of the surface as a dark seam across the view. A sea-floor dot more than 1,000 m off the
  // straight line between the dots 3 rows (or columns) either side, where those two agree within 300 m, takes that line's
  // value. ETOPO1 is a 1.85 km grid, so a real one-to-two-dot feature that size cannot come from it.
  function despike(e) {
    for (const [di, dj] of [[0, 1], [1, 0]]) for (let j = 3 * dj; j < N - 3 * dj; j++) for (let i = 3 * di; i < N - 3 * di; i++) {
      const k = j * N + i, h = e[k]; if (h >= 0) continue;
      const o = 3 * (dj * N + di), a = e[k - o], b = e[k + o];
      if (a < 0 && b < 0 && Math.abs(a - b) < 300 && Math.abs(h - (a + b) / 2) > 1000) e[k] = (a + b) / 2;
    }
  }

  // Ocean voids: past about z10 the Terrarium tiles over open ocean can hold exactly 0 m (no ETOPO1 there), which drew a
  // flat "shallow" plate with a cliff at its edge. A dot that reads exactly 0 m where the parent tile (already filled the
  // same way) has sea floor deeper than 20 m takes the parent's value, interpolated: ETOPO1 again, like the readout says.
  function fillOceanVoid(d, elev) {
    if (d.polar) return 0;
    const par = cache.get(`${d.z - 1}/${d.x >> 1}/${d.y >> 1}`);
    if (!par || !par.elev) return 0;
    const pe = par.elev, ox = (d.x & 1) * N, oy = (d.y & 1) * N;
    const pz = d.z - 1, px = d.x >> 1, py = d.y >> 1, pn = 2 ** pz;
    const at = (i, j) => {            // parent dots; past its edge, the neighbouring parent's (no seam), else clamped
      if (i >= 0 && i < N && j >= 0 && j < N) return pe[j * N + i];
      const dx = i < 0 ? -1 : i >= N ? 1 : 0, dy = j < 0 ? -1 : j >= N ? 1 : 0;
      const nb = py + dy >= 0 && py + dy < pn ? cache.get(`${pz}/${(px + dx + pn) % pn}/${py + dy}`) : null;
      if (nb && nb.elev) { const v = nb.elev[(j - dy * N) * N + (i - dx * N)]; if (v !== 0) return v; }
      return pe[Math.max(0, Math.min(N - 1, j)) * N + Math.max(0, Math.min(N - 1, i))];
    };
    let n = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i; if (elev[k] !== 0) continue;
      const u = (ox + i + 0.5) / 2 - 0.5, v = (oy + j + 0.5) / 2 - 0.5, i0 = Math.floor(u), j0 = Math.floor(v), fu = u - i0, fv = v - j0;
      const h = (at(i0, j0) * (1 - fu) + at(i0 + 1, j0) * fu) * (1 - fv) + (at(i0, j0 + 1) * (1 - fu) + at(i0 + 1, j0 + 1) * fu) * fv;
      if (h < -20) { elev[k] = h; n++; }
    }
    return n;
  }

  // Coastal voids (round 3, #5): near the shore Terrarium tiles hold patches of exactly 0 m (seen at Peniche: up to half of a
  // z12 tile) where the parent is too shallow for fillOceanVoid. Drawn as 0 m water they glowed as round pale "bubbles" and a
  // pale band along the shelf. A 0 m dot with sea floor around it takes the mean of its sea neighbours, a ring at a time
  // (filled in between, like the rest of the ETOPO1 sea floor at this zoom; the readout says so). Land (> 0 m) is untouched.
  function inpaintVoid(d, e) {
    if (d.polar || d.z < 8) return 0;
    let n = 0;
    for (let pass = 0; pass < 24; pass++) {
      const fill = [];
      for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
        const k = j * N + i; if (e[k] !== 0) continue;
        let s = 0, c = 0, land = 0;
        for (const [di, dj] of [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]]) {
          const ii = i + di, jj = j + dj; if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
          const v = e[jj * N + ii]; if (v < 0) { s += v; c++; } else if (v > 0) land++;
        }
        if (c >= 2 && c >= land) fill.push(k, s / c);
      }
      if (!fill.length) break;
      for (let q = 0; q < fill.length; q += 2) e[fill[q]] = Math.min(-0.5, fill[q + 1]);
      n += fill.length / 2;
    }
    return n;
  }

  // Colour, hillshade and shore boost per dot, then the mean colour of each 2 × 2 block (aParCol: what the block looks
  // like one level coarser, used by the geomorph in dots.js). Plain loops, no per-dot arrays.
  function colourTile(t) {
    const p = palette, g = t.points.geometry, col = g.attributes.color.array, pcol = g.attributes.aParCol.array;
    const e = t.elev, sp = t.spacingM, rs = t.rowScale;
    const [L0, L1, L2] = p.land, [S0, S1, S2] = p.shallow, [M0, M1, M2] = p.mid, [D0, D1, D2] = p.deep;
    let ocean = 0; const lt = [0, 0, 0];
    for (let j = 0; j < N; j++) {
      const spj = sp * rs[j];                            // this row's dot spacing (web-mercator rows)
      const jU = j > 0 ? j - 1 : j, jD = j < N - 1 ? j + 1 : j;
      for (let i = 0; i < N; i++) {
        const k = j * N + i, h = e[k], land = h > 0;
        let c0, c1, c2;
        if (land) { landTone(h, lt, t.latC, t.lonC); c0 = lt[0]; c1 = lt[1]; c2 = lt[2]; }   // same height tone as the base globe (latC: Antarctic ice)
        else {
          ocean++;
          oceanTone(-h, lt, true); const sk = SEA_K;   // same ramp as the base globe (dots.js); 2026-11-23: one brightness for all water, no pale shallow glow
          c0 = lt[0] * sk; c1 = lt[1] * sk; c2 = lt[2] * sk;
        }
        // hillshade from the north-west: one-sided difference at the tile edge (divided by the real step), so edges
        // carry the same gradient as the middle instead of half of it (that was the faint line between tiles)
        const iL = i > 0 ? i - 1 : i, iR = i < N - 1 ? i + 1 : i;
        const dx = (e[j * N + iR] - e[j * N + iL]) / ((iR - iL) * spj);
        const dy = (e[jD * N + i] - e[jU * N + i]) / ((jD - jU) * spj);   // + = rising southward
        let b = Math.min(1.6, Math.max(0.45, 1 + 2.5 * (dx + dy) / Math.SQRT2));
        // seabed: a calmer shade, and steep slopes dimmed by how tightly their dots pile up on screen once the relief is
        // exaggerated (~×6 close in, SEABED_EXAG); without this canyon walls (Nazaré) summed to bright blue-white ridges
        // Round 5 (round-4 #2): floor SEABED_B_MIN. Unfloored, the Nazaré canyon's walls (GEBCO: ~1,000 m drop per 2-3 km) fell to
        // a quarter of the open sea's brightness and the canyon read as a black gash; the depth ramp itself does not run out
        // (it reaches its deepest colour at 6,000 m). Now a canyon is the same deep blue as the open deep sea, a little dimmer.
        if (!land) b = Math.max(SEABED_B_MIN, Math.min(SEABED_B_MAX, Math.max(0.7, b)) / Math.sqrt(1 + SEABED_EXAG * SEABED_EXAG * (dx * dx + dy * dy)));
        // shore: land next to sea, drawn brighter like the base globe's coastlines
        if ((i > 0 && (e[k - 1] > 0) !== land) || (i < N - 1 && (e[k + 1] > 0) !== land) ||
            (j > 0 && (e[k - N] > 0) !== land) || (j < N - 1 && (e[k + N] > 0) !== land)) b *= SHORE_K;
        const f = 255 * b / COL_MAX;                     // stored as bytes, scaled back up by the material colour
        col[3 * k] = Math.min(255, c0 * f); col[3 * k + 1] = Math.min(255, c1 * f); col[3 * k + 2] = Math.min(255, c2 * f);
      }
    }
    for (let j = 0; j < N; j += 2) for (let i = 0; i < N; i += 2) {   // block means, written on the block's keeper dot
      const k = j * N + i;
      for (let q = 0; q < 3; q++) pcol[3 * k + q] = (col[3 * k + q] + col[3 * (k + 1) + q] + col[3 * (k + N) + q] + col[3 * (k + N + 1) + q]) / 4;
    }
    t.hasOcean = ocean > N * N * 0.02;
    g.attributes.color.needsUpdate = true; g.attributes.aParCol.needsUpdate = true;
  }

  // Geomorph attributes (see dots.js, MORPH): the (even, even) dot of each 2 × 2 block is its keeper. aPar.xyz is the
  // keeper's offset to the block centre, aPar.w = 1 on keepers; aParElev the block's mean elevation. As the tile's dots
  // close up on screen the other three fade and the keeper moves to the centre, doubles in size and takes the block's
  // mean colour and height: at the split threshold a tile looks like its parent, so a level change does not pop.
  const dotK = h => h < -COAST_M ? SEA_DOT_K : h > 0 ? TILE_LAND_K : TILE_LAND_K + (SEA_DOT_K - TILE_LAND_K) * Math.max(0, -h) / COAST_M;
  // Build profile: set globalThis.__buildProf = {} in the console; each section's total ms and the tile count accumulate.
  const prof = (P, k, t0) => { const t1 = performance.now(); if (P) P[k] = (P[k] || 0) + t1 - t0; return t1; };
  function build(t) {
    const P = globalThis.__buildProf; let pt = performance.now(); const pt0 = pt;
    if (!t.si && fillOceanVoid(t, t.elev) + inpaintVoid(t, t.elev)) {   // parent loaded by now (lower zooms fetch first); stand-ins come from filled tiles
      despike(t.elev); let m = 0; for (const v of t.elev) m = Math.max(m, Math.abs(v)); t.maxAbs = m;
    }
    pt = prof(P, 'fill', pt);
    const n = 2 ** t.z, NN = N * N, dk = new Float32Array(NN), v = new THREE.Vector3();
    const pel = new Float32Array(NN), e = t.elev;
    // b53: positions, parent offsets and row scale from terrain-worker.js when it made them (real tiles: with the decode;
    // stand-ins: asked for when queued), else computed here as before
    let pre = t.polar ? null : t.pre || (t.si ? geoCache.get(t.key) : null) || null;
    if (t.si && pre) geoCache.delete(t.key);
    t.pre = null;
    const pos = pre ? pre.pos : new Float32Array(NN * 3), sz = pre ? pre.sz : new Float32Array(NN), par = pre ? pre.par : new Float32Array(NN * 4), rs = pre ? pre.rs : new Float32Array(N);
    const cosC = Math.cos(t.latC * D2R);
    const pw = 2 * POLE_S / n;
    if (pre) for (let k = 0; k < NN; k++) dk[k] = dotK(e[k]);
    else for (let j = 0; j < N; j++) {
      const lat = t.polar ? 0 : latOf(t.y + (j + 0.5) / N, n), s = t.polar ? 1 : Math.cos(lat * D2R) / cosC;   // mercator rows: spacing ∝ cos(lat)
      rs[j] = s;
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        // each dot nudged by up to ±0.2 of the spacing (fixed hash of its global grid index): a regular grid seen close
        // and tilted beats against the pixel grid (moiré bands over the sea). A display nudge, not a change of any value.
        const gi = t.x * N + i, gj = t.y * N + j;
        const jx = jit(gi, gj, t.z), jy = jit(gj + 7919, gi, t.z);
        let out = false;
        if (t.polar) {
          const [la, lo, c] = polarLL(t.polar, -POLE_S + (t.x + (i + 0.5 + jx) / N) * pw, -POLE_S + (t.y + (j + 0.5 + jy) / N) * pw);
          unit(la, lo, v).sub(t.center); out = c > POLE_S;
        } else unitM(t.y + (j + 0.5 + jy) / N, n, lonOf(t.x + (i + 0.5 + jx) / N, n), v).sub(t.center);   // relative to tile centre
        pos[3 * k] = v.x; pos[3 * k + 1] = v.y; pos[3 * k + 2] = v.z; sz[k] = s;
        dk[k] = out ? -1 : dotK(e[k]);   // -1: outside a polar cap, not drawn; shallow water eases from the land dot size to the deep one (round 2: its fine 0.9-spacing dots read as black holes along the coast)
      }
    }
    pt = prof(P, 'pos', pt);
    const n2 = n / 2, pw2 = 2 * pw;
    for (let j = 0; j < N; j += 2) for (let i = 0; i < N; i += 2) { const k = j * N + i; pel[k] = (e[k] + e[k + 1] + e[k + N] + e[k + N + 1]) / 4; }
    if (!pre) for (let j = 0; j < N; j += 2) for (let i = 0; i < N; i += 2) {
      const k = j * N + i;
      // the keeper's target: the parent level's own dot for this block (its global index, its jitter)
      const GI = (t.x * N + i) >> 1, GJ = (t.y * N + j) >> 1, pz = t.z - 1;
      const pjx = jit(GI, GJ, pz), pjy = jit(GJ + 7919, GI, pz);
      if (t.polar) { const [la, lo] = polarLL(t.polar, -POLE_S + (GI + 0.5 + pjx) / N * pw2, -POLE_S + (GJ + 0.5 + pjy) / N * pw2); unit(la, lo, v).sub(t.center); }
      else unitM((GJ + 0.5 + pjy) / N, n2, lonOf((GI + 0.5 + pjx) / N, n2), v).sub(t.center);
      par[4 * k] = v.x - pos[3 * k]; par[4 * k + 1] = v.y - pos[3 * k + 1]; par[4 * k + 2] = v.z - pos[3 * k + 2];
      par[4 * k + 3] = 1;
    }
    t.rowScale = rs;
    pt = prof(P, 'par', pt);
    // drawn heights: a stand-in keeps its own copy (it may geomorph to a finer source); a real tile that replaces a drawn
    // stand-in starts at the stand-in's heights and eases to its own (morphFrame)
    const si = t.si ? null : standInUnder(t);
    const from = si ? resample(t, si, si.disp, siNb) : null;
    if (t.si || from) t.disp = Float32Array.from(from || e);
    pt = prof(P, 'from', pt);
    if (from) for (let j = 0; j < N; j += 2) for (let i = 0; i < N; i += 2) { const k = j * N + i; pel[k] = (from[k] + from[k + 1] + from[k + N] + from[k + N + 1]) / 4; }
    t.pel = pel;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aElev', new THREE.BufferAttribute(t.disp || e, 1));
    g.setAttribute('aSize', new THREE.BufferAttribute(sz, 1));
    g.setAttribute('aDotK', new THREE.BufferAttribute(dk, 1));
    g.setAttribute('aPar', new THREE.BufferAttribute(par, 4));
    g.setAttribute('aParElev', new THREE.BufferAttribute(pel, 1));
    g.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(NN * 3), 3, true));
    g.setAttribute('aParCol', new THREE.BufferAttribute(new Uint8Array(NN * 3), 3, true));
    const size = 0.9 * t.spacingM / R_EARTH;
    t.points = new THREE.Points(g, makeDotMaterial({ size, color: [COL_MAX, COL_MAX, COL_MAX], vertexColors: true, displace: true, center: t.center,
      sizeAttr: true, dotK: true, areaComp: true, maxPx: TILE_MAX_PX * renderer.getPixelRatio(), capComp: TILE_CAP_COMP, hueMax: HUE_MAX, coverIn: coverTex, morph: { spacing: t.spacingM / R_EARTH, graze: t.radius < 0.05, n: t.polar ? 0 : N } }));
    t.points.position.copy(t.center);
    t.points.frustumCulled = false;
    t.points.visible = false;
    t.fade = 0;
    pt = prof(P, 'geomMat', pt);
    colourTile(t);
    pt = prof(P, 'colour', pt);
    group.add(t.points);
    if (P) { P.total = (P.total || 0) + pt - pt0; P.n = (P.n || 0) + 1; if (t.si) P.si = (P.si || 0) + 1; }
    if (from) startMorph(t, from);
    t.state = 'ready'; t.builtAt = lastNow; tlog(t, 'built');
  }

  function dispose(t) {
    if (t.ctrl) t.ctrl.abort();
    live.delete(t); morphing.delete(t);
    if (t.points) { group.remove(t.points); t.points.geometry.dispose(); t.points.material.dispose(); }
    cache.delete(t.key);
  }
  // stand-ins count toward the cache: the ones not drawn go first, then real tiles least recently used
  function evict() {
    if (cache.size + sic.size <= CACHE) return;
    for (const s of [...sic.values()].filter(s => !s.shownNow && !(s.fade > 0)).sort((a, b) => a.used - b.used)) { if (cache.size + sic.size <= CACHE) return; disposeSI(s); }
    const old = [...cache.values()].filter(t => t.state !== 'loading' && !t.shownNow && !(t.fade > 0) && t.keep !== selectId && !(t.pfUntil > lastNow)).sort((a, b) => a.used - b.used);
    for (const t of old) { if (cache.size + sic.size <= CACHE) break; dispose(t); }
  }

  // Cross-fade: a tile that joins the drawn set fades in over FADE_MS while the tile(s) it replaces fade out over the
  // same time (additive dots: the two sum to one), so a level change is a short blend, not a swap.
  const live = new Set();                 // tiles drawn or fading
  const COARSE_M = 50000;                 // base globe: ~41 km between dots
  const coarseStandIn = t => !t.polar && t.spacingM > COARSE_M;
  let alpha = 1;                          // the whole tile layer's opacity (globe.js cross-fades it with the base globe by zoom)
  let lastNow = 0;
  function fadeFrame(now) {
    const step = Math.max(0, Math.min(100, lastNow ? now - lastNow : 16)) / FADE_MS; lastNow = Math.max(lastNow, now);
    for (const t of live) {
      const f0 = t.fade;
      t.fade = Math.max(0, Math.min(1, t.fade + (t.shownNow ? step : -step)));
      if (t.fade !== f0) covDirty = true;
      // round 4: a stand-in tile coarser than the base globe's ~41 km grid (z2 at mid latitudes) is not drawn and does
      // not cover the base globe (updateCover): it showed as a dark square of sparse dots while its children loaded
      t.points.material.uniforms.uOpacity.value = coarseStandIn(t) ? 0 : t.fade * alpha;
      if (t.leafPx === undefined && !t.si && coverageKnown()) t.leafPx = (t.polar ? t.z >= POLE_MAX_Z : t.z < MAX_Z && !kidsBuilt(t)) ? LEAF_MAX_PX : 0;   // b54
      t.points.material.uniforms.uMaxPx.value = (t.leafPx || TILE_MAX_PX) * renderer.getPixelRatio();
      t.points.visible = t.fade > 0;
      if (!t.shownNow && t.fade === 0) live.delete(t);
    }
    morphFrame(now);
  }
  function update(now) {
    if (lite) TPX = CAP_ON ? Math.max(liteTpx(), 2 * MIN_RPX / renderer.getPixelRatio()) : liteTpx();   // phone 2026-11-23 late (rotation and resizes change the short side); b53: the detail cap
    if (!enabled) return;
    frameNo++;
    morphT.value = TPX * refine * renderer.getPixelRatio();
    // builds: as many as fit in ~6 ms of this frame (at least one); a tile whose parent is still on its way waits for it
    // Budget: BUILD_MS at 60 fps; when frames are slow anyway (a loaded machine, software GL), up to 12 % of the last
    // frame interval (at most 16 ms; round 3: a quarter / 30 ms made slow frames slower still), so decoded tiles do not wait several slow frames each in the queue (measured
    // 2026-11-24: build() is ~1.4 ms a tile; the 300-700 ms between decode and build seen under load was queue wait).
    const fdt = lastUpd ? Math.min(500, now - lastUpd) : 16; lastUpd = now;
    if (fdt >= 6) frameEma += (fdt - frameEma) * 0.1;   // ignores a second call in the same frame (a probe rendering extra)
    slow = slow ? frameEma > FAST_MS : frameEma > SLOW_MS;
    const budget = Math.min(16, Math.max(BUILD_MS, 0.12 * fdt));
    const tb0 = performance.now(); let built = 0; const UP = globalThis.__buildProf; let ut = tb0;
    for (let b = 0, tries = queue.length; tries > 0 && queue.length && (b === 0 || performance.now() - tb0 < budget); tries--) {
      const t = queue.shift(); if (cache.get(t.key) !== t) continue;
      const par = cache.get(parKey(t));
      if (par && par.state === 'loading' && t.z > SKIP_TO_Z) { queue.push(t); continue; }   // only fillOceanVoid (z > 10) needs the parent
      build(t); b++; built++;
      if (t.z <= BASE_MAX_Z + 1) siKick = true;   // b53: a coarse (world base) level is in: refine on it next frame, not in 120 ms
    }
    ut = prof(UP, 'u.build', ut);
    // stand-ins: nearest the middle of the screen first; one a frame even when real builds used the budget (they would
    // starve while tiles stream in, which is exactly when they are needed), more while the budget lasts. lite: on frames
    // that also built a real tile, only every other frame.
    if (siQueue.size) {
      const list = [...siQueue.values()].sort((a, c) => a.prio - c.prio);
      let n = 0;
      for (const e of list) {
        if (e.id < selectId - 1) { siQueue.delete(e.d.key); continue; }   // not asked for by the last two passes
        if (n >= SI_PER_FRAME || (n && performance.now() - tb0 >= budget) || (!n && built && lite && frameNo & 1)) break;
        if (!sic.has(e.d.key) && !geoReady(e.d.key)) continue;   // b53: its geometry is on its way from the worker
        siQueue.delete(e.d.key);
        const t0 = performance.now();
        if (siBuild(e)) { n++; siMs += performance.now() - t0; siCount++; }
      }
      if (n && !siQueue.size) siKick = true;   // all asked-for stand-ins built: refine again next frame, not in 120 ms
    }
    ut = prof(UP, 'u.si', ut);
    fadeFrame(now);
    ut = prof(UP, 'u.fade', ut);
    updateCover();
    ut = prof(UP, 'u.cover', ut); if (UP) UP.frames = (UP.frames || 0) + 1;
    if (now - lastSelect < (siKick ? 30 : 120)) return;
    siKick = false;
    covDirty = true;
    lastSelect = now;
    camPos.copy(camera.position);
    camera.updateMatrixWorld();
    projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projView);
    selectId++;
    ut = performance.now();
    const { show, want, siShow, measured: ms } = select();
    ut = prof(UP, 'u.select', ut);
    // Round 4: pending counts only what this view still wants (loading or not). Not stand-in sources (the level three up),
    // prefetches, or fetches left running on the path after the view stopped wanting them: a warm reload over a slow line
    // waited a full round trip (~3 s) for such tiles after everything on screen was in.
    const needKeys = new Set(); for (const [d, , helper] of want) if (!helper) needKeys.add(d.key);
    pending = needKeys.size;
    for (const t of shown) t.shownNow = false;
    for (const t of shownSI) t.shownNow = false;
    for (const t of show) { t.shownNow = true; t.used = frameNo; live.add(t); tlog(t, 'shown'); }
    for (const t of siShow) { t.shownNow = true; t.used = frameNo; live.add(t); }
    shown = show; shownSI = siShow; measured = ms;
    noteLevels(show, siShow);
    edgeRamp(siShow.length ? [...show, ...siShow] : show);
    for (const s of [...sic.values()]) if (!s.shownNow && !(s.fade > 0) && s.keep !== selectId) disposeSI(s);   // replaced or left the view
    // drop fetches that are no longer wanted, start new ones nearest-first
    const wantKeys = new Set(want.map(w => w[0].key));
    // round 3: a fetch still on the path of this view (keep) runs on even if a finer level is now wanted (in a wheel zoom it
    // becomes the stand-in); tiles that left the view or dropped out of the wanted list are cancelled, unless prefetched
    // ahead of the camera (pfUntil) and not yet expired
    for (const t of cache.values()) if (t.state === 'loading' && !wantKeys.has(t.key) && t.keep !== selectId && !(t.pfUntil > now && !(t.pfSeen && !visible(t))) && t.ctrl) t.ctrl.abort();
    if (globalThis.__terrainLog) { const W = globalThis.__terrainWant ??= {}; for (const [d] of want) W[d.key] ??= performance.now(); }
    const maxIn = pack ? MAX_INFLIGHT_V2 : MAX_INFLIGHT;
    for (const [d, p, helper] of want) {
      if (inflight >= maxIn) break;
      if (!cache.has(d.key)) { load(d, p); if (helper) d.srcOnly = true; }
      else if (!helper && cache.get(d.key).srcOnly) cache.get(d.key).srcOnly = false;
      else cache.get(d.key).used = frameNo;
    }
    motionPrefetch(now);
    runPrefetch(now, maxIn);
    evict();
    prof(UP, 'u.rest', ut);
  }

  // b38 (Egmond seam): for each drawn mercator tile, which of its four edges borders a drawn tile one or more levels coarser
  // that is held there (the drawn detail steps down at a spot box edge), with the neighbour's area on screen. dots.js ramps those dots toward the parent level (uEdge, MORPH_N), so the grain
  // changes dot by dot instead of in a straight step along the edge. Polar tiles are left as they were.
  const edgeP = new THREE.Vector3();
  function edgeRamp(show) {
    const keys = new Set(show.map(t => t.key));
    // the shared edge (tile units at level z, from (x0, y0) to (x1, y1)) is on screen: one of 5 points along it inside the
    // view and on the camera's side of the globe. A step just off screen (under the camera) ramped the whole near tile,
    // which is large on screen, so the foreground lost its detail.
    const onScreen = (z, x0, y0, x1, y1) => {
      const n = 2 ** z;
      for (let i = 0; i <= 4; i++) {
        const f = i / 4; unit(latOf(y0 + (y1 - y0) * f, n), lonOf(x0 + (x1 - x0) * f, n), edgeP);
        if (edgeP.dot(camPos) > 1 && frustum.containsPoint(edgeP)) return true;
      }
      return false;
    };
    const coarser = (z, x, y, x0, y0, x1, y1) => {
      const n = 2 ** z; if (y < 0 || y >= n) return 0;
      x = ((x % n) + n) % n;
      // only a held step: the coarser tile wanted finer dots (spacing over the split threshold) but stayed coarse (capped or
      // nearCap). A plain distance step is already blended by the spacing geomorph.
      for (let k = 1; k <= z - MIN_Z; k++) if (keys.has(`${z - k}/${x >> k}/${y >> k}`)) return spacingPx(desc(z - k, x >> k, y >> k)) > TPX * refine && onScreen(z, x0, y0, x1, y1) ? 1 : 0;
      return 0;
    };
    for (const t of show) {
      const u = t.points && t.points.material.uniforms.uEdge; if (!u) continue;
      if (t.polar || globalThis.__noEdgeRamp) { u.value.set(0, 0, 0, 0); continue; }   // __noEdgeRamp: console switch for before/after checks
      const { z, x, y } = t;
      u.value.set(coarser(z, x - 1, y, x, y, x, y + 1), coarser(z, x + 1, y, x + 1, y, x + 1, y + 1),
                  coarser(z, x, y - 1, x, y, x + 1, y), coarser(z, x, y + 1, x, y + 1, x + 1, y + 1));
    }
  }


  // Data level drawn in the last pass: real tiles their own level, stand-ins their source's. lvlOwn: by drawn key; lvlUnder:
  // the lowest level drawn anywhere below a key (4 levels up from each drawn tile).
  let lvlOwn = new Map(), lvlUnder = new Map();
  function noteLevels(show, sis) {
    lvlOwn = new Map(); lvlUnder = new Map();
    const note = (t, l) => {
      if (t.polar) return;
      lvlOwn.set(t.key, l);
      for (let k = 1, x = t.x >> 1, y = t.y >> 1; k <= 4 && t.z - k >= MIN_Z; k++, x >>= 1, y >>= 1) {
        const key = `${t.z - k}/${x}/${y}`, o = lvlUnder.get(key); if (o === undefined || l < o) lvlUnder.set(key, l);
      }
    };
    for (const t of show) note(t, t.z);
    for (const t of sis) note(t, t.srcZ);
  }
  // the lowest data level drawn last pass on the 8 same-level neighbours of d (Infinity where nothing was drawn)
  function lvlNb(d) {
    const n = 2 ** d.z; let m = Infinity;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const y = d.y + dy; if (y < 0 || y >= n) continue;
      let x = (d.x + dx + n) % n, l = lvlUnder.get(`${d.z}/${x}/${y}`);
      if (l === undefined) { let yy = y; for (let z = d.z; z >= MIN_Z; z--, x >>= 1, yy >>= 1) { const o = lvlOwn.get(`${z}/${x}/${yy}`); if (o !== undefined) { l = o; break; } } }
      if (l !== undefined && l < m) m = l;
    }
    return m;
  }

  // ---------- prefetch ----------
  // Tiles at (lat, lon) for a view from `dist` radii away (looking at it): the level the view would end on there (walked up
  // to the finest level that exists) as a 3 × 3 block, after one tile three levels coarser that the stand-ins can come from.
  // Kept until `until` (ms); tier 0 (asked for by globe.js) before tier 1 (camera motion).
  function prefetchAt(lat, lon, dist, until, tier) {
    if (!(Math.abs(lat) < 85) || !Number.isFinite(lon) || !(dist > 0)) return;
    const la = lat * D2R, my = (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2, ppu = pxPerUnit(), tp = TPX * refine;
    const at = z => { const n = 2 ** z; return [((Math.floor((lon + 180) / 360 * n) % n) + n) % n, Math.min(n - 1, Math.floor(my * n))]; };
    let z = MIN_Z; while (z < MAX_Z && 2 * Math.PI / 2 ** z * Math.cos(la) / N / dist * ppu > tp) z++;
    while (z > MIN_Z && !srcHas(z, ...at(z))) z--;
    const list = [];
    const zs = Math.max(3, z - 3); if (zs < z) list.push([zs, ...at(zs)]);
    const [cx, cy] = at(z), n = 2 ** z;
    list.push([z, cx, cy]);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && cy + dy >= 0 && cy + dy < n) list.push([z, (cx + dx + n) % n, cy + dy]);
    list.forEach(([tz, tx, ty], i) => {
      if (!srcHas(tz, tx, ty)) return;
      const key = `${tz}/${tx}/${ty}`, o = pf.get(key), p = tier * 100 + i;
      if (o) { o.until = Math.max(o.until, until); o.prio = Math.min(o.prio, p); return; }
      if (pf.size < PF_MAX) pf.set(key, { z: tz, x: tx, y: ty, until, prio: p, sent: false, tier });
    });
  }
  // b53, zoom-ahead (globe.js calls it every frame while zooming in): the ground point under the cursor / pinch (or the
  // middle of the view) and the height the zoom is heading for. The tiles the view will end on there, plus those of a
  // halfway height when the zoom is still far from its target, at the lowest priority (behind every visible tile).
  let zaLast = 0;
  function zoomAhead(lat, lon, targetAlt, alt) {
    const now = performance.now(); if (!ZOOM_AHEAD || now - zaLast < 150 || !enabled) return; zaLast = now;
    if (!(targetAlt > 0) || !(alt > targetAlt * 1.05)) return;
    prefetchAt(lat, lon, targetAlt, now + 1500, 1);
    if (alt > targetAlt * 4) prefetchAt(lat, lon, Math.sqrt(alt * targetAlt), now + 1500, 2);
  }
  // camera motion: the ground point in the middle of the view and the distance to it, over the last ~0.6 s
  const pfHist = [], pfG = new THREE.Vector3(), pfFwd = new THREE.Vector3();
  function motionPrefetch(now) {
    camera.getWorldDirection(pfFwd);
    const c = camPos, b = c.dot(pfFwd), disc = b * b - (c.lengthSq() - 1);
    let dist;
    if (disc > 0 && -b - Math.sqrt(disc) > 0) { dist = -b - Math.sqrt(disc); pfG.copy(c).addScaledVector(pfFwd, dist); }
    else { pfG.copy(c).normalize(); dist = c.length() - 1; }
    if (!(dist > 0)) return;
    pfHist.push({ t: now, g: pfG.clone(), dist });
    while (pfHist.length > 2 && now - pfHist[0].t > 650) pfHist.shift();
    const h = pfHist[0], dt = (now - h.t) / 1000;
    if (dt < 0.15) return;
    const k = PF_LOOK / dt, ang = pfG.angleTo(h.g), zr = Math.log(dist / h.dist);
    if (ang < 0.08 * dist && Math.abs(zr) < 0.05) return;            // still (or nearly): nothing to get ahead of
    const gp = pfG.clone().addScaledVector(pfG.clone().sub(h.g), k).normalize();
    const dp = Math.max(dist * 0.1, Math.min(dist * 10, dist * Math.exp(zr * k)));
    prefetchAt(Math.asin(gp.y) / D2R, Math.atan2(-gp.z, gp.x) / D2R, dp, now + 1200, 1);
  }
  // Prefetched tiles load like wanted ones, behind them, in at most PF_SLOTS of the slots; with ?terrain=v2 they go to the
  // pack source's own prefetch (into its persistent cache, no decode).
  function runPrefetch(now, maxIn) {
    if (!pf.size) return;
    // b53: a prefetch whose tile was on screen when it was asked for and has left it since is cancelled (zoom and motion
    // prefetches; a flight's landing tiles, tier 0, are not on screen until it lands and run until they expire)
    for (const [key, p] of pf) {
      const gone = p.tier > 0 && p.seen && !visible(p.d || (p.d = desc(p.z, p.x, p.y)));
      if (p.until < now || gone) { if (p.ctrl) p.ctrl.abort(); pf.delete(key); if (gone) pfCancelled++; }
    }
    const list = [...pf.values()].sort((a, b) => a.prio - b.prio);
    for (const p of list) {
      const key = `${p.z}/${p.x}/${p.y}`, c = cache.get(key);
      if (c) { if (c.state === 'loading' || c.state === 'ready') { c.pfUntil = p.until; c.pfTier = p.tier; c.used = frameNo; } continue; }
      if (pack) {
        if (!p.sent) {
          p.sent = true; p.seen = p.tier > 0 && visible(p.d || (p.d = desc(p.z, p.x, p.y)));
          p.ctrl = typeof AbortController === 'function' ? new AbortController() : null;
          try { pack.prefetch(p.z, p.x, p.y, { signal: p.ctrl && p.ctrl.signal, prio: p.prio }).then(() => { p.ctrl = null; }, () => {}); } catch (e) { /* best effort */ }
        }
        continue;
      }
      if (inflight >= Math.min(maxIn, PF_SLOTS)) break;
      const d = desc(p.z, p.x, p.y); load(d, 1000 + p.prio); d.pfUntil = p.until; d.pfTier = p.tier; d.pfSeen = p.tier > 0 && visible(d);
    }
  }
  let pfCancelled = 0;
  // globe.js, at the start of a flight: the tiles where it will land (altRadii: the camera's height there, in radii)
  function prefetch(lat, lon, altRadii) { prefetchAt(lat, lon, altRadii, performance.now() + 6000, 0); }

  function setEnabled(on) {
    enabled = on; group.visible = on && alpha > 0.001;
    lastUpd = 0;   // the first frame after a switch is not a slow frame
    if (!on) {
      for (const s of [...sic.values()]) disposeSI(s);
      siQueue.clear(); shownSI = []; measured = [];
      for (const t of [...cache.values()]) if (t.state === 'loading') t.ctrl && t.ctrl.abort();
      for (const t of live) { t.fade = 0; t.shownNow = false; t.points.visible = false; }   // fade in again when switched back on
      live.clear(); shown = []; lastNow = 0; covData.fill(0); coverTex.needsUpdate = true; covFull = false; lastHoles = 1;
    }
  }

  // What is on screen, for the honesty readout: the tile nearest the middle of the view.
  function status() {
    const shown = measured;                 // real tiles only: stand-ins are drawn from these and add no detail
    if (!enabled || !shown.length) return null;
    const fwd = new THREE.Vector3(); camera.getWorldDirection(fwd);
    let best = null, bd = -2;
    for (const t of shown) { const d = fwd.dot(t.center.clone().sub(camera.position).normalize()); if (d > bd) { bd = d; best = t; } }
    // the ground under the middle of the view (ray onto the unit sphere): the finest drawn tile that holds it, if any. The
    // nearest-centre pick above could name a big coarse tile on the horizon (seen: "59 km apart" over Sicily).
    const c = camera.position, b = c.dot(fwd), disc = b * b - (c.lengthSq() - 1);
    if (disc > 0) {
      const g = c.clone().addScaledVector(fwd, -b - Math.sqrt(disc));
      let gz = -1; for (const t of shown) if (t.z > gz && g.distanceTo(t.center) <= t.radius) { gz = t.z; best = t; }
    }
    const dots = shown.length * N * N;
    const oceanInView = shown.some(t => t.hasOcean);
    const landSrc = [...new Set(shown.flatMap(t => t.sources || []).filter(s => s !== 'etopo1'))];
    const polarInView = shown.some(t => t.polar);
    if (!best) return null;                 // no tile faced the camera (NaN directions while the camera sat on a tile centre): seen as null.polar
    const sb = best.polar ? SEABED : seabedOf(best.z, best.x, best.y);   // the seabed source under the middle of the view
    return { polarInView, polarBest: !!best.polar, refine, z: best.z, mPerDot: best.spacingM, tiles: shown.length, dots, cached: cache.size, oceanInView,
      seabedCoarse: oceanInView && best.spacingM < sb.m * (SEABED_M / SEABED.m) && !best.polar, landSrc, exag: dotExag.value, detailEnds, seabedName: sb.name, seabedLabel: sb.label };
  }
  // Coverage map (round 3): which lat/lon cells a drawn tile covers, by its fade (0..1), as an equirectangular texture the base
  // globe reads (dots.js cover). The base globe fades only under drawn tiles, so a region still loading keeps it.
  const CW = 1024, CH = 512, covData = new Uint8Array(CW * CH);
  const coverTex = new THREE.DataTexture(covData, CW, CH, THREE.RedFormat, THREE.UnsignedByteType);
  coverTex.wrapS = THREE.RepeatWrapping; coverTex.magFilter = coverTex.minFilter = THREE.LinearFilter; coverTex.needsUpdate = true;
  let covDirty = true, covFull = false;
  function updateCover() {
    if (!covDirty) return; covDirty = false;
    covData.fill(0);
    const polar = { 1: 0, '-1': 0 }; let full = lastHoles === 0;
    for (const t of live) {
      const v = coarseStandIn(t) ? 0 : Math.round(255 * t.fade); if (v <= 0) continue;
      if (t.fade < 1) full = false;
      if (t.polar) { polar[t.polar] = Math.max(polar[t.polar], v); continue; }
      const n = 2 ** t.z, x0 = Math.floor((lonOf(t.x, n) + 180) / 360 * CW), x1 = Math.ceil((lonOf(t.x + 1, n) + 180) / 360 * CW);
      const y0 = Math.floor((latOf(t.y + 1, n) + 90) / 180 * CH), y1 = Math.ceil((latOf(t.y, n) + 90) / 180 * CH);
      for (let y = Math.max(0, y0); y < Math.min(CH, y1); y++) { const r = y * CW; for (let x = x0; x < x1; x++) { const k = r + ((x % CW) + CW) % CW; covData[k] = Math.min(255, covData[k] + v); } }   // summed (round 4): a parent fading out and its child fading in add to one
    }
    const yN = Math.floor((POLE_EDGE + 90) / 180 * CH), yS = Math.ceil((90 - POLE_EDGE) / 180 * CH);
    if (polar[1]) covData.fill(polar[1], yN * CW, CH * CW);
    if (polar[-1]) covData.fill(polar[-1], 0, yS * CW);
    coverTex.needsUpdate = true; covFull = full;
  }
  // Finest dot spacing built under a point (m), for the zoom floor where our tiles stop (globe.js detailFloor). 0 = no
  // floor: AWS (every level everywhere), or coverage.json not in yet.
  function finestM(lat, lon) {
    if (USE_AWS || !coverageKnown() || Math.abs(lat) > POLE_EDGE) return 0;
    const la = lat * D2R;
    for (let z = MAX_Z; z >= MIN_Z; z--) {
      const n = 2 ** z, x = Math.floor((lon + 180) / 360 * n), y = Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n);
      if (srcHas(z, ((x % n) + n) % n, y)) return 2 * Math.PI * R_EARTH / n * Math.cos(la) / N;
    }
    return 0;
  }
  function setAlpha(a) { alpha = a; group.visible = enabled && a > 0.001; }
  function recolour() { for (const t of cache.values()) if (t.state === 'ready') colourTile(t); for (const t of sic.values()) if (t.state === 'ready') { t.cFrom = t.cTo = t.pFrom = t.pTo = null; colourTile(t); } }

  return { group, update, setEnabled, setAlpha, status, finestM, recolour, elevationAt, get refine() { return refine; }, get enabled() { return enabled; }, get pending() { return pending; }, get holes() { return lastHoles; }, coverTex, get coverFull() { return covFull; }, get health() { return { ok: loadedOk, fails: loadFails, lastErr, inflight }; }, cache,
    prefetch, zoomAhead, get pfCancelled() { return pfCancelled; }, get packStats() { return pack && pack.stats ? pack.stats() : null; }, get workers() { return workOk(); }, get standIns() { return shownSI.length; }, get fading() { let n = 0; for (const t of live) if (t.fade > 0 && t.fade < 1) n++; return n; }, get heldN() { return heldKeys.size; }, get frameEma() { return frameEma; }, get siDebug() { return { msPerBuild: +(siMs / Math.max(1, siCount)).toFixed(2), builds: siCount, built: sic.size, queued: siQueue.size, shown: shownSI.length, morphing: morphing.size, colourMorphs: [...morphing].filter(t => t.cFrom).length, pf: pf.size }; }, get format() { return pack ? 'v2' : 'png'; } };
}
