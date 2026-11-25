// Oceany globe: "Wonders" tour (2026-11-25). A button in the bar flies the camera round the Earth's beauty points
// (wonders.json): an eased flight to each stop, then a slow orbit of a few seconds, with a caption that teaches one true,
// checkable thing there. Next / previous, play / pause; any touch, drag, wheel or key on the globe pauses it.
//
// Self-contained: it does not edit globe.js. It waits for window.__globe and drives the same camera rig the globe's own
// flyTo moves (view.n, view.alt, view.pitch through view.manual, view.heading), with the same flight shape: cubic ease,
// altitude eased on a log scale, a hop up and over on long flights, and the landing tiles prefetched (terrain.prefetch).
// The globe's own systems keep working: its ground floor still lifts the camera over high ground (we adopt the lift),
// and spin, zoom and north-up easing are held still while a flight or orbit runs.
//
// Desktop: cinematic, low and tilted. Phone (globe LITE): a little higher and flatter (fewer tiles, smoother), a compact
// caption at the top over the sky, never over most of the globe.

const RADIUS = 1, KM = 1 / 6371, D2R = Math.PI / 180;
const qs = new URLSearchParams(location.search);

const waitGlobe = (ms = 30000) => new Promise((ok, no) => {
  const t0 = performance.now();
  (function poll() {
    const G = window.__globe;
    if (G && G.view && G.zoom && G.THREE) return ok(G);
    if (performance.now() - t0 > ms) return no(new Error('globe not ready'));
    setTimeout(poll, 100);
  })();
});

const css = `
/* b60 (Benn on iPhone, b59: "way too big, you can't even see the wonders"): while the tour runs the globe fills the screen:
   everything on the page except the globe canvas and the tour strip is hidden (bar, zoom stack, notices, cards, labels),
   and put back exactly when the tour ends. The strip is small, at the bottom, and carries the safety line itself. */
body.wonders-on > *:not(#globe):not(#wonders-cap):not(script):not(style):not(link) { visibility: hidden !important; pointer-events: none !important; }
#wonders-cap { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(14px + env(safe-area-inset-bottom, 0px)); z-index: 7;
  width: min(560px, calc(100vw - 16px)); box-sizing: border-box; padding: 8px 10px 6px 14px; border-radius: 12px; cursor: pointer;
  background: color-mix(in srgb, var(--bg, #04060a) 58%, transparent); border: 1px solid color-mix(in srgb, var(--open, #5ff2ff) 16%, transparent);
  color: var(--ink, #cfe6f2); font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px); transition: opacity .35s; }
#wonders-cap[hidden] { display: none; }
#wonders-cap.fade { opacity: 0; }
#wonders-cap .w-top { display: flex; align-items: center; gap: 6px; }
#wonders-cap .w-name { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#wonders-cap .w-n { font-size: 10.5px; color: var(--dim, #6b8696); margin-left: 6px; font-weight: 400; }
#wonders-cap .w-top button { all: unset; cursor: pointer; width: 30px; height: 30px; border-radius: 15px; flex: none;
  display: inline-flex; align-items: center; justify-content: center; font-size: 13px; color: var(--ink, #cfe6f2); }
#wonders-cap .w-top button:hover, #wonders-cap .w-top button:focus-visible { background: color-mix(in srgb, var(--open, #5ff2ff) 16%, transparent); }
#wonders-cap .w-line { font-size: 13px; color: color-mix(in srgb, var(--ink, #cfe6f2) 88%, transparent); margin-top: 1px;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; transition: opacity .4s; }
#wonders-cap.short .w-line { -webkit-line-clamp: 1; opacity: .75; }
#wonders-cap .w-data { display: none; font-size: 11.5px; color: var(--dim, #6b8696); margin-top: 4px; }
#wonders-cap.open .w-line { -webkit-line-clamp: unset; opacity: 1; }
#wonders-cap.open .w-data { display: block; }
#wonders-cap .w-bar { height: 2px; background: color-mix(in srgb, var(--open, #5ff2ff) 10%, transparent); border-radius: 1px; margin-top: 5px; overflow: hidden; }
#wonders-cap .w-bar i { display: block; height: 100%; width: 0; background: var(--open, #5ff2ff); opacity: .6; }
#wonders-cap .w-legal { font-size: 10px; color: color-mix(in srgb, #fff 70%, transparent); margin-top: 3px; }
#wonders-cap .w-live { display: none; }
#wonders-cap.live .w-live { display: inline; }
@media (max-width: 600px) { #wonders-cap { bottom: calc(12px + env(safe-area-inset-bottom, 0px)); padding: 6px 6px 5px 12px; } #wonders-cap .w-top button { width: 32px; height: 32px; } }
#wonders-pill { all: unset; position: fixed; left: 8px; top: calc(62px + env(safe-area-inset-top, 0px)); z-index: 4; cursor: pointer;
  min-height: 44px; padding: 0 14px; box-sizing: border-box; display: inline-flex; align-items: center; gap: 7px; border-radius: 22px;
  font: 13px system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink, #cfe6f2);
  background: color-mix(in srgb, var(--bg, #04060a) 80%, transparent); border: 1px solid color-mix(in srgb, var(--open, #5ff2ff) 30%, transparent); }
#wonders-pill::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--open, #5ff2ff); box-shadow: 0 0 6px var(--open, #5ff2ff); }
#wonders-pill[hidden] { display: none; }
`;

function el(tag, attrs = {}, kids = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) if (k === 'text') e.textContent = v; else e.setAttribute(k, v);
  for (const k of kids) e.appendChild(k);
  return e;
}

const KIND = { mountain: 'Mountains', seafloor: 'Ocean floor', coast: 'Coasts and reefs', surf: 'Surf spot', wonder: 'Wonder' };
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));

export async function startWonders() { return (await init()).play(0); }
let api = null;
export async function init() {
  if (api) return api;
  const G = await waitGlobe();
  const { THREE, view, zoom } = G;
  const LITE = !!G.LITE;
  const { stops } = await (await fetch(new URL('./wonders.json', import.meta.url), { cache: 'no-cache' })).json();

  // profile: phone higher (×1.35) and flatter (×0.85 tilt), shorter flights, slower orbit
  const P = LITE ? { alt: 1.35, pitch: 0.85, fly: [1900, 2200], orbitDeg: 3, hold: 7000 } : { alt: 1, pitch: 1, fly: [2400, 2800], orbitDeg: 4, hold: 9000 };
  if (qs.get('wondersHold')) P.hold = Math.max(800, +qs.get('wondersHold'));   // tests: shorter stops

  const dirOf = (lat, lon) => G.latLonToVector3(lat, lon, 1).normalize();
  const camOf = s => {
    const ph = LITE && s.phone;                       // a stop's own phone view, where the scaled one did not read (visual review)
    return { dir: dirOf(s.lat, s.lon), alt: (ph && ph.altKm ? ph.altKm : s.altKm * P.alt) * KM,
      pitch: Math.min(80, ph && ph.pitch ? ph.pitch : s.pitch * P.pitch) * D2R, heading: (s.heading || 0) * D2R };
  };

  // ---------- UI ----------
  document.head.appendChild(el('style', { text: css }));
  const nameT = el('span'), num = el('span', { class: 'w-n' }), name = el('div', { class: 'w-name' }, [nameT, num]);
  const line = el('div', { class: 'w-line' }), data = el('div', { class: 'w-data' });
  const bPrev = el('button', { type: 'button', 'aria-label': 'Previous wonder', title: 'Previous (←)', text: '‹' });
  const bPlay = el('button', { type: 'button', 'aria-label': 'Pause', title: 'Play / pause (space)', text: '❚❚' });
  const bNext = el('button', { type: 'button', 'aria-label': 'Next wonder', title: 'Next (→)', text: '›' });
  const bClose = el('button', { type: 'button', class: 'w-close', 'aria-label': 'End the wonders tour', title: 'End the tour (Esc)', text: '✕' });
  const barFill = el('i');
  const cap = el('section', { id: 'wonders-cap', 'aria-label': 'Wonders of the Earth', 'aria-live': 'polite', title: 'Tap for more', hidden: '' }, [
    el('div', { class: 'w-top' }, [name, bPrev, bPlay, bNext, bClose]), line, data,
    el('div', { class: 'w-bar' }, [barFill]),
    el('div', { class: 'w-legal' }, [el('span', { text: 'For research and play only. Not a forecast or warning service.' }),
      el('span', { class: 'w-live', text: ' Not an official product. Do not use for safety decisions.' })]),
  ]);
  document.body.appendChild(cap);

  // the bar button, just before "?" (help). Where the bar has no room for it (phones: one full row), it sits instead as a
  // small pill just under the bar, top left (the bottom is the welcome card's and the standing notice's), hidden while the tour runs (the caption has the controls) or while the
  // globe's own bottom button ("Open in 3D") is up.
  const bar = document.getElementById('bar');
  let btn = document.getElementById('wonders-btn');
  const pill = el('button', { type: 'button', id: 'wonders-pill', 'aria-pressed': 'false', title: 'Wonders: fly round the Earth’s most beautiful places', text: 'Wonders' });
  document.body.appendChild(pill);
  if (!btn && bar) {
    btn = el('button', { type: 'button', id: 'wonders-btn', 'aria-pressed': 'false', title: 'Wonders: fly round the Earth’s most beautiful places', text: 'Wonders' });
    const help = document.getElementById('help-btn');
    if (help && help.parentNode === bar) bar.insertBefore(btn, help); else bar.appendChild(btn);
  }
  const openSpot = document.getElementById('open-spot'), compass = document.getElementById('compass');
  function place() {
    let fits = !!btn;
    if (btn) {
      btn.style.display = '';
      const b = btn.getBoundingClientRect(), r = bar.getBoundingClientRect(), c = compass && compass.getBoundingClientRect();
      fits = b.right <= r.right + 1 && b.right <= innerWidth - 8 && !(c && c.width && b.right > c.left - 4 && b.top < c.bottom);
      btn.style.display = fits ? '' : 'none';
    }
    pill.hidden = fits || S.on || !!(openSpot && !openSpot.hidden);
  }

  // ---------- state ----------
  const S = { on: false, playing: false, i: 0, phase: 'idle', t0: 0, fl: null, orbit: null, lift: 0, wrote: null, raf: 0, last: 0 };

  function show(i) {
    const s = stops[i];
    cap.classList.add('fade');
    clearTimeout(S.shortT);
    setTimeout(() => {
      nameT.textContent = s.name; num.textContent = `${i + 1}/${stops.length}`;
      line.textContent = s.line; data.textContent = s.data || '';
      cap.classList.remove('fade', 'short', 'open');
      S.shortT = setTimeout(() => { if (!cap.classList.contains('open')) cap.classList.add('short'); }, 8000);   // the fact folds to one line
    }, 180);
  }
  function setPlaying(p) {
    S.playing = p; bPlay.textContent = p ? '❚❚' : '▶'; bPlay.setAttribute('aria-label', p ? 'Pause' : 'Play');
  }

  // hold the globe's own movers still while we steer: spin, follow, zoom easing, north-up easing (see globe.js frame)
  function quiet(now) {
    if (G.spin) { G.spin.k = 0; G.spin.quietUntil = now + 1500; }
  }
  function releaseFollow() {
    if (!G.follow) return;
    if (typeof G.releaseFollow === 'function') { G.releaseFollow(); return; }
    // no hook yet: a one-pixel drag on the canvas is the globe's own "let go of the storm" (pointermove → releaseFollow)
    const c = document.getElementById('globe'); if (!c) return;
    const x = innerWidth / 2, y = innerHeight / 2, o = { bubbles: true, pointerId: 77, pointerType: 'mouse', button: 0, isPrimary: true };
    S.synthetic = true;
    c.dispatchEvent(new PointerEvent('pointerdown', { ...o, clientX: x, clientY: y }));
    c.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: x + 1, clientY: y }));
    c.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: x + 1, clientY: y }));
    S.synthetic = false;
  }

  function write(n, alt, pitch, heading) {
    // the globe's floor (applyView) may have lifted the camera over high ground since our last write: keep that lift
    // (only low down, and capped: a clamp of the zoom range is not a lift)
    // (not while leaving a stop: the floor there lets go as the camera climbs; a lift kept then would ride the whole flight)
    const leaving = S.phase === 'fly' && S.fl && performance.now() - S.fl.t0 < S.fl.dur / 2;
    S.pushed = !leaving && S.wrote && Number.isFinite(view.alt) && view.alt > S.wrote.alt * 1.002 && S.wrote.alt < 0.05;
    if (S.pushed) S.lift = Math.min(150 * KM, S.lift + view.alt - S.wrote.alt);
    const a = Math.max(1e-5, alt + S.lift);
    view.n.copy(n).normalize();
    view.heading = heading;                            // after n: heading is set in n's frame
    view.alt = a; zoom.target = a; zoom.cursor = null;
    view.manual = pitch; view.pitch = pitch;
    S.wrote = { alt: a };
  }
  const here = () => ({ dir: view.n.clone().normalize(), alt: Number.isFinite(view.alt) ? view.alt : 2.6, pitch: view.pitch || 0, heading: view.heading || 0 });

  function flyTo(i) {
    S.i = (i + stops.length) % stops.length;
    const s = stops[S.i], to = camOf(s), from = here();
    const angle = from.dir.angleTo(to.dir);
    const dur = P.fly[0] + P.fly[1] * Math.min(1, angle / Math.PI);
    S.fl = { from, to, angle, t0: performance.now(), dur, q: new THREE.Quaternion().setFromUnitVectors(from.dir, to.dir) };
    S.lift = 0; S.wrote = null; S.phase = 'fly';
    if (G.terrain && G.terrain.enabled && G.terrain.prefetch) try { G.terrain.prefetch(s.lat, s.lon, to.alt); } catch (e) { /* best effort */ }
    show(S.i);
    barFill.style.width = '0';
  }
  const tmpQ = new THREE.Quaternion(), idQ = new THREE.Quaternion(), tmpV = new THREE.Vector3();
  function stepFly(now) {
    const f = S.fl, t = Math.max(0, Math.min(1, (now - f.t0) / f.dur)), e = ease(t);
    tmpQ.copy(idQ).slerp(f.q, e);
    tmpV.copy(f.from.dir).applyQuaternion(tmpQ);
    const hop = Math.min(1.8, 0.4 * f.angle + 0.5 * f.angle * f.angle) * Math.sin(Math.PI * e);
    const a = Math.exp(Math.log(f.from.alt) + (Math.log(f.to.alt) - Math.log(f.from.alt)) * e) + hop;
    // tilt: level out while high (up to the hop's top), then tilt into the landing view
    const high = smooth((a - 0.15) / 0.35);
    const pitch = (f.from.pitch + (f.to.pitch - f.from.pitch) * e) * (1 - high);
    // facing: from where we were to the stop's heading; north up while high (as the globe's own northFrame wants)
    const h0 = f.from.heading, h = h0 + wrap(f.to.heading - h0) * e;
    const heading = h * (1 - high);
    write(tmpV, a, pitch, heading);
    if (t >= 1) { S.phase = 'orbit'; S.orbit = { t0: now, h: f.to.heading, dir: f.to.dir.clone(), alt: f.to.alt, pitch: f.to.pitch }; }
  }
  function stepOrbit(now, dt) {
    const o = S.orbit;
    if (S.playing) o.h += P.orbitDeg * D2R * dt;
    if (!S.pushed) S.lift *= Math.exp(-dt * 0.3);       // the floor did not push this frame: let the lift go slowly (tiles loaded)
    write(o.dir, o.alt, o.pitch, o.h);
    const k = Math.min(1, (now - o.t0) / P.hold);
    barFill.style.width = (k * 100).toFixed(1) + '%';
    if (S.playing && k >= 1) flyTo(S.i + 1);
  }

  function loop(now) {
    if (!S.on) return;
    S.raf = requestAnimationFrame(loop);
    const dt = Math.max(0, Math.min(0.1, (now - (S.last || now)) / 1000)); S.last = now;
    // another mover took the camera: the gesture tour, a storm flight or a spot flight from the globe
    if ((G.TOUR && G.TOUR.on) || G.flight || G.follow) { pause(); return; }
    if (!S.playing && S.phase !== 'fly') { if (S.orbit) S.orbit.t0 += dt * 1000; return; }   // paused: the camera is the visitor's
    quiet(now);
    // a spot's card pops up as the camera lands near it (surf stops); while the tour plays it would cover the view, so it
    // stays shut until the visitor pauses (then the globe's own cards and "Open in 3D" work as usual)
    if (G.POP && G.POP.r && G.popClose) try { G.popClose(); } catch (e) { /* ignore */ }
    if (S.phase === 'fly') stepFly(now); else if (S.phase === 'orbit') stepOrbit(now, dt);
  }

  // ---------- controls ----------
  // live and model layers (globe.js NOTICE.liveIds): off while the tour runs, so the safety line they need is not needed,
  // and back on as they were when it ends. Through each layer's own checkbox, so the globe's state stays in step.
  const LIVE = new Set(['hurricanes', 'hurricanes-live', 'tornado-live', 'aurora', 'quakes-live', 'snow', 'wind', 'waves', 'swell']);
  const boxOf = l => l.userData && l.userData.row && l.userData.row.querySelector('input[type=checkbox]');
  function clearScreen(on) {
    document.body.classList.toggle('wonders-on', on);
    if (on) {
      S.layersOff = [];
      for (const l of G.layers || []) {
        if (!l.visible || !LIVE.has(l.userData.layerId)) continue;
        const b = boxOf(l);
        if (b) { b.checked = false; b.dispatchEvent(new Event('change')); } else l.visible = false;
        S.layersOff.push(l);
      }
    } else {
      for (const l of S.layersOff || []) {
        const b = boxOf(l);
        if (b) { b.checked = true; b.dispatchEvent(new Event('change')); } else l.visible = true;
      }
      S.layersOff = [];
    }
    liveLine();
  }
  const liveLine = () => cap.classList.toggle('live', (G.layers || []).some(l => l.visible && LIVE.has(l.userData.layerId)));
  function start(i = 0) {
    if (G.TOUR && G.TOUR.g && G.TOUR.g.on) try { G.TOUR.g.end(); } catch (e) { /* ignore */ }
    if (G.popClose) try { G.popClose(); } catch (e) { /* ignore */ }
    const w = document.getElementById('welcome'); if (w && !w.hidden) w.hidden = true;
    releaseFollow();
    // the tour is about relief: ground detail on, as zooming in turns it on (globe.js zoom); it stays on after, as there
    const tb = document.getElementById('terrain-toggle');
    if (tb && !tb.checked && !(G.terrain && G.terrain.enabled)) { tb.checked = true; tb.dispatchEvent(new Event('change')); }
    clearScreen(true);
    S.on = true; cap.hidden = false; if (btn) btn.setAttribute('aria-pressed', 'true'); place();
    setPlaying(true); S.last = 0;
    flyTo(i);
    cancelAnimationFrame(S.raf); S.raf = requestAnimationFrame(loop);
  }
  function stop() {
    S.on = false; S.phase = 'idle'; cancelAnimationFrame(S.raf);
    clearScreen(false);
    cap.hidden = true; if (btn) btn.setAttribute('aria-pressed', 'false'); place();
    view.manual = null; zoom.target = view.alt;     // tilt back to automatic; the zoom carries on from here
  }
  function pause() {
    if (!S.on) return;
    if (S.phase === 'fly') { S.phase = 'orbit'; S.orbit = { t0: performance.now(), ...here(), h: view.heading, dir: view.n.clone() }; }
    setPlaying(false);
  }
  function resume() {
    if (!S.on) return;
    setPlaying(true);
    // the visitor may have moved: fly back to this stop rather than jump
    const o = S.orbit, moved = !o || view.n.angleTo(o.dir) > 1e-4 || Math.abs(view.alt - (o.alt + S.lift)) > 1e-5;
    if (moved) flyTo(S.i); else S.orbit.t0 = performance.now() - (S.orbit.t0 ? 0 : 0);
  }
  function go(d) { if (!S.on) start(0); setPlaying(true); flyTo(S.i + d); }

  if (btn) btn.onclick = () => { if (S.on) stop(); else start(0); };
  pill.onclick = () => start(0);
  place(); addEventListener('resize', place);
  if (openSpot) new MutationObserver(place).observe(openSpot, { attributes: true, attributeFilter: ['hidden'] });
  bPrev.onclick = () => go(-1);
  bNext.onclick = () => go(1);
  bPlay.onclick = () => { S.playing ? pause() : resume(); };
  bClose.onclick = () => stop();
  cap.addEventListener('click', e => { if (e.target.closest('button')) return; cap.classList.toggle('open'); cap.classList.remove('short'); });

  // any touch, drag or wheel on the globe pauses (the visitor takes the camera)
  const canvas = document.getElementById('globe');
  const userTouch = () => { if (S.on && !S.synthetic && S.playing) pause(); };
  if (canvas) {
    canvas.addEventListener('pointerdown', userTouch, true);
    canvas.addEventListener('wheel', userTouch, { capture: true, passive: true });
    canvas.addEventListener('touchstart', userTouch, { capture: true, passive: true });
  }
  // the globe's own zoom and tilt controls count as touch too
  const zb = document.getElementById('zoom'); if (zb) zb.addEventListener('pointerdown', userTouch, true);
  addEventListener('keydown', e => {
    if (!S.on || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === 'Escape') { stop(); e.preventDefault(); }
    else if (e.key === 'ArrowRight' && !cap.contains(t) || e.key === 'PageDown') { go(1); e.preventDefault(); }
    else if (e.key === 'ArrowLeft' && !cap.contains(t) || e.key === 'PageUp') { go(-1); e.preventDefault(); }
    else if (e.key === ' ' && (t === document.body || cap.contains(t))) { S.playing ? pause() : resume(); e.preventDefault(); }
    else if (/^Arrow|^[+\-=wasdqe]$/i.test(e.key)) pause();   // the globe's keyboard moves: the visitor takes over
  }, true);

  api = { stops, start, stop, pause, resume, next: () => go(1), prev: () => go(-1), play: i => start(i || 0), state: S, profile: LITE ? 'phone' : 'desktop' };
  window.__wonders = api;
  if (qs.get('wonders') === '1' || qs.get('wonders') === 'play') setTimeout(() => start(+(qs.get('wondersAt') || 0)), 400);
  return api;
}

init().catch(e => console.error('Oceany wonders: not started', e));
