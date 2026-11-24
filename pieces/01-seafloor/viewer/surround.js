// Surroundings of a reef patch: the coast and sea floor for a few km around the lidar, as dimmer, sparser dots,
// so the reef sits in its real setting instead of alone in the dark.
//
// Data: Oceany's terrain2 packs, the globe's own (pieces/07-globe/terrarium.js via terrain-source.js; b57, was the v1 PNG
// tiles): land from Copernicus DEM GLO-30 (a surface model, about 30 m); seabed from the survey overlay bathy2 where it exists
// (NOAA CUDEM ~10 m at Pipeline, EMODnet DTM 2024 ~115 m in European seas) and GEBCO_2026 (a ~463 m grid) elsewhere, so
// offshore depths away from surveys are coarse and only approximate. (AWS Terrain Tiles / ETOPO1 only with ?terrain_src=aws.)
// Honesty rules kept here:
// - one dot per 30 m height (a terrain2 zoom-13 dot = one old zoom-12 pixel, about 30 m here): no interpolation on land;
// - at sea one dot per ~120 m (one terrain2 zoom-11 dot = one old zoom-10 pixel), sparser still. terrain2 zoom 13 carries a
//   sea floor value almost everywhere, but unless it is a survey finer than the dots (CUDEM) it is the coarse grid resampled,
//   so the depth then comes from zoom 11 (EMODnet where bathy2 has it, else GEBCO), and from the zoom-13 value only where
//   that is a survey (CUDEM) or zoom 11 has no depth there. The caption names the seabed sources actually used;
// - nothing is drawn where the lidar has points (30 m occupancy cells), so the two never overlap;
// - brightness fades to nothing at RANGE_M from the patch, so there is no square edge.
// Built once per layer (static buffers); returns null on any failure (the viewer then simply draws no surround).
//
// PLUMBING: tile maths and the loops. WORTH READING: the constants and the honesty rules above.

const Z = 12;                  // tile zoom: one pixel ≈ 30 m at 39-44° N, ≈ 35 m at Oahu
const SEA_STRIDE = 4;          // sea: one dot per zoom-10 pixel = every 4th zoom-12 pixel each way (≈ 120 m apart)
const ZS = Z - 2;              // the zoom the sea depths come from where zoom 12 is void
const RANGE_M = 5000;          // drawn up to 5 km beyond the lidar box, fading out
const CELL_M = 30;             // lidar occupancy cell for the cut-out
const M_PER_DEG = 111195.0;    // same flat-earth scaling as the viewer (toLatLon) and 02-reefs/export_reefs.py
const EARTH_C = 40075016.7;    // equator length (m), web mercator

export async function buildSurround({ meta, pos, N }) {
  const o = meta && meta.origin; if (!o || !isFinite(o.lat) || !isFinite(o.lon)) return null;
  const { fetchTerrarium } = await import('../../07-globe/terrarium.js?v=2');
  const cosO = Math.cos(o.lat * Math.PI / 180);
  // lidar box (x east, z south, metres) and its occupancy grid
  let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
  for (let i = 0; i < N; i++) { const x = pos[3 * i], z = pos[3 * i + 2]; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (z < bz0) bz0 = z; if (z > bz1) bz1 = z; }
  const gw = Math.ceil((bx1 - bx0) / CELL_M) + 1, gh = Math.ceil((bz1 - bz0) / CELL_M) + 1, occ = new Uint8Array(gw * gh);
  for (let i = 0; i < N; i++) occ[Math.floor((pos[3 * i + 2] - bz0) / CELL_M) * gw + Math.floor((pos[3 * i] - bx0) / CELL_M)] = 1;
  const occupied = (x, z) => {
    const c = Math.floor((x - bx0) / CELL_M), r = Math.floor((z - bz0) / CELL_M);
    return c >= 0 && r >= 0 && c < gw && r < gh && occ[r * gw + c] === 1;
  };
  // tiles covering the box plus the range
  const n = 2 ** Z, P = 256 * n;                             // P: pixels around the world at this zoom
  const latOfZ = z => o.lat + (-z) / M_PER_DEG, lonOfX = x => o.lon + x / (M_PER_DEG * cosO);
  const gx = lon => (lon + 180) / 360 * P;
  const gy = lat => { const la = lat * Math.PI / 180; return (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * P; };
  const px0 = Math.floor(gx(lonOfX(bx0 - RANGE_M))), px1 = Math.ceil(gx(lonOfX(bx1 + RANGE_M)));
  const py0 = Math.floor(gy(latOfZ(bz0 - RANGE_M))), py1 = Math.ceil(gy(latOfZ(bz1 + RANGE_M)));   // z south: bz0 is the north edge
  const tiles = [];
  for (let ty = Math.floor(py0 / 256); ty <= Math.floor(py1 / 256); ty++)
    for (let tx = Math.floor(px0 / 256); tx <= Math.floor(px1 / 256); tx++) tiles.push([tx, ty]);
  if (tiles.length > 16) return null;                         // safety: never more than a 4 × 4 block
  const seaTiles = [...new Set(tiles.map(([tx, ty]) => (tx >> 2) + ',' + (ty >> 2)))].map(k => k.split(',').map(Number));
  const [got, gotSea] = await Promise.all([tiles, seaTiles].map(list => Promise.allSettled(list.map(([tx, ty]) => fetchTerrarium(list === tiles ? Z : ZS, tx, ty)))));
  if (!got.some(g => g.status === 'fulfilled')) return null;
  const sources = new Set(), seaElev = new Map(), seaBed = new Map(), beds = new Map();
  gotSea.forEach((g, k) => { if (g.status === 'fulfilled') { const key = seaTiles[k].join(','); seaElev.set(key, g.value.elev); seaBed.set(key, g.value.seabed); g.value.sources.forEach(x => sources.add(x)); } });
  const seaAt = (X, Y) => {                                   // coarse (~120 m) value under fine pixel (X, Y), or 0 if not loaded
    const e = seaElev.get((X >> 10) + ',' + (Y >> 10)), v = e ? e[((Y >> 2) & 255) * 256 + ((X >> 2) & 255)] : 0; return isFinite(v) ? v : 0;
  };
  const seaBedAt = (X, Y) => { const b = seaBed.get((X >> 10) + ',' + (Y >> 10)); return b ? b[((X >> 9) & 1) + 2 * ((Y >> 9) & 1)] : null; };
  const SURVEY_M = 30;                                        // a seabed source this fine (or finer) is used at the fine level
  const outPos = [], outElev = [], outFade = [], outSize = [];
  const pxM = EARTH_C / P * cosO;                             // metres per pixel here (east-west and north-south alike in mercator)
  let seaFine = 0, seaCoarse = 0;
  got.forEach((g, k) => {
    if (g.status !== 'fulfilled') return;
    g.value.sources.forEach(x => sources.add(x));
    const [tx, ty] = tiles[k], e = g.value.elev, fb = g.value.seabed;
    for (let j = 0; j < 256; j++) {
      const Y = ty * 256 + j; if (Y < py0 || Y > py1) continue;
      for (let i = 0; i < 256; i++) {
        const X = tx * 256 + i; if (X < px0 || X > px1) continue;
        let h = e[j * 256 + i], cx = X + 0.5, cy = Y + 0.5, bed = null;
        if (!isFinite(h)) continue;                           // quadrant without a tile
        const sea = h <= 0;
        if (sea) {                                            // sea: one dot per coarse (~120 m) cell, at its centre
          if ((X & 3) !== 2 || (Y & 3) !== 2) continue;
          cx = X; cy = Y;
          const fineBed = fb && fb[(i >> 7) + 2 * (j >> 7)], c = seaAt(X, Y);
          if (h < 0 && fineBed && fineBed.m <= SURVEY_M) { bed = fineBed; seaFine++; }   // survey finer than the dots (CUDEM)
          else if (c < 0) { h = c; bed = seaBedAt(X, Y); seaCoarse++; }
          else if (h < 0) { bed = fineBed; seaFine++; }
          else continue;
        }
        const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * cy / P))) * 180 / Math.PI, z = -(lat - o.lat) * M_PER_DEG;
        const x = (cx / P * 360 - 180 - o.lon) * M_PER_DEG * cosO;
        const dx = Math.max(bx0 - x, 0, x - bx1), dz = Math.max(bz0 - z, 0, z - bz1), d = Math.hypot(dx, dz);
        if (d > RANGE_M || occupied(x, z)) continue;
        const f = 1 - d / RANGE_M;
        if (bed) beds.set(bed.name, bed);
        outPos.push(x, 0, z); outElev.push(h); outFade.push(f * f); outSize.push(sea ? 0.45 * SEA_STRIDE * pxM : 0.9 * pxM);
      }
    }
  });
  if (!outElev.length) return null;
  return { pos: Float32Array.from(outPos), elev: Float32Array.from(outElev), fade: Float32Array.from(outFade), size: Float32Array.from(outSize),
    count: outElev.length, landM: pxM, seaM: pxM * SEA_STRIDE, sources: [...sources], seabeds: [...beds.values()].sort((a, b) => a.m - b.m), box: [bx0, bx1, bz0, bz1], tiles: tiles.length + seaTiles.length, seaFine, seaCoarse,
    failed: got.filter(g => g.status !== 'fulfilled').length };
}
