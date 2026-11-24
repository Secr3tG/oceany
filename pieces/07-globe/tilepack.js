// terrain2 tiles from range-read packs (format: tiles-build/v2/FORMAT.md; built by tiles-build/v2/convert.py / pack.py).
// One tile = 128 x 128 dot heights (the old PNG decoder's 2 x 2 means), deflate-raw, ~3.5x smaller than the PNG.
// Tiles live in packs of 16 x 16 (z6+) or in base.pack (z0-z5); this module reads a pack's header once, then fetches
// the tiles it is asked for with as few HTTP Range requests as possible, inflates them with DecompressionStream and
// keeps the compressed bytes in the Cache API (persistent, size-capped). No dependencies, no build step.
//
// API (DESIGN.md "Client API"; fields may be added, never changed):
//   supported                                 DecompressionStream('deflate-raw') exists
//   createPackSource(base, { cacheName, maxInflight, cacheMaxBytes })
//     .ready      Promise<coverage | null>
//     .covered(z, x, y)
//     .getTile(z, x, y, { signal, prio })     -> Promise<{ elev: Float32Array(16384), base, step, flags } | null>
//                                                null: tile absent (not covered, pack 404, empty entry).
//                                                prio: lower is fetched sooner (e.g. screen distance); default 0.
//                                                Rejects with an AbortError when its signal aborts, Error on network failure.
//     .getTile(z, x, y, { raw: true, ... })   (b53) -> Promise<{ body: Uint8Array } | null>: the compressed body, not
//                                                decoded (terrain.js decodes it in terrain-worker.js); dropTile() if it is bad
//     .dropTile(z, x, y)                      (b53) forget a cached body that would not decode
//     .prefetch(z, x, y, { signal, prio })    low priority (after every getTile), into the persistent cache only; the signal
//                                                (b53) cancels it while it waits or, with its range, while in flight
//     .warmBase(maxZ)                         (b53) the coarse world base: every tile z0..maxZ (<= 5) into the persistent
//                                                cache, pinned (never trimmed), in a background lane that starts a range only
//                                                while no other tile is waiting, at most BG_INFLIGHT at once.
//                                                -> Promise<{ tiles, fetched, ms }>; progress in stats().base
//     .inCache(z, x, y)                       (b53) true when the tile's body is in the persistent cache (sync)
//     .stats()                                { requests, bytes, tiles, cacheHits, headerReads, ... }
//   decodeTile(bytes)                         (addition) one compressed tile body -> same object as getTile

const N = 128, NN = N * N;
const BASE_Z = 5, BASE_COUNT = 1365, LEVEL_START = [0, 1, 5, 21, 85, 341];
const PACK_COUNT = 256;
const MERGE_GAP = 8192;              // wanted tiles of one pack closer than this share one Range request
// ...up to this many bytes per request. 2026-11-24 round 3: 1 MB → 192 KB. A whole-globe view asked base.pack for one
// multi-MB run and waited for all of it over a slow link (first readable 8.7 s vs 0.1 s for the PNG tiles); now the run
// is split into ranges fetched in parallel (maxInflight), the one holding the most urgent tile (lowest prio) first.
const MAX_RANGE = 192 << 10;
const FULL_MAX = 16 << 20;           // a server that ignores Range sends the whole pack: keep it in memory if smaller
// b53: priorities. getTile callers use screen distance (small numbers); prefetches come after every getTile (PF_PRIO + prio);
// the world base after everything (BG_PRIO + order), and its ranges (BG_RANGE at most) start only when no other tile waits or
// is in flight, BG_INFLIGHT at once, so on a slow line it holds at most ~2 x 128 KB of bandwidth from tiles the screen needs.
const PF_PRIO = 1e9, BG_PRIO = 1e12, BG_INFLIGHT = 2, BG_RANGE = 128 << 10, BG_IDLE_MS = 500;

export const supported = (() => {
  try { return typeof DecompressionStream === 'function' && !!new DecompressionStream('deflate-raw'); } catch (e) { return false; }
})();

const abortError = () => (typeof DOMException === 'function' ? new DOMException('Aborted', 'AbortError') : Object.assign(new Error('Aborted'), { name: 'AbortError' }));
const checkAbort = (signal) => { if (signal && signal.aborted) throw abortError(); };

function morton(x, y) {
  let m = 0;
  for (let b = 0; b < 8; b++) m += (((x >> b) & 1) << (2 * b)) + (((y >> b) & 1) << (2 * b + 1));
  return m;
}
const entryIndex = (z, x, y) => (z <= BASE_Z ? LEVEL_START[z] + morton(x, y) : morton(x & 15, y & 15));

async function inflate(u8) {
  const s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// One compressed tile body -> { elev, base, step, flags }. Inverse of t2.py encode: un-shuffle the bytes, un-zigzag,
// add back the predictor left + up - upleft (0 outside the tile) mod 2^16, then h = base + q * step.
export async function decodeTile(body) {
  const raw = await inflate(body);
  if (raw.length < 16 + 2 * NN || raw[0] !== 79 || raw[1] !== 84 || raw[2] !== 50 || raw[3] !== 84) throw new Error('terrain2: not a tile');
  const dv = new DataView(raw.buffer, raw.byteOffset, 16);
  if (raw[4] !== 1 || dv.getUint16(6, true) !== N) throw new Error('terrain2: unsupported tile version');
  const flags = raw[5], base = dv.getFloat32(8, true), step = dv.getFloat32(12, true);
  const q = new Int32Array(NN), elev = new Float32Array(NN);
  const LO = 16, HI = 16 + NN;
  for (let j = 0, k = 0; j < N; j++) {
    for (let i = 0; i < N; i++, k++) {
      const zz = raw[LO + k] | (raw[HI + k] << 8);
      const r = (zz >>> 1) ^ -(zz & 1);
      const a = i ? q[k - 1] : 0, b = j ? q[k - N] : 0, c = i && j ? q[k - N - 1] : 0;
      const v = (r + a + b - c) & 0xFFFF;
      q[k] = v; elev[k] = base + v * step;
    }
  }
  return { elev, base, step, flags };
}

function parseHeader(buf) {
  const u8 = new Uint8Array(buf);
  if (u8.length < 16 || u8[0] !== 79 || u8[1] !== 84 || u8[2] !== 50 || u8[3] !== 80 || u8[4] !== 1) throw new Error('terrain2: not a pack');
  const dv = new DataView(buf);
  const count = dv.getUint16(6, true);
  if (u8.length < 16 + 8 * count) throw new Error('terrain2: short pack header');
  const table = new Uint32Array(2 * count);
  for (let k = 0; k < 2 * count; k++) table[k] = dv.getUint32(16 + 4 * k, true);
  return { z: u8[5], count, table, bytes: u8.slice(0, 16 + 8 * count) };
}

export function createPackSource(base, opts = {}) {
  const baseUrl = (() => { const u = new URL(base, typeof location !== 'undefined' ? location.href : undefined).href; return u.endsWith('/') ? u : u + '/'; })();
  const cacheName = opts.cacheName || 'oceany-terrain2-v1';
  const maxInflight = Math.max(1, opts.maxInflight || 6);
  const cacheMax = opts.cacheMaxBytes || 150e6;
  const HEADER_LRU = opts.headerLru || 96;
  const st = { requests: 0, bytes: 0, tiles: 0, cacheHits: 0, headerReads: 0, headerCacheHits: 0, ranges: 0, rangeTiles: 0, absent: 0, aborted: 0, errors: 0 };

  // ---- coverage
  // Round 4 (2026-11-24): a repeat visit starts from the copy of coverage.json kept in the Cache API at once and revalidates
  // it in the background, so cached tiles and headers are served without waiting on the network (over a line with 3-4 s
  // TTFB a warm whole-globe view took 42 s). When the network copy has another version, new requests switch to it (new
  // cache keys, pack headers re-read); tiles cached under the old version stay until the next start purges them.
  let cov = null, ver = '';
  const COV_KEY = `${baseUrl}__coverage.json`;
  const accept = (j) => (j && j.format === 'terrain2' ? j : null);
  const verOf = (j) => (j && (j.version || j.built)) || '';
  const fromCache = (async () => {
    try {
      if (typeof caches === 'undefined') return null;
      const r = await (await caches.open(cacheName)).match(COV_KEY);
      return r ? accept(await r.json()) : null;
    } catch (e) { return null; }
  })();
  const fromNet = fetch(baseUrl + 'coverage.json', { credentials: 'omit', cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null)).then(accept).catch(() => null);
  function useNet(j) {
    if (!j) return;
    if (cov && verOf(j) !== ver) headers.clear();   // another build: pack offsets differ, read the headers again
    cov = j; ver = verOf(j);
    try { if (typeof caches !== 'undefined') caches.open(cacheName).then((c) => c.put(COV_KEY, new Response(JSON.stringify(j), { headers: { 'content-type': 'application/json' } }))).catch(() => {}); } catch (e) { /* ignore */ }
  }
  const ready = fromCache.then((cj) => {
    if (cj) { cov = cj; ver = verOf(cj); fromNet.then(useNet); return cov; }
    return fromNet.then((j) => { useNet(j); return cov; });
  });
  const inRects = (rs, x, y) => { if (rs) for (const r of rs) if (x >= r[0] && x <= r[1] && y >= r[2] && y <= r[3]) return true; return false; };
  function covered(z, x, y) {
    const n = 2 ** z; if (z < 0 || x < 0 || y < 0 || x >= n || y >= n) return false;
    if (!cov) return z <= 7;                                // before coverage.json arrives: global levels only (as terrain-source.js)
    if (z <= cov.globalMaxZoom) return true;
    return inRects(cov.rects && cov.rects[z], x, y);
  }
  const packListed = (z, X, Y) => z <= BASE_Z || !cov || !cov.packs || inRects(cov.packs[z], X, Y);
  const packId = (z, x, y) => (z <= BASE_Z ? 'base' : `${z}/${x >> 4}_${y >> 4}`);
  const packUrl = (id) => baseUrl + id + '.pack';
  const hdrKey = (id) => `${baseUrl}${id}.hdr?v=${ver}`;
  const tileKey = (z, x, y) => `${baseUrl}${z}/${x}/${y}.t2?v=${ver}`;

  // ---- persistent cache (Cache API); every call guarded, the source works without it
  let cacheP = null, index = null, total = 0, saveTimer = 0;
  const INDEX_KEY = () => `${baseUrl}__t2index.json`;
  function openCache() {
    if (!cacheP) cacheP = (async () => {
      try {
        if (typeof caches === 'undefined') return null;
        const c = await caches.open(cacheName);
        index = new Map(); total = 0;
        try { const r = await c.match(INDEX_KEY()); if (r) for (const [k, t, s] of await r.json()) index.set(k, { t, s }); } catch (e) { /* rebuilt below */ }
        await ready;
        const live = new Set();
        for (const req of await c.keys()) {
          const k = req.url; if (k === INDEX_KEY() || !k.startsWith(baseUrl)) continue;
          if (k === COV_KEY) continue;
          if (!k.endsWith('?v=' + ver)) { c.delete(k).catch(() => {}); index.delete(k); continue; }   // an older build
          live.add(k); if (!index.has(k)) index.set(k, { t: 0, s: 16384 });
        }
        for (const k of [...index.keys()]) if (!live.has(k)) index.delete(k);
        for (const v of index.values()) total += v.s;
        return c;
      } catch (e) { return null; }
    })();
    return cacheP;
  }
  function saveIndexSoon(c) {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      try { c.put(INDEX_KEY(), new Response(JSON.stringify([...index].map(([k, v]) => [k, v.t, v.s])), { headers: { 'content-type': 'application/json' } })).catch(() => {}); } catch (e) { /* ignore */ }
    }, 3000);
  }
  async function cacheGet(key) {
    try {
      const c = await openCache(); if (!c) return null;
      const r = await c.match(key); if (!r) return null;
      const u8 = new Uint8Array(await r.arrayBuffer());
      const e = index.get(key); if (e) e.t = Date.now(); else { index.set(key, { t: Date.now(), s: u8.length }); total += u8.length; }
      saveIndexSoon(c);
      return u8;
    } catch (e) { return null; }
  }
  async function cachePut(key, u8) {
    try {
      const c = await openCache(); if (!c) return false;
      await c.put(key, new Response(u8, { headers: { 'content-type': 'application/octet-stream' } }));
      const old = index.get(key); if (old) total -= old.s;
      index.set(key, { t: Date.now(), s: u8.length }); total += u8.length;
      if (total > cacheMax) trim(c);
      saveIndexSoon(c);
      return true;
    } catch (e) { return false; }
  }
  async function cacheHas(key) {
    try { const c = await openCache(); return !!(c && index.has(key) && (await c.match(key))); } catch (e) { return false; }
  }
  function cacheDrop(key) {
    openCache().then((c) => { if (c) { c.delete(key).catch(() => {}); const e = index.get(key); if (e) { total -= e.s; index.delete(key); } } }).catch(() => {});
  }
  let pinZ = -1;                             // warmBase: tiles at this level or coarser are never trimmed
  const keyZ = (k) => { const m = /\/(\d+)\/\d+\/\d+\.t2\?v=/.exec(k); return m ? +m[1] : 99; };
  function trim(c) {
    const all = [...index].filter(([k]) => keyZ(k) > pinZ).sort((a, b) => a[1].t - b[1].t);   // least recently used first
    for (const [k, v] of all) {
      if (total <= 0.9 * cacheMax) break;
      index.delete(k); total -= v.s; c.delete(k).catch(() => {});
    }
  }

  // ---- concurrency: header reads first, then tile ranges by priority
  let inflight = 0, pumpTimer = 0, bgInflight = 0, fgAt = 0, bgTimer = 0;
  const headerJobs = [];                       // thunks
  const pending = new Map();                   // pack header object -> { hdr, entries: Set }
  const flying = new Map();                    // tile key -> entry (queued or in flight)
  function schedule() { if (!pumpTimer) pumpTimer = setTimeout(() => { pumpTimer = 0; pump(); }, 0); }
  function pump() {
    while (inflight < maxInflight) {
      if (headerJobs.length) { inflight++; fgAt = performance.now(); headerJobs.shift()().finally(() => { inflight--; fgAt = performance.now(); pump(); }); continue; }
      let best = null, bestPack = null;
      for (const [id, p] of pending) for (const e of p.entries) if (!best || e.prio < best.prio) { best = e; bestPack = id; }
      if (!best) return;
      const bg = best.prio >= BG_PRIO;   // only background tiles wait (best is the lowest prio)
      // and only while no other range is in flight and none has started or ended for BG_IDLE_MS (between two select passes
      // of terrain.js the queue is empty for a moment while the view is still loading)
      if (bg && (bgInflight >= BG_INFLIGHT || inflight > bgInflight)) return;
      if (bg && performance.now() - fgAt < BG_IDLE_MS) { if (!bgTimer) bgTimer = setTimeout(() => { bgTimer = 0; pump(); }, BG_IDLE_MS + 20); return; }
      const cap = bg ? BG_RANGE : MAX_RANGE;
      const p = pending.get(bestPack);
      // b53: a range for visible tiles never carries world-base tiles along (base.pack is contiguous: a z3 tile asked for
      // by the view pulled ~190 KB of the background's neighbours with it, on Fast 4G +2 s for a cold Peniche)
      const list = (bg ? [...p.entries] : [...p.entries].filter((e) => e.prio < BG_PRIO)).sort((a, b) => a.off - b.off);
      // gap-merge the pack's wanted tiles into ranges, take the range holding the most urgent tile
      let cur = null, pick = null;
      for (const e of list) {
        if (!cur || e.off - cur.end >= MERGE_GAP || e.off + e.len - cur.start > cap) {
          if (pick) break;
          cur = { start: e.off, end: e.off + e.len, entries: [] };
        }
        cur.entries.push(e); cur.end = Math.max(cur.end, e.off + e.len);
        if (e === best) pick = cur;
      }
      if (!pick) pick = cur;
      for (const e of pick.entries) p.entries.delete(e);
      if (!p.entries.size) pending.delete(bestPack);
      inflight++; if (bg) bgInflight++; else fgAt = performance.now();
      runRange(p.hdr, pick).finally(() => { inflight--; if (bg) bgInflight--; else fgAt = performance.now(); pump(); });
    }
  }
  const limited = (fn) => new Promise((res, rej) => { headerJobs.push(() => fn().then(res, rej)); schedule(); });

  // ---- pack headers: memory LRU -> Cache API -> network (Range 0..16 + 8 * count - 1)
  const headers = new Map(), headerWait = new Map();
  function rememberHeader(id, h) { headers.delete(id); headers.set(id, h); while (headers.size > HEADER_LRU) headers.delete(headers.keys().next().value); return h; }
  function dropHeader(id) { headers.delete(id); cacheDrop(hdrKey(id)); }
  async function getHeader(id) {
    const m = headers.get(id); if (m) { headers.delete(id); headers.set(id, m); return m; }
    if (headerWait.has(id)) return headerWait.get(id);
    const p = (async () => {
      const cached = await cacheGet(hdrKey(id));
      if (cached) {
        try {
          const h = parseHeader(cached.buffer.slice(cached.byteOffset, cached.byteOffset + cached.length));
          st.headerCacheHits++;   // no ETag kept: the cache key carries coverage.json's version instead
          return rememberHeader(id, { id, url: packUrl(id), table: h.table, count: h.count, etag: null });
        } catch (e) { /* refetch */ }
      }
      const count = id === 'base' ? BASE_COUNT : PACK_COUNT;
      return limited(async () => {
        const r = await fetch(packUrl(id), { headers: { Range: `bytes=0-${16 + 8 * count - 1}` }, credentials: 'omit' });
        st.requests++; st.headerReads++;
        if (r.status === 404 || r.status === 403) { return rememberHeader(id, { id, absent: true }); }
        if (!r.ok) throw new Error('terrain2 pack header HTTP ' + r.status);
        const buf = await r.arrayBuffer(); st.bytes += buf.byteLength;
        const h = parseHeader(buf);
        const hd = { id, url: packUrl(id), table: h.table, count: h.count, etag: r.headers.get('ETag') };
        if (r.status === 200 && buf.byteLength <= FULL_MAX) hd.full = new Uint8Array(buf);   // server ignored Range
        cachePut(hdrKey(id), h.bytes);
        return rememberHeader(id, hd);
      });
    })();
    headerWait.set(id, p);
    try { return await p; } finally { headerWait.delete(id); }
  }

  // ---- one Range request for some tiles of one pack
  async function runRange(hdr, range) {
    const live = range.entries.filter((e) => e.waiters.size);
    if (!live.length) return;
    const ctrl = new AbortController(); range.ctrl = ctrl; range.live = live.length;
    for (const e of range.entries) e.range = range;
    st.ranges++; st.rangeTiles += range.entries.length;
    try {
      const r = await fetch(hdr.url, { headers: { Range: `bytes=${range.start}-${range.end - 1}` }, signal: ctrl.signal, credentials: 'omit' });
      st.requests++;
      if (r.status === 404 || r.status === 403) { rememberHeader(hdr.id, { id: hdr.id, absent: true }); for (const e of range.entries) settle(e, null); return; }
      if (!r.ok) { dropHeader(hdr.id); throw new Error('terrain2 range HTTP ' + r.status); }
      const etag = r.headers.get('ETag');
      if (r.status === 206 && hdr.etag && etag && etag !== hdr.etag) { dropHeader(hdr.id); const err = new Error('terrain2: pack changed'); err.stale = true; throw err; }
      const buf = new Uint8Array(await r.arrayBuffer()); st.bytes += buf.length;
      const at = r.status === 206 ? range.start : 0;
      if (r.status === 200 && buf.length <= FULL_MAX) hdr.full = buf;
      for (const e of range.entries) {
        if (e.off - at + e.len > buf.length) { settle(e, undefined, new Error('terrain2: short range')); continue; }
        settle(e, buf.slice(e.off - at, e.off - at + e.len));
      }
    } catch (err) {
      if (ctrl.signal.aborted) st.aborted++; else st.errors++;
      for (const e of range.entries) settle(e, undefined, ctrl.signal.aborted ? abortError() : err);
    }
  }
  function settle(e, body, err) {
    if (flying.get(e.key) === e) flying.delete(e.key);
    for (const w of e.waiters) { w.off(); err ? w.reject(err) : w.resolve(body); }
    e.waiters.clear();
  }

  // a tile's compressed bytes through the shared queue (one request per tile key, many waiters)
  function requestBody(hdr, idx, key, signal, prio) {
    return new Promise((resolve, reject) => {
      let e = flying.get(key);
      if (!e) {
        e = { key, off: hdr.table[2 * idx], len: hdr.table[2 * idx + 1], prio, waiters: new Set(), range: null };
        flying.set(key, e);
        let p = pending.get(hdr); if (!p) { p = { hdr, entries: new Set() }; pending.set(hdr, p); }
        p.entries.add(e);
        schedule();
      } else if (prio < e.prio) e.prio = prio;
      const w = { resolve, reject, off: () => {} };
      if (signal) {
        const onAbort = () => {
          e.waiters.delete(w); reject(abortError());
          if (e.waiters.size) return;
          if (flying.get(e.key) === e) flying.delete(e.key);      // nobody wants this tile any more
          if (!e.range) { const p = pending.get(hdr); if (p) { p.entries.delete(e); if (!p.entries.size) pending.delete(hdr); } }
          else if (--e.range.live <= 0 && e.range.ctrl) e.range.ctrl.abort();   // abort only when every tile of the range is cancelled
        };
        signal.addEventListener('abort', onAbort, { once: true });
        w.off = () => signal.removeEventListener('abort', onAbort);
      }
      e.waiters.add(w);
    });
  }

  async function fetchBody(z, x, y, signal, prio, known = false) {
    const key = tileKey(z, x, y);
    const cached = known ? null : await cacheGet(key);   // known: the caller checked the index (warmBase; keeps hundreds of
                                                         // lookups out of the Cache API queue the visible tiles wait in)
    checkAbort(signal);
    if (cached) { st.cacheHits++; return { body: cached, cached: true }; }
    const id = packId(z, x, y), idx = entryIndex(z, x, y);
    for (let attempt = 0; ; attempt++) {
      const hdr = await getHeader(id);
      checkAbort(signal);
      if (hdr.absent || idx >= hdr.count || !hdr.table[2 * idx + 1]) return { body: null };
      if (hdr.full) { const o = hdr.table[2 * idx], l = hdr.table[2 * idx + 1]; return { body: hdr.full.slice(o, o + l) }; }
      try { return { body: await requestBody(hdr, idx, key, signal, prio) }; } catch (err) { if (!err || !err.stale || attempt) throw err; }
    }
  }

  async function getTile(z, x, y, { signal, prio = 0, raw = false } = {}) {
    checkAbort(signal);
    if (!cov) await ready;
    checkAbort(signal);
    if (!covered(z, x, y) || !packListed(z, x >> 4, y >> 4)) { st.absent++; return null; }
    const { body, cached } = await fetchBody(z, x, y, signal, prio);
    if (!body) { st.absent++; return null; }
    if (!cached) cachePut(tileKey(z, x, y), body);
    if (raw) { st.tiles++; return { body, cached: !!cached }; }
    let t;
    try { t = await decodeTile(body); } catch (err) { if (cached) cacheDrop(tileKey(z, x, y)); throw err; }
    st.tiles++;
    return t;
  }

  async function prefetch(z, x, y, { signal = null, prio = 0 } = {}) {
    try {
      if (!cov) await ready;
      if (!covered(z, x, y) || !packListed(z, x >> 4, y >> 4)) return false;
      if (!(await openCache())) return false;                    // nowhere to keep it
      const key = tileKey(z, x, y);
      if (await cacheHas(key)) return true;
      const { body, cached } = await fetchBody(z, x, y, signal, PF_PRIO + Math.max(0, Math.min(PF_PRIO - 1, prio)));
      if (body && !cached) return cachePut(key, body);
      return !!body;
    } catch (e) { return false; }
  }

  // b53: the coarse world base (see the API note). Coarse levels first (z0-z3 is ~1.8 MB, z4 ~4.9 MB more), Morton order
  // inside a level, which is the order of base.pack, so neighbouring tiles share ranges. Tiles already in the persistent
  // cache are skipped: after the first visit this costs no request at all.
  const baseSt = { maxZ: -1, tiles: 0, have: 0, fetched: 0, done: false };
  let baseP = null;
  function warmBase(maxZ = 4) {
    if (baseP) return baseP;
    maxZ = Math.max(0, Math.min(BASE_Z, maxZ)); pinZ = maxZ; baseSt.maxZ = maxZ;
    const t0 = performance.now();
    return (baseP = (async () => {
      if (!cov) await ready;
      const c = await openCache(); if (!c) { baseSt.done = true; return { tiles: 0, fetched: 0, ms: 0 }; }   // nowhere to keep it
      const list = [];
      for (let z = 0; z <= maxZ; z++) { const n = 2 ** z, byM = new Array(n * n); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) byM[morton(x, y)] = [z, x, y]; list.push(...byM); }
      baseSt.tiles = list.length;
      await Promise.all(list.map(async ([z, x, y], i) => {
        const key = tileKey(z, x, y);
        if (index.has(key)) { baseSt.have++; return; }
        try {
          const { body, cached } = await fetchBody(z, x, y, null, BG_PRIO + i, true);
          if (body && !cached) { await cachePut(key, body); baseSt.fetched++; }
          if (body) baseSt.have++;
        } catch (e) { /* a failed range: the tile loads on demand later */ }
      }));
      baseSt.done = true; baseSt.ms = Math.round(performance.now() - t0);
      return { tiles: baseSt.tiles, fetched: baseSt.fetched, ms: baseSt.ms };
    })());
  }
  const baseHas = (z) => baseSt.done && z <= baseSt.maxZ;
  // (b53) is this tile's body in the persistent cache already (no request needed)? Synchronous, from the cache index.
  const inCache = (z, x, y) => !!(index && index.has(tileKey(z, x, y)));

  function stats() {
    let queued = 0; for (const p of pending.values()) queued += p.entries.size;
    return Object.assign({}, st, { base: Object.assign({}, baseSt), bgInflight, inflight, queued, headersInMemory: headers.size, cacheBytes: total, cacheEntries: index ? index.size : 0 });
  }

  const dropTile = (z, x, y) => cacheDrop(tileKey(z, x, y));
  return { ready, covered, getTile, dropTile, prefetch, warmBase, baseHas, inCache, stats, base: baseUrl, get coverage() { return cov; } };
}
