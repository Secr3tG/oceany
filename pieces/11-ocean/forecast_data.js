// Wave forecast steps for the time bar (plumbing): reads what build_forecast.py writes into data/forecast/<model>/ and
// turns each step into two small GPU textures. Nothing is fetched until the wave layer is first shown, and then only
// the steps the viewer is near (the one shown, its neighbours, and the next few while playing).
//
// Hosted pages read the files from Cloudflare R2 when latest.json lists the layer 'wavefc-gfs' / 'wavefc-ecmwf'
// (../07-globe/data-source.js); otherwise, and on localhost, from data/forecast/ beside this file.
// Each step file is gzip; the browser unpacks it with DecompressionStream (all current browsers).
//
//   const fc = await loadForecast('gfs', 'hi' | 'lo')   -> { manifest, steps: [{ fh, valid (ms), res }], grid(res), mask(res) }
//   const s = await fc.step(i)                          -> { grid, texA, texB, raw, mask: { tex, data } }   (cached)
//   texA RGBA: total height, swell height, wind-sea height (all m / 25.5), swell period (s / 25.5)
//   texB RGBA: swell going (east, north) and wind-sea going (east, north), as 0.5 + 0.5 x component
//   fc.hasWind; const w = await fc.wind(i) -> { grid, tex, peak }   10 m wind, for wind.js (same steps, same clock)
import { layerFile } from '../07-globe/data-source.js';

const local = (model, file) => new URL(`./data/forecast/${model}/${file}`, import.meta.url);
const SAFE = /^[A-Za-z0-9_.-]+$/;

async function getFile(model, file) {
  if (!SAFE.test(file)) throw new Error('bad file name in manifest');
  const url = await layerFile('wavefc-' + model, file, local(model, file));
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error(file + ' HTTP ' + r.status);
  return r;
}
async function gunzip(r) {
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unpack the forecast');
  return new Uint8Array(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}

// direction byte (256 per turn, going) -> unit east / north as a byte
const COS = new Uint8Array(256), SIN = new Uint8Array(256);
for (let k = 0; k < 256; k++) { const a = k / 256 * 2 * Math.PI; SIN[k] = Math.round(127.5 + 127.5 * Math.sin(a)); COS[k] = Math.round(127.5 + 127.5 * Math.cos(a)); }

const cache = new Map();          // model|res -> forecast object
export function loadForecast(THREE, model, want) {
  const key = model + '|' + want;
  if (cache.has(key)) return cache.get(key);
  const p = (async () => {
    const manifest = await (await getFile(model, 'manifest.json')).json();
    const steps = manifest.steps.map((s) => ({ fh: s.fh, valid: Date.parse(s.valid), res: want === 'hi' && s.hi ? 'hi' : 'lo',
      file: want === 'hi' && s.hi ? s.hi : s.lo, peak: s.peak }));
    const masks = {};
    const mask = (res) => masks[res] ||= getFile(model, manifest.grids[res].mask).then(gunzip).then((m) => {
      const g = manifest.grids[res], t = new THREE.DataTexture(m, g.nLon, g.nLat, THREE.RedFormat, THREE.UnsignedByteType);
      setup(THREE, t); return { tex: t, data: m };
    });
    const loaded = new Map();     // index -> Promise
    const step = (i) => {
      if (loaded.has(i)) return loaded.get(i);
      const s = steps[i], g = manifest.grids[s.res], n = g.nLat * g.nLon;
      const pr = getFile(model, s.file).then(gunzip).then(async (raw) => {
        if (raw.length !== 6 * n) throw new Error('forecast step size does not match the manifest');
        return makeStep(THREE, raw, g, await mask(s.res));
      }).catch((e) => { loaded.delete(i); throw e; });
      loaded.set(i, pr);
      return pr;
    };
    // keep GPU memory bounded: drop steps far from the one shown (they reload from the browser cache if needed)
    const trim = (keep) => {
      for (const [i, pr] of loaded) if (Math.abs(i - keep) > 6) { loaded.delete(i); pr.then((s) => { s.texA.dispose(); s.texB.dispose(); }).catch(() => {}); }
    };
    // 10 m wind for the same steps (manifest.wind; absent in older runs): one RG texture per step, u and v as
    // 128 + m/s / scale, the layout wind.js has always read. hi to +120 h on desktop, lo (1 degree) otherwise.
    const W = manifest.wind, wloaded = new Map();
    const hasWind = !!(W && W.grids && manifest.steps.some((s) => s.wlo || s.whi));
    const wind = (i) => {
      if (wloaded.has(i)) return wloaded.get(i);
      const ms = manifest.steps[i], res = want === 'hi' && ms.whi ? 'hi' : 'lo', file = res === 'hi' ? ms.whi : ms.wlo;
      if (!file) return Promise.reject(new Error('no wind in this forecast step'));
      const g = W.grids[res], n = g.nLat * g.nLon;
      const pr = getFile(model, file).then(gunzip).then((raw) => {
        if (raw.length !== 2 * n) throw new Error('wind step size does not match the manifest');
        return makeWindStep(THREE, raw, g, W.scale || 0.5, ms.wpeak);
      }).catch((e) => { wloaded.delete(i); throw e; });
      wloaded.set(i, pr);
      return pr;
    };
    const wtrim = (keep) => {
      for (const [i, pr] of wloaded) if (Math.abs(i - keep) > 6) { wloaded.delete(i); pr.then((s) => s.tex.dispose()).catch(() => {}); }
    };
    return { manifest, steps, step, trim, mask, model, hasWind, wind, wtrim };
  })();
  p.catch(() => cache.delete(key));
  cache.set(key, p);
  return p;
}

// One step's textures from its six byte planes (see build_forecast.py). mask: { tex, data } for the same grid.
export function makeStep(THREE, raw, g, mask) {
  const n = g.nLat * g.nLon, a = new Uint8Array(4 * n), b = new Uint8Array(4 * n);
  for (let k = 0; k < n; k++) {
    a[4 * k] = raw[k]; a[4 * k + 1] = raw[n + k]; a[4 * k + 2] = raw[2 * n + k]; a[4 * k + 3] = raw[3 * n + k];
    const sd = raw[4 * n + k], wd = raw[5 * n + k];
    // no swell (height 0) -> zero vector, so a blend toward it fades instead of turning
    if (raw[n + k] > 0) { b[4 * k] = SIN[sd]; b[4 * k + 1] = COS[sd]; } else { b[4 * k] = b[4 * k + 1] = 128; }
    if (raw[2 * n + k] > 0) { b[4 * k + 2] = SIN[wd]; b[4 * k + 3] = COS[wd]; } else { b[4 * k + 2] = b[4 * k + 3] = 128; }
  }
  const tA = new THREE.DataTexture(a, g.nLon, g.nLat, THREE.RGBAFormat), tB = new THREE.DataTexture(b, g.nLon, g.nLat, THREE.RGBAFormat);
  setup(THREE, tA); setup(THREE, tB);
  return { grid: g, texA: tA, texB: tB, raw, mask };
}

// The older single snapshot (ocean_data.js loadWaves: GFS 9 fields or ECMWF 4) as one step, for when no forecast
// files are hosted yet. Land / ice keep 0 (the mask hides them).
export function stepFromSnapshot(THREE, w) {
  const g = { nLat: w.nLat, nLon: w.nLon, lat0: w.lat0, step: w.step }, n = g.nLat * g.nLon, f = w.f, raw = new Uint8Array(6 * n), m = new Uint8Array(n);
  const q = (v) => (v >= 0 ? Math.min(254, Math.round(v * 10)) : 0), d = (v) => (v >= 0 ? Math.round(((v + 180) % 360) / 360 * 256) % 256 : 0);
  const part = !!f.shgt;
  for (let k = 0; k < n; k++) {
    if (!(f.Thgt[k] >= 0)) continue;
    m[k] = 255; raw[k] = q(f.Thgt[k]);
    if (part) { raw[n + k] = q(f.shgt[k]); raw[2 * n + k] = q(f.whgt[k]); raw[3 * n + k] = q(f.sper[k]); raw[4 * n + k] = d(f.sdir[k]); raw[5 * n + k] = d(f.wdir[k]); }
    else { raw[n + k] = q(f.Thgt[k]); raw[3 * n + k] = q(f.Tper[k]); raw[4 * n + k] = d(f.Tdir[k]); }
  }
  const t = new THREE.DataTexture(m, g.nLon, g.nLat, THREE.RedFormat, THREE.UnsignedByteType);
  setup(THREE, t);
  return makeStep(THREE, raw, g, { tex: t, data: m });
}

// One wind step: int8 u plane then int8 v plane (m/s = value x scale) -> RGBA bytes 128 + 2 x m/s (0.5 m/s per step,
// clamped), the encoding wind.js decodes. Also finds the strongest wind if the manifest did not give it.
export function makeWindStep(THREE, raw, g, scale, peak) {
  const n = g.nLat * g.nLon, d = new Uint8Array(4 * n), i8 = new Int8Array(raw.buffer, raw.byteOffset, raw.length);
  let best = -1, bk = 0;
  for (let k = 0; k < n; k++) {
    const u = i8[k] * scale, v = i8[n + k] * scale;
    d[4 * k] = Math.max(1, Math.min(255, Math.round(u * 2 + 128)));
    d[4 * k + 1] = Math.max(1, Math.min(255, Math.round(v * 2 + 128)));
    d[4 * k + 3] = 255;
    if (!peak) { const s2 = u * u + v * v; if (s2 > best) { best = s2; bk = k; } }
  }
  if (!peak) peak = { s: Math.sqrt(best), lat: g.lat0 + Math.floor(bk / g.nLon) * g.step, lon: ((((bk % g.nLon) * g.step + (g.lon0 || 0)) + 180) % 360) - 180 };
  const t = new THREE.DataTexture(d, g.nLon, g.nLat, THREE.RGBAFormat);
  setup(THREE, t);
  return { grid: g, tex: t, peak };
}

function setup(THREE, t) {
  t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = t.minFilter = THREE.LinearFilter; t.generateMipmaps = false; t.flipY = false; t.needsUpdate = true;
}

// Values at one point (for the readout), from a step's raw bytes: nearest grid cell. null on land or ice.
export function sampleAt(step, lat, lon) {
  const maskData = step.mask && step.mask.data;
  const g = step.grid, n = g.nLat * g.nLon;
  const i = Math.round((lat - g.lat0) / g.step), j = ((Math.round((((lon % 360) + 360) % 360) / g.step)) % g.nLon);
  if (i < 0 || i >= g.nLat) return null;
  const k = i * g.nLon + j;
  if (maskData && !maskData[k]) return null;
  const r = step.raw, from = (d) => ((d / 256 * 360) + 180) % 360;
  return { hs: r[k] / 10, sH: r[n + k] / 10, wH: r[2 * n + k] / 10, sT: r[3 * n + k] / 10, sFrom: from(r[4 * n + k]), wFrom: from(r[5 * n + k]) };
}
