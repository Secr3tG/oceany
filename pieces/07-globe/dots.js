// House dot style for the globe and its layers: the same glowing round dots as the seafloor viewer
// (pieces/01-seafloor/viewer/main.js): additive blending, soft round falloff pow(1 - r, 2), alpha 0.85,
// size in world units turned into pixels by perspective (bigger when near), never under 1.5 px.
//
//   makeDotMaterial({ size, color, vertexColors, opacity })
//     size          dot diameter in world units (globe radius = 1). The Earth's dots use 0.0058.
//     color         a THREE.Color, hex number or [r, g, b] (0..1). Multiplies the vertex colour if both are given.
//     vertexColors  true: read a per-dot 'color' attribute (vec3) from the geometry.
//     opacity       0..1
//     maxPx         largest dot on screen, device px (uniform uMaxPx; default: no cap). The base globe caps its dots.
//     dotK          true: read a per-dot 'aDotK' draw-size multiplier (terrain tiles: wider, softer deep-water dots);
//                   aDotK = 0 marks land: farK × wider seen from afar, own size close in (see the shader).
//     grazeMin      > 0: dim dots seen edge-on (toward the limb) by cos(incidence)/0.45, floor grazeMin.
//     capComp       > 1: a capped dot is brightened by (wanted / drawn size)², at most capComp (keeps brightness per area).
//     cover         { texture, k }: base globe only; dots fade by k.value × the texture's red channel at their lat/lon
//                   (terrain.js coverage map: where a tile is drawn). k is a shared { value } uniform.
//     hueMax        > 0: no dot brighter than hueMax in any channel, hue kept (base globe and tiles: no cream / white clipping).
//                   With dotK, aDotK = -1 marks a dot that is not drawn (polar-cap tile corners, terrain.js).
//   Returns a THREE.ShaderMaterial for THREE.Points. Its uniforms (uSize, uColor, uOpacity) can be changed later.
//
//   palette  the globe's colours, [r, g, b] 0..1: shallow, mid, deep, land (same as the viewer's Ocean palette),
//            plus unlocked, forecast, locked, hazard (region markers). The globe switches palettes by overwriting these
//            arrays in place, so read them when you build colours, not once at import.
import * as THREE from 'three';

export const PALETTES = {   // shallow/mid/deep/land copied from the seafloor viewer so the globe matches the reef maps
  // relief: land colour by height, [metres, [r, g, b]] stops (a hypsometric tint, the atlas convention: it shows height,
  // not vegetation, rock type or snow; no land-cover data is used). Muted olive lowland, warm brown uplands, grey rock,
  // pale only on the highest ground. Values are tones; landTone() and the base globe set the brightness.
  Ocean: { shallow: [0.35, 1.0, 0.95], mid: [0.1, 0.5, 0.95], deep: [0.03, 0.08, 0.45], land: [0.30, 0.26, 0.22],
    relief: [[0, [0.22, 0.31, 0.17]], [300, [0.29, 0.31, 0.18]], [1000, [0.37, 0.29, 0.19]], [2200, [0.36, 0.27, 0.20]],
      [3800, [0.36, 0.28, 0.22]], [5200, [0.37, 0.30, 0.25]], [6500, [0.45, 0.42, 0.40]]], ice: [0.14, 0.19, 0.28] },
  // Round 3 (#8): Ember and Mono read like Ocean: warm land over a dark, cool sea of the same contrast (Ember was cream land on
  // a maroon sea, Mono white dots on black at mid zoom). Ember: rust and umber land on a blue-black indigo sea, a warm
  // glow only in the shallows close in. Mono: neutral mid-grey land over a darker cool slate sea.
  Ember: { shallow: [1.0, 0.72, 0.35], mid: [0.26, 0.20, 0.72], deep: [0.05, 0.05, 0.36], land: [0.30, 0.18, 0.12],
    relief: [[0, [0.34, 0.17, 0.08]], [300, [0.36, 0.19, 0.09]], [1000, [0.38, 0.21, 0.11]], [2200, [0.37, 0.22, 0.13]], [3800, [0.37, 0.24, 0.16]],
      [5000, [0.38, 0.27, 0.20]], [6200, [0.44, 0.35, 0.30]]], ice: [0.24, 0.20, 0.27] },
  // Round 5 (round-4 #5): Mono land was ~half Ocean's land brightness (near-black against the sea at mid zoom) and its shallow
  // water glowed near-white (the snow specks along coasts close in). Now land is a fixed mid-grey (peak ≈ the Mono hue cap, so
  // hillshade can lift a dot only ~10 %: no white specks), the sea a dimmer cool slate, the shallows a pale steel, not white.
  Mono:  { shallow: [0.50, 0.57, 0.66], mid: [0.25, 0.28, 0.35], deep: [0.09, 0.10, 0.16], land: [0.24, 0.24, 0.23],
    relief: [[0, [0.235, 0.225, 0.205]], [1000, [0.24, 0.23, 0.21]], [3800, [0.245, 0.237, 0.22]], [5000, [0.25, 0.243, 0.23]], [6200, [0.26, 0.255, 0.245]]], ice: [0.20, 0.215, 0.25] },
};
// Ice: ETOPO1 "Ice Surface" heights are the top of the ice sheets, so the two ice sheets take a pale blue-grey instead of
// the height tint (palette.ice): Antarctica (all land south of ICE_LAT) and Greenland's interior (land above GL_ICE_M inside a box
// round Greenland; its ice-free margin lies mostly below that). Known facts about two ice sheets, set by hand, not a
// per-dot measurement of ice; all other land, the Himalaya included, is height tint only (no snow is drawn).
export const ICE_LAT = -60;
const GL_ICE_M = 1000, inGreenland = (lat, lon) => lat > 59.5 && lat < 84 && lon > -74 && lon < -10;
// Round 4 (round-3 #6): one accent per palette, everywhere. Ocean's forecast/wanted state was amber, a second accent next
// to the cyan; it is now the cyan dimmed and greyed, so state reads by strength (and the dashed marker), not by hue.
// palette.unlocked is THE accent: layers that want a UI hue should read it (CSS: var(--open), alias var(--accent)).
const ACCENTS = { unlocked: [0.37, 0.95, 1.0], forecast: [0.56, 0.76, 0.82], locked: [0.29, 0.35, 0.40], hazard: [0.55, 0.64, 0.72],
  bg: [0.016, 0.024, 0.039], night: [0.008, 0.012, 0.027], panel: [0.024, 0.055, 0.086], ink: [0.81, 0.90, 0.95], dim: [0.42, 0.53, 0.59] };
// bg: clear colour (the seafloor viewer's); night: the unlit sphere that hides the far side; panel, ink, dim: the page's UI.
// The page's CSS colour variables are set from these (applyCssPalette), so the DOM and the scene share one palette.   // hazard: calm blue-grey for 'data needed' sites (disaster coasts), never a bounty colour
export const palette = { ...structuredClone(PALETTES.Ocean), ...structuredClone(ACCENTS) };
const hex = c => '#' + c.map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('');
export function applyCssPalette(root = document.documentElement) {
  const vars = { '--open': 'unlocked', '--accent': 'unlocked', '--fc': 'forecast', '--lock': 'locked', '--hz': 'hazard', '--bg': 'bg', '--panel': 'panel', '--ink': 'ink', '--dim': 'dim' };
  for (const [v, k] of Object.entries(vars)) root.style.setProperty(v, hex(palette[k]));
}
// Per-palette accents (markers, labels, top bar): the shared ACCENTS are the Ocean ones (cyan unlocked, amber forecast);
// Ember and Mono override them so labels and markers follow the palette. Round 3: one accent per palette (Ocean cyan, Ember
// ember orange, Mono ice blue) on the unlocked state; the other states are that accent dimmed (Ember) or greys (Mono).
const PALETTE_ACCENTS = {
  Ember: { unlocked: [1.0, 0.62, 0.30], forecast: [0.72, 0.46, 0.28], locked: [0.36, 0.30, 0.30], hazard: [0.70, 0.62, 0.62],
    panel: [0.07, 0.04, 0.04], ink: [0.95, 0.88, 0.82], dim: [0.62, 0.50, 0.46] },
  Mono: { unlocked: [0.55, 0.86, 1.0], forecast: [0.66, 0.66, 0.66], locked: [0.32, 0.32, 0.32], hazard: [0.72, 0.72, 0.72],
    panel: [0.05, 0.05, 0.05], ink: [0.88, 0.88, 0.88], dim: [0.55, 0.55, 0.55] },
};
// Brightest channel per dot, by palette (shared uniform of every material made with hueMax = HUE_MAX). Mono's dots are grey,
// so a channel at 0.92 is white: its capped mid-zoom land read as white dots (round 2 #8); 0.6 keeps it mid-grey.
const PAL_HUE_MAX = { Mono: 0.5 };   // round 5: 0.5 with land at ~0.45 peak (was 0.45 over 0.29 land: dark land, white highlights)
//   // round 4 (round-3 #8): 0.6 still read as salt (grey-white dots on black) at the plain globe's mid zoom
export function setPalette(name) { Object.assign(palette, structuredClone(PALETTES[name]), structuredClone(ACCENTS), structuredClone(PALETTE_ACCENTS[name] || {})); hueMaxU.value = PAL_HUE_MAX[name] || HUE_MAX; }

// Pixels per world unit at distance 1: shared by every dot material, set by the globe on resize.
export const dotScale = { value: 1 };
export function updateDotScale(renderer, camera) {
  dotScale.value = renderer.domElement.clientHeight * renderer.getPixelRatio() / (2 * Math.tan(camera.fov * Math.PI / 360));
}

// Vertical exaggeration for displaced dots (see `displace` below): shared, set by the globe every frame.
// Land tone by height, shared by the base globe and the terrain tiles so ranges read the same at every zoom: the
// palette's relief tint (above), a little brighter as the ground rises. A depiction of height (labelled "heights ×N"),
// not imagery. The result is the PEAK colour of one land dot (its bright centre), the same at every zoom and in both
// the base globe and the tiles: what makes land read the same from whole globe to close in. Every land dot is drawn
// LAND_DOT_D × its own spacing wide (base globe and tiles alike), so the share of the screen the dots light, and with it
// the mean brightness, is the same at every zoom too (pow(1 − r, 2) falloff: ~23 % of the peak). LAND_K sets that peak:
// lowland olive ~0.6, hillshade and coasts lift it, and the shader clamps any dot to HUE_MAX keeping its hue, so no dot
// clips to cream or white. lat, lon (optional, degrees): the ice sheets are drawn as ice (see ICE_LAT), blended in by
// height on Greenland (no hard edge).
export const LAND_DOT_D = 1.45, HUE_MAX = 0.92;
export const hueMaxU = { value: HUE_MAX };
const LAND_K = 1.9;
const relief = (st, hh, out, k) => {
  let i = 0; while (i < st.length - 2 && hh > st[i + 1][0]) i++;
  const [h0, a] = st[i], [h1, b] = st[i + 1], w = Math.min(1, Math.max(0, (hh - h0) / (h1 - h0)));
  for (let q = 0; q < 3; q++) out[q] = (a[q] + (b[q] - a[q]) * w) * k;
  return out;
};
export function landTone(h, out = [0, 0, 0], lat = 0, lon = 0) {
  const hh = Math.min(Math.max(h, 0), 6000), t = Math.pow(hh / 6000, 0.7), k = LAND_K * (1 + 0.1 * t);
  relief(palette.relief, hh, out, k);
  // ice weight: all of Antarctica; Greenland's interior eased in over 600–1400 m (its ice-free margin is mostly lower)
  const wi = lat < ICE_LAT ? 1 : inGreenland(lat, lon) ? Math.min(1, Math.max(0, (h - GL_ICE_M + 400) / 800)) : 0;
  if (wi > 0) for (let q = 0; q < 3; q++) out[q] += (palette.ice[q] * LAND_K * (1 + 0.1 * t) - out[q]) * wi;
  return out;
}
// Ocean tone by depth d (metres, + down), shared by the base globe and the terrain tiles. 2026-11-23 (Benn: the North Sea
// read pale cyan and the Norwegian Trench was not readable): a shelf-tuned ramp like the 01-seafloor North Sea view
// (deepAt 120 m there). The old ramp ran 0-6000 m (square root) with a cyan glow under 40 m, so the shelf (50 m) and the
// trench (500 m) got nearly one tone and only a pale coastal fringe stood out. Now the tone steps down by depth band:
//   0 m      a medium blue a little toward the palette's shallow colour (no pale glow)
//   100 m    the palette's mid colour: the shelf seas (North Sea, Biscay shelf) are one calm blue
//   250 m    most of the way to deep: shelf break, Norwegian Trench edges, Skagerrak
//   700 m    the palette's deep colour: trench floor, continental slope
//   6000 m   a little darker: abyssal plain
// Multipliers keep the shelf below the land's brightness (land stays the brightest thing). shallow = false (the base
// globe, whole-globe zoom) pulls the shelf half-way toward the 250 m tone, so shelves do not read as fat coastlines from
// afar; the tiles (shallow = true, from ~5,000 km down) show the full shelf / trench contrast.
export const SHALLOW_M = 40;     // tiles: dot size and brightness ease over COAST_M only (terrain.js); kept for imports
const OCEAN_STOPS = [   // [depth m, weight toward shallow (s), toward deep (dd), brightness]
  [0, 0.22, 0, 0.29], [100, 0, 0, 0.235], [250, 0, 0.7, 0.29], [700, 0, 1, 0.40], [6000, 0, 1, 0.38]];
export function oceanTone(d, out = [0, 0, 0], shallow = false) {
  const p = palette, S = OCEAN_STOPS;
  d = Math.max(0, d);
  let i = 0; while (i < S.length - 2 && d > S[i + 1][0]) i++;
  const a = S[i], b = S[i + 1], t = Math.min(1, (d - a[0]) / (b[0] - a[0]));
  let s = a[1] + (b[1] - a[1]) * t, dd = a[2] + (b[2] - a[2]) * t, k = a[3] + (b[3] - a[3]) * t;
  if (!shallow && d < 250) { const f = 0.5 * (1 - d / 250); s *= 1 - f; dd += (0.7 - dd) * f; k += (0.29 - k) * f; }
  for (let q = 0; q < 3; q++) out[q] = (p.mid[q] + (p.shallow[q] - p.mid[q]) * s + (p.deep[q] - p.mid[q]) * dd) * k;
  return out;
}
export const dotExag = { value: 1 };
// The sea floor's own exaggeration (round 3, #5): the ETOPO1 sea floor (~1.85 km grid) lifted as much as the land drew the
// Nazaré canyon as glowing walls, the loudest thing close in. Set by globe.js each frame (less than dotExag; the readout says so).
export const seaExag = { value: 1 };
// Geomorph threshold for the terrain tiles (see `morph` below), in device pixels: a tile splits into its children when
// its dots are this far apart on screen. Shared, set by terrain.js every frame (TARGET_PX × refine × pixel ratio).
export const morphT = { value: 8 };

// Optional, used by the terrain tiles: displace: true reads a per-dot 'aElev' attribute (metres) and lifts each dot
// along the local vertical by aElev × dotExag / 6,371,000. Positions may be relative to a tile origin: pass that
// origin as `center` (world units) and set the Points object's position to it, so close zooms keep float precision.
// Also optional, for the terrain tiles: sizeAttr: true reads a per-dot 'aSize' multiplier of `size` (dots spaced unevenly
// within one geometry, e.g. web-mercator rows at high latitude); areaComp: true dims a dot that would be drawn below the
// 1.5 px minimum by its (true size / 1.5 px)², so a dense far-off patch keeps the same brightness per area as a near one.
// morph: { spacing, graze } (terrain tiles; needs displace, sizeAttr and vertexColors): geomorph to the next coarser level.
//   Per dot, from its spacing on screen px (spacing × aSize, seen at its distance, squashed by the grazing angle when
//   graze is true, like terrain.js's split test): m = 1 − smoothstep(0.5·T, T, px), T = morphT. The 3 non-keeper dots
//   of each 2 × 2 block fade by 1 − m; the keeper (aPar.w = 1) moves by aPar.xyz × m to the block centre, grows by
//   1 + m and blends to the block's mean colour (aParCol) and height (aParElev). At m = 1 a tile matches its parent.
export function makeDotMaterial({ size = 0.006, color = 0xffffff, vertexColors = false, opacity = 1, displace = false, center = null,
  sizeAttr = false, areaComp = false, morph = null, maxPx = 1e4, capComp = 0, dotK = false, grazeMin = 0, farK = 1, hueMax = 0, cover = null, coverIn = null } = {}) {
  const defines = {};
  if (cover) defines.COVER = 1;
  if (coverIn) defines.COVER_IN = 1;
  if (morph) defines.MORPH = 1;
  if (morph && morph.n) defines.MORPH_N = morph.n;   // b38: dots per tile side, for the edge ramp (uEdge)
  if (displace) defines.DISPLACE = 1;
  if (sizeAttr) defines.SIZE_ATTR = 1;
  if (areaComp) defines.AREA_COMP = 1;
  if (capComp > 1) defines.CAP_COMP = 1;
  if (dotK) defines.DOT_K = 1;
  if (grazeMin > 0) defines.GRAZE_FADE = 1;
  if (hueMax > 0) defines.HUE_CLAMP = 1;
  const c = Array.isArray(color) ? new THREE.Color(...color) : new THREE.Color(color);
  return new THREE.ShaderMaterial({
    uniforms: { uSize: { value: size }, uMaxPx: { value: maxPx }, uCapComp: { value: capComp }, uGrazeMin: { value: grazeMin }, uFarK: { value: farK }, uHueMax: hueMax === HUE_MAX ? hueMaxU : { value: hueMax }, uScale: dotScale, uColor: { value: c }, uOpacity: { value: opacity },
      uExag: dotExag, uSeaExag: seaExag, uCenter: { value: center ? center.clone() : new THREE.Vector3() },
      uMorphT: morphT, uSpacing: { value: morph ? morph.spacing : 0 }, uGraze: { value: morph && morph.graze ? 1 : 0 }, uEdge: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCover: { value: cover ? cover.texture : coverIn }, uCoverK: cover ? cover.k : { value: 0 } },
    defines,
    vertexColors, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */`
      uniform float uSize, uScale, uExag, uSeaExag, uMaxPx, uCapComp, uGrazeMin, uFarK, uHueMax; uniform vec3 uColor, uCenter;
      varying vec3 vColor; varying float vFade;
      #ifdef DISPLACE
        attribute float aElev;
      #endif
      #ifdef SIZE_ATTR
        attribute float aSize;
      #endif
      #ifdef DOT_K
        attribute float aDotK;
      #endif
      #if defined(COVER) || defined(COVER_IN)
        uniform sampler2D uCover; uniform float uCoverK;
        // Round 4 (round-3 #2): the drawn-tile map, read soft. Nine taps ~1.5 and ~3.5 texels (60-140 km) apart, then a
        // ramp. Returns (F, E): F the drawn-tile cover here (the tiles' summed fade), E an edge factor, 1 well inside the
        // drawn area and falling to 0 at its edge (the nine-tap mean over F, so a fade in time does not read as an edge).
        // The base globe is weighted 1 − F·E and each tile E × its own fade, so the two always sum to one: where loaded and
        // unloaded ground meet they cross-fade over ~100 km instead of meeting in a straight-edged block, and where drawn
        // tiles meet each other E stays 1 (no seam).
        // Round 5 (round-4 #2): a tap off screen or past the horizon counts as covered (takes the centre's value). Tiles out of
        // view are never drawn, so their cells read 0: close in, where the taps reach 60-140 km and the view is ~40 km wide,
        // every tap fell outside the view and the tiles faded toward black in broad straight-edged patches (the cover map's
        // 0.35° cells), the "dark blotches" and straight seams at Peniche. Now E only falls at a real edge of the loaded area.
        float coverTap(vec2 uv, float F) {
          float lo = (uv.x - 0.5) * 6.2831853, la = (uv.y - 0.5) * 3.1415927;
          vec3 q = vec3(cos(la) * cos(lo), sin(la), -cos(la) * sin(lo));
          vec4 cp = projectionMatrix * viewMatrix * vec4(q, 1.0);
          bool seen = cp.w > 0.0 && abs(cp.x) < cp.w * 1.02 && abs(cp.y) < cp.w * 1.02 && dot(q, cameraPosition - q) > 0.0;
          return seen ? texture2D(uCover, uv).r : F;
        }
        vec2 coverSoft(vec3 qn) {
          vec2 uv = vec2(atan(-qn.z, qn.x) / 6.2831853 + 0.5, asin(clamp(qn.y, -1.0, 1.0)) / 3.1415927 + 0.5);
          vec2 a = vec2(1.5 / 1024.0, 1.5 / 512.0), b = vec2(3.5 / 1024.0, 3.5 / 512.0);
          float F = texture2D(uCover, uv).r;
          if (F < 0.004) return vec2(F, 0.0);
          float c = F
            + coverTap(uv + vec2(a.x, 0.0), F) + coverTap(uv - vec2(a.x, 0.0), F)
            + coverTap(uv + vec2(0.0, a.y), F) + coverTap(uv - vec2(0.0, a.y), F)
            + coverTap(uv + vec2(b.x, 0.0), F) + coverTap(uv - vec2(b.x, 0.0), F)
            + coverTap(uv + vec2(0.0, b.y), F) + coverTap(uv - vec2(0.0, b.y), F);
          return vec2(F, smoothstep(0.55, 1.0, min(1.0, c / 9.0 / F)));
        }
      #endif
      #ifdef MORPH
        attribute vec4 aPar; attribute float aParElev; attribute vec3 aParCol;
        uniform float uMorphT, uSpacing, uGraze;
        uniform vec4 uEdge;   // b38: west, east, north, south edge borders a coarser drawn tile (1) or not (0); set by terrain.js
      #endif
      void main() {
        vec3 p = position;
        float sizeMul = 1.0, morphFade = 1.0;
        #ifdef DISPLACE
          float h = aElev;
        #endif
        #ifdef MORPH
          vec4 mv0 = modelViewMatrix * vec4(position, 1.0);
          float dist = length(mv0.xyz);
          vec3 nrm = normalize(position + uCenter);
          float g = uGraze > 0.5 ? sqrt(max(0.0625, abs(dot(normalize(-mv0.xyz), normalize(normalMatrix * nrm))))) : 1.0;
          float sPx = uSpacing * aSize * uScale / max(1e-9, dist) * g;
          float m = 1.0 - smoothstep(0.5 * uMorphT, uMorphT, sPx);
          #ifdef MORPH_N
            // b38 (Egmond seam): where the drawn detail steps down a level (a spot box edge, terrain.js nearCap) the finer tile's
            // dots stood at full grain against the coarser tile's: a straight ×2 step in dot size and spacing, worst close and
            // tilted over shallow sea (fine dots). Each dot now also morphs toward the parent level by its distance (in tile
            // widths) from an edge that borders a coarser tile: fully the parent's grain at that edge, its own one tile in.
            // The next ring in does the same against this one, so the grain changes smoothly dot by dot across the boundary.
            // The ramp ends one tile in or 40 × the split threshold on screen (~320 device px) in, whichever comes first: a near
            // tile is large on screen, and ramping all of it coarsened the foreground.
            float eu = (float(gl_VertexID % MORPH_N) + 0.5) / float(MORPH_N), ev = (float(gl_VertexID / MORPH_N) + 0.5) / float(MORPH_N);
            // 2026-11-23: 40 → 96 × T. TARGET_PX went 4 → 2.5 (terrain.js), which had shortened this ramp from ~160 to ~100
            // device px, and the EMODnet / spot box edges showed a step (measured: ~100 px wide at 60 km, ×2 dot size). Now
            // ~240 px at T = 2.5: the grain changes over about a fifth of the screen.
            float eK = max(1.0, float(MORPH_N) * sPx / (96.0 * uMorphT));   // tile widths per ramp length
            #define EDGE_R(d) (1.0 - smoothstep(0.0, 1.0, (d) * eK))
            float mE = max(max(uEdge.x * EDGE_R(eu), uEdge.y * EDGE_R(1.0 - eu)), max(uEdge.z * EDGE_R(ev), uEdge.w * EDGE_R(1.0 - ev)));
            m = max(m, mE);
          #endif
          float mk = m * aPar.w;
          p += aPar.xyz * mk;
          h = mix(aElev, aParElev, mk);
          sizeMul = 1.0 + mk;
          morphFade = aPar.w > 0.5 ? 1.0 : 1.0 - m;
        #endif
        float farW = 0.0;
        #if defined(MORPH) && defined(DISPLACE)
          // Round 5 (round-4 #3): distance haze for terrain tiles in low, tilted views. Far ground near and past the horizon
          // (Greenland and Iceland seen from Norway) was lifted ×7 and drawn at full brightness: a pale slab floating over the
          // horizon with a hard lower edge. From 0.6 to 1.05 × the distance to the horizon, a dot's relief eases back to true
          // scale and the dot fades out (90 %), like the base globe's horizon fade. Low views only (full under 0.12 radii, none above 0.3).
          float camH = max(1e-5, length(cameraPosition) - 1.0), dHz = sqrt(camH * (2.0 + camH));
          float d0 = length((modelViewMatrix * vec4(position, 1.0)).xyz);
          farW = smoothstep(0.6 * dHz, 1.05 * dHz, d0) * (1.0 - smoothstep(0.12, 0.3, camH));
        #endif
        #ifdef DISPLACE
          float ex = h < 0.0 ? uSeaExag : uExag;
          ex = mix(ex, 1.0, farW);
          p += normalize(position + uCenter) * (h * ex / 6371000.0);
        #endif
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float px = uSize * sizeMul * uScale / -mv.z;
        #ifdef SIZE_ATTR
          px *= aSize;
        #endif
        #ifdef DOT_K
          // drawn size only (the geomorph's spacing test reads aSize, not this). aDotK = 0 marks a land dot: it is drawn
          // uFarK × wider seen from afar (camera ≥ 0.1 radii away), easing to its own size by 0.02 radii (~130 km), so the
          // tiles read as the same surface as the base globe at the hand-over and as crisp dots close in.
          px *= aDotK > 0.5 ? aDotK : mix(1.0, uFarK, smoothstep(0.02, 0.1, -mv.z));
        #endif
        float pxC = clamp(px, 1.5, max(1.5, uMaxPx));
        gl_PointSize = pxC;   // uMaxPx (device px): a cap, so a coarse grid seen close stays dots, not discs
        vFade = morphFade * (1.0 - 0.9 * farW);
        #ifdef CAP_COMP
          // capped dots cover less of the screen than their size asks for; brighten them (up to uCapComp) so a dot
          // field that reads as a surface from afar does not thin into salt as you zoom in. Colour (hue) is unchanged.
          // alpha is clamped to 1 in blending, so past ×1.15 the rest goes into the colour (hue kept, values stay low)
          float capK = min(uCapComp, px * px / (pxC * pxC));
          vFade *= min(capK, 1.15);
          float capC = capK / min(capK, 1.15);
        #endif
        #ifdef AREA_COMP
          vFade *= min(1.0, px * px / 2.25);
        #endif
        #ifdef MORPH
          // grazing fade: a tilted surface packs ~1/cos(incidence) dots into each screen pixel, so with additive blending
          // the far ground toward the horizon summed to a solid white band. Dimming by cos(incidence) (floor 0.1) keeps
          // the brightness per screen area about what it is seen from above.
          float cIs = dot(normalize(-mv.xyz), normalize(normalMatrix * normalize(position + uCenter)));
          float cI = abs(cIs);
          float gFloor = 0.1;
          #ifdef DOT_K
            // deep-water dots are ~2.2× wider, so they overlap more toward the horizon: they fade further (bright blue
            // streaks of exaggerated sea floor summed at the horizon in low, tilted views). Round 3 (#6): from cos 0.6, squared,
            // no floor: the sea's horizon was a hard bright-cyan line in every follow view; now it fades out to the limb.
            if (aDotK > 2.0 && aDotK < 2.5) { gFloor = 0.0; float u = clamp(cI / 0.6, 0.0, 1.0); cI = 0.45 * u * u; }
            // sea dots past the sphere's horizon (seen from behind): the occluder sits under the sunken sea floor, so they
            // showed above the true horizon as a second, ghost limb. Dropped, like the base globe's far-side dots.
            if (cIs < 0.0 && aDotK > 1.62) vFade = 0.0;
          #endif
          vFade *= clamp(cI / 0.45, gFloor, 1.0);
        #endif
        #ifdef GRAZE_FADE
          // the same toward the limb for the base globe (its wide overlapping dots summed to a white ring); floor uGrazeMin
          // (round 2: ~0, so dots piling up edge-on at the limb sum to a bounded brightness: no yellow-white rim on land)
          // Dots on the far side of the globe are dropped: the occluder sphere sits under the sunken sea floor, so far-side
          // dots just past the limb (lifted land most of all) showed above it as a white-yellow rim / band at the horizon.
          float cS = dot(normalize(-mv.xyz), normalize(normalMatrix * normalize(position + uCenter)));
          float cG = abs(cS);
          float gU = clamp(cG / 0.6, 0.0, 1.0);
          #ifdef SIZE_ATTR
            if (aSize > 2.0) gU = gU * gU;   // round 3 (#6): sea dots (wide, overlapping) fade out to the limb: no bright sea rim when pitched
          #endif
          vFade *= cS < 0.0 ? 0.0 : mix(uGrazeMin, 1.0, gU);   // 0.6 (was 0.45, floor 0.15): dots pile up as 1/cos toward the limb; fading by cos from 0.6 with no floor caps the sum at ~1.6× in the last few px (was a 2×+ rim); 0.85 flattened it fully but dimmed pitched mid-zoom views by ~30 %
        #endif
        #ifdef COVER
          // the base globe under the terrain tiles (round 3): it steps aside only where a tile is drawn (uCover, a lat/lon
          // map of drawn tiles written by terrain.js), so an area whose tiles are still loading keeps the base globe, never black
          vec2 cv = coverSoft(normalize(position + uCenter));
          vFade *= 1.0 - uCoverK * cv.x * cv.y;
        #endif
        #ifdef COVER_IN
          vFade *= coverSoft(normalize(position + uCenter)).y;   // a tile at the edge of the drawn area fades into the base globe
        #endif
        gl_Position = projectionMatrix * mv;
        if (vFade < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
        vColor = uColor;
        #ifdef CAP_COMP
          vColor *= capC;
        #endif
        #ifdef USE_COLOR
          #ifdef MORPH
            vColor *= mix(color, aParCol, mk);
          #else
            vColor *= color;
          #endif
        #endif
        #ifdef HUE_CLAMP
          // no dot brighter than uHueMax in any channel, hue kept: a bright olive dot stays olive instead of clipping
          // to cream (capped mid-zoom dots, hillshaded coasts)
          float mc = max(vColor.r, max(vColor.g, vColor.b));
          if (mc > uHueMax) vColor *= uHueMax / mc;
        #endif
        #ifdef DOT_K
          if (aDotK < -0.5) morphFade = 0.0;   // aDotK = -1: a dot outside its tile's area (polar cap corners): not drawn
        #endif
        if (morphFade < 0.002) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);   // faded out: clip it, no fragment cost
      }`,
    fragmentShader: /* glsl */`
      uniform float uOpacity; varying vec3 vColor; varying float vFade;
      void main() {
        float r = length(gl_PointCoord - 0.5) * 2.0;
        if (r > 1.0) discard;
        gl_FragColor = vec4(vColor, pow(1.0 - r, 2.0) * 0.85 * uOpacity * vFade);
      }`,
  });
}
