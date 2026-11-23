// Snow-on-the-ground layer for the Oceany globe, all dots. Data: NOAA / US National Ice Center IMS daily snow and ice
// analysis, 24 km, Northern Hemisphere (NSIDC G02156), pre-built into data/ by build_snow.py (see SOURCES.md).
//
//   const layer = await createLayer({ THREE, radius: 1, makeDotMaterial, palette });
//   scene.add(layer);  layer.update(t) every frame (only loads the snapshot the first time it is visible)
//   layer.label / .details / .status, layer.setDim(k), layer.setPalette(name, palette)
//
// One dot per 24 km grid cell that IMS marks as snow-covered land (white-blue) or sea/lake ice (paler blue, labelled).
// Dot size = the cell's true ground size at its latitude (the polar map's cells shrink toward the south), so the dots
// form a carpet no finer than the analysis. Northern Hemisphere only: IMS does not cover the south (no snow drawn there
// is "no data", not "no snow"). IMS reports cover only, never falling snow, so no falling snow is drawn.
// Heights: IMS has none; each dot is lifted to the base globe's land height under it (ETOPO1, same exaggeration as the land dots).
// Static: nothing moves, so update() does no work after loading.

const META_URL = new URL('./data/snow_ims24.json', import.meta.url);
const BIN_URL = new URL('./data/snow_ims24.bin', import.meta.url);
// the base globe's own dot file (read only): its ETOPO1 heights, so snow sits on the same lifted, exaggerated land surface
const EARTH_META_URL = new URL('../07-globe/assets/earth_dots.json', import.meta.url);
const EARTH_BIN_URL = new URL('../07-globe/assets/earth_dots.bin', import.meta.url);
const LIFT_R = 0.0002;          // a fixed ~1.3 km above the drawn land (not exaggerated), so snow stays on top of the land dots
const CELL_KM = 24, EARTH_KM = 6371, D2R = Math.PI / 180;
const STALE_DAYS = 3;           // analysis older than this: say "stale, re-run build_snow.py"
// Snow lies on the relief instead of hiding it: see-through (SNOW_OPACITY) and hillshaded per dot from the base globe's
// heights (same light as the globe: north-west, 45 deg up; slopes exaggerated SHADE_ZF x like the globe's hillshade),
// so ranges under snow (Alps, Tibet, Rockies, Scandinavia) keep their light and shadow sides and the land tint shows
// between the discs. Was 0.95 opaque white over the whole globe, which read as "the Earth is snow".
// 2026-11-23 (snow visibility): was 0.55 / 0.5 / shade 0.45-1.25, which with 2 px soft-rimmed discs at whole globe added only
// ~+28 grey levels over the land: snow read as pale land, the thing the land fix removed. Now near-opaque, shade range narrowed
// so shadow sides stay white-grey (still lighter than any land dot), not land-grey; relief still shows as light and shadow.
// b40 (Benn: b39 "a bit too harsh", a white sheet over seas and continents): middle ground. Opacity is set apart for far out
// (whole globe: *_FAR_OPACITY) and Europe zoom (*_OPACITY), close-in carpet unchanged; sea ice clearly more see-through than
// land snow so the sea under it shows; hillshade range widened back so relief reads under the snow.
const SNOW_OPACITY = 0.85, SNOW_FAR_OPACITY = 0.8, ICE_OPACITY = 0.55, ICE_FAR_OPACITY = 0.45;
const SHADE_ZF = 12, SHADE_MIN = 0.45, SHADE_MAX = 1.2;
// far out (camera beyond ~1.6 radii from the centre) a 24 km cell is only ~2-3 device px, so the 0.7-of-a-cell discs fell to the
// 1.5 px floor with a soft rim and barely covered: the discs grow to FAR_FILL of a cell there (cells just touch, a carpet that
// still stops at the cell edge) with a MIN_PX floor (CSS px) and a hard rim when small.
const FAR_FILL = 0.85, MIN_PX = 1.0;   // b40: was 0.95 / 1.4 (dots touched: no gaps); now gaps show the land between
// Close up (terrain tiles on, camera below CLOSE_ALT_R): inside a zone around the point under the camera, each 24 km snow cell
// is drawn as a carpet of small dots on a grid inside the cell, each lifted to the terrain tiles' own height there and
// hillshaded from them, so the snow lies on the relief the tiles show. The snow's edge is still the 24 km cell edge: the
// analysis does not say which slopes inside a cell hold snow, so the whole cell is covered evenly. Outside the zone the
// 24 km discs stay. The zone is rebuilt (CPU, from terrain.elevationAt) when the camera moves or new tiles arrive.
const CLOSE_ALT_R = 0.08;       // camera height (globe radii, ~510 km) below which the close zone is used
const CLOSE_DOTS = 90000;       // dot budget for the zone (sets the dot spacing)
const CLOSE_OPACITY = 0.9, CLOSE_LIFT_R = 0.00002;   // ~130 m above the tiles' dots
const CLOSE_REBUILD_MS = 900;   // at most this often
const CLOSE_FILL = 0.65;        // close dot diameter as a share of their spacing: separate dots, the tiles' relief shows between
const DOT_FILL = 0.7;           // dot diameter as a share of the cell: crisp discs that stay inside their cell (no wash over the sea), land showing between

const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
const WHITE = [1, 1, 1];
// snow: clean white with a slight tint; sea ice: its own tint per palette, apart from both the snow and that palette's sea
const SNOW_COLOURS = { Ocean: [0.94, 0.97, 1.0], Ember: [1.0, 0.98, 0.95], Mono: [1.0, 1.0, 1.0] };
const ICE_COLOURS = { Ocean: [0.55, 0.75, 1.0], Ember: [0.72, 0.76, 1.0], Mono: [0.62, 0.74, 0.9] };

// Snow dots are drawn as crisp discs with normal (not additive) blending, so snow reads as white lying on the land, not as
// a glow added over it. Same size rule and lift-by-height as the globe's makeDotMaterial (shared uScale and uExag uniforms).
const VERT = /* glsl */`
  uniform float uSize, uScale, uExag, uMaxPx, uMinPx, uFarFill, uFarOp, uLift, uShrink; uniform vec4 uZone; uniform vec2 uZoneK;
  attribute float aSize; attribute float aElev; attribute float aShade; varying float vNear, vShade, vPx;
  void main() {
    vec3 p = position + normalize(position) * (aElev * uExag / 6371000.0 + uLift);
    // close-up hand-over (terrain on, camera low): uZone.xyz = the ground point under the camera, uZone.w = the close zone's
    // angular radius. uZoneK.x = 1 for the 24 km discs (they fade out inside the zone), uZoneK.y = 1 for the close dots
    // (they fade out at its edge). uZone.w = 0: no close zone, discs everywhere.
    float zoneA = acos(clamp(dot(normalize(position), uZone.xyz), -1.0, 1.0));
    float inZ = uZone.w > 0.0 ? 1.0 - smoothstep(0.7 * uZone.w, 0.95 * uZone.w, zoneA) : 0.0;
    float zoneK = uZoneK.x * (1.0 - inZ) + uZoneK.y * inZ;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // close up (camera within ~0.3 radii) the discs shrink to ~0.55 of the cell and go a little see-through, so the
    // hillshaded land shows between them; far out they fill 0.7 of the cell, see-through and hillshaded (land shows between and under)
    float near = uShrink * (1.0 - smoothstep(0.12, 0.45, -mv.z));
    // graze fade, the same rule as the base globe's land dots (dots.js GRAZE_FADE, no floor): discs seen edge-on toward
    // the limb fade by cos(incidence)/0.6 and far-side discs are dropped, so overlapping snow no longer sums to an opaque
    // white band along the horizon when pitched
    float cS = dot(normalize(-mv.xyz), normalize(normalMatrix * normalize(position)));
    float graze = cS < 0.0 ? 0.0 : clamp(cS / 0.6, 0.0, 1.0);
    vNear = (1.0 - 0.2 * near) * graze * zoneK;
    vShade = aShade;
    float far = smoothstep(1.4, 2.6, -mv.z);                  // 0 at Europe zoom, 1 at whole globe
    float sz = mix(uSize, uSize * uFarFill, far);
    gl_PointSize = clamp(sz * aSize * (1.0 - 0.3 * near) * uScale / -mv.z, uMinPx, uMaxPx);
    vPx = gl_PointSize;
    vNear *= mix(1.0, uFarOp, far);                          // far-out opacity share (uFarOp = far / near opacity)
    gl_Position = projectionMatrix * mv;
  }`;
const FRAG = /* glsl */`
  uniform vec3 uColor; uniform float uOpacity; varying float vNear, vShade, vPx;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    if (r > 1.0) discard;
    float edge = mix(0.92, 0.55, smoothstep(3.0, 8.0, vPx));   // soft rim on big discs; a hard one on small (else a 2 px disc is mostly rim)
    gl_FragColor = vec4(uColor * vShade, uOpacity * vNear * (1.0 - smoothstep(edge, 1.0, r)));
  }`;

export async function createLayer({ THREE, radius = 1, makeDotMaterial, palette }) {
  const group = new THREE.Group();
  group.name = 'snow';
  let uScale = { value: 450 }, uExag = { value: 1 };   // borrowed from the globe's shared dot uniforms (dot scale, mountain exaggeration)
  if (makeDotMaterial) { const probe = makeDotMaterial({ size: 0.001 }); if (probe.uniforms?.uScale) uScale = probe.uniforms.uScale; if (probe.uniforms?.uExag) uExag = probe.uniforms.uExag; probe.dispose?.(); }
  const zone = { value: new THREE.Vector4(0, 1, 0, 0) };   // shared by all three materials
  const mkMat = (opacity, close = false) => new THREE.ShaderMaterial({
    uniforms: { uSize: { value: close ? 1 : DOT_FILL * CELL_KM / EARTH_KM }, uScale, uExag,
      uMaxPx: { value: (close ? 48 : 12) * (globalThis.devicePixelRatio || 1) }, uMinPx: { value: (close ? 1.5 : MIN_PX * (globalThis.devicePixelRatio || 1)) }, uFarFill: { value: close ? 1 : FAR_FILL / DOT_FILL }, uFarOp: { value: 1 }, uLift: { value: close ? CLOSE_LIFT_R : LIFT_R },
      uShrink: { value: close ? 0 : 1 }, uZone: zone, uZoneK: { value: new THREE.Vector2(close ? 0 : 1, close ? 1 : 0) },
      uColor: { value: new THREE.Color() }, uOpacity: { value: opacity } },
    vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.NormalBlending,
  });
  const snowMat = mkMat(SNOW_OPACITY), iceMat = mkMat(ICE_OPACITY), closeMat = mkMat(CLOSE_OPACITY, true);
  snowMat.uniforms.uFarOp.value = SNOW_FAR_OPACITY / SNOW_OPACITY; iceMat.uniforms.uFarOp.value = ICE_FAR_OPACITY / ICE_OPACITY;
  iceMat.uniforms.uZoneK = { value: new THREE.Vector2(1, 1) };   // sea ice lies flat at sea level: it keeps its discs close up
  const close = new THREE.Points(new THREE.BufferGeometry(), closeMat); close.frustumCulled = false; close.visible = false;
  closeMat.uniforms.uColor = snowMat.uniforms.uColor;   // same snow colour per palette
  const snow = new THREE.Points(new THREE.BufferGeometry(), snowMat), ice = new THREE.Points(new THREE.BufferGeometry(), iceMat);
  snow.frustumCulled = ice.frustumCulled = false;
  group.add(ice, snow, close);

  const setPalette = (name, pal) => {
    const p = pal || palette || { shallow: [0.35, 1, 0.95], mid: [0.1, 0.5, 0.95] };
    snowMat.uniforms.uColor.value.setRGB(...(SNOW_COLOURS[name] || mix(WHITE, p.shallow, 0.08)));
    iceMat.uniforms.uColor.value.setRGB(...(ICE_COLOURS[name] || mix(WHITE, p.mid, 0.55)));
  };
  setPalette('Ocean', palette);
  let dimK = 1;
  const setDim = (k) => {
    dimK = Math.max(0, Math.min(1, k));
    snowMat.uniforms.uOpacity.value = SNOW_OPACITY * dimK; iceMat.uniforms.uOpacity.value = ICE_OPACITY * dimK;
    closeMat.uniforms.uOpacity.value = CLOSE_OPACITY * dimK;
  };

  // height lookup in the base globe's dot rings: [lat, count] per ring, dots evenly spaced in longitude from -180
  // (the globe nudges each dot a little; the nearest ring and slot is the dot under this point). Land only (sea = 0).
  async function loadHeights() {
    const [em, eb] = await Promise.all([fetch(EARTH_META_URL).then((r) => r.json()), fetch(EARTH_BIN_URL).then((r) => r.arrayBuffer())]);
    const elev = new Int16Array(eb, 0, em.count), rings = em.rings, start = new Int32Array(rings.length);
    for (let i = 1; i < rings.length; i++) start[i] = start[i - 1] + rings[i - 1][1];
    const lat0 = rings[0][0], dLat = rings[1][0] - rings[0][0];
    return (latDeg, lonDeg) => {
      const i = Math.max(0, Math.min(rings.length - 1, Math.round((latDeg - lat0) / dLat))), n = rings[i][1];
      const j = Math.max(0, Math.min(n - 1, Math.floor(((lonDeg + 180) / 360) * n)));
      return Math.max(0, elev[start[i] + j]);
    };
  }

  // hillshade at a point from the base globe's heights 0.37 deg (one base dot) either side: 1 on flat ground (and sea ice)
  function shadeAt(heightAt, laD, loD) {
    const d = 0.37, cl = Math.max(0.05, Math.cos(laD * D2R)), m = d * D2R * EARTH_KM * 1000;
    const dzdx = (heightAt(laD, Math.min(180, loD + d / cl)) - heightAt(laD, Math.max(-180, loD - d / cl))) / (2 * m);
    const dzdy = (heightAt(Math.min(90, laD + d), loD) - heightAt(Math.max(-90, laD - d), loD)) / (2 * m);
    const nx = -SHADE_ZF * dzdx, ny = -SHADE_ZF * dzdy, len = Math.hypot(nx, ny, 1), lx = -0.5, ly = 0.5, lz = Math.SQRT1_2;
    return Math.min(SHADE_MAX, Math.max(SHADE_MIN, Math.max(0, (nx * lx + ny * ly + lz) / len) / lz));
  }

  let cells = [];                 // snow cell centres, lat, lon (degrees), for the close zone
  function build(meta, buf, heightAt) {
    cells = [];
    const M = meta.count;
    if (!(M > 0) || buf.byteLength !== M * 5) throw new Error('snapshot size does not match its metadata');
    const lat = new Int16Array(buf, 0, M), lon = new Int16Array(buf, 2 * M, M), code = new Uint8Array(buf, 4 * M, M);
    const sinTs = Math.sin(60 * D2R), parts = { 3: { pos: [], size: [], elev: [], shade: [] }, 4: { pos: [], size: [], elev: [], shade: [] } };
    const R = radius;
    for (let i = 0; i < M; i++) {
      const part = parts[code[i]]; if (!part) continue;
      const la0 = lat[i] / 100 * D2R, k = (1 + Math.sin(la0)) / (1 + sinTs);   // ground size of a polar-stereographic cell true at 60 N
      // a fixed random nudge of up to 0.3 cell, so the snow grid does not beat against the base globe's dots (moire);
      // the dot stays inside its own cell, so no finer detail than the 24 km grid is implied
      const h = Math.sin(i * 12.9898) * 43758.5453, j1 = h - Math.floor(h) - 0.5, j2 = (h * 7.31) - Math.floor(h * 7.31) - 0.5;
      const step = 0.6 * k * CELL_KM / EARTH_KM;          // radians: 0.6 x cell, so the nudge is within +-0.3 cell
      const la = la0 + j1 * step, lo = lon[i] / 100 * D2R + j2 * step / Math.max(0.05, Math.cos(la0));
      part.pos.push(R * Math.cos(la) * Math.cos(lo), R * Math.sin(la), -R * Math.cos(la) * Math.sin(lo));
      if (code[i] === 4) cells.push(lat[i] / 100, lon[i] / 100);
      part.size.push(k);
      const laD = la / D2R, loD = ((lo / D2R + 540) % 360) - 180;
      part.elev.push(heightAt ? heightAt(laD, loD) : 0);
      part.shade.push(heightAt ? shadeAt(heightAt, laD, loD) : 1);
    }
    for (const [obj, p] of [[ice, parts[3]], [snow, parts[4]]]) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
      g.setAttribute('aSize', new THREE.Float32BufferAttribute(p.size, 1));
      g.setAttribute('aElev', new THREE.Float32BufferAttribute(p.elev, 1));
      g.setAttribute('aShade', new THREE.Float32BufferAttribute(p.shade, 1));
      obj.geometry.dispose(); obj.geometry = g;
    }
    cells = Float32Array.from(cells);
    return { snow: parts[4].pos.length / 3, ice: parts[3].pos.length / 3 };
  }

  // ---- close zone. Polar stereographic on a sphere (true scale 60 N, central meridian 80 W, as the IMS grid): each
  // cell's dots sit on an n x n grid in the cell's own projected square, so neighbouring cells join without gaps or overlap.
  const PS_K = 2 * EARTH_KM * (1 + Math.sin(60 * D2R)) / 2, PS_L0 = -80 * D2R;
  const psFwd = (la, lo) => { const r = PS_K * Math.tan(Math.PI / 4 - la / 2); return [r * Math.sin(lo - PS_L0), -r * Math.cos(lo - PS_L0)]; };
  const psInv = (x, y) => [Math.PI / 2 - 2 * Math.atan(Math.hypot(x, y) / PS_K), PS_L0 + Math.atan2(x, -y)];
  let zoneBuilt = null, zoneT = 0, zoneMix = 0;
  function buildClose(terrain, gLa, gLo, hKm) {
    const exag = Math.max(1, uExag.value);
    const Rn = Math.min(600, Math.max(60, 3 * hKm));                   // zone radius on the ground, km (keep in step with closeFrame)
    const cA = Math.cos(Rn / EARTH_KM), g = [Math.cos(gLa) * Math.cos(gLo), Math.sin(gLa), -Math.cos(gLa) * Math.sin(gLo)];
    const pick = [];
    for (let i = 0; i < cells.length; i += 2) {
      const la = cells[i] * D2R, lo = cells[i + 1] * D2R;
      if (Math.cos(la) * Math.cos(lo) * g[0] + Math.sin(la) * g[1] - Math.cos(la) * Math.sin(lo) * g[2] > cA - 0.0001) pick.push(i);
    }
    const area = Math.PI * Rn * Rn, sp = Math.max(0.25, Math.sqrt(area / CLOSE_DOTS));   // km between dots
    const pos = [], size = [], elev = [], shade = [];
    const L = [-0.5, 0.5, Math.SQRT1_2];
    let miss = 0;
    for (const i of pick) {
      const la0 = cells[i] * D2R, lo0 = cells[i + 1] * D2R, k = (1 + Math.sin(la0)) / (1 + Math.sin(60 * D2R));
      const n = Math.max(2, Math.min(40, Math.round(CELL_KM / (sp * k)))), [xc, yc] = psFwd(la0, lo0), st = CELL_KM / n;
      const H = new Float32Array(n * n), LA = new Float32Array(n * n), LO = new Float32Array(n * n);
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        // a fixed random nudge of up to 0.35 of the spacing (no visible rows); the dot stays inside its own cell
        const hh = Math.sin((i * 4096 + a * 64 + b) * 12.9898) * 43758.5453, j1 = hh - Math.floor(hh) - 0.5, j2 = hh * 7.31 - Math.floor(hh * 7.31) - 0.5;
        const [la, lo] = psInv(xc + (a + 0.5 + 0.7 * j1) * st - CELL_KM / 2, yc + (b + 0.5 + 0.7 * j2) * st - CELL_KM / 2);
        const laD = la / D2R, loD = ((lo / D2R + 540) % 360) - 180;
        let h = terrain.elevationAt(laD, loD);
        if (h == null) { miss++; h = heightAtFn ? heightAtFn(laD, loD) : 0; }
        H[a * n + b] = Math.max(0, h); LA[a * n + b] = la; LO[a * n + b] = lo;
      }
      const cl = Math.cos(la0), m = EARTH_KM * 1000;
      const P = (a, b) => { const j = a * n + b; return [(LO[j] - lo0) * cl * m, (LA[j] - la0) * m, H[j] * exag]; };
      for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
        const j = a * n + b, la = LA[j], lo = LO[j];
        const p1 = P(Math.min(n - 1, a + 1), b), p0 = P(Math.max(0, a - 1), b), q1 = P(a, Math.min(n - 1, b + 1)), q0 = P(a, Math.max(0, b - 1));
        const u = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], v = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]];
        let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0];
        if (nz < 0) { nx = -nx; ny = -ny; nz = -nz; }
        const ln = Math.hypot(nx, ny, nz) || 1;
        shade.push(Math.min(SHADE_MAX, Math.max(SHADE_MIN, Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / ln) / L[2])));
        pos.push(radius * Math.cos(la) * Math.cos(lo), radius * Math.sin(la), -radius * Math.cos(la) * Math.sin(lo));
        size.push(CLOSE_FILL * st * k / EARTH_KM * radius); elev.push(H[j]);
      }
    }
    const gm = new THREE.BufferGeometry();
    gm.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    gm.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    gm.setAttribute('aElev', new THREE.Float32BufferAttribute(elev, 1));
    gm.setAttribute('aShade', new THREE.Float32BufferAttribute(shade, 1));
    close.geometry.dispose(); close.geometry = gm;
    zone.value.set(g[0], g[1], g[2], Rn / EARTH_KM);
    return { g, Rn, exag, cells: pick.length, dots: pos.length / 3, miss, tilesOk: terrain.health && terrain.health.ok };
  }
  let heightAtFn = null;
  function closeFrame(camera) {
    const terrain = globalThis.__globe && globalThis.__globe.terrain;   // read only: the globe's own tile heights
    const cp = camera && camera.position, r = cp ? cp.length() : 0;
    const want = state === 'ok' && !!terrain && terrain.enabled && typeof terrain.elevationAt === 'function' && r > 0 && r - radius < CLOSE_ALT_R * radius;
    zoneMix += ((want ? 1 : 0) - zoneMix) * 0.15;                       // ease the hand-over (about half a second)
    if (want) {
      const now = performance.now(), hKm = (r - radius) / radius * EARTH_KM;
      const gLa = Math.asin(cp.y / r), gLo = Math.atan2(-cp.z, cp.x);
      const z = zoneBuilt, moved = z ? Math.acos(Math.min(1, Math.cos(gLa) * Math.cos(gLo) * z.g[0] + Math.sin(gLa) * z.g[1] - Math.cos(gLa) * Math.sin(gLo) * z.g[2])) * EARTH_KM : 1e9;
      const stale = !z || moved > 0.2 * z.Rn || Math.abs(Math.min(600, Math.max(60, 3 * hKm)) - z.Rn) > 0.3 * z.Rn
        || (terrain.health && terrain.health.ok !== z.tilesOk) || Math.abs(uExag.value - z.exag) > 0.1 * z.exag;
      if (stale && now - zoneT > CLOSE_REBUILD_MS) { zoneT = now; zoneBuilt = buildClose(terrain, gLa, gLo, hKm); zoneBuilt.ms = performance.now() - now; zoneT = performance.now(); }
    }
    const on = zoneBuilt && zoneMix > 0.01;
    close.visible = !!on;
    if (!on) zone.value.w = 0;
    else if (zoneBuilt) zone.value.w = zoneBuilt.Rn / EARTH_KM;
    snowMat.uniforms.uZoneK.value.set(1, 1 - zoneMix);                  // discs: 1 outside, fading inside as the dots come in
    closeMat.uniforms.uZoneK.value.set(0, zoneMix);
  }

  let state = 'waiting', meta = null, counts = null, err = '', heightsOk = false;
  async function load() {
    state = 'loading'; text();
    try {
      const [m, buf, heightAt] = await Promise.all([
        fetch(META_URL, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error('metadata HTTP ' + r.status); return r.json(); }),
        fetch(BIN_URL, { cache: 'no-cache' }).then((r) => { if (!r.ok) throw new Error('data HTTP ' + r.status); return r.arrayBuffer(); }),
        loadHeights().catch(() => null),
      ]);
      heightsOk = !!heightAt; heightAtFn = heightAt;
      counts = build(m, buf, heightAt); meta = m; state = 'ok';
    } catch (e) { err = (e && e.message) || 'network error'; state = 'failed'; group.children.forEach((c) => { c.visible = false; }); }
    text();
  }

  const fmtDate = (s) => { const d = new Date(s.slice(0, 10) + 'T00:00:00Z'); return d.getUTCDate() + ' ' + d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }) + ' ' + d.getUTCFullYear(); };
  function text() {
    group.label = meta ? `Snow and sea ice: IMS analysis for ${fmtDate(meta.valid)}, 24 km, north only` : 'Snow and sea ice: IMS daily analysis (24 km)';
    group.details =
      `Snow on the ground and sea ice from the daily IMS analysis (NOAA / US National Ice Center, NSIDC G02156 v1). Analysts combine ` +
      `satellite images, microwave data and station reports into one map a day. One dot per 24 km cell: white-blue = snow-covered land, ` +
      `paler blue = sea or lake ice (from the same product). Each dot is drawn at its cell's true ground size (slightly under, so dots do not merge), never finer; each dot is nudged at random within its own cell to avoid moire against the base globe's dots. ` +
      `Northern Hemisphere only: nothing is drawn in the south because IMS does not map it, not because there is no snow. ` +
      `Cover only: IMS does not report falling snow or snow depth, so neither is shown. Dots sit on the base globe's land surface, lifted by the same ETOPO1 heights and the same exaggeration as the land dots ` +
      `(read from the globe's own dot file; ${heightsOk ? 'loaded' : 'not loaded, so snow is drawn flat'}); close up with the terrain tiles on, each 24 km snow cell near the camera becomes a carpet of small dots lying on the tiles' own heights and hillshaded from them; the whole cell is covered evenly (the analysis does not say which slopes inside a cell hold snow), so the snow's edge is still the 24 km cell edge. ` +
      `A snapshot built by build_snow.py` + (meta ? ` (file ${meta.source.split('/').pop()}, data day ${meta.dataDayOfYear}, built ${meta.built}).` : '.');
    let st = '';
    if (state === 'waiting' || state === 'loading') st = 'Loading the snow snapshot…';
    else if (state === 'failed') st = `Snow snapshot not available (${err}); nothing drawn. Run pieces/10-sky/build_snow.py.`;
    else {
      const ageDays = (Date.now() - new Date(meta.valid.slice(0, 10) + 'T00:00:00Z').getTime()) / 864e5;
      st = `Snapshot: ${counts.snow.toLocaleString('en-GB')} snow cells, ${counts.ice.toLocaleString('en-GB')} sea-ice cells.` +
        (ageDays > STALE_DAYS ? ` Stale: the analysis is ${Math.floor(ageDays)} days old; re-run build_snow.py.` : '');
    }
    group.status = st;
    group.userData.onChange?.(group);
  }

  // load on first show only; per frame only the close-zone check (a rebuild at most every CLOSE_REBUILD_MS)
  group.update = (t, camera) => { if (!group.visible) return; if (state === 'waiting') load(); else if (state === 'ok') closeFrame(camera); };
  group.setDim = setDim;
  group.setPalette = setPalette;
  group.userData = { snow, ice, get meta() { return meta; }, get counts() { return counts; }, get state() { return state; }, load, close, get zone() { return zoneBuilt; } };
  text();
  return group;
}
