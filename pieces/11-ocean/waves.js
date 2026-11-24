// Total significant wave height for the Oceany globe, as a calm dot field: one dot per 0.5 degree model grid cell that has
// wave data, colour and brightness by height. Data: NOAA NCEP GFS-Wave (WAVEWATCH III, forced by GFS winds), from
// NOMADS, snapshot built by build_ocean.py (see SOURCES.md). Nothing is drawn on land or under sea ice, where the model
// has no data. Static: nothing moves, update() does no work after loading.
//
//   const layer = await createLayer({ THREE, radius, makeDotMaterial, palette });   layer.update(t) every frame
//   layer.label / .details / .status, layer.setDim(k), layer.setPalette(name, palette)

import { loadWaves, dataLine, onOceanUpdate, fmtTime, fmtRun, staleNote, SAFETY, rampColours } from './ocean_data.js';
import { mountModelSwitch } from './ocean_model.js';

const D2R = Math.PI / 180;
const LIFT = 0.0012;          // radii above the base sphere (the ocean is at the base radius), so the field sits on the sea dots
const OPACITY = 0.9;          // a quiet base under the swell and wind layers
const H_TOP = 8;              // metres at the top of the colour ramp (higher waves stay at the brightest colour)
// Round 4: at whole-globe zoom the field read as almost nothing (each dot is ~4 device px there, and the dot falloff leaves
// little light per cell). FAR_GAIN lifts the opacity from the camera's altitude, 1 at regional zoom (alt <= FAR_LO) up to
// FAR_GAIN at whole globe (alt >= FAR_HI), a little more for a dim palette; colours, the limb fade and the dot are unchanged.
const FAR_GAIN = 3.2, FAR_LO = 0.6, FAR_HI = 2.0;

export async function createLayer({ THREE, radius = 1, makeDotMaterial, palette }) {
  const mat = makeDotMaterial({ size: 0.5 * D2R * radius * 0.9, vertexColors: true, sizeAttr: true, opacity: OPACITY,
    maxPx: 6 * (globalThis.devicePixelRatio || 1),
    grazeMin: 0.001 });   // the globe's limb fade (as for land): the wide overlapping dots summed to a bright cyan ring at the edge
  const pts = new THREE.Points(new THREE.BufferGeometry(), mat);
  pts.frustumCulled = false;
  pts.name = 'waves';
  let pal = palette, hs = null, state = 'waiting', err = '', meta = null, count = 0, peak = null;
  const ramp = [];

  let palK = 1;   // whole-globe lift per palette: a dim sea ramp (Mono's slate) gets up to 1.4x more, so it reads like Ocean
  function colour() {
    rampColours(THREE, pal, ramp);
    const m = ramp[1]; palK = Math.max(1, Math.min(1.4, 0.4 / Math.max(0.05, 0.3 * m.r + 0.5 * m.g + 0.2 * m.b)));
    if (!hs) return;
    const col = pts.geometry.getAttribute('color'), c = new THREE.Color();
    for (let i = 0; i < hs.length; i++) {
      const x = Math.sqrt(Math.min(1, hs[i] / H_TOP)) * 3;           // square root: calm seas still separate (1 m vs 2 m)
      const k = Math.min(2, Math.floor(x));
      c.copy(ramp[k]).lerp(ramp[k + 1], x - k);
      const b = 0.04 + 1.1 * Math.pow(x / 3, 2.2);                    // brightness by height too: calm sea nearly dark, so high seas stand out
      col.setXYZ(i, c.r * b, c.g * b, c.b * b);
    }
    col.needsUpdate = true;
  }

  function build(w) {
    const { nLat, nLon, lat0, step, f } = w, H = f.Thgt;
    const pos = [], size = [], hv = [];
    for (let i = 0; i < nLat; i++) {
      const cl = Math.cos((lat0 + i * step) * D2R);
      for (let j = 0; j < nLon; j++) {
        const h = H[i * nLon + j];
        if (!(h >= 0)) continue;                                       // NaN: land, ice or outside the model
        // a fixed random nudge within the cell (up to +-0.3 cell), so the regular grid does not beat into moire rings
        const hh = Math.sin((i * nLon + j) * 12.9898) * 43758.5453, j1 = hh - Math.floor(hh) - 0.5, j2 = hh * 7.31 - Math.floor(hh * 7.31) - 0.5;
        const la = (lat0 + (i + 0.6 * j1) * step) * D2R, lo = (j + 0.6 * j2) * step * D2R, r = radius + LIFT;
        pos.push(r * Math.cos(la) * Math.cos(lo), r * Math.sin(la), -r * Math.cos(la) * Math.sin(lo));
        size.push(Math.max(0.4, cl));                                  // cells narrow toward the poles: dots narrow with them
        hv.push(h);
        if (!peak || h > peak.h) peak = { h, lat: lat0 + i * step, lon: ((j * step + 180) % 360) - 180 };
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    pts.geometry.dispose(); pts.geometry = g;
    hs = Float32Array.from(hv); count = hv.length;
    colour();
  }

  async function load() {
    state = 'loading'; text();
    try { const w = await loadWaves(); meta = w.meta; build(w); state = 'ok'; }
    catch (e) { err = (e && e.message) || 'network error'; state = 'failed'; pts.geometry.dispose(); pts.geometry = new THREE.BufferGeometry(); }
    text();
  }

  function text() {
    const m = meta && meta.waves;
    pts.label = m ? `Wave height: ${meta.modelId === 'ecmwf' ? 'ECMWF' : 'WAVEWATCH III'}, valid ${fmtTime(meta.validWaves)}` : 'Wave height (model)';
    pts.details = `${SAFETY} Model output, not measurement. ` +
      (m ? `Model: ${m.model}. Run: ${fmtRun(m.run)}. Valid: ${fmtTime(meta.validWaves)}. ` : 'Model: NOAA NCEP GFS-Wave (WAVEWATCH III), forced by GFS winds. ') +
      `Significant wave height of the whole sea (swell and wind sea together): roughly the average of the highest third of the waves. ` +
      `One dot per 0.5 degree cell (every second point of the model's 0.25 degree grid; about 55 km north-south), never finer (each dot nudged at random within its own cell, so the grid does not form moire rings); colour and brightness rise with height, from calm (dark) to ${H_TOP} m and above (brightest). ` +
      `No dot means no model data: land and sea ice. ` +
      dataLine(meta);
    let st = '';
    if (state === 'waiting' || state === 'loading') st = 'Loading the wave snapshot…';
    else if (state === 'failed') st = `Wave snapshot not available (${err}); nothing drawn. Run pieces/11-ocean/build_ocean.py.`;
    else st = `${count.toLocaleString('en-GB')} model cells. Highest: ${peak.h.toFixed(1)} m near ${Math.abs(peak.lat).toFixed(1)}°${peak.lat < 0 ? 'S' : 'N'} ${Math.abs(peak.lon).toFixed(1)}°${peak.lon < 0 ? 'W' : 'E'}.` + staleNote(meta.validWaves);
    pts.status = st;
    pts.userData.onChange?.(pts);
  }

  pts.update = () => { if (pts.visible && state === 'waiting') load(); };   // first show only; nothing per frame
  let dim = 1;
  const gain = (camera) => {                               // whole-globe lift, from the camera's height above the base sphere
    const alt = camera.position.distanceTo(pts.parent ? pts.parent.getWorldPosition(_c) : _c.set(0, 0, 0)) / radius - 1;
    const t = Math.max(0, Math.min(1, (alt - FAR_LO) / (FAR_HI - FAR_LO)));
    return 1 + (FAR_GAIN * palK - 1) * t * t * (3 - 2 * t);
  };
  const _c = new THREE.Vector3();
  pts.onBeforeRender = (r, s, camera) => { mat.uniforms.uOpacity.value = OPACITY * dim * gain(camera); };
  pts.setDim = (k) => { dim = Math.max(0, Math.min(1, k)); mat.uniforms.uOpacity.value = OPACITY * dim; };
  pts.setPalette = (name, p) => { pal = p || pal; colour(); };
  onOceanUpdate(() => { if (state === 'ok' || state === 'failed') load(); });   // newer build while open (hosted only), or the GFS / ECMWF switch
  mountModelSwitch(pts);
  pts.userData.layer = { get state() { return state; }, load };
  text();
  return pts;
}
