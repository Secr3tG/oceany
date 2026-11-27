// swell_worker.js: runs swell_model.js off the main thread (module Web Worker), so a Guéthary-size run (0.1-0.3 s)
// never freezes the page. PLUMBING: the physics is swell_model.js, unchanged. Started by swell_client.js.
// Messages: { id, op: 'make', key, points: { x_m, y_m, depth_m }, grid } builds and keeps a model;
//           { id, op: 'run', key, p } runs one case and posts back the per-point arrays and the grid fields play.js reads.
import { makeModel } from './swell_model.js?v=c4';
const models = new Map(), MODELS_MAX = 2;   // least recently used out: a 4 m French grid model holds up to ~100 MB of cached normals
self.onmessage = e => {
  const { id, op, key } = e.data;
  try {
    if (op === 'make') {
      models.delete(key); models.set(key, makeModel(e.data.points, e.data.grid || undefined));
      while (models.size > MODELS_MAX) models.delete(models.keys().next().value);
      self.postMessage({ id, ok: true });
    } else if (op === 'run') {
      const m = models.get(key); if (!m) { self.postMessage({ id, error: 'no model ' + key, noModel: true }); return; }   // evicted: the client sends the model again
      models.delete(key); models.set(key, m);
      const r = m.run(e.data.p), P = r.points, g = r.grid;
      const points = { H: Float64Array.from(P.H), broken: Uint8Array.from(P.broken), k: Float64Array.from(P.k), phase: Float64Array.from(P.phase),
                       state: Uint8Array.from(P.state), first: P.first };
      const grid = { H: g.H, broken: g.broken, first: g.first, d: g.d, wet: g.wet, reach: g.reach };   // fresh per run: transferred, not copied
      self.postMessage({ id, ok: true, res: { points, grid } }, [...Object.values(points), ...Object.values(grid)].map(a => a.buffer));
    }
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
