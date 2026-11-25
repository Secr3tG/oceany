// The forecast time bar: one shared clock for the ocean layers, and the bar at the bottom of the screen that moves it.
// It shows while the wave layer OR the wind layer is on (timeBar.need(owner, on), a refcount), and both follow the
// same clock with onTime(), so Waves and Wind together scrub and play in sync.
//
//   import { timeBar } from './forecast_bar.js'
//   timeBar.setSteps(steps, { model, run, partitions })   steps: [{ fh, valid (ms) }], sorted
//   timeBar.need('waves' | 'wind', on)   show while any owner needs it;  timeBar.time  (ms, the valid time shown);  timeBar.onTime(cb)
//   timeBar.setReadout(text)   phone: the values under the centre of the globe
//
// Play runs the clock at PLAY_RATE (6 forecast hours per second), the same time-lapse the swell dots use, so while it
// plays, the dots travel exactly as far as the swell energy would in that time.
import { HS_STOPS, hsX } from './wave_colours.js';

export const PLAY_RATE = 6 * 3600e3;            // forecast ms per real second (6 h per s: 7 days in about half a minute)
const H = 3600e3;
const SAFETY_LINE = 'Model output, not measurement. For research and play only. Not a forecast or warning service. Not an official product. Do not use for safety decisions.';

const css = `
#wavebar { position: fixed; left: 50%; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); z-index: 6;
  width: min(780px, calc(100vw - 200px)); box-sizing: border-box; padding: 8px 14px 7px; border-radius: 12px; color: var(--ink, #cfe6f2);
  background: color-mix(in srgb, var(--panel, #060e16) 80%, transparent); border: 1px solid color-mix(in srgb, var(--open, #5ff2ff) 15%, transparent);
  backdrop-filter: blur(6px); font: 12px/1.35 system-ui, -apple-system, sans-serif; user-select: none; -webkit-user-select: none; }
#wavebar[hidden] { display: none; }
#wavebar .wb-row { display: flex; align-items: center; gap: 10px; }
#wavebar .wb-play { all: unset; cursor: pointer; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; flex: none;
  color: var(--open, #5ff2ff); border: 1px solid color-mix(in srgb, var(--open, #5ff2ff) 40%, transparent); }
#wavebar .wb-play:hover, #wavebar .wb-play:focus-visible { background: color-mix(in srgb, var(--open, #5ff2ff) 12%, transparent); }
#wavebar .wb-play svg { width: 12px; height: 12px; fill: currentColor; }
#wavebar .wb-track { position: relative; flex: 1; height: 34px; }
#wavebar input[type=range] { position: absolute; left: 0; right: 0; top: 4px; width: 100%; margin: 0; height: 20px; background: transparent; -webkit-appearance: none; appearance: none; cursor: pointer; }
#wavebar input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--open, #5ff2ff) 18%, transparent); }
#wavebar input[type=range]::-moz-range-track { height: 4px; border-radius: 2px; background: color-mix(in srgb, var(--open, #5ff2ff) 18%, transparent); }
#wavebar input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%; background: var(--open, #5ff2ff); box-shadow: 0 0 8px var(--open, #5ff2ff); }
#wavebar input[type=range]::-moz-range-thumb { width: 14px; height: 14px; border: 0; border-radius: 50%; background: var(--open, #5ff2ff); box-shadow: 0 0 8px var(--open, #5ff2ff); }
#wavebar .wb-days { position: absolute; left: 0; right: 0; top: 21px; height: 12px; pointer-events: none; font-size: 10px; color: var(--dim, #6b8696); }
#wavebar .wb-days span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
#wavebar .wb-days i { position: absolute; top: -9px; width: 1px; height: 5px; background: color-mix(in srgb, var(--open, #5ff2ff) 30%, transparent); }
#wavebar .wb-now { position: absolute; top: 2px; width: 2px; height: 10px; margin-left: -1px; border-radius: 1px; background: #fff; opacity: .8; pointer-events: none; }
#wavebar .wb-lo { position: absolute; top: 6px; height: 4px; border-radius: 2px; pointer-events: none;
  background: repeating-linear-gradient(90deg, transparent 0 3px, color-mix(in srgb, var(--open, #5ff2ff) 35%, transparent) 3px 5px); }
#wavebar .wb-when { min-width: 13.5em; text-align: right; font-variant-numeric: tabular-nums; flex: none; }
#wavebar .wb-when b { font-weight: 600; color: #fff; }
#wavebar .wb-when small, #wavebar .wb-foot { color: var(--dim, #6b8696); font-size: 10.5px; }
#wavebar .wb-legend { display: flex; align-items: center; gap: 8px; margin-top: 4px; }
#wavebar .wb-scale { position: relative; flex: 1; height: 8px; border-radius: 4px; }
#wavebar .wb-ticks { position: relative; flex: 1; height: 11px; font-size: 9.5px; color: var(--dim, #6b8696); }
#wavebar .wb-ticks span { position: absolute; transform: translateX(-50%); white-space: nowrap; }
#wavebar.no-waves .wb-sw, #wavebar.no-waves .wb-title { display: none; }
#wavebar .wb-key { font-size: 10.5px; color: var(--dim, #6b8696); white-space: nowrap; }
#wavebar .wb-foot { margin-top: 3px; display: flex; gap: 10px; justify-content: space-between; }
#wavebar .wb-busy { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: var(--open, #5ff2ff); opacity: 0; transition: opacity .2s; margin-left: 6px; vertical-align: middle; }
#wavebar.loading .wb-busy { opacity: .9; animation: wbpulse 0.9s infinite alternate; }
@keyframes wbpulse { to { opacity: .2; } }
#wavebar .wb-read { display: none; }
#wavebar.single .wb-track, #wavebar.single .wb-play { display: none; }
#wavebar.single .wb-row { justify-content: flex-start; }
#wavebar.single .wb-when { text-align: left; }
/* while the bar shows: the globe's bottom-centre hint hides, and bottom UI moves up by the bar's height
   (--wavebar-h, measured). Kept here so the globe's own files need no change; see review/waves-2026-11-25/HOOKS.md */
body.ocean-timebar #hint { display: none; }
body.ocean-timebar #open-spot, body.ocean-timebar #welcome { bottom: calc(var(--wavebar-h, 100px) + 22px) !important; }
@media (max-width: 600px) {
  body.ocean-timebar #zoom { bottom: calc(var(--wavebar-h, 90px) + 14px) !important; }
  #wavebar { width: calc(100vw - 16px); max-width: calc(100vw - 16px); overflow: hidden; bottom: calc(6px + env(safe-area-inset-bottom, 0px)); padding: 6px 10px 5px; border-radius: 10px; }
  #wavebar .wb-row { gap: 8px; }
  #wavebar .wb-play { width: 34px; height: 34px; }
  #wavebar .wb-when { min-width: 0; font-size: 11px; }
  #wavebar .wb-when small { display: none; }
  #wavebar .wb-key, #wavebar .wb-legend .wb-title { display: none; }
  #wavebar .wb-legend { margin-top: 2px; }
  #wavebar .wb-foot .wb-model { display: none; }
  #wavebar .wb-foot { font-size: 9.5px; margin-top: 2px; }
  #wavebar .wb-read { display: block; font-size: 11px; margin-top: 2px; min-height: 1.35em; color: var(--ink, #cfe6f2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
}`;

const PLAY = '<svg viewBox="0 0 12 12"><path d="M2 1l9 5-9 5z"/></svg>';
const PAUSE = '<svg viewBox="0 0 12 12"><path d="M2 1h3v10H2zM7 1h3v10H7z"/></svg>';
const DAY = (d) => d.toLocaleDateString(undefined, { weekday: 'short' });
const pad = (n) => String(n).padStart(2, '0');
const local = (ms) => { const d = new Date(ms); return `${d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}, ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const utc = (ms) => { const d = new Date(ms); return `${pad(d.getUTCDate())} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`; };

function makeBar() {
  const subs = new Set(), owners = new Set(), labels = new Map();   // labels: owner -> its model's name
  let steps = [], info = {}, t = Date.now(), playing = false, last = 0, el = null, raf = 0, dragging = false;
  const t0 = () => steps.length ? steps[0].valid : Date.now(), t1 = () => steps.length ? steps[steps.length - 1].valid : Date.now();
  const clamp = (x) => Math.max(t0(), Math.min(t1(), x));
  const emit = () => { for (const f of subs) { try { f(t); } catch (e) { /* a layer's own problem */ } } };

  function build() {
    if (el) return;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    el = document.createElement('div'); el.id = 'wavebar'; el.hidden = true;
    el.setAttribute('role', 'group'); el.setAttribute('aria-label', 'Forecast time');
    const stops = HS_STOPS.map(([h, c]) => `${c} ${(hsX(h) * 100).toFixed(1)}%`).join(', ');
    const ticks = [0, 1, 2, 3, 4, 6, 8, 12].map((h) => `<span style="left:${(hsX(h) * 100).toFixed(1)}%">${h}${h === 12 ? '+ m' : ''}</span>`).join('');
    el.innerHTML = `
      <div class="wb-row">
        <button class="wb-play" type="button" aria-label="Play the forecast">${PLAY}</button>
        <div class="wb-track"><div class="wb-lo"></div><input type="range" min="0" max="1" step="0.25" value="0" aria-label="Forecast valid time">
          <div class="wb-now" title="Now"></div><div class="wb-days"></div></div>
        <div class="wb-when" aria-live="off"><b class="wb-t"></b><span class="wb-busy" title="Loading this step"></span><br><small class="wb-sub"></small></div>
      </div>
      <div class="wb-legend"><span class="wb-key wb-title">Wave height</span>
        <div class="wb-sw" style="flex:1;margin:0 16px 0 4px"><div class="wb-scale" style="background:linear-gradient(90deg, ${stops})"></div><div class="wb-ticks">${ticks}</div></div>
        <span class="wb-key wb-dots"></span></div>
      <div class="wb-read"></div>
      <div class="wb-foot"><span class="wb-safe">${SAFETY_LINE}</span><span class="wb-model"></span></div>`;
    document.body.appendChild(el);
    const range = el.querySelector('input'), btn = el.querySelector('.wb-play');
    btn.onclick = () => (playing ? pause() : play());
    range.addEventListener('input', () => { pause(); dragging = true; set(steps.length ? t0() + Number(range.value) * H : t); });
    range.addEventListener('change', () => { dragging = false; });
    // keep the globe's own keys and drags away from the bar
    for (const ev of ['pointerdown', 'wheel', 'keydown']) el.addEventListener(ev, (e) => e.stopPropagation(), { passive: ev === 'wheel' });
    addEventListener('keydown', (e) => {
      if (el.hidden || e.target.closest?.('input, textarea, select') && e.target !== range) return;
      if (e.key === ' ' && e.target === document.body) { e.preventDefault(); playing ? pause() : play(); }
    });
    matchMedia('(max-width: 600px)').addEventListener('change', layout);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => document.body.style.setProperty('--wavebar-h', el.offsetHeight + 'px')).observe(el);
  }

  function layout() {
    if (!el || !steps.length) return;
    el.classList.toggle('single', steps.length < 2);       // no forecast steps (snapshot fallback): no slider, no play
    if (steps.length < 2) { text(); return; }
    const range = el.querySelector('input'), span = (t1() - t0()) / H;
    range.max = String(span);
    const pct = (ms) => ((ms - t0()) / (t1() - t0()) * 100).toFixed(2) + '%';
    // day ticks at local midnight; labels at local noon (short weekday), every other day on a narrow phone
    const days = el.querySelector('.wb-days'), narrow = matchMedia('(max-width: 600px)').matches;
    let html = '', d = new Date(t0()); d.setHours(24, 0, 0, 0);
    let k = 0;
    for (; d.getTime() < t1(); d.setDate(d.getDate() + 1), k++) {
      html += `<i style="left:${pct(d.getTime())}"></i>`;
      const noon = new Date(d); noon.setHours(12);
      if (noon.getTime() < t1() && (!narrow || k % 2 === 0)) html += `<span style="left:${pct(noon.getTime())}">${DAY(noon)}</span>`;
    }
    const first = new Date(t0()); first.setHours(12, 0, 0, 0);
    if (first.getTime() > t0() + 3 * H && first.getTime() < t1()) html += `<span style="left:${pct(first.getTime())}">${DAY(first)}</span>`;
    days.innerHTML = html;
    const now = el.querySelector('.wb-now'), nowMs = Date.now();
    now.style.display = nowMs >= t0() && nowMs <= t1() ? '' : 'none'; now.style.left = pct(nowMs);
    const lo = el.querySelector('.wb-lo'), firstLo = steps.find((s) => s.res === 'lo');
    if (info.hiTo && firstLo) { lo.style.display = ''; lo.style.left = pct(info.hiTo); lo.style.right = '0'; lo.title = 'Beyond 5 days: coarser (1 degree) and less certain'; }
    else lo.style.display = 'none';
    text();
  }

  function text() {
    if (!el) return;
    const range = el.querySelector('input');
    if (!dragging && steps.length > 1) range.value = String((t - t0()) / H);
    const fh = info.run ? Math.round((t - info.run) / H) : null;
    const ahead = Math.round((t - Date.now()) / H);
    el.querySelector('.wb-t').textContent = local(t);
    el.querySelector('.wb-sub').textContent = steps.length < 2 ? `${utc(t)} · single snapshot; the forecast steps are not available here` : `${utc(t)} · ${Math.abs(ahead) < 2 ? 'now' : ahead > 0 ? `in ${fmtAhead(ahead)}` : `${fmtAhead(-ahead)} ago`}`;
    const old = info.run ? Math.round((Date.now() - info.run) / H) : 0;   // GFS runs every 6 h, ECMWF every 12 h: say when the run is older than a day
    const names = [...owners].map((o) => labels.get(o)).filter(Boolean), model = names.length ? [...new Set(names)].join(' + ') : info.model;
    el.querySelector('.wb-model').textContent = model ? `${model} · run ${utc(info.run)}${fh != null ? ` · +${fh} h` : ''}${old > 24 ? ` · run ${fmtAhead(old)} old` : ''}` : '';
    range.setAttribute('aria-valuetext', `${local(t)}, ${info.model || ''} model output`);
    const wv = owners.has('waves'), wd = owners.has('wind');
    el.classList.toggle('no-waves', !wv);
    el.querySelector('.wb-dots').textContent = [
      wv ? (info.partitions === false ? 'Lines: wave crests, mean direction' : 'Lines: swell crests, moving at the swell’s speed ×21,600') : '',
      wd ? (wv ? 'Grey streaks: wind' : 'Wind at 10 m: grey streaks along the flow, brighter = faster') : ''].filter(Boolean).join(' · ');
  }
  const fmtAhead = (h) => (h < 48 ? `${h} h` : `${Math.floor(h / 24)} d ${h % 24} h`);

  function tick(now) {
    raf = 0;
    if (!playing) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    let nt = t + dt * PLAY_RATE;
    if (nt >= t1()) nt = Math.max(t0(), Math.min(t1(), Date.now()));   // at the end, loop back to now
    set(nt);
    raf = requestAnimationFrame(tick);
  }
  function play() { if (playing || steps.length < 2) return; playing = true; last = performance.now(); el.querySelector('.wb-play').innerHTML = PAUSE; el.querySelector('.wb-play').setAttribute('aria-label', 'Pause'); raf = requestAnimationFrame(tick); }
  function pause() { if (!playing) return; playing = false; if (raf) cancelAnimationFrame(raf); raf = 0; el.querySelector('.wb-play').innerHTML = PLAY; el.querySelector('.wb-play').setAttribute('aria-label', 'Play the forecast'); }
  function set(ms) { t = clamp(ms); text(); emit(); }

  return {
    get time() { return t; },
    get playing() { return playing; },
    onTime(cb) { subs.add(cb); return () => subs.delete(cb); },
    setSteps(list, meta = {}, owner) {
      build();
      if (owner) labels.set(owner, meta.model);
      const keep = steps.length ? t : Date.now();
      steps = list; info = meta;
      t = clamp(keep);
      layout(); emit();
    },
    setLoading(on) { el?.classList.toggle('loading', !!on); },
    setReadout(s) { if (el) el.querySelector('.wb-read').textContent = s || ''; },
    need(owner, on) {
      const had = owners.has(owner);
      if (on) owners.add(owner); else owners.delete(owner);
      if (owners.size) { if (!had || el?.hidden) this.show(); else text(); } else this.hide();
    },
    get owners() { return [...owners]; },
    show() { build(); el.hidden = false; document.body.classList.add('ocean-timebar'); layout(); },
    hide() { if (!el) return; pause(); el.hidden = true; document.body.classList.remove('ocean-timebar'); },
    set,
  };
}

export const timeBar = makeBar();
