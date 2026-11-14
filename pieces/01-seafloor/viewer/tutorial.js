// tutorial.js: a short guided tour of the viewer with five small challenges solved with the Play sliders (play.js).
// Checks run in code on the model's own numbers. Progress is kept in localStorage (if the browser allows it).
// PLUMBING, apart from the step texts, which are worth reading.

const KEY = 'oceany-tutorial-v1';
const REEF = 'Reef maps: Consolação and Porto Batel';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) { return {}; } };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* private mode: progress not kept */ } };
const S = Object.assign({ step: 0, solved: {}, seen: false, open: false }, load());
const play = () => window.__play, viewer = () => window.__viewer;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ready() { for (let i = 0; i < 400 && !(viewer() && play()); i++) await sleep(50); return !!(viewer() && play()); }
async function toReef() {
  const V = viewer(); if (V.cur && V.cur.cfg && V.cur.cfg.portugal) return;
  await V.showLayer(REEF);
}
function flyPortoBatel() {
  const b = [...document.querySelectorAll('[id^="spot-"]')].find(x => /Porto Batel/i.test(x.textContent));
  if (b) b.click();
}
async function swellWith(p) { await toReef(); await play().set(p); }
function setCheckbox(id, on) {
  const cb = document.getElementById(id); if (!cb || cb.checked === on) return;
  cb.checked = on; cb.dispatchEvent(new Event('change'));
}

// ---------- the steps ----------
// challenge: { id, sliders: [...], check(stats, ctx) -> true when solved, status(stats, ctx) -> short live text }
const STEPS = [
  { title: 'Swell over a real reef',
    body: `<p>This viewer shows the sea floor at two reefs near Peniche, Portugal, measured by an aircraft lidar in 2011, and a simple model of swell crossing it.</p>
           <p>About five minutes: what you are looking at, then five small challenges you solve with sliders. Everything here is <b>illustrative, not a forecast</b>.</p>` },
  { title: 'The sea floor',
    enter: async () => { setCheckbox('bw-on', false); await toReef(); flyPortoBatel(); },
    body: `<p>Each dot is one lidar depth, about 11 by 14 m. Colour is depth below the lowest tide (LAT); the height is stretched so the reef shapes show.</p>
           <p>Drag to look around, scroll or pinch to zoom. The camera is now over <b>Porto Batel</b>.</p>` },
  { title: 'The swell layer',
    enter: async () => { await swellWith({ ...play().PRESETS.sep_total }); flyPortoBatel(); },
    body: `<p>Now a swell is on: <b>2.7 m, 7.8 s</b>, the model forecast for 17 Sep 2026 at about 18:00, tide 2.1 m.</p>
           <p>Teal dots are the water surface where the wave is still unbroken. <b>White</b> is where the model says it has broken.</p>` },
  { title: 'Refraction: crests bend',
    body: `<p>A wave is slower in shallow water. The end of a crest that reaches shallow water first slows down, and the rest catches up, so the crest turns to face the shore.</p>
           <p>Look at the crest lines near Porto Batel: they follow the shape of the coast, not a straight line. Bending also spreads a crest over more coast, which makes it a little smaller.</p>` },
  { title: 'Shoaling: waves grow as they slow',
    body: `<p>As the water gets shallower, a wave's energy travels slower and bunches up, so the wave gets taller. Long-period swell feels the bottom sooner and grows more.</p>`,
    challenge: { id: 'shoal', sliders: ['T'],
      task: 'Find a period where a wave in 5 m of water is at least 25% taller than it was in deep water.',
      status: s => `In 5 m of water: x${s.ks5.toFixed(2)} at ${s.params.T.toFixed(1)} s`,
      check: s => s.ks5 >= 1.25,
      done: 'Long swells grow more on the way in. Short wind swell (6 s) even shrinks a little at first: that is real, not a bug.' } },
  { title: 'Where does it break?',
    enter: async () => { await swellWith({ ...play().PRESETS.sep_total }); },
    body: `<p>The model marks a wave as broken once its height reaches <b>0.78 x the water depth</b>. Inside the surf zone the height is held there.</p>`,
    challenge: { id: 'where', quiz: true,
      task: 'For this swell, how far out from the filming position (the orange diamond on the cliff) does the outermost break start?',
      options: s => { const c = Math.round((s.outer || 0) / 10) * 10; return [Math.max(20, c - 110), c, c + 150]; },
      answer: s => Math.round((s.outer || 0) / 10) * 10,
      done: 'The footage put the take-off about 115 m out (90-145 m). The model breaks further out, at the edge of the lidar: it uses the full offshore height, an upper bound.' } },
  { title: 'Push the break out',
    enter: async ctx => { await swellWith({ H0: 1.5, T: 9, dir: 337, tide: 2.1, wrapped: true }); ctx.base = play().last && play().last.outer; },
    body: `<p>A smaller swell now: 1.5 m, 9 s.</p>`,
    challenge: { id: 'further', sliders: ['H0', 'tide'],
      task: 'Make the outer break start at least 40 m further out than it does now.',
      status: (s, ctx) => `Outer break: ${s.outer == null ? 'none' : Math.round(s.outer) + ' m'} (start ${ctx.base == null ? '?' : Math.round(ctx.base) + ' m'})`,
      check: (s, ctx) => ctx.base != null && s.outer != null && s.outer >= ctx.base + 40,
      done: 'Bigger waves break in deeper water, and lower tide means less water over the reef. Either pushes the break out.' } },
  { title: 'Tide pulls it back in',
    enter: async () => { await swellWith({ ...play().PRESETS.sep_total }); },
    body: `<p>Back to the 2.7 m swell.</p>`,
    challenge: { id: 'tide', sliders: ['tide'],
      task: 'Keep the 2.7 m swell, and bring the outer break within 150 m of the filming position.',
      status: s => `Outer break: ${s.outer == null ? 'none' : Math.round(s.outer) + ' m'} at tide ${s.params.tide.toFixed(1)} m`,
      check: s => s.params.H0 >= 2.5 && s.outer != null && s.outer <= 150,
      done: 'More water over the same reef: the wave reaches the 0.78 x depth limit closer in. That is why a reef can be fine at high tide and closed out at low.' } },
  { title: 'Which direction gets in?',
    enter: async ctx => { await swellWith({ ...play().PRESETS.sep_total, wrapped: false }); ctx.best = null;
      play().bestDirection(play().params).then(b => { ctx.best = b; ctx.refresh && ctx.refresh(); }); },
    body: `<p>The forecast swell came from 337&deg; (NNW). Taken as it is, that swell runs <i>along</i> this coast, and this simple model cannot bring it in: Porto Batel stays empty. In reality it bends round the Peniche headland, which the model cannot compute, so the other steps use a stated assumption (<i>wrapped</i>): the swell arrives head-on at full height.</p>
           <p>"Wrapped" is now off, so direction counts.</p>`,
    challenge: { id: 'direction', sliders: ['dir'],
      task: 'Find the swell direction that sends the biggest waves into the water off Porto Batel (within 2% of the best).',
      status: (s, ctx) => `Waves off Porto Batel: ${Math.round(s.size * 100)}% of offshore height, from ${s.params.dir}\u00b0` + (ctx.best ? ` (best: ${Math.round(ctx.best.size * 100)}%)` : ' (finding the best...)'),
      check: (s, ctx) => !s.params.wrapped && ctx.best && s.size > 0 && s.size >= 0.98 * ctx.best.size,
      done: 'Porto Batel faces roughly SW, so a SW swell walks straight in at nearly full height. The more oblique the swell, the more its crests are stretched along the coast by bending, and the smaller it gets. A NNW swell only gets in by wrapping round Peniche.' } },
  { title: 'The zoom-in: one breaking wave',
    enter: async () => { await swellWith({ ...play().PRESETS.sep_total }); setCheckbox('bw-on', true); flyPortoBatel(); },
    body: `<p>The swell model only says <i>where</i> a wave is broken. The breaking-wave slice is a separate particle simulation of one representative wave along one line out from the filming position, so you can see the shape: the face steepening and the lip throwing.</p>
           <p>It is a 2D slice with no refraction. Illustrative, not a forecast; its break position is good to about 15-20 m.</p>` },
  { title: 'Observer marks',
    enter: async () => { setCheckbox('bw-on', false); flyPortoBatel(); },
    body: `<p>The orange diamonds are <b>observer marks (one surfer, 17 Sep 2026)</b>: the filming position on the cliff and the take-off zone, where rock contact was observed. They are how the model gets checked against what someone actually saw.</p>
           <p>On a computer, shift+click a point to drop your own mark.</p>` },
  { title: 'That is the tour',
    body: `<p>You have seen the sea floor, refraction, shoaling, breaking, the zoom-in and the observer marks. The sliders stay in the panel under "Play with the swell".</p>
           <p>The model is about 250 lines of Python (<code>pieces/02-reefs/simulate_swell.py</code>) and the same steps in JavaScript run here. It is a simple, honest model: one height and period for the whole sea, straight-contour refraction, no headland. Illustrative, not a forecast.</p>` },
];
const CHALLENGES = STEPS.filter(s => s.challenge).map(s => s.challenge.id);

// ---------- UI ----------
let card = null, ctx = {}, unsub = null;
function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }
function progress() { return CHALLENGES.filter(id => S.solved[id]).length; }

function close() { S.open = false; save(); document.body.classList.remove('tut-open'); if (card) card.style.display = 'none'; if (unsub) { unsub(); unsub = null; } }
function open(step = S.step) { S.open = true; S.seen = true; document.body.classList.add('tut-open'); go(step); }
async function go(i) {
  i = Math.max(0, Math.min(STEPS.length - 1, i)); S.step = i; save();
  if (!card) { card = el('<div id="tut" role="dialog" aria-label="Guided tour"></div>'); document.body.appendChild(card); }
  card.style.display = '';
  if (unsub) { unsub(); unsub = null; }
  ctx = { step: i };
  const st = STEPS[i], ch = st.challenge;
  card.innerHTML = `
    <div class="tut-top"><span class="tut-count">${i + 1} / ${STEPS.length}</span>
      <span class="tut-score">${progress()} / ${CHALLENGES.length} challenges</span>
      <button class="tut-x" aria-label="Close the tour">&times;</button></div>
    <h2>${st.title}</h2><div class="tut-body">${st.body}</div>
    ${ch ? `<div class="tut-ch"><div class="tut-task"><b>Challenge:</b> ${ch.task}</div><div class="tut-ctl"></div>
      <div class="tut-status"></div><div class="tut-done" style="display:none"></div></div>` : ''}
    <div class="tut-nav"><button class="tut-back">Back</button>
      ${i === STEPS.length - 1 ? '<button class="tut-restart">Restart tour</button><button class="tut-reset">Clear progress</button><button class="tut-next on">Close</button>'
        : `<button class="tut-next on">${i === 0 ? 'Start' : ch && !S.solved[ch.id] ? 'Skip' : 'Next'}</button>`}</div>
    ${i === 0 ? '<button class="tut-skip">No thanks, skip the tour</button>' : ''}`;
  card.querySelector('.tut-x').onclick = close;
  card.querySelector('.tut-back').disabled = i === 0;
  card.querySelector('.tut-back').onclick = () => go(i - 1);
  card.querySelector('.tut-next').onclick = () => (i === STEPS.length - 1 ? close() : go(i + 1));
  const sk = card.querySelector('.tut-skip'); if (sk) sk.onclick = close;
  const rs = card.querySelector('.tut-restart'); if (rs) rs.onclick = () => go(0);
  const rz = card.querySelector('.tut-reset'); if (rz) rz.onclick = () => { S.solved = {}; save(); go(i); };
  const status = card.querySelector('.tut-status');
  if (status) status.textContent = 'Setting up...';
  try { if (st.enter) await st.enter(ctx); } catch (e) { console.error('tutorial step', e); }
  if (S.step !== i || !ch) return;                       // moved on while setting up, or no challenge here
  const ctl = card.querySelector('.tut-ctl');
  (ch.sliders || []).forEach(k => ctl.appendChild(play().slider(k)));
  if (ch.quiz) quiz(ch, ctl); else watch(ch);
}
function solved(ch) {
  const first = !S.solved[ch.id]; S.solved[ch.id] = true; save();
  const d = card.querySelector('.tut-done'); d.style.display = ''; d.innerHTML = `<b>Solved.</b> ${ch.done}`;
  card.querySelector('.tut-score').textContent = `${progress()} / ${CHALLENGES.length} challenges`;
  const n = card.querySelector('.tut-next'); if (n && n.textContent === 'Skip') n.textContent = 'Next';
  if (first) card.classList.add('tut-flash'), setTimeout(() => card && card.classList.remove('tut-flash'), 900);
}
function watch(ch) {
  const status = card.querySelector('.tut-status');
  const upd = s => { if (!s) return; status.textContent = ch.status ? ch.status(s, ctx) : '';
    if (ch.check(s, ctx)) solved(ch); };
  ctx.refresh = () => upd(play().last);
  unsub = play().onUpdate(upd); upd(play().last);
}
function quiz(ch, ctl) {
  const s = play().last, status = card.querySelector('.tut-status');
  if (!s) { status.textContent = 'The model has not run yet.'; return; }
  status.textContent = '';
  const ans = ch.answer(s);
  ch.options(s).forEach(v => {
    const b = el(`<button class="tut-opt">about ${v} m</button>`);
    b.onclick = () => { if (v === ans) { b.classList.add('on'); solved(ch); } else { b.disabled = true; status.textContent = 'Not that one. Look for where the dots first turn white, walking in from the sea.'; } };
    ctl.appendChild(b);
  });
}

const CSS = `
#tut { position: fixed; right: 12px; bottom: 40px; width: 330px; max-height: calc(100vh - 80px); overflow-y: auto; z-index: 20;
  padding: 12px 14px; background: rgba(6, 12, 18, .92); border: 1px solid #2a5260; border-radius: 10px; color: #cfe8ee;
  font-size: 13px; box-shadow: 0 6px 30px rgba(0,0,0,.5); transition: border-color .3s; }
#tut.tut-flash { border-color: #3dffa0; }
#tut h2 { font-size: 15px; margin: 4px 0 6px; color: #fff; font-weight: 600; }
#tut p { margin: 0 0 8px; }
#tut code { font-size: 11px; color: #9ab; }
.tut-top { display: flex; gap: 8px; align-items: center; color: #7d97a0; font-size: 11px; }
.tut-score { flex: 1; text-align: right; }
.tut-x { padding: 0 8px; font-size: 16px; line-height: 22px; }
.tut-ch { margin: 8px 0; padding: 8px; border: 1px solid #1d3b47; border-radius: 8px; background: rgba(11, 26, 34, .6); }
.tut-ctl { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.tut-opt { padding: 8px 10px; text-align: left; }
.tut-status { color: #7fe3f0; margin-top: 6px; font-variant-numeric: tabular-nums; }
.tut-done { color: #3dffa0; margin-top: 6px; }
.tut-nav { display: flex; gap: 6px; justify-content: flex-end; margin-top: 8px; flex-wrap: wrap; }
.tut-nav button, .tut-skip { padding: 7px 12px; }
.tut-nav button:disabled { opacity: .4; }
.tut-skip { display: block; width: 100%; margin-top: 6px; background: none; border: none; color: #7d97a0; text-decoration: underline; }
#tut-open { margin-top: 6px; }
@media (max-width: 600px) {
  body.tut-open #panel { display: none; }   /* the panel would sit under the tour card on a phone; close the tour to get it back */
  #tut { left: 8px; right: 8px; bottom: 8px; width: auto; max-height: 52vh; font-size: 13px; }
}`;

async function init() {
  const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  const panel = document.getElementById('panel');
  const b = el('<button id="tut-open" title="A short guided tour with five challenges">Guided tour and challenges</button>');
  b.onclick = () => open(S.step >= STEPS.length - 1 ? 0 : S.step);
  const row = el('<div class="row"></div>'); row.appendChild(b);
  const first = panel.querySelector('#layers'); panel.insertBefore(row, first);
  if (!(await ready())) return;
  if (!S.seen || S.open) open(S.step);                    // first visit: welcome card; mid-tour: carry on where you were
}
init();
window.__tutorial = { open, close, go, get state() { return JSON.parse(JSON.stringify(S)); }, STEPS };
