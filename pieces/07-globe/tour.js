// tour.js: gesture-teaching tours (2026-11-23, late night). Benn: the old tour "didn't show HOW to use the controls".
// Each gesture step draws a small animated cue on the globe or reef itself (a mouse cursor on desktop, a hand or finger
// rings on a touch screen, in the house dot style and --open accent), and moves the real camera with it as a demo. Then
// it is the visitor's turn: the real gesture is detected (camera moved by a threshold, with the matching input seen) and
// a small "Nice" tick shows. Then a highlight ring points at each on-screen control where it actually sits.
// Offered, never forced; Next and Skip tour always there; Escape ends it. The engine (makeTour) is shared with the reef
// viewer (pieces/01-seafloor/viewer/tutorial.js imports it); globeTour() holds the globe's steps.

const D2R = Math.PI / 180;
// Round 4 (2026-11-23): one sessionStorage key holds where the tour is, across the globe and the reef viewer:
// { page: 'globe' | 'viewer', step, next?, profile? }. page/step: the step on screen now (a reload carries on there);
// next: on the reef part, the globe step to carry on at when the visitor goes back to the globe by any route. Only
// Skip, Escape or Done (end()) remove it. Every access is in try/catch (storage can be blocked).
export const TOUR_KEY = 'oceany-tour';
export const tourKey = {
  get() { try { const m = JSON.parse(sessionStorage.getItem(TOUR_KEY)); return m && typeof m === 'object' ? m : null; } catch (e) { return null; } },
  set(m) { try { sessionStorage.setItem(TOUR_KEY, JSON.stringify({ ...m, t: Date.now() })); } catch (e) { /* storage blocked */ } },
  clear() { try { sessionStorage.removeItem(TOUR_KEY); } catch (e) { /* storage blocked */ } },
};
const smooth = t => { t = Math.max(0, Math.min(1, t)); return t * t * (3 - 2 * t); };
const CSS = `
#gtour { position: fixed; z-index: 31; box-sizing: border-box; padding: 11px 13px 10px; border-radius: 12px; color: #cfe6f2;
  font: 14px/1.4 system-ui, -apple-system, sans-serif; background: rgba(6,14,22,.9); border: 1px solid rgba(95,242,255,.28);
  backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); box-shadow: 0 6px 26px rgba(0,0,0,.45); }
#gtour[hidden] { display: none; }
#gtour .gt-top { display: flex; justify-content: space-between; align-items: center; min-height: 16px; }
#gtour .gt-n { color: #6b8696; font-size: 11px; letter-spacing: .12em; }
#gtour .gt-ok { color: var(--gt-acc); font-size: 13px; font-weight: 600; opacity: 0; transform: scale(.8); transition: opacity .25s, transform .25s; }
#gtour .gt-ok.on { opacity: 1; transform: none; }
#gtour .gt-t { margin: 4px 0 2px; }
#gtour .gt-s { margin: 0 0 8px; min-height: 18px; color: #6b8696; font-size: 12px; }
#gtour .gt-btns { display: flex; gap: 8px; justify-content: flex-end; }
#gtour button { min-height: 44px; padding: 0 16px; border-radius: 22px; font: 600 14px/1 system-ui, sans-serif; cursor: pointer; background: none;
  color: #cfe6f2; border: 1px solid rgba(107,134,150,.55); }
#gtour button.gt-next { border-color: var(--gt-acc); color: var(--gt-acc); }
#gtour button.gt-next.ready { box-shadow: 0 0 14px color-mix(in srgb, var(--gt-acc) 55%, transparent); }
#gtour button:hover, #gtour button:focus-visible { border-color: var(--gt-acc); outline: none; }
#gtour-cue { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 30; pointer-events: none; }
.gtour-ring { position: fixed; z-index: 30; pointer-events: none; box-sizing: border-box; border-radius: 12px; border: 2px dotted var(--gt-acc);
  box-shadow: 0 0 16px color-mix(in srgb, var(--gt-acc) 45%, transparent), inset 0 0 10px color-mix(in srgb, var(--gt-acc) 20%, transparent);
  animation: gtour-pulse 1.6s ease-in-out infinite; }
.gtour-ring[hidden] { display: none; }
#gtour { transition: opacity .25s ease; }
#gtour.gt-fade { opacity: 0; }
#gtour .gt-rd { display: block; height: 2px; margin: -4px 0 8px; border-radius: 1px; background: var(--gt-acc); opacity: .55; width: 0; }
#gtour .gt-rd[hidden] { display: none; }
@keyframes gtour-pulse { 50% { opacity: .55; } }
@media (prefers-reduced-motion: reduce) { .gtour-ring { animation: none; } }`;

// ---------- dot glyphs: a shape is sampled once on a grid; edge dots bright, inside dots faint ----------
function sample(path, w, h, step) {
  const c = document.createElement('canvas').getContext('2d'), inn = (x, y) => c.isPointInPath(path, x, y), pts = [];
  for (let y = step / 2; y < h; y += step) for (let x = step / 2; x < w; x += step) {
    if (!inn(x, y)) continue;
    pts.push([x, y, !inn(x + step, y) || !inn(x - step, y) || !inn(x, y + step) || !inn(x, y - step)]);
  }
  return pts;
}
let GL = null;
function glyphs() {
  if (GL) return GL;
  const arrow = new Path2D('M0 0 L0 16 L3.8 12.4 L6.6 18.6 L9.2 17.4 L6.5 11.4 L11.5 11.4 Z');
  const hand = new Path2D();
  const rr = (x, y, w, h, r) => { const p = new Path2D(); p.roundRect(x, y, w, h, r); return p; };
  for (const p of [rr(5, 0, 4.4, 14, 2.2), rr(9.2, 7, 3.8, 8, 1.9), rr(12.8, 8.2, 3.6, 7.6, 1.8), rr(16.2, 9.6, 3.4, 7, 1.7), rr(5, 11, 14.6, 12.5, 4), rr(7, 21, 10.5, 5, 1.5)]) hand.addPath(p);
  hand.addPath(rr(0, 0, 4.2, 9.5, 2.1), new DOMMatrix().translate(0.6, 13.2).rotate(-38));
  const mouse = rr(0, 0, 14, 22, 7), key = rr(0, 0, 24, 24, 5);
  GL = { arrow: { path: arrow, pts: sample(arrow, 12, 19, 0.95), S: 2.3, tip: [0, 0] },
    hand: { path: hand, pts: sample(hand, 20, 26, 1.1), S: 2.2, tip: [7.2, 0.3] },
    mouse: { path: mouse, pts: sample(mouse, 14, 22, 1.4), S: 1.6 },
    key: { path: key, pts: sample(key, 24, 24, 2.6).filter(p => p[2]), S: 1.05 } };
  return GL;
}

// ---------- the engine ----------
// steps: [{ text, cue?, anchor?() -> [x, y] | null, D?, demo?(p, dp), demoEnd?(), arm?(), check?(inp) -> bool,
//           rings?() -> [[el, ...], ...], skip?() -> bool, enter?(), leave?(), nice?, doneNote?, note? }]
// host: { steps: () => [...], avoid: [selectors], busy?() -> bool, onEnd?(), accent? }
export function makeTour(host) {
  const T = { on: false, i: 0, steps: [], phase: 'idle', t0: 0, tArm: 0, lastUser: -1e9, placeAt: 0 };
  let el, cv, cx, rings = [], dpr = 1;
  const acc = () => host.accent || (getComputedStyle(document.documentElement).getPropertyValue('--open').trim() || '#5ff2ff');
  const inp = { touches: new Map(), mouse: null, lastWheel: -1e9, reset() { Object.assign(inp, { drag1: false, drag2: false, touch1: false, touch2: false, wheel: 0, wheelCard: false, tap: false, dist: 0, keys: new Set(), maxT: inp.touches.size }); } };
  inp.reset();
  const inUI = t => !!(t && t.closest && t.closest('#gtour'));
  const L = {
    pointerdown: e => {
      if (inUI(e.target)) return;
      T.lastUser = performance.now();
      if (e.pointerType === 'touch') { inp.touches.set(e.pointerId, { x0: e.clientX, y0: e.clientY }); inp.maxT = Math.max(inp.maxT, inp.touches.size); }
      else inp.mouse = { x0: e.clientX, y0: e.clientY, btn: e.button, mod: e.shiftKey || e.altKey || e.ctrlKey || e.metaKey };   // round 4: trackpads (Shift-, Ctrl-, Cmd-drag pan or tilt)
    },
    pointermove: e => {
      if (e.pointerType === 'touch') {
        const t = inp.touches.get(e.pointerId); if (!t) return;
        if (inp.touches.size === 1) inp.dist = Math.max(inp.dist || 0, Math.hypot(e.clientX - t.x0, e.clientY - t.y0));
        if (Math.hypot(e.clientX - t.x0, e.clientY - t.y0) > 10) { if (inp.touches.size === 1 && inp.maxT === 1) inp.touch1 = true; if (inp.touches.size >= 2) inp.touch2 = true; }
      } else if (inp.mouse && !e.buttons) inp.mouse = null;                   // a release we never saw (outside the window)
      else if (inp.mouse && e.buttons && (inp.dist = Math.max(inp.dist || 0, Math.hypot(e.clientX - inp.mouse.x0, e.clientY - inp.mouse.y0))) > 10) {
        if (inp.mouse.btn === 2 || inp.mouse.mod) inp.drag2 = true; else if (inp.mouse.btn === 0) inp.drag1 = true;
      }
    },
    pointerup: e => {
      if (e.pointerType === 'touch') { inp.touches.delete(e.pointerId); if (!inp.touches.size) inp.maxT = 0; } else inp.mouse = null;
      if (!inUI(e.target)) inp.tap = true;
    },
    wheel: e => { if (inUI(e.target)) return; T.lastUser = inp.lastWheel = performance.now(); inp.wheel++; if (e.target.closest && e.target.closest('#spot-pop')) inp.wheelCard = true; },
    keydown: e => { if (e.key === 'Escape') { end(); return; } if (inUI(e.target)) return; inp.keys.add(e.code); T.lastUser = performance.now(); },
  };
  L.pointercancel = L.pointerup;
  function build() {
    if (el) return;
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    el = document.createElement('div'); el.id = 'gtour'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', 'How to move around'); el.hidden = true;
    el.innerHTML = '<div class="gt-top"><span class="gt-n"></span><span class="gt-ok" aria-hidden="true">✓ Nice</span></div><p class="gt-t" aria-live="polite"></p><p class="gt-s" aria-live="polite"></p><i class="gt-rd" hidden></i>' +
      '<div class="gt-btns"><button type="button" class="gt-skip">Skip tour</button><button type="button" class="gt-next">Next</button></div>';
    el.querySelector('.gt-skip').onclick = () => end();
    el.querySelector('.gt-next').onclick = () => { const s = T.steps[T.i]; if (s && s.onNext) { try { s.onNext(); } catch (e) { console.error('tour step', e); } return; } go(T.i + 1, 1); };   // round 4: a step may act instead (the viewer's "Back to globe")
    document.body.appendChild(el);
    cv = document.createElement('canvas'); cv.id = 'gtour-cue'; cv.setAttribute('aria-hidden', 'true'); document.body.appendChild(cv); cx = cv.getContext('2d');
    for (let k = 0; k < 4; k++) { const r = document.createElement('div'); r.className = 'gtour-ring'; r.hidden = true; document.body.appendChild(r); rings.push(r); }
  }
  function start(i = 0) {
    build();
    el.style.setProperty('--gt-acc', acc()); rings.forEach(r => r.style.setProperty('--gt-acc', acc()));
    if (T.on) leave(); else for (const [k, f] of Object.entries(L)) addEventListener(k, f, { capture: true, passive: true });
    T.on = true; T.steps = host.steps(); el.hidden = false; cv.hidden = false;
    go(i, 1);
  }
  function leave() { const s = T.steps[T.i]; if (s && s.leave) try { s.leave(); } catch (e) { console.error('tour step', e); } }
  function end() {
    if (!T.on) return;
    tourKey.clear();                                  // Skip, Done or Escape: no carrying on elsewhere (r3; round 4: one key)
    if (T.phase === 'demo') { const s = T.steps[T.i]; if (s && s.demoEnd) try { s.demoEnd(true); } catch (e) { /* ignore */ } }
    leave(); T.on = false; T.phase = 'idle';
    for (const [k, f] of Object.entries(L)) removeEventListener(k, f, { capture: true });
    el.hidden = true; rings.forEach(r => r.hidden = true); cx.clearRect(0, 0, cv.width, cv.height); cv.hidden = true;
    if (host.onEnd) host.onEnd();
  }
  const visible = e => !!(e && !(e instanceof Element) ? e.getBoundingClientRect : e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && (() => { const r = e.getBoundingClientRect(); return r.width > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; })());
  const ringRects = s => !s.rings ? [] : s.rings().map(g => g.filter(visible).map(e => e.getBoundingClientRect())).filter(g => g.length)
    .map(g => ({ left: Math.min(...g.map(r => r.left)) - 6, top: Math.min(...g.map(r => r.top)) - 6, right: Math.max(...g.map(r => r.right)) + 6, bottom: Math.max(...g.map(r => r.bottom)) + 6 }));
  function go(i, dir) {
    if (T.on && T.steps[T.i] && i !== T.i) leave();
    if (T.phase === 'demo' && T.steps[T.i] && T.steps[T.i].demoEnd) { try { T.steps[T.i].demoEnd(true); } catch (e) { /* ignore */ } }
    while (i < T.steps.length && i >= 0 && T.steps[i].skip && T.steps[i].skip()) i += dir;
    if (i >= T.steps.length || i < 0) { end(); return; }
    T.i = i; const s = T.steps[i];
    if (s.enter) try { s.enter(); } catch (e) { console.error('tour step', e); }
    if (s.rings && !ringRects(s).length && !s.cue) { go(i + dir, dir); return; }   // nothing to point at in this layout
    const live = x => !(x.skip && x.skip()), n = T.steps.filter(live).length, at = T.steps.slice(0, i + 1).filter(live).length;
    el.querySelector('.gt-n').textContent = at + ' of ' + n;
    el.querySelector('.gt-t').textContent = s.text;
    el.querySelector('.gt-s').textContent = s.note || '';
    el.querySelector('.gt-ok').classList.remove('on');
    const nx = el.querySelector('.gt-next'); nx.textContent = s.nextLabel || (i === T.steps.length - 1 || T.steps.slice(i + 1).every(x => x.skip && x.skip()) ? 'Done' : 'Next'); nx.classList.remove('ready');
    if (host.onStep) try { host.onStep(i); } catch (e) { console.error('tour step', e); }   // round 4: the host stores the step (tourKey)
    T.phase = s.cue ? 'demo' : 'point'; T.t0 = performance.now(); T.lastP = 0; T.demoStarted = false; T.placeAt = 0; T.sig = '';
    T.n = 0; T.okAt = 0; T.advAt = 0; T.rearm = false; T.readAt = 0; T.fading = false; el.classList.remove('gt-fade'); el.querySelector('.gt-rd').hidden = true;
    if (!s.cue) arm(s);
    nx.focus({ preventScroll: true });
  }
  function arm(s) {
    // a finger or button already down stays known (2026-11-23 fix): a drag started during the demo then counts, and
    // handsFree() still waits for its release
    T.phase = s.cue ? 'try' : 'point'; T.tArm = performance.now(); inp.reset();
    if (s.arm) try { s.arm(); } catch (e) { console.error('tour step', e); }
    if (s.cue && !s.note) el.querySelector('.gt-s').textContent = s.yourTurn || 'Your turn.';
    // Benn 2026-11-23: a step that only points at a control moves on by itself after a read time (about 4 to 7 s by its
    // length; any touch, click or scroll restarts it); the last step waits for Done.
    if (!s.cue && !isLast(T.i)) { T.readAt = T.tArm + readTime(s); el.querySelector('.gt-rd').hidden = false; }
  }
  const isLast = i => i === T.steps.length - 1 || T.steps.slice(i + 1).every(x => x.skip && x.skip());
  const readTime = s => Math.max(s.read || 4000, Math.min(Math.max(7000, s.read || 0), 2200 + 45 * (s.text.length + (s.note || '').length)));
  // No finger down, no button held, no wheel for 350 ms: a gesture has ended (a counted one never moves on mid-gesture).
  const handsFree = now => !inp.touches.size && !inp.mouse && now - inp.lastWheel > 350;
  function fadeNext() {
    if (T.fading) return; T.fading = true; draw(null); el.classList.add('gt-fade');
    const i = T.i; setTimeout(() => { if (T.on && T.i === i) go(i + 1, 1); if (el) el.classList.remove('gt-fade'); }, 260);
  }
  // Benn 2026-11-23: the tour moves on by itself. First clear gesture: the "Nice" tick. Then it moves on after a second
  // gesture (counted once the first has ended), or 1.2 s after the first when that one was big (step.big()), always only
  // once the hands are free, with a short fade. Next and Skip stay as the fallback.
  function success(s) {
    const now = performance.now(); T.n++;
    if (T.n === 1) {
      T.okAt = now;
      el.querySelector('.gt-ok').classList.add('on');
      el.querySelector('.gt-s').textContent = s.nice || '';
      el.querySelector('.gt-next').classList.add('ready');
    }
    T.phase = 'done';
    if (isLast(T.i)) return;
    if (T.n >= 2) T.advAt = now + 450;
    else if (bigNow(s)) T.advAt = T.okAt + (s.after || 1200);
    else T.rearm = true;
  }
  const bigNow = s => { if (!s.big) return false; try { return !!s.big(inp); } catch (e) { return false; } };
  // ---- every frame (the host calls it from its own render loop) ----
  function tick(now) {
    if (!T.on) return;
    const s = T.steps[T.i]; if (!s) return;
    // r3 (Benn: "the hurricane showcase was zoom in then next"): while a flight runs (host.busy) the read timer and a
    // pending auto-advance stand still, so a step's time counts from when the camera has arrived
    const dtF = T.lastTick ? Math.min(250, now - T.lastTick) : 0; T.lastTick = now;
    if (T.phase !== 'demo' && host.busy && host.busy()) { if (T.readAt) T.readAt += dtF; if (T.advAt) T.advAt += dtF; }
    if (s.frame && T.phase !== 'demo') try { s.frame(now - T.tArm, { hold: ms => { if (T.readAt) T.readAt = Math.max(T.readAt, performance.now() + ms); } }); } catch (e) { console.error('tour step', e); }
    if (T.phase === 'demo') {
      if (host.busy && host.busy() && !T.demoStarted) { T.t0 = now; draw(null); place(s, now); return; }   // a flight is running: wait for it
      if (T.lastUser > T.t0) { if (s.demoEnd) try { s.demoEnd(true); } catch (e) { /* ignore */ } arm(s); }   // the visitor started on their own
      else {
        const D = s.D || 2600, u = (now - T.t0) / D;
        if (!T.demoStarted) { T.demoStarted = true; if (s.demoStart) try { s.demoStart(); } catch (e) { console.error('tour step', e); } }
        const p = s.cue === 'click' || s.cue === 'tap' ? (u >= 0.6 ? 1 : 0) : smooth((u - 0.15) / 0.65);
        if (s.demo && (p !== T.lastP || s.raw)) try { s.demo(p, p - T.lastP, u); } catch (e) { console.error('tour demo', e); }
        T.lastP = p;
        draw(s, Math.min(1, u), 1);
        if (u >= 1) { if (s.demoEnd) try { s.demoEnd(false); } catch (e) { /* ignore */ } arm(s); }
      }
    }
    if (T.phase === 'done' && !T.fading) {
      if (T.rearm && bigNow(s)) { T.rearm = false; T.advAt = T.okAt + (s.after || 1200); }   // the first gesture carried on and grew big
      if (T.rearm && handsFree(now)) {                                          // the first one has ended: count the next
        T.rearm = false; inp.reset(); if (s.arm) try { s.arm(); } catch (e) { console.error('tour step', e); } T.phase = 'again';
      }
      if (T.advAt && now >= T.advAt && handsFree(now)) fadeNext();
    }
    if (T.phase === 'again' && s.check) { let ok = false; try { ok = s.check(inp); } catch (e) { console.error('tour check', e); } if (ok) success(s); }
    if (T.phase === 'point' && T.readAt && !T.fading) {
      if (T.lastUser > T.tArm) { T.readAt = Math.max(T.readAt, T.lastUser + 2500); }
      const D = readTime(s), b = el.querySelector('.gt-rd');
      b.style.width = Math.round(100 * Math.max(0, Math.min(1, 1 - (T.readAt - now) / D))) + '%';
      if (now >= T.readAt && handsFree(now)) fadeNext();
    }
    if (T.phase === 'try' || T.phase === 'point') {
      if (s.check) { let ok = false; try { ok = s.check(inp); } catch (e) { console.error('tour check', e); } if (ok) success(s); }
    }
    if (T.phase === 'try') {
      const busyHand = inp.touches.size || (inp.mouse && now - T.lastUser < 4000), D = s.D || 2600, P = D + 1600, u = ((now - T.tArm) % P) / D;
      draw(busyHand || u > 1 ? null : s, u, 0.5);
    } else if (T.phase !== 'demo') draw(s.pointCue && T.phase === 'point' ? { ...s, cue: s.pointCue } : null, ((now - T.tArm) % 3200) / 2200, 0.55);
    // rings: around the real elements, every frame (they move with resizes and panel changes)
    const R = T.phase === 'idle' ? [] : ringRects(s);
    while (rings.length < R.length) { const r = document.createElement('div'); r.className = 'gtour-ring'; r.hidden = true; r.style.setProperty('--gt-acc', acc()); document.body.appendChild(r); rings.push(r); }   // as many rings as groups (2026-11-23 r2)
    rings.forEach((r, k) => {
      const q = R[k]; if (!q) { r.hidden = true; return; }
      r.hidden = false; r.style.left = q.left + 'px'; r.style.top = q.top + 'px'; r.style.width = (q.right - q.left) + 'px'; r.style.height = (q.bottom - q.top) + 'px';
    });
    place(s, now, R);
  }
  // ---- the bubble: beside what it points at, else at the bottom (above the standing line), else at the top ----
  function place(s, now, R = ringRects(s)) {
    if (now - T.placeAt < 200) return; T.placeAt = now;
    const m = 8, W = innerWidth, H = innerHeight, narrow = W < 700;
    el.style.width = Math.min(340, W - 2 * m - (narrow ? 60 : 0)) + 'px';
    const w = el.offsetWidth, h = el.offsetHeight;
    const avoid = [...R];
    for (const sel of host.avoid || []) for (const e of document.querySelectorAll(sel)) if (visible(e) && !el.contains(e)) avoid.push(e.getBoundingClientRect());
    const a = s.cue && s.anchor ? s.anchor() : null;
    if (a) avoid.push({ left: a[0] - 110, right: a[0] + 110, top: a[1] - 90, bottom: a[1] + 90 });
    const hits = (l, t) => avoid.some(o => l < o.right + 4 && l + w > o.left - 4 && t < o.bottom + 4 && t + h > o.top - 4);
    const cl = (l, t) => [Math.max(m, Math.min(W - w - m, l)), Math.max(m, Math.min(H - h - m, t))];
    const tries = [];
    if (R.length) { const r = R[0], mx = (r.left + r.right) / 2, my = (r.top + r.bottom) / 2;
      tries.push(cl(mx - w / 2, r.bottom + 10), cl(mx - w / 2, r.top - h - 10), cl(r.left - w - 10, my - h / 2), cl(r.right + 10, my - h / 2)); }
    const xs = narrow ? [m, (W - w) / 2] : [(W - w) / 2, m + 60, W - w - m - 60];
    for (let y = H - h - m; y > H * 0.4; y -= 16) for (const x of xs) tries.push(cl(x, y));
    for (let y = 56; y < H * 0.5; y += 16) for (const x of xs) tries.push(cl(x, y));
    const p = tries.find(([l, t]) => !hits(l, t)) || cl((W - w) / 2, H - h - 60);
    const sig = Math.round(p[0]) + ',' + Math.round(p[1]);
    if (sig !== T.sig) { T.sig = sig; el.style.left = Math.round(p[0]) + 'px'; el.style.top = Math.round(p[1]) + 'px'; }
  }
  // ---- the cue: where the pointer(s) are at time u (0..1) of one play ----
  function cuePose(s, u) {
    const a = s.anchor ? s.anchor() : [innerWidth / 2, innerHeight / 2];
    if (!a) return null;
    const [ax, ay] = a, mv = smooth((u - 0.15) / 0.65), down = u >= 0.12 && u < 0.82, fade = u < 0.08 ? u / 0.08 : u > 0.9 ? (1 - u) / 0.1 : 1;
    const sw = Math.sin(Math.PI * mv);
    switch (s.cue) {
      case 'drag': return { kind: 'mouse', btn: down ? 'L' : null, pts: [[ax - 70 + 140 * mv, ay]], fade, trail: true };
      case 'rdragx': return { kind: 'mouse', btn: down ? 'R' : null, pts: [[ax - 50 + 100 * mv, ay]], fade, trail: true };
      case 'rdrag': return { kind: 'mouse', btn: down ? 'R' : null, pts: [[ax, ay + 50 - 100 * sw]], fade, trail: true };
      case 'wheel': return { kind: 'mouse', btn: null, wheel: down ? mv : null, pts: [[ax, ay]], fade };
      case 'click': case 'tap': case 'point': {
        const f = smooth((u - 0.08) / 0.42), x = ax + 70 * (1 - f), y = ay + 90 * (1 - f), press = s.cue !== 'point' && u >= 0.55 && u < 0.7;
        return { kind: s.cue === 'click' || (s.cue === 'point' && !s.touch) ? 'mouse' : 'hand', btn: press ? 'L' : null, press, pts: [[x, y]], fade: u > 0.92 ? (1 - u) / 0.08 : Math.min(1, u / 0.08) };
      }
      case 'touch1': return { kind: 'hand', press: down, pts: [[ax - 70 + 140 * mv, ay]], fade, trail: true };
      case 'pinch': { const d = 60 + 130 * mv, c = Math.cos(55 * D2R) * d / 2, q = Math.sin(55 * D2R) * d / 2; return { kind: 'two', press: down, pts: [[ax - c, ay + q], [ax + c, ay - q]], fade, trail: true }; }
      case 'twist': { const g = (20 + 50 * sw) * D2R, c = Math.cos(g) * 60, q = Math.sin(g) * 60; return { kind: 'two', press: down, pts: [[ax - c, ay - q], [ax + c, ay + q]], fade, trail: true }; }
      case 'tilt2': return { kind: 'two', press: down, pts: [[ax - 45, ay + 50 - 110 * sw], [ax + 45, ay + 50 - 110 * sw]], fade, trail: true };
      case 'pan2': return { kind: 'two', press: down, pts: [[ax - 45 - 50 + 100 * mv, ay], [ax + 45 - 50 + 100 * mv, ay]], fade, trail: true };
      case 'keys': return { kind: 'keys', lit: down ? 'W' : null, pts: [[ax, ay]], fade };
    }
    return null;
  }
  function draw(s, u, alpha) {
    const W = innerWidth, H = innerHeight, r = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(W * r) || cv.height !== Math.round(H * r)) { cv.width = Math.round(W * r); cv.height = Math.round(H * r); }
    dpr = r; cx.setTransform(1, 0, 0, 1, 0, 0); cx.clearRect(0, 0, cv.width, cv.height);
    if (!s) return;
    const P = cuePose(s, u); if (!P) return;
    const A = acc(), g = glyphs();
    cx.globalAlpha = alpha * Math.max(0, P.fade);
    if (P.trail && u > 0.15) {                               // fading dots along the path already travelled
      for (let k = 1; k <= 7; k++) { const uu = Math.max(0.15, u - k * 0.04); const Q = cuePose(s, uu); if (!Q) break;
        for (const [x, y] of Q.pts) dot(x, y, 2.2 - k * 0.2, A, alpha * Math.max(0, P.fade) * (0.5 - k * 0.06)); }
      cx.globalAlpha = alpha * Math.max(0, P.fade);
    }
    for (const [x, y] of P.pts) {
      if (P.kind === 'mouse') { glyph(g.arrow, x, y, A); mouseGlyph(g.mouse, x + 26, y + 30, A, P.btn, P.wheel); }
      else if (P.kind === 'hand') { if (P.press) ring(x, y, A, 1); glyph(g.hand, x, y, A); }
      else if (P.kind === 'two') ring(x, y, A, P.press ? 1 : 0.5);
      else if (P.kind === 'keys') keys(g.key, x, y, A, P.lit);
    }
    cx.globalAlpha = 1;
  }
  function dot(x, y, rad, col, al) { cx.globalAlpha = Math.max(0, al); cx.fillStyle = col; cx.beginPath(); cx.arc(x * dpr, y * dpr, Math.max(0.3, rad) * dpr, 0, 7); cx.fill(); }
  function glyph(G, x, y, col) {
    const S = G.S, ox = x - G.tip[0] * S, oy = y - G.tip[1] * S, a0 = cx.globalAlpha;
    cx.setTransform(dpr * S, 0, 0, dpr * S, dpr * ox, dpr * oy); cx.fillStyle = 'rgba(4,8,14,0.62)'; cx.fill(G.path); cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.fillStyle = col;
    for (const [px, py, e] of G.pts) { cx.globalAlpha = a0 * (e ? 1 : 0.32); cx.beginPath(); cx.arc((ox + px * S) * dpr, (oy + py * S) * dpr, (e ? 1.15 : 0.8) * dpr, 0, 7); cx.fill(); }
    cx.globalAlpha = a0;
  }
  function mouseGlyph(G, x, y, col, btn, wheel) {
    const S = G.S, a0 = cx.globalAlpha;
    cx.setTransform(dpr * S, 0, 0, dpr * S, dpr * x, dpr * y); cx.fillStyle = 'rgba(4,8,14,0.62)'; cx.fill(G.path); cx.setTransform(1, 0, 0, 1, 0, 0);
    cx.fillStyle = col;
    for (const [px, py, e] of G.pts) {
      const top = py < 8, div = top && Math.abs(px - 7) < 0.8 || Math.abs(py - 8) < 0.8, lit = top && !e && ((btn === 'L' && px < 7) || (btn === 'R' && px > 7));
      cx.globalAlpha = a0 * (e || div ? 0.95 : lit ? 0.95 : 0.22);
      cx.beginPath(); cx.arc((x + px * S) * dpr, (y + py * S) * dpr, (e || lit ? 1.1 : 0.75) * dpr, 0, 7); cx.fill();
    }
    if (wheel != null) for (let k = 0; k < 3; k++) {             // the wheel turning: three dots running up the middle
      const t = ((wheel * 3 + k / 3) % 1); cx.globalAlpha = a0 * Math.sin(Math.PI * t);
      cx.beginPath(); cx.arc((x + 7 * S) * dpr, (y + (6.5 - 5 * t) * S) * dpr, 1.6 * dpr, 0, 7); cx.fill();
    }
    cx.globalAlpha = a0;
  }
  function ring(x, y, col, k) {                              // a fingertip: a ring of dots and a glowing core
    const a0 = cx.globalAlpha; cx.fillStyle = col;
    cx.globalAlpha = a0 * 0.16 * k; cx.beginPath(); cx.arc(x * dpr, y * dpr, 15 * dpr, 0, 7); cx.fill();
    for (let j = 0; j < 14; j++) { const t = j / 14 * 2 * Math.PI; cx.globalAlpha = a0 * (0.45 + 0.55 * k); cx.beginPath(); cx.arc((x + Math.cos(t) * 15) * dpr, (y + Math.sin(t) * 15) * dpr, 1.3 * dpr, 0, 7); cx.fill(); }
    cx.globalAlpha = a0; cx.beginPath(); cx.arc(x * dpr, y * dpr, 3.2 * dpr, 0, 7); cx.fill();
  }
  function keys(G, x, y, col, lit) {
    const at = { W: [1, 0], A: [0, 1], S: [1, 1], D: [2, 1] }, u = 28 * G.S, a0 = cx.globalAlpha;
    cx.font = `600 ${Math.round(12 * dpr)}px system-ui, sans-serif`; cx.textAlign = 'center'; cx.textBaseline = 'middle';
    for (const [k, [i, j]] of Object.entries(at)) {
      const ox = x - 1.5 * u + i * u, oy = y - u + j * u, on = lit === k;
      cx.setTransform(dpr * G.S, 0, 0, dpr * G.S, dpr * ox, dpr * oy); cx.fillStyle = on ? 'rgba(95,242,255,0.22)' : 'rgba(4,8,14,0.62)'; cx.fill(G.path); cx.setTransform(1, 0, 0, 1, 0, 0);
      cx.fillStyle = col;
      for (const [px, py] of G.pts) { cx.globalAlpha = a0 * (on ? 1 : 0.6); cx.beginPath(); cx.arc((ox + px * G.S) * dpr, (oy + py * G.S) * dpr, 1 * dpr, 0, 7); cx.fill(); }
      cx.globalAlpha = a0 * (on ? 1 : 0.7); cx.fillText(k, (ox + 12 * G.S) * dpr, (oy + 12.5 * G.S) * dpr);
    }
    cx.globalAlpha = a0;
  }
  return { start, end, tick, next: () => go(T.i + 1, 1), get on() { return T.on; }, get step() { return T.i; }, get phase() { return T.phase; }, get readAt() { return T.readAt; }, get advAt() { return T.advAt; }, get steps() { return T.steps; }, inp };
}

// ---------- the globe's steps ----------
// G: the globe's own functions and state (globe.js tourApi). Desktop: drag, wheel, right-drag (or Shift/Alt-drag) tilt and
// turn, click a name, scroll on the card. Phone: one-finger drag, pinch, twist, two-finger tilt, tap a name, Open in 3D.
// Then rings on Layers/Spots/View, Home and the compass, Spin and full screen, and "?".
export function globeTour(G) {
  const phone = G.PROFILE === 'phone', T = G.TOUR, q = s => document.querySelector(s), qa = s => [...document.querySelectorAll(s)];
  const V = G.view, Z = G.zoom, B = {};
  const pitchNow = () => V.manual ?? V.pitch;
  const centre = () => [innerWidth / 2, innerHeight * (phone ? 0.42 : 0.45)];
  const labelShown = r => r.label && r.label.classList.contains('show') && (() => { const b = r.label.getBoundingClientRect(); return b.width > 0 && b.left > 0 && b.right < innerWidth - 60 && b.top > 60 && b.bottom < innerHeight - 60; })();
  const openable = r => r.status === 'unlocked' && r.link;
  function spot() {                                           // a glowing name on screen that opens a card: Supertubos first
    const c = G.regions.filter(r => r.pos && labelShown(r) && (openable(r) || (r.cl && !r.clSplit && r.cl.members.some(openable))));
    const hasS = r => r.id === 'supertubos' || (r.cl && r.cl.members.some(m => m.id === 'supertubos'));
    const [cx, cy] = centre();
    const d = r => { const b = r.label.getBoundingClientRect(); return Math.hypot(b.left + b.width / 2 - cx, b.top + b.height / 2 - cy); };
    return c.sort((a, b) => (hasS(b) - hasS(a)) || d(a) - d(b))[0] || null;
  }
  const lblAt = r => { if (!r || !labelShown(r)) return null; const b = r.label.getBoundingClientRect(); return [b.left + Math.min(b.width / 2, 40), b.top + b.height / 2]; };
  const single = r => r ? (openable(r) ? r : (r.cl ? (r.cl.members.find(m => m.id === 'supertubos' && openable(m)) || r.cl.members.find(openable)) : null)) : null;
  const ensureCard = () => {                                  // a single spot's card (the cluster card has no fill bar)
    if (G.POP.r && !G.POP.cl) return;
    const s = single(B.spot = spot()) || single(G.regions.find(r => r.id === 'supertubos'));
    if (s) { G.popOpen(s); B.opened = s; }
  };
  const cardAt = () => { const e = q('#spot-pop'); if (!e || e.hidden) return null; const b = e.getBoundingClientRect(); return [b.left + b.width * 0.3, b.top + b.height * 0.78]; };
  const openBtnAt = () => { const e = q('#spot-pop:not([hidden]) .sp-open'); if (!e) return null; const b = e.getBoundingClientRect(); return [b.left + b.width * 0.35, b.top + b.height / 2]; };
  const kindReset = () => { if (window.__globe) window.__globe.touchKind = null; };
  const kind = () => window.__globe && window.__globe.touchKind;

  const rotate = {
    text: phone ? 'Drag one finger to turn the globe.' : 'Drag to turn the globe.', cue: phone ? 'touch1' : 'drag', anchor: centre,
    demo: (p, dp) => { const k = 2 * Math.PI * Math.min(0.5, V.alt * 0.35) / innerHeight; G.pan.x -= dp * 140 * k; },
    arm: () => { B.n0 = V.n.clone(); },
    check: I => (phone ? I.touch1 : I.drag1) && V.n.angleTo(B.n0) > 4 * D2R, big: I => V.n.angleTo(B.n0) > 15 * D2R || (I.dist || 0) > 150,
    nice: 'The ground follows your ' + (phone ? 'finger.' : 'pointer.'),
  };
  const zoomStep = {
    text: phone ? 'Pinch to zoom: fingers apart in, together out.' : 'Scroll to zoom in and out.', cue: phone ? 'pinch' : 'wheel', anchor: centre,
    demoStart: () => { B.z0 = Z.target; Z.cursor = null; },
    demo: p => { Z.target = G.clampAlt(B.z0 * Math.exp(-0.45 * p)); },
    arm: () => { B.zt0 = Z.target; kindReset(); },
    check: I => (phone ? kind() === 'pinch' : I.wheel > 0) && Math.abs(Math.log(Z.target / B.zt0)) > 0.12, big: () => Math.abs(Math.log(Z.target / B.zt0)) > 0.4,
    nice: phone ? 'A pinch only zooms: it never turns or tilts.' : 'It zooms toward the pointer.',
  };
  const tiltDesk = {
    text: 'Right-drag (or Shift-drag): up and down tilts, sideways turns.', cue: 'rdrag', anchor: centre, D: 3000,
    demoStart: () => { B.m0 = V.manual; B.p0 = pitchNow(); },
    demo: p => { V.manual = Math.max(0, Math.min(G.pitchLimit(V.alt), B.p0 + 0.5 * Math.sin(Math.PI * p))); G.syncTilt(); },
    demoEnd: () => { V.manual = B.m0; G.syncTilt(); },
    arm: () => { B.p1 = pitchNow(); B.h1 = V.heading; B.max = 0; },
    // track() also runs from big(): after the tick check() is no longer called, so the size must keep growing (2026-11-23 fix)
    track: () => { const dh = Math.abs(Math.atan2(Math.sin(V.heading - B.h1), Math.cos(V.heading - B.h1))); return (B.max = Math.max(B.max, Math.abs(pitchNow() - B.p1), dh * 0.6)); },
    check: I => tiltDesk.track() > 5 * D2R && I.drag2, big: () => tiltDesk.track() > 15 * D2R,
    nice: 'Close to the ground, tilt shows the relief side on.',
  };
  const twist = {
    text: 'Twist two fingers to turn the view.', cue: 'twist', anchor: centre, D: 3000,
    demoStart: () => { B.h0 = V.heading; },
    demo: p => { G.setNorthEase(false); V.heading = B.h0 - 50 * D2R * Math.sin(Math.PI * p); },
    demoEnd: () => { V.heading = B.h0; },
    arm: () => { B.h1 = V.heading; B.max = 0; kindReset(); },
    track: () => { const dh = Math.abs(Math.atan2(Math.sin(V.heading - B.h1), Math.cos(V.heading - B.h1))); return (B.max = Math.max(B.max, dh)); },
    check: () => twist.track() > 8 * D2R && kind() === 'twist', big: () => twist.track() > 25 * D2R,
    nice: 'From far out the globe turns back to north up by itself.',
  };
  const tiltPhone = {
    text: 'Drag two fingers up or down to tilt.', cue: 'tilt2', anchor: centre, D: 3000,
    demoStart: () => { B.m0 = V.manual; B.p0 = pitchNow(); },
    demo: p => { V.manual = Math.max(0, Math.min(G.pitchLimit(V.alt), B.p0 + 0.55 * Math.sin(Math.PI * p))); G.syncTilt(); },
    demoEnd: () => { V.manual = B.m0; G.syncTilt(); },
    arm: () => { B.p1 = pitchNow(); B.max = 0; kindReset(); },
    track: () => (B.max = Math.max(B.max, Math.abs(pitchNow() - B.p1))),
    check: () => tiltPhone.track() > 5 * D2R && kind() === 'tilt', big: () => tiltPhone.track() > 15 * D2R,
    nice: 'Close to the ground, tilt shows the relief side on.',
  };
  const card = {
    text: (phone ? 'Tap' : 'Click') + ' a glowing name to open its card.', cue: phone ? 'tap' : 'click', D: 3400,
    raw: true,
    enter: () => { B.spot = spot(); B.glide = null; },
    demoStart: () => {                                        // no glowing name on screen: the globe turns one (Supertubos) into view first
      if (B.spot) return;
      const st = G.regions.find(r => r.id === 'supertubos' && r.pos); if (!st) return;
      B.glide = { n0: V.n.clone(), n1: st.pos.clone().normalize(), z0: Z.target };
      B.glide.n1.lerp(B.glide.n0, 0.12).normalize();          // not dead centre: the name sits a little off the middle
    },
    anchor: () => lblAt(B.spot),
    demo: (p, dp, u) => {
      if (B.glide && u < 0.4) { const k = smooth(u / 0.36); V.n.copy(B.glide.n0).lerp(B.glide.n1, k).normalize(); Z.target = G.clampAlt(Math.max(B.glide.z0, 0.5)); return; }
      if (!B.spot) B.spot = spot();
      if (p >= 1 && B.spot && !G.POP.r) { G.tapSpot(B.spot); B.demoCard = true; }
    },
    demoEnd: () => { if (B.demoCard) { G.popClose(); B.demoCard = false; } },
    arm: () => { B.popWas = G.POP.r; },
    check: () => !!G.POP.r && G.POP.r !== B.popWas, big: () => true,
    nice: phone ? 'Open in 3D on the card shows the reef and its sea floor.' : 'Each reef has its card; nothing opens by itself.',
  };
  const scrollIn = {                                          // desktop: the fill bar only; the viewer never opens in the tour
    text: 'On the card, keep scrolling in: the bar fills and the reef opens in 3D.', cue: 'wheel', D: 3000,
    enter: ensureCard, anchor: cardAt, rings: () => [[q('#spot-pop')].filter(Boolean)],
    demo: p => { const b = q('#spot-pop .sp-cue i'); if (b) b.style.width = Math.round(70 * Math.sin(Math.PI * Math.min(1, p))) + '%'; },   // never full: a full bar always opens 3D
    demoEnd: () => { const b = q('#spot-pop .sp-cue i'); if (b) b.style.width = '0%'; },
    note: 'A full bar opens the reef in 3D (and ends the tour).',
    check: I => I.wheelCard || !!T.tried, big: () => true, nice: 'Near the ground the bar fills and 3D opens. "Open in 3D" does it in one click.',
  };
  const openBtn = {                                           // phone: point at the card's Open in 3D (never opens it here)
    text: '"Open in 3D" shows the reef and its sea floor.', pointCue: 'point', touch: true,
    enter: () => { ensureCard(); T.tried = null; }, anchor: openBtnAt, rings: () => [[q('#spot-pop:not([hidden]) .sp-open')].filter(Boolean)],
    note: 'Tapping it ends the tour and opens the reef.', check: () => !!T.tried, big: () => true, nice: 'That is the way in. It opens once the tour is done.',
  };
  const closeTourCard = () => { if (B.opened && G.POP.r === B.opened) G.popClose(); B.opened = null; };
  // ---- layers (Benn 2026-11-23: "the tour says nothing about the storm overlays"): the Layers panel opens, Hurricanes is
  // switched on as the live example, a ring on its row, its Fly button and a storm on the globe; then one step names the
  // other layer families. Ticking any layer or pressing Fly counts. When the tour ends, every layer is put back as it was
  // and the panel closes again if the tour opened it.
  const boxOf = l => l.userData.row && l.userData.row.querySelector('input[type=checkbox]');
  const layerOn = (l, on) => { const b = boxOf(l); if (!b || b.disabled || b.checked === on) return; b.checked = on; if (b.onchange) b.onchange(); };
  const hur = () => G.layers.find(l => l.userData.layerId === 'hurricanes');
  const flyBtn = () => { const h = hur(); return h && h.userData.row ? h.userData.row.closest('.layer-item')?.querySelector('.fly-storm') || null : null; };
  const onLayerUse = e => { if (e.isTrusted && e.target.closest && (e.target.closest('#layers') || e.target.closest('.fly-storm'))) { B.used = true; if (phone && e.type === 'click' && e.target.closest('.fly-storm')) setTimeout(() => G.openSection(null), 300); } };
  const layersIn = () => {
    closeTourCard(); B.used = false;
    if (!B.saved) { B.saved = new Map(G.layers.map(l => [l, l.visible])); B.secWas = G.section; }
    if (G.section !== 'layers') G.openSection('layers');
    addEventListener('change', onLayerUse, true); addEventListener('click', onLayerUse, true);
  };
  const layersOut = () => { removeEventListener('change', onLayerUse, true); removeEventListener('click', onLayerUse, true); };
  const stormRect = () => {                                   // a ring round the nearest storm, unless a panel covers it
    const a = G.stormAt(); if (!a) return null;
    const P = q('#panel'), pr = P && !P.hidden ? P.getBoundingClientRect() : null;
    if (pr && a[0] > pr.left - 30 && a[0] < pr.right + 30 && a[1] > pr.top - 30 && a[1] < pr.bottom + 30) return null;
    return { getBoundingClientRect: () => ({ left: a[0] - 22, top: a[1] - 22, right: a[0] + 22, bottom: a[1] + 22, width: 44, height: 44 }) };
  };
  // r3: the three tour layers fade in and out (setDim) instead of popping; restoreLayers cancels a fade under way
  const FADES = new Map();
  const fade = (l, on) => {
    if (typeof l.setDim !== 'function') { layerOn(l, on); return; }
    const k1 = l.userData.dimNow ?? 1, tok = {}; FADES.set(l, tok);
    if (on) { if (l.visible) { FADES.delete(l); try { l.setDim(k1); } catch (e) { /* ignore */ } return; } l.setDim(0); layerOn(l, true); }
    else if (!l.visible) { FADES.delete(l); return; }
    const t0 = performance.now(), D = on ? 700 : 450;
    const step = () => {
      if (FADES.get(l) !== tok) return;
      const u = Math.min(1, (performance.now() - t0) / D);
      try { l.setDim(k1 * (on ? u : 1 - u)); } catch (e) { /* ignore */ }
      if (u < 1) { requestAnimationFrame(step); return; }
      FADES.delete(l); if (!on) { layerOn(l, false); try { l.setDim(k1); } catch (e) { /* ignore */ } }
    };
    requestAnimationFrame(step);
  };
  const unfade = l => { if (FADES.has(l)) { FADES.delete(l); try { l.setDim(l.userData.dimNow ?? 1); } catch (e) { /* ignore */ } } };
  const only = id => { for (const l of G.layers) if (['hurricanes', 'quakes-history', 'wind'].includes(l.userData.layerId)) fade(l, l.userData.layerId === id); };
  const lay = id => G.layers.find(l => l.userData.layerId === id);
  const rowOf = id => { const l = lay(id); return l && l.userData.row; };
  const phonePanel = open => { if (phone) G.openSection(open ? 'layers' : null); };
  const storms = {                                            // 1. Hurricanes: follow one storm, then come back
    text: 'Hurricanes: each trail of dots is one storm. Fly follows one.', pointCue: 'point',
    enter: () => { layersIn(); only('hurricanes'); B.autoFly = false; },
    leave: layersOut, read: 5000, after: 4500,   // r3: a Fly (yours or the demo's) holds on the followed storm 4.5-5 s after arriving
    frame: (t, api) => {                       // r3: no Fly pressed within 2 s: the tour presses it itself as the demo (not counted)
      if (B.autoFly || B.used || t < 2000 || document.querySelector('#panel:hover')) return;   // a pointer over the panel: the visitor is on the way
      const f = flyBtn(); if (!f || !f.getClientRects().length) return;
      B.autoFly = true; f.click(); api.hold(5000);
      if (phone) setTimeout(() => G.openSection(null), 300);
    },
    anchor: () => { const f = flyBtn(); if (f && f.getClientRects().length) { const b = f.getBoundingClientRect(); return [b.left + b.width * 0.3, b.top + b.height / 2]; } const a = G.stormAt(); return a ? [a[0], a[1]] : null; },
    rings: () => [[rowOf('hurricanes')].filter(Boolean), [flyBtn()].filter(Boolean), [stormRect()].filter(Boolean)],
    note: 'Drag, or press Home, to come back.',
    check: () => B.used, big: () => true, nice: 'Following it. Next comes back to the whole Earth.',
  };
  const quakes = {                                            // 2. Earthquakes M5+ since 1970: what hides in here
    text: 'Earthquakes M5+ since 1970: the dots trace the plate edges.',
    enter: () => { layersIn(); if (G.follow) G.releaseFollow(); only('quakes-history'); phonePanel(false); const h = q('#home-btn'); if (h) h.click(); },
    leave: layersOut, read: 5000,              // r3: counted from when the Home flight has landed (busy pause)
    rings: () => [phone ? [q('#bar [data-sec=layers]')].filter(Boolean) : [rowOf('quakes-history')].filter(Boolean)],
    check: () => B.used, big: () => true, nice: 'Every layer switches on and off the same way.',
  };
  const wind = {                                              // 3. Wind (GFS): the moving flow lines; the rest in one line
    text: 'Wind (GFS model): the moving lines are the wind.',
    enter: () => { layersIn(); only('wind'); phonePanel(false); }, read: 5000,
    leave: () => { layersOut(); if (B.secWas !== 'layers' && G.section === 'layers') G.openSection(B.secWas || null); },
    rings: () => [phone ? [q('#bar [data-sec=layers]')].filter(Boolean) : [rowOf('wind')].filter(Boolean)],
    note: 'Waves, swell, snow and more: tick them in Layers.',
    check: () => B.used, big: () => true, nice: 'Your own layers come back when the tour ends.',
  };
  const restoreLayers = () => {
    if (!B.saved) return;
    for (const [l, on] of B.saved) { unfade(l); layerOn(l, on); }
    const f = G.follow; if (f && f.layer && !f.layer.visible) G.releaseFollow();
    if (B.secWas !== 'layers' && G.section === 'layers') G.openSection(B.secWas || null);
    B.saved = null;
  };
  const ringStep = (text, groups, extra = {}) => ({ text, rings: () => groups.map(g => g.flatMap(s => qa(s))), enter: closeTourCard, ...extra });
  const steps = phone ? [rotate, zoomStep, twist, tiltPhone, card, storms, quakes, wind,
    ringStep('Home: whole Earth. Compass: north up. Right: zoom, full screen and "?".', [['#home-btn'], ['#compass'], ['#zoom']]),
  ] : [rotate, zoomStep, tiltDesk, card, scrollIn, storms, quakes, wind,
    // r2 fix: "?" sits in the bar on desktop, so a ring grouping it with #zoom spanned the whole screen; one ring each
    ringStep('Home: whole Earth. Compass: north up. Spin turns it. Right: zoom, tilt, full screen.', [['#home-btn'], ['#compass'], ['#spin-btn', '#spin-speed-box'], ['#zoom'], ['#help-btn']]),
  ];
  for (const s of steps) if (s.rings && !s.leave && /full screen/i.test(s.text)) s.leave = () => q('#zoom') && q('#zoom').classList.add('faded');
  const tour = makeTour({
    steps: () => steps,
    avoid: ['#bar', '#compass', '#zoom', '#notice-standing', '#hint', '#spot-pop', '#open-spot', '#welcome', '#panel', '#zoom-note'],
    busy: () => G.busy(),
    onEnd: () => { closeTourCard(); restoreLayers(); G.ended(); },
    onStep: i => tourKey.set({ page: 'globe', step: i, profile: G.PROFILE }),   // round 4: a reload, or a trip to the reef by any route, carries on
  });
  // the faint zoom column comes up while a ring points into it
  const tick0 = tour.tick;
  tour.tick = now => { tick0(now); if (tour.on && tour.steps[tour.step] && /full screen|"\?"/i.test(tour.steps[tour.step].text)) { const z = q('#zoom'); if (z) z.classList.remove('faded'); } };
  return tour;
}
