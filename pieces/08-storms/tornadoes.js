// US tornado history layer for the Oceany globe, as dots (THREE.Points only).
// Data: NOAA/NWS SPC tornado database 1950-2025, see SOURCES.md.
//
//   const layer = await createLayer({ THREE, radius: 1, makeDotMaterial, palette });
//   scene.add(layer);
//   layer.update()             // follows the globe's palette (recolours only when it changes)
//   layer.label                // what the dots are
//   layer.setDim(k)            // 0..1 brightness multiplier on opacity and dot size (1 = normal); the globe dims this while a live layer is on
//   layer.setShowPaths(bool)   // the 73k path dots; default false, so only the density relief shows
//   layer.userData.tracks      // Points: dots along each path (even spacing), coloured by F/EF rating (palette: mid = weak, shallow = strong)
//   layer.userData.density     // Points: one dot per 0.25 degree cell with a tornado path (1991-2024), lifted by log frequency
//
// Tornadoes with no recorded end point (SPC stores 0.0) are one dot at the start, not an invented path.
// Cells with no tornado have no dot: nothing is implied outside the data. Reporting is biased towards recent
// decades and towards weak tornadoes, so the density is a map of reports.
// Per-dot attributes on tracks: aYear, aStorm (tornado index), aPhase (0..1 along the path), aRating (0-5, 6 unknown).
// Dots are ordered by year (userData.setYear(y) limits them to a year by draw range); geometry is never rebuilt.

import { layerFile } from '../07-globe/data-source.js';   // hosted: newest build on R2; else the files in data/
import { toXYZ, dotMaterial, densityPoints, makeRamp, dimMaterial, D2R } from './dots_common.js';

const mixC = (a, b, f) => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
// F/EF 0..5 from the globe's palette (mid = weak, shallow = strong, same as the live layer); 6 = unknown in the palette's grey
const ratingColors = (p) => [0, 1, 2, 3, 4, 5].map((k) => mixC(p.mid.map((x) => x * 1.2), p.shallow, k / 5)).concat([(p.locked || [0.29, 0.35, 0.4]).map((x) => x * 2)]);
// density keeps its own warm heat ramp (judged good; it also keeps tornado history apart from the ocean-coloured layers)
const densityRamp = () => makeRamp([[0, [0.35, 0.1, 0.65]], [0.35, [0.9, 0.2, 0.5]], [0.7, [1.0, 0.6, 0.2]], [1, [1.0, 0.97, 0.75]]]);
const FIRST_YEAR = 1950;
const SPACING_DEG = 0.08;       // even spacing along a path (about 9 km); shorter paths get one dot at the start (+ end)
const MAX_LIFT = 0.05;

export async function createLayer({ THREE, radius = 1.0, makeDotMaterial, palette } = {}) {
  const pal = palette || { shallow: [0.35, 1, 0.95], mid: [0.1, 0.5, 0.95], deep: [0.03, 0.08, 0.45] };
  let RATING_COLORS = ratingColors(pal);
  const url = (f) => new URL('./data/' + f, import.meta.url);
  const get = async (f, kind) => fetch(await layerFile('tornadoes', f, url(f))).then((r) => { if (!r.ok) throw new Error(f + ' ' + r.status); return r[kind](); });
  const [meta, buf, dbuf] = await Promise.all([get('tornado_tracks.json', 'json'), get('tornado_tracks.bin', 'arrayBuffer'), get('tornado_density_points.bin', 'arrayBuffer')]);
  const N = meta.tornadoes, M = meta.density.points;
  const slat = new Int16Array(buf, 0, N), slon = new Int16Array(buf, 2 * N, N);
  const elat = new Int16Array(buf, 4 * N, N), elon = new Int16Array(buf, 6 * N, N);
  const year = new Uint8Array(buf, 8 * N, N), rating = new Uint8Array(buf, 9 * N, N);

  const dotsFor = (i) => {
    if (slat[i] === elat[i] && slon[i] === elon[i]) return 1;
    const dlat = (elat[i] - slat[i]) / 100, dlon = (elon[i] - slon[i]) / 100 * Math.cos(slat[i] / 100 * D2R);
    return Math.max(2, Math.round(Math.hypot(dlat, dlon) / SPACING_DEG) + 1);   // endpoints included
  };
  let total = 0;
  for (let i = 0; i < N; i++) total += dotsFor(i);

  const pos = new Float32Array(total * 3), col = new Float32Array(total * 3);
  const aYear = new Float32Array(total), aStorm = new Float32Array(total), aPhase = new Float32Array(total), aRating = new Float32Array(total);
  const years = meta.yearOffsets.length - 1;
  const yearEnd = new Uint32Array(years + 1);   // cumulative dots after each year
  let d = 0;
  const R = radius * 1.005;
  for (let y = 0; y < years; y++) {
    for (let i = meta.yearOffsets[y]; i < meta.yearOffsets[y + 1]; i++) {
      const n = dotsFor(i), c = RATING_COLORS[rating[i]];
      for (let k = 0; k < n; k++) {
        const f = n === 1 ? 0 : k / (n - 1);
        toXYZ((slat[i] + (elat[i] - slat[i]) * f) / 100, (slon[i] + (elon[i] - slon[i]) * f) / 100, R, pos, d * 3);
        col[d * 3] = c[0]; col[d * 3 + 1] = c[1]; col[d * 3 + 2] = c[2];
        aYear[d] = FIRST_YEAR + year[i]; aStorm[d] = i; aPhase[d] = f; aRating[d] = rating[i]; d++;
      }
    }
    yearEnd[y + 1] = d;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aYear', new THREE.BufferAttribute(aYear, 1));
  g.setAttribute('aStorm', new THREE.BufferAttribute(aStorm, 1));
  g.setAttribute('aPhase', new THREE.BufferAttribute(aPhase, 1));
  g.setAttribute('aRating', new THREE.BufferAttribute(aRating, 1));
  g.setDrawRange(0, total);
  // limb fade (the globe material's GRAZE_FADE, floor ~0): the raised density dots piled up edge-on at the globe's edge into a bright
  // pink streak at whole-globe zoom (round 3, rings at the limb); they now fade by viewing angle like the base globe's dots
  const limbMat = (o) => makeDotMaterial ? makeDotMaterial({ ...o, vertexColors: true, grazeMin: 0.001 }) : dotMaterial(THREE, null, o);
  const tracks = new THREE.Points(g, limbMat({ size: 0.0026, opacity: 0.22 }));   // 73k overlapping paths: low alpha so dense areas do not burn to white
  tracks.name = 'tornado-path-dots'; tracks.frustumCulled = false;

  const density = densityPoints(THREE, dbuf, M, radius, MAX_LIFT, densityRamp(), limbMat({ size: 0.0042, opacity: 0.85 }));
  density.name = 'tornado-density-dots';

  const group = new THREE.Group();
  group.name = 'tornadoes';
  tracks.visible = false;                   // paths are off by default: the density relief is the history view
  group.add(density, tracks);

  const showUpTo = (yr) => { // tornadoes up to and including this (fractional) year
    const k = Math.max(0, Math.min(years, Math.floor(yr - FIRST_YEAR) + 1));
    g.setDrawRange(0, yearEnd[k]);
    return k ? meta.yearOffsets[k] : 0;
  };
  let palKey = pal.shallow[0] + 3 * pal.shallow[1] + 5 * pal.mid[0] + 7 * pal.mid[2] + 11 * pal.deep[0] + 13 * pal.deep[1];
  const recolor = () => {   // only when the globe's palette changes: one colour upload per palette switch
    RATING_COLORS = ratingColors(pal);
    const ca = g.attributes.color.array;
    for (let i = 0; i < total; i++) { const c = RATING_COLORS[aRating[i]]; ca[i * 3] = c[0]; ca[i * 3 + 1] = c[1]; ca[i * 3 + 2] = c[2]; }
    g.attributes.color.needsUpdate = true;
  };
  group.update = () => {
    const k = pal.shallow[0] + 3 * pal.shallow[1] + 5 * pal.mid[0] + 7 * pal.mid[2] + 11 * pal.deep[0] + 13 * pal.deep[1];
    if (k !== palKey) { palKey = k; recolor(); }
  };
  group.label = 'US tornado reports 1950-2025 (SPC). Raised dots: where paths were reported, 1991-2024; a map of reports, not of risk.';
  group.details = `US tornado reports from the NOAA/NWS Storm Prediction Center database, 1950-2025 (2025 ends in September). ` +
    `Raised dots: one per 0.25 degree cell crossed by at least one recorded path in 1991-2024, higher where more were reported; ` +
    `empty cells have no dot. Reporting rose over the decades and favours weak tornadoes, so this is a map of reports, not of true risk. ` +
    `"Show all paths" draws every recorded path, coloured by F/EF rating; tornadoes with no recorded end point are one dot.`;
  group.setDim = (k) => { dimMaterial(tracks.material, k); dimMaterial(density.material, k); };
  group.setShowPaths = (on) => { tracks.visible = !!on; };
  group.userData = {
    tracks, density, meta, dots: { tracks: total, density: M },
    setYear: showUpTo,
    showAll: () => g.setDrawRange(0, total),
    showDensity: (on) => { density.visible = on; },
    showTracks: (on) => { tracks.visible = on; },
  };
  return group;
}
