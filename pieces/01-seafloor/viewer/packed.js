// packed.js: reads the viewer's .bin.gz data files (written by tools/pack_data.py). PLUMBING.
// Returns the same object JSON.parse gave for the matching .json, except that each long list of numbers is a
// Float64Array (same doubles; null became NaN). gzip is unpacked with DecompressionStream (all current browsers).
const TYPES = { i1: Int8Array, i2: Int16Array, i4: Int32Array, f8: Float64Array };
export function decodePacked(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf);
  if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'OCB1') throw new Error('not a packed data file');
  const hlen = dv.getUint32(4, true), head = JSON.parse(new TextDecoder().decode(u8.subarray(8, 8 + hlen)));
  const base = (8 + hlen + 7) & ~7;
  const arrays = head.arrays.map(a => {
    const T = TYPES[a.t], raw = new T(buf, base + a.o, a.n), out = new Float64Array(a.n);
    if (a.t === 'f8') { out.set(raw); return out; }
    const nul = -(2 ** (8 * T.BYTES_PER_ELEMENT - 1)), f = 10 ** a.s;   // smallest value of the type = null
    if (a.s === 0) for (let i = 0; i < a.n; i++) { const q = raw[i]; out[i] = q === nul ? NaN : q; }
    else for (let i = 0; i < a.n; i++) { const q = raw[i]; out[i] = q === nul ? NaN : q / f; }   // correctly rounded: same double as the decimal text
    return out;
  });
  const walk = o => {
    if (Array.isArray(o)) return o.map(walk);
    if (o && typeof o === 'object') {
      if (typeof o.$a === 'number' && Object.keys(o).length === 1) return arrays[o.$a];
      for (const k of Object.keys(o)) o[k] = walk(o[k]);
    }
    return o;
  };
  return walk(head.root);
}
export async function fetchPacked(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unpack the data (no DecompressionStream)');
  return decodePacked(await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
}
