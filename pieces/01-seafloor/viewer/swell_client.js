// swell_client.js: the swell model behind a worker (swell_worker.js). PLUMBING.
// makeModelAsync(points, grid, key) returns { run(p) -> Promise of { grid, points }, cellAt, outerBreak, cellOf, N }:
// the same results as swell_model.js makeModel().run(), computed off the main thread. If module workers are not
// available it runs the same code on the main thread instead.
import { makeModel, cellIndex, gridTools, GRID } from './swell_model.js?v=c4';
let worker = null, seq = 0;
const pending = new Map();
const MAKE_TIMEOUT_MS = 30000, RUN_TIMEOUT_MS = 20000;   // far above the 0.3 s worst case: only a dead or stuck worker gets here
function killWorker(w, why) {                          // the worker is gone or stuck: reject everything waiting on it, drop it; handles fall back to the main thread
  try { w.terminate(); } catch (e) { /* already gone */ }
  w.dead = true; if (worker === w) worker = null;
  for (const [id, q] of pending) if (q.w === w) { pending.delete(id); clearTimeout(q.timer); q.reject(new Error('swell worker failed: ' + why)); }
}
function getWorker() {
  if (worker !== null) return worker;
  try {
    const w = worker = new Worker(new URL('./swell_worker.js?v=w2', import.meta.url), { type: 'module' });
    w.onmessage = e => { const q = pending.get(e.data.id); if (!q) return; pending.delete(e.data.id); clearTimeout(q.timer);
      if (e.data.error) { const err = new Error(e.data.error); err.noModel = !!e.data.noModel; q.reject(err); } else q.resolve(e.data.res); };
    w.onerror = e => killWorker(w, e.message || 'error');
    w.onmessageerror = () => killWorker(w, 'message error');
  } catch (err) { worker = false; }
  return worker;
}
const call = (w, msg, ms) => new Promise((resolve, reject) => {
  if (w.dead) return reject(new Error('swell worker is gone'));
  const id = ++seq, timer = setTimeout(() => killWorker(w, 'timeout after ' + ms + ' ms'), ms);
  pending.set(id, { w, resolve, reject, timer });
  try { w.postMessage({ ...msg, id }); } catch (err) { pending.delete(id); clearTimeout(timer); reject(err); }
});
export async function makeModelAsync(points, grid = GRID, key = 'model') {
  const tools = gridTools(grid), cellOf = cellIndex(points, grid), N = points.depth_m.length;
  const local = () => { const m = makeModel(points, grid); return { ...tools, cellOf, N, run: async p => m.run(p), where: 'main thread' }; };
  const w = getWorker();
  if (!w) return local();
  const make = () => call(w, { op: 'make', key, grid, points: { x_m: points.x_m, y_m: points.y_m, depth_m: points.depth_m } }, MAKE_TIMEOUT_MS);   // copied, not transferred: the viewer keeps its own
  try {
    await make();
  } catch (err) { return local(); }
  let fallback = null;
  return { ...tools, cellOf, N, where: 'worker',
    run: async p => { if (fallback) return fallback.run(p);
      try {
        try { return await call(w, { op: 'run', key, p }, RUN_TIMEOUT_MS); }
        catch (err) { if (!err.noModel) throw err; await make(); return await call(w, { op: 'run', key, p }, RUN_TIMEOUT_MS); }   // the worker evicted this model (it keeps few): send it again
      } catch (err) { fallback = local(); return fallback.run(p); } } };
}
