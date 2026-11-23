// live_core.js: the parts of the Live forecast panel that need no DOM and no three.js, so Node can test them
// (pieces/06-live-wave/lookup/test_live_core.mjs). live.js imports everything from here.
//
// WHAT YOU SHOULD UNDERSTAND: periodFor() and readout(). PLUMBING: the rest.

export const MSL_MINUS_LAT = 1.66, DATUM_UNC = '0.1-0.3 m', MAX_SNAPSHOT_AGE_H = 48;
export const SPOT = { lat: 39.3195, lon: -9.3558 };          // Porto Batel's point (live-data/spots.py)
// No browser call to any outside host: everything comes from the same-origin snapshot live/<spot>.json, written by
// live-data/build_snapshot.py --public (NOAA GFS-Wave, Copernicus, DMI, NOAA CO-OPS). Open-Meteo was removed on 2026-11-23
// (its free tier is non-commercial).
export const DISCLAIMER = ['For research and play only. Not a forecast or warning service.', 'Not an official product. Do not use for safety decisions.'];

// ---------- one table for every spot (mirrors live-data/spots.py; test_live_core.mjs checks the two agree) ----------
// lat/lon: the spot's point (spots.py). snapshot: a public file live/<key>.json exists (spots.py `public`; every spot now).
// tide: how the snapshot's sea level (MSL: Copernicus tide + surge, or NOAA CO-OPS tide) becomes the water level on the map:
//   mslToMap = metres added to get "above the map datum". Only Peniche has a measured offset (LAT = MSL - 1.66 m).
// swell: what the forecast hour can drive on screen.
//   'play'  the "Play with the swell" sliders (Porto Batel); 'model' the same swell model run in the browser on that map's
//   grid (swell_model.js SPOT_GRIDS, checked against the shipped file by validate_spot_swell.mjs); null = no swell model on the map.
// layers: the viewer layers (main.js LAYERS labels) that show this spot; a spot with none is "forecast only".
// stageA: the reef model (Stage A: break distance, breaker height, peel, break line) where one exists: { lookup: folder of its
//   precomputed table, relative to the viewer, site: sites.py key }. Porto Batel (checked against the 17 Sep 2026 footage) and
//   Pipeline (checked against Sentinel-2 whitewater, pieces/05-pipeline/VALIDATION.md).
const PENICHE_TIDE = { datum: 'LAT', mslToMap: MSL_MINUS_LAT, unc: DATUM_UNC, words: 'above lowest tide (LAT)',
  how: `Tide above lowest tide (LAT) = forecast sea level + ${MSL_MINUS_LAT} m (Peniche offset, notes/forecast-fields.md), uncertain by ${DATUM_UNC}.` };
const MSL_TIDE = { datum: 'MSL', mslToMap: 0, words: 'relative to mean sea level',
  how: 'Sea level relative to (approximate) mean sea level, from the Copernicus regional model (tide + surge). No chart-datum offset is known for this spot, so none is applied.' };
const NORTH_SEA = ['EMODnet ~115 m', 'Danish model 50 m', 'North Sea (zoomed out)'];
export const LIVE_SPOTS = {
  porto_batel: { name: 'Porto Batel', lat: 39.3195, lon: -9.3558, snapshot: true, stageA: { lookup: '../../06-live-wave/lookup/', site: 'porto_batel' }, tide: PENICHE_TIDE,
    swell: { mode: 'play' }, layers: ['Reef maps: Consolação and Porto Batel'], snapWhat: 'NOAA / Copernicus',
    also: 'Consolação, 1 km away on the same map, shares this forecast point.' },
  supertubos: { name: 'Supertubos', lat: 39.3398, lon: -9.3619, snapshot: true, tide: PENICHE_TIDE,
    swell: { mode: 'model', grid: 'supertubos', file: 'data/reefs_wide.json' }, layers: ['Reef map: Supertubos, Peniche'],
    snapWhat: 'NOAA / Copernicus' },
  pipeline: { name: 'Pipeline', lat: 21.665, lon: -158.053, snapshot: true, stageA: { lookup: '../../06-live-wave/lookup_pipeline/', site: 'pipeline' },
    tide: { datum: 'LMSL', mslToMap: 0, words: 'above local mean sea level (LMSL, the lidar datum)',
      how: 'NOAA CO-OPS tide prediction for Honolulu (MSL, about 45 km away on the south shore) is taken as the tide on the lidar\'s LMSL at Pipeline; timing and range differ a little and are not checked. Astronomical tide only, no surge. Spring range here is only ~0.6 m.' },
    swell: { mode: 'model', grid: 'pipeline', file: 'data/pipeline.json' }, layers: ['Reef map: Pipeline, Oahu'], snapWhat: 'NOAA',
    also: 'The NDBC 51201 buoy (Waimea Bay) stays out of the public file until its terms are settled (data from CDIP, which asks that data are not altered).',
    credit: 'Reef model bed: Derived from 2013 USACE NCMP Topobathy Lidar DEM (LMSL): Oahu, HI (NOAA OCM dataset 9365), collected by USACE JALBTCX, distributed by NOAA Office for Coastal Management. US Government work, provided as-is, not endorsed by NOAA or USACE.' },
  guethary: { name: 'Guéthary / Parlementia', lat: 43.427718, lon: -1.611053, snapshot: true,
    tide: { datum: 'IGN69', mslToMap: 0, words: 'above IGN69 (within ~0.2 m of mean sea level here)',
      how: 'Copernicus IBI sea level (approximate MSL, tide + surge) is used as height above IGN69, whose zero lies within ~0.2 m of mean level on this coast.' },
    swell: { mode: 'model', grid: 'guethary', file: 'data/guethary.json' }, layers: ['Reef map: Guéthary / Parlementia, France'],
    snapWhat: 'NOAA / Copernicus' },
  hossegor: { name: 'Hossegor / La Gravière', lat: 43.67562, lon: -1.443375, snapshot: true,
    tide: { datum: 'IGN69', mslToMap: 0, words: 'above IGN69 (within ~0.2 m of mean sea level here)',
      how: 'Copernicus IBI sea level (approximate MSL, tide + surge) is used as height above IGN69, whose zero lies within ~0.2 m of mean level on this coast.' },
    swell: { mode: 'model', grid: 'hossegor', file: 'data/hossegor.json' }, layers: ['Reef map: Hossegor / La Gravière, France'],
    snapWhat: 'NOAA / Copernicus' },
  klitmoller: { name: 'Klitmøller', lat: 57.04, lon: 8.49, snapshot: true, tide: MSL_TIDE, swell: null, layers: NORTH_SEA,
    snapWhat: 'NOAA / Copernicus / DMI' },
  hvide_sande: { name: 'Hvide Sande', lat: 56.00, lon: 8.10, snapshot: true, tide: MSL_TIDE, swell: null, layers: NORTH_SEA,
    snapWhat: 'NOAA / Copernicus / DMI' },
  tel_aviv: { name: 'Tel Aviv', lat: 32.08, lon: 34.76, snapshot: true, tide: MSL_TIDE, swell: null, layers: [],
    snapWhat: 'NOAA / Copernicus' },
};
for (const [k, v] of Object.entries(LIVE_SPOTS)) v.key = k;
// Spots offered on a viewer layer: the ones drawn on it first, then the forecast-only spots (no map in the viewer).
export function spotsForLayer(label) {
  const on = Object.values(LIVE_SPOTS).filter(s => s.layers.includes(label));
  return { on, other: Object.values(LIVE_SPOTS).filter(s => !s.layers.length) };
}
export const snapshotPath = key => `live/${key}.json`;
export const PROFILE = { offsets: Array.from({ length: 49 }, (_, i) => -600 + 25 * i), lineDeg: 236, alongDeg: 326 };
export const ATTR = {
  gfs: 'Waves and wind: NOAA/NCEP GFS-Wave (WAVEWATCH III) and GFS, public domain, processed by Oceany. Not an official NOAA product.',
  cm: 'Generated using E.U. Copernicus Marine Service Information; <a href="https://doi.org/10.48670/moi-00025" target="_blank" rel="noopener">https://doi.org/10.48670/moi-00025</a> (IBI wave analysis and forecast).',
};

// The table and Stage A take one regular wave of period Tp; the period that sets its wavelength over the reef is the
// swell's spectral peak. NOAA GFS-Wave gives the swell partition's peak period for the whole run.
// (Copernicus: the snapshot already applies build_snapshot.stage_a_period.)
export function periodFor(peak, mean) { return peak != null ? [peak, 'peak'] : [mean, 'mean (swell partition)']; }

const latlon = (lat, lon) => `${Math.abs(lat).toFixed(3)} ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(3)} ${lon >= 0 ? 'E' : 'W'}`;
const toMap = (sl, spot) => sl == null ? null : +(sl + spot.tide.mslToMap).toFixed(3);
// Wind sea / total sea of one hour, or null when the source has none.
const windOf = (hs, tp, dir) => hs == null ? null : { hs, tp: tp ?? null, dir: dir ?? null };
const col = (sm, k) => sm[k] || sm.t.map(() => null);
const W10 = (sm, i) => sm.wind_speed && sm.wind_speed[i] != null ? { speed: sm.wind_speed[i], dir: sm.wind_dir ? sm.wind_dir[i] : null } : null;
const runOf = sm => ({ model: sm.model_name || null, run: sm.run_label || null, runUtc: sm.run_utc || null });

// build_snapshot.pack_profiles: two base-36 digits of s/2 per profile, '--' = no break
export function unpackProfiles(x) {
  if (x == null || Array.isArray(x)) return x;
  const out = [];
  for (let i = 0; i < x.length; i += 2) { const c = x.slice(i, i + 2); out.push(c === '--' ? null : 2 * parseInt(c, 36)); }
  return out;
}
function exactList(sm) {   // snapshot model columns -> per-hour exact records (or nulls)
  const e = sm.exact; if (!e) return sm.t.map(() => null);
  return sm.t.map((_, i) => e.state[i] == null ? null : { state: e.state[i], break_house: e.break_house[i], breaker_H_house: e.breaker_H_house[i],
    peel_angle_near: e.peel_angle_near[i], peel_speed_near: e.peel_speed_near[i], break_s: unpackProfiles(e.break_s[i]) });
}
const FEED_KEY = { gfs_wave: 'gfs', cmems_wave: 'cm', dmi_wam: 'dmi' };
const shortName = sm => sm.feed === 'gfs_wave' ? 'NOAA GFS-Wave' : sm.feed === 'dmi_wam' ? 'DMI WAM'
  : /IBI/.test(sm.model || sm.source || '') ? 'Copernicus IBI' : (sm.source || sm.model || sm.feed).replace(/ wave /, ' ');
// Columns of a non-Stage-A snapshot model (build_snapshot.public_spot) -> the panel's model shape. Hours without swell are dropped.
function genericModel(sm, spot) {
  const m = { name: shortName(sm), key: FEED_KEY[sm.feed] || sm.feed, source: sm.source, feed: sm.feed, doi: sm.doi, provider: sm.provider, ...runOf(sm),
    t: [], hs: [], tp: [], kind: [], dir: [], tide: [], exact: [], wind: [], total: [], w10: [], point: sm.point && sm.point.lat != null ? latlon(sm.point.lat, sm.point.lon) : '' };
  sm.t.forEach((t, i) => {
    if (sm.swell_hs[i] == null || sm.swell_tp[i] == null || sm.swell_dir[i] == null) return;
    m.t.push(t); m.hs.push(sm.swell_hs[i]); m.tp.push(sm.swell_tp[i]); m.kind.push(sm.swell_tp_kind[i] === 'peak' ? 'peak' : 'mean (swell partition)');
    m.dir.push(sm.swell_dir[i]); m.tide.push(toMap(sm.sea_level_msl[i], spot)); m.exact.push(null);
    m.wind.push(windOf(sm.wind_sea_hs[i], sm.wind_sea_tp[i], sm.wind_sea_dir[i])); m.total.push(sm.hs[i] ?? null); m.w10.push(W10(sm, i));
  });
  return m;
}
export function parseSnapshot(d, nowMs, spot = LIVE_SPOTS.porto_batel) {
  const age = (nowMs - Date.parse(d.built_utc + 'Z')) / 3.6e6;
  if (!(age <= MAX_SNAPSHOT_AGE_H)) return { state: 'stale', age };
  const tideMeta = !d.tide ? null : (d.tide.feed && typeof d.tide.feed === 'object') ? d.tide.feed : (d.tide.source && typeof d.tide.feed === 'string' ? d.tide : null);
  const out = { state: 'ok', age, models: {}, observations: d.observations || [], comparison: d.comparison || [], built: d.built_utc, excluded: d.excluded || {},
    tide: tideMeta };
  for (const sm of d.models || []) {
    const cmw = sm.feed === 'cmems_wave';
    const m = spot.stageA ? { name: cmw ? 'Copernicus IBI' : shortName(sm), key: FEED_KEY[sm.feed] || sm.feed, ...runOf(sm),
      source: sm.model, feed: sm.feed, doi: sm.doi || (cmw ? '10.48670/moi-00025' : undefined),
      attr: cmw ? ATTR.cm : ATTR.gfs, t: sm.t, hs: sm.hs, tp: sm.tp, kind: sm.tp_kind, dir: sm.dir, tide: sm.tide_lat,
      exact: exactList(sm), wind: sm.t.map((_, i) => windOf(col(sm, 'wind_sea_hs')[i], col(sm, 'wind_sea_tp')[i], col(sm, 'wind_sea_dir')[i])),
      total: col(sm, 'total_hs'), w10: sm.t.map((_, i) => W10(sm, i)), point: sm.point ? latlon(sm.point.lat, sm.point.lon) : '' }
      : genericModel(sm, spot);
    if (m.t.length) out.models[m.key] = m;
  }
  if (!Object.keys(out.models).length) out.state = 'empty';
  return out;
}
export async function fetchSnapshot(fetchFn, url, nowMs, spot) {
  const r = await fetchFn(url, { cache: 'no-cache' });
  if (!r.ok) return { state: 'absent' };
  return parseSnapshot(await r.json(), nowMs, spot);
}

// Not used by the viewer any more (no browser model call since 2026-11-23); kept because pieces/06-live-wave/lookup/test_live_core.mjs imports it.
export function attachExact(om, omSnap) {
  if (!om || !omSnap) return 0;
  const idx = new Map(omSnap.t.map((t, i) => [t, i])); let n = 0;
  om.t.forEach((t, i) => {
    const j = idx.get(t); if (j == null || !omSnap.exact[j]) return;
    const same = Math.abs(om.hs[i] - omSnap.hs[j]) < 1e-6 && Math.abs(om.tp[i] - omSnap.tp[j]) < 1e-6 &&
      Math.abs(om.dir[i] - omSnap.dir[j]) < 1e-6 && Math.abs(om.tide[i] - omSnap.tide[j]) < 1e-3;
    if (same) { om.exact[i] = omSnap.exact[j]; n++; }
  });
  return n;
}

// Load everything for one spot from its same-origin snapshot; never throws. Returns models (key -> model), status notes,
// the credit lines (HTML) for exactly the sources shown, and the snapshot's buoy observations and model-vs-buoy numbers.
export async function loadModels({ fetchFn, snapshotUrl, nowMs, spot = LIVE_SPOTS.porto_batel }) {
  let s;
  try { s = spot.snapshot && snapshotUrl ? await fetchSnapshot(fetchFn, snapshotUrl, nowMs, spot) : { state: 'none' }; }
  catch (e) { s = { state: 'absent', why: e.message }; }
  const models = {}, notes = [];
  const fresh = s.state === 'ok';
  if (fresh) {
    for (const k of ['cm', 'dmi', 'gfs']) if (s.models[k]) models[k] = s.models[k];
    for (const [k, m] of Object.entries(s.models)) if (!models[k]) models[k] = m;
    notes.push(`Snapshot built ${s.built.replace('T', ' ')} UTC (${s.age.toFixed(0)} h ago).`);
    if (!s.tide) notes.push('Tide: not available for this spot right now.');
  } else if (s.state === 'stale') notes.push(`The newest snapshot is ${s.age.toFixed(0)} h old (over ${MAX_SNAPSHOT_AGE_H} h), so it is not shown.`);
  else if (s.state === 'empty') notes.push('The snapshot has no model data.');
  else notes.push('No forecast snapshot is published for this spot right now.');
  const observations = fresh ? s.observations : [], comparison = fresh ? s.comparison : [];
  return { models, notes, attr: Object.keys(models), ok: Object.keys(models).length > 0, snapshot: s.state, tide: fresh ? s.tide : null,
    built: fresh ? s.built : null, observations, comparison,
    credits: [...credits(models, observations, fresh ? s.built : null, fresh ? s.tide : null), ...(spot.credit ? [spot.credit] : [])] };
}

// ---------- credit lines, one per source actually shown ----------
const doiLink = d => `<a href="https://doi.org/${d}" target="_blank" rel="noopener">https://doi.org/${d}</a>`;
export function credits(models, observations = [], built = null, tide = null) {
  const L = [];
  if (models.gfs) L.push(ATTR.gfs);
  const cm = [];
  if (models.cm) cm.push(`${doiLink(models.cm.doi || '10.48670/moi-00025')} (${models.cm.name} wave analysis and forecast)`);
  if (tide && tide.feed === 'cmems_sea_level' && tide.doi) cm.push(`${doiLink(tide.doi)} (${tide.source.replace('Copernicus ', '')}, physics analysis and forecast)`);
  for (const o of observations) if (o.feed === 'cmems_insitu') cm.push(`${doiLink(o.doi || '10.48670/moi-00036')} (in-situ buoy ${o.source.replace(/ \(.*/, '')}${o.provider ? '; data provider: ' + o.provider : ''})`);
  if (cm.length) L.push('Generated using E.U. Copernicus Marine Service Information; ' + cm.join(', ') + '.');
  const dmi = !!models.dmi || observations.some(o => o.feed === 'dmi_water_level');
  if (dmi) L.push(`Kilde: DMI (${[models.dmi && 'WAM wave forecast', observations.some(o => o.feed === 'dmi_water_level') && 'water level'].filter(Boolean).join(', ')}, ` +
    `<a href="https://www.dmi.dk/friedata" target="_blank" rel="noopener">DMI open data</a>, CC BY 4.0${built ? ', retrieved ' + built.replace('T', ' ') + ' UTC' : ''}). ` +
    'Model-vs-buoy numbers: baseret p&aring; data fra DMI og efterf&oslash;lgende bearbejdet.');
  if (tide && tide.feed === 'coops_tide') L.push('Tide: NOAA NOS CO-OPS tide predictions (public domain), Honolulu station 1612340. Not an official NOAA product.');
  return L;
}

// Which model, which run, which hour: "NOAA/NCEP GFS-Wave global 0.25 deg, run 22 Nov 18Z, valid 23 Nov 06:00 UTC".
export function runLine(m, t, built = null) {
  const v = new Date(t + 'Z'), valid = `${v.getUTCDate()} ${v.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${t.slice(11, 16)} UTC`;
  const name = m.model ? m.model.replace(' (WAVEWATCH III)', '').replace('NCEP ', 'NOAA/NCEP ') : m.name;
  if (m.run) return `${name}, run ${m.run}, valid ${valid}`;
  return `${name}${built ? `, retrieved ${built.replace('T', ' ')} UTC` : ''}, valid ${valid}`;
}

// ---------- readouts for spots without the reef model ----------
const deg = d => d == null ? '' : `, from <b>${Math.round(d)}&deg; ${compass(d)}</b>`;
const kindTag = k => k === 'peak' ? '' : ` <span class="flag">(${k.startsWith('peak') ? 'whole-sea peak' : 'mean period'})</span>`;
export function swellLine(p) { return `Swell <b>${p.hs.toFixed(1)} m</b>, <b>${p.tp.toFixed(1)} s</b>${kindTag(p.kind)}${deg(p.dir)}`; }
export function windLine(p) {
  const w10 = p.w10 ? `10 m wind <b>${(p.w10.speed * 3.6).toFixed(0)} km/h</b> (${p.w10.speed.toFixed(1)} m/s)${p.w10.dir != null ? `, from ${Math.round(p.w10.dir)}&deg; ${compass(p.w10.dir)}` : ''}` : null;
  if (!p.wind) return w10 || (p.total != null ? `Total sea ${p.total.toFixed(1)} m` : null);
  if (w10) return windLine({ ...p, w10: null }) + '<br>' + w10;
  return `Wind sea ${p.wind.hs.toFixed(1)} m${p.wind.tp != null ? `, ${p.wind.tp.toFixed(1)} s` : ''}${p.wind.dir != null ? `, from ${Math.round(p.wind.dir)}&deg; ${compass(p.wind.dir)}` : ''}` +
    (p.total != null ? `; total sea ${p.total.toFixed(1)} m` : '');
}
export function tideLine(p, spot) {
  if (p.tide == null) return 'Tide: <b>not available</b> for this hour.';
  const T = spot.tide;
  if (T.datum === 'MSL') return `Sea level <b>${p.tide >= 0 ? '+' : ''}${p.tide.toFixed(2)} m</b> relative to mean sea level (forecast tide + surge)`;
  return `Tide <b>${p.tide.toFixed(2)} m</b> ${T.words}${T.unc ? ` (&plusmn; ${T.unc} datum)` : ''}`;
}
export function forecastLines(p, spot) { return [swellLine(p), windLine(p), tideLine(p, spot)].filter(Boolean); }

// Latest buoy / tide-gauge values and the selected model's bias against each buoy (both from the snapshot).
export function buoyLines(observations, comparison, model, nowMs) {
  const L = [];
  for (const o of observations || []) {
    const r = o.latest; if (!r) continue;
    const ago = (nowMs - Date.parse(r.time_utc + 'Z')) / 3.6e6, when = `${r.time_utc.slice(11)} UTC${ago > 1.5 ? ` (${ago.toFixed(0)} h ago${ago > 12 ? ', <span class="flag">old</span>' : ''})` : ''}`;
    if (o.kind === 'water_level') { L.push(`Tide gauge ${o.source}: ${r.sea_level >= 0 ? '+' : ''}${r.sea_level.toFixed(2)} m at ${when} <span class="hint">(DMI sea_reg, datum not verified; not used above)</span>`); continue; }
    const v = [r.hs != null && `Hs <b>${r.hs.toFixed(1)} m</b>`, r.tp != null && `peak ${r.tp.toFixed(1)} s`, r.tm != null && `mean ${r.tm.toFixed(1)} s`, r.dir != null && `from ${Math.round(r.dir)}&deg;`].filter(Boolean).join(', ');
    L.push(`Buoy ${o.source}: ${v} at ${when}`);
    const c = model && (comparison || []).find(x => x.buoy === o.source && x.model === model.source);
    if (c && c.hs_m) L.push(`&nbsp;&nbsp;${model.name} minus this buoy, last 48 h: Hs bias <b>${c.hs_m.bias >= 0 ? '+' : ''}${c.hs_m.bias.toFixed(2)} m</b>, RMSE ${c.hs_m.rmse.toFixed(2)} m (n ${c.hs_m.n}; total sea)` +
      (c.km_model_point_to_buoy != null ? `; model point ${Math.round(c.km_model_point_to_buoy)} km from the buoy${c.km_model_point_to_buoy > 20 ? ', so a regional check only' : ''}` : ''));
    else if (model) L.push(`&nbsp;&nbsp;<span class="hint">No ${model.name}-vs-buoy numbers in the snapshot.</span>`);
  }
  return L;
}

// ---------- forecast hour -> the spot's swell visual ----------
// Play sliders' ranges (play.js SLIDERS); the browser model on the other maps takes any value, so only sanity limits apply.
export const PLAY_RANGE = { H0: [0.5, 7], T: [5, 18], dir: [180, 360], tide: [0, 3.8] };
// What a forecast hour puts into the spot's swell visual. Returns { ok, why } or { ok, mode, inputs, clamped, label }.
// Always strict (direction used as given): a real forecast direction is not assumed to wrap round a headland.
export function swellHandoff(spot, p, modelName, t, layerLabel, fileTide = 0) {
  if (!spot.swell) return { ok: false, why: spot.layers.length ? 'No swell model on this map: the forecast is shown as numbers only.'
    : `No sea-floor map of ${spot.name} in the viewer yet: the forecast is shown as numbers only.` };
  if (layerLabel != null && !spot.layers.includes(layerLabel)) return { ok: false, why: `${spot.name} is not on the map on screen.` };
  if (!p || p.hs == null || p.tp == null || p.dir == null) return { ok: false, why: 'This hour has no complete swell (height, period, direction).' };
  const clamped = [], c = (v, [lo, hi], name) => { const w = Math.min(hi, Math.max(lo, v)); if (w !== v) clamped.push(name); return w; };
  const noTide = p.tide == null, tide0 = noTide ? fileTide : p.tide;
  let inputs;
  if (spot.swell.mode === 'play') {
    const R = PLAY_RANGE;
    inputs = { H0: +c(p.hs, R.H0, 'height').toFixed(1), T: +c(p.tp, R.T, 'period').toFixed(1), dir: Math.round(c(p.dir, R.dir, 'direction') / 5) * 5,
      tide: +c(tide0, R.tide, 'tide').toFixed(1), wrapped: false };
  } else inputs = { H0: +c(p.hs, [0.1, 15], 'height').toFixed(2), T: +c(p.tp, [3, 25], 'period').toFixed(1), dir: Math.round(p.dir), tide: +tide0.toFixed(2), wrapped: false };
  return { ok: true, mode: spot.swell.mode, inputs, clamped, noTide, label: `forecast for ${t.replace('T', ' ')} UTC, ${modelName}` };
}
// The line under the panel that says what the swell on screen is.
export function swellStateText(st) {
  if (!st) return 'Swell on screen: none (the swell layer is off).';
  if (st.kind === 'forecast') return `Swell on screen: <b>${st.label}</b> (model driven by forecast input, illustrative).`;
  if (st.kind === 'sliders') return 'Swell on screen: <b>your slider values</b> (Play with the swell).';
  return `Swell on screen: <b>the map's typical swell</b> (fixed illustration, not a forecast)${st.label ? ': ' + st.label : ''}.`;
}
// Play box params equal to what a hand-off set? (then the slider picture is still "forecast for ...")
export const sameInputs = (a, b) => !!a && !!b && ['H0', 'T', 'dir', 'tide'].every(k => Math.abs(a[k] - b[k]) < 1e-9) && !!a.wrapped === !!b.wrapped;

// An exact snapshot record in the same shape as live_lookup.interpolate() returns.
// ix: the site's lookup index.json (profile geometry, origin, shoreline); without it, Porto Batel's geometry.
export function exactResult(e, ix = null) {
  const status = e.state === 'reef' ? 'reef' : e.state === 'edge' ? 'edge' : 'off-house';
  const g = ix ? { offsets: ix.profile_offsets_m, lineDeg: ix.profile_line_deg, alongDeg: ix.profile_along_deg } : PROFILE;
  return { source: 'exact', status, breakHouse: e.break_house ?? NaN, breakerHHouse: e.breaker_H_house ?? NaN,
    peelAngleNear: e.peel_angle_near ?? NaN, peelSpeedNear: e.peel_speed_near ?? NaN, lowConfidence: false, clamped: {}, outOfRange: false,
    breakS: e.break_s.map(v => v == null ? NaN : v), profileOffsets: g.offsets, lineDeg: g.lineDeg, alongDeg: g.alongDeg,
    house: ix ? ix.house : null, site: ix && ix.site ? ix.site : 'porto_batel', shoreS: ix ? ix.shore_s_lmsl_m : undefined,
    takeoffS: ix && ix.takeoff ? ix.takeoff.s : null, reefs: ix ? ix.reefs : undefined };
}

// For an exact run: which inputs lie outside the range the site's table (and its validation) covers. Same shape as the
// table's `clamped`. A direction axis may run through north (Pipeline 270-390): d and d + 360 are both tried.
export function outsideRange(p, ix) {
  if (!ix) return {};
  const ax = ix.axes, inR = (v, a) => v >= a[0] && v <= a[a.length - 1], tideAx = ax.tide_above_LAT_m || ax.tide_above_datum_m;
  return { hs: !inR(p.hs, ax.H0_m), tp: !inR(p.tp, ax.tp_s), dir: !(inR(p.dir, ax.dir_from_deg) || inR(p.dir + 360, ax.dir_from_deg)), tide: !inR(p.tide, tideAx) };
}

// Which named reef a break distance falls on (Pipeline: bands from the shoreline, sites.py PIPELINE reefs). null if none.
export function reefName(fromShore, reefs) {
  if (!reefs || !Number.isFinite(fromShore)) return null;
  const r = reefs.find(q => fromShore >= q.from_shore_m[0] && (q.from_shore_m[1] == null || fromShore < q.from_shore_m[1]));
  return r ? r.name : null;
}

// Pipeline caveats from the validation (pieces/05-pipeline/VALIDATION.md section 3-4), shown with the reef readout when they apply.
export function pipelineCaveats(p) {
  const C = [];
  if (p.hs >= 2 && p.hs <= 3) C.push('At 2-3 m the reef name tends to read one reef too far out (satellite checks and published reef lore put Second Reef nearer 3.5 m).');
  if (p.tp >= 16 && p.dir >= 280 && p.dir <= 305) C.push('Long-period (16-20 s) WNW swell: these breaks are not supported by the evidence (the model can jump to Third Reef and beyond).');
  if (p.hs > 4) C.push('Nothing above about 4 m was checked: no clear satellite day that big.');
  return C;
}

const compass = b => ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(((b % 360) + 360) % 360 / 22.5) % 16];

// Readout lines (HTML) for one hour. p: inputs {hs, tp, dir, tide, kind}; r: exactResult() or interpolate() output.
export function readout(p, r) {
  const L = [], pipe = r.site === 'pipeline';
  L.push(`Swell <b>${p.hs.toFixed(1)} m</b>, <b>${p.tp.toFixed(1)} s</b>${p.kind === 'peak' ? '' : ` <span class="flag">(${p.kind.startsWith('peak') ? 'whole-sea peak' : 'mean period'})</span>`}, from <b>${Math.round(p.dir)}&deg; ${compass(p.dir)}</b>`);
  L.push(pipe ? `Tide <b>${p.tide >= 0 ? '+' : ''}${p.tide.toFixed(2)} m</b> above local mean sea level (CO-OPS Honolulu MSL taken as LMSL at Pipeline, not checked)`
    : `Tide <b>${p.tide.toFixed(2)} m</b> above lowest tide (&plusmn; ${DATUM_UNC} datum)`);
  L.push(r.source === 'exact' ? '<span class="src">Model run for this hour (exact Stage A).</span>'
    : '<span class="src">Interpolated from the precomputed table (the snapshot has no run for this hour).</span>');
  const out = Object.entries(r.clamped || {}).filter(([, v]) => v).map(([k]) => ({ hs: 'height', tp: 'period', dir: 'direction', tide: 'tide' }[k]));
  if (out.length) L.push(r.source === 'exact'
    ? `<span class="flag">Outside the range the model was set up and checked for (${out.join(', ')}): run as given, but treat it with caution${out.includes('direction') ? ' (the model box does not contain the coast that shelters the spot from this direction)' : ''}.</span>`
    : `<span class="flag">Outside the modelled range (${out.join(', ')}): shown at the edge of the range.</span>`);
  if (r.status === 'reef' && pipe) {
    const fromShore = r.breakHouse - r.shoreS, rel = r.takeoffS != null ? r.breakHouse - r.takeoffS : NaN, reef = reefName(fromShore, r.reefs);
    L.push(`Modelled first break straight out from the take-off: <b>${Math.round(fromShore)} m</b> from the shoreline` +
      (Number.isFinite(rel) ? ` (${Math.abs(Math.round(rel))} m ${rel >= 0 ? 'outside' : 'inside'} the published take-off)` : '') + (reef ? `: <b>${reef}</b>` : ''));
    pipelineCaveats(p).forEach(c => L.push(`<span class="flag">${c}</span>`));
    if (r.lowConfidence) L.push(`<span class="flag">Low confidence: neighbouring table cases put it between ${Math.round(r.cornerMin - r.shoreS)} and ${Math.round(r.cornerMax - r.shoreS)} m from the shoreline (the break jumps between reefs here).</span>`);
    if (Number.isFinite(r.breakerHHouse)) L.push(`Breaker height there: <b>${r.breakerHHouse.toFixed(1)} m</b> (model, regular wave of the forecast swell height)`);
    if (Number.isFinite(r.peelAngleNear)) L.push(`Peel angle near the take-off: <b>${Math.round(r.peelAngleNear)}&deg;</b> (order of magnitude)`);
  } else if (r.status === 'reef') {
    L.push(`Modelled first break on the house line: <b>${Math.round(r.breakHouse)} m</b> from the house`);
    if (r.lowConfidence) L.push(`<span class="flag">Low confidence: neighbouring table cases put it between ${Math.round(r.cornerMin)} and ${Math.round(r.cornerMax)} m (the break jumps between reef sections here).</span>`);
    if (Number.isFinite(r.breakerHHouse)) L.push(`Breaker height there: <b>${r.breakerHHouse.toFixed(1)} m</b> (model, regular wave)`);
    if (Number.isFinite(r.peelAngleNear)) L.push(`Peel angle near the house: <b>${Math.round(r.peelAngleNear)}&deg;</b> (crest vs break line; under ~30&deg; is close to closing out; order of magnitude)`);
  } else if (r.status === 'edge') {
    L.push(pipe ? '<b>Not breaking on the reef</b> straight out from the take-off: the wave only reaches the breaking depth at the shoreline (shore break).'
      : '<b>Not breaking on the reef</b> on the house line: the wave only reaches the breaking depth at the water\'s edge (shore or dry rock).');
  } else {
    L.push(pipe ? '<b>Not breaking on the reef</b> straight out from the take-off for this swell: the model breaks it elsewhere (see the line), or not at all.'
      : '<b>Not breaking on the reef</b> on the house line for this swell: the model breaks it elsewhere on the reef (see the line), or not at all.');
  }
  return L;
}
