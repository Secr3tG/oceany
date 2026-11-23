"""A small GRIB2 reader for what NOAA's NOMADS serves (GFS 10 m wind, GFS-Wave / WAVEWATCH III). No eccodes needed.

One reader for the project: it does what build_ocean.py's own reader did (complex packing for GFS wind, JPEG 2000 for
the full GFS-Wave files) and what live-data/grib2_simple.py does (simple packing from the filter_gfswave.pl CGI, plus
each message's names, times and grid). Anything else raises, so a format change shows up as an error instead of wrong
numbers.

A GRIB2 file is a run of messages ("GRIB" ... "7777"). Each message is a list of numbered sections: 1 = reference time,
3 = the grid, 4 = what the field is and when, 5 = how the numbers are packed, 6 = which points have data (a bitmap:
land has none in the wave files), 7 = the packed numbers. Every value is (R + X * 2^E) / 10^D for whole numbers X
(WMO GRIB2 manual, section 5).

Handled: grid template 3.0 (regular latitude-longitude), product template 4.0, packing templates 5.0 (simple),
5.3 (complex with spatial differencing) and 5.40 (JPEG 2000, decoded with Pillow), bitmap present or absent.

  messages(buf)      yields one dict per message: discipline, category, number, surface (type, value), ref, lead_h,
                     valid (datetimes), ni, nj, lats (1-D, as stored), lons (1-D, 0..360), values (2-D, NaN = no data)
  decode_grib2(msg)  one message's values only, as float32 rows from the south (what build_ocean.py stores)
"""
import datetime as dt
import io
import struct

import numpy as np


def signed(raw, nbytes):
    """GRIB stores negative whole numbers as a sign bit plus size, not two's complement."""
    top = 1 << (8 * nbytes - 1)
    return -(raw & (top - 1)) if raw & top else raw


def _u(b, o, n):
    return int.from_bytes(b[o:o + n], "big")


def read_bits(buf, bit_pos, widths):
    """Unsigned whole numbers of the given widths (0..32 bits) starting at the given bit positions, all at once."""
    b = np.frombuffer(bytes(buf) + bytes(8), dtype=np.uint8)
    byte = (bit_pos >> 3).astype(np.int64)
    window = np.zeros(len(byte), dtype=np.uint64)
    for k in range(5):                                            # 5 bytes cover 32 bits at any starting bit
        window = (window << np.uint64(8)) | b[byte + k].astype(np.uint64)
    shift = (40 - (bit_pos & 7) - widths).astype(np.uint64)
    return ((window >> shift) & ((np.uint64(1) << widths.astype(np.uint64)) - np.uint64(1))).astype(np.int64)


def unpack_simple(d, n, nbits):
    """Template 5.0: n whole numbers of nbits each, back to back."""
    if nbits == 0:
        return np.zeros(n, np.int64)
    bits = np.unpackbits(np.frombuffer(bytes(d), dtype=np.uint8))[: n * nbits].reshape(n, nbits)
    return bits.dot(1 << np.arange(nbits - 1, -1, -1, dtype=np.int64))


def unpack_jpeg2000(d, n, nbits):
    """Template 5.40: the whole numbers are a greyscale JPEG 2000 image."""
    if nbits == 0:
        return np.zeros(n, np.int64)
    from PIL import Image                                         # only needed for these files
    depth = (d[42] & 0x7F) + 1                                    # the image's bit depth, from its header (SIZ marker)
    X = np.array(Image.open(io.BytesIO(bytes(d))), dtype=np.int64).ravel()
    if depth < 16:                                                # Pillow stretches it to 16 bits by shifting left; undo that
        assert not (X & ((1 << (16 - depth)) - 1)).any(), "unexpected JPEG 2000 scaling"
        X >>= 16 - depth
    return X


def unpack_complex(p, d, nbits):
    """Template 5.3: values come in groups, each with its own minimum and bit width; then one or two rounds of
    'difference from the previous value' are undone. The GFS file uses this for its wind."""
    ng = struct.unpack(">I", p[31:35])[0]
    w_ref, w_bits = p[35], p[36]
    l_ref, l_inc = struct.unpack(">I", p[37:41])[0], p[41]
    l_last, l_bits = struct.unpack(">I", p[42:46])[0], p[46]
    order, nd = p[47], p[48]
    assert p[22] == 0, "missing-value groups not handled"
    assert order in (1, 2)
    first = [int.from_bytes(d[k * nd:(k + 1) * nd], "big") for k in range(order)]
    gmin = signed(int.from_bytes(d[order * nd:(order + 1) * nd], "big"), nd)
    pos = (order + 1) * nd * 8

    def block(n, bits):                                           # n numbers of equal width, then skip to a whole byte
        nonlocal pos
        out = read_bits(d, pos + np.arange(n, dtype=np.int64) * bits, np.full(n, bits)) if bits else np.zeros(n, np.int64)
        pos += -(-n * bits // 8) * 8
        return out
    refs = block(ng, nbits)
    widths = block(ng, w_bits) + w_ref
    lengths = block(ng, l_bits) * l_inc + l_ref
    lengths[-1] = l_last
    each_w = np.repeat(widths, lengths)
    starts = pos + np.concatenate([[0], np.cumsum(each_w)[:-1]])
    X = read_bits(d, starts, each_w) + np.repeat(refs, lengths)
    X[order:] += gmin
    X[:order] = first
    if order == 2:                                                # second differences -> first differences -> values
        X[1:] = X[1] - X[0] + np.concatenate([[0], np.cumsum(X[2:])])
        X[1:] = X[0] + np.cumsum(X[1:])
    else:
        X = np.cumsum(X)
    return X


def _message(msg):
    """Decode one message (bytes from "GRIB" to "7777") into the dict that messages() yields."""
    if msg[:4] != b"GRIB" or msg[7] != 2:
        raise ValueError("not a GRIB2 message")
    m = dict(discipline=msg[6])
    pos, sec = 16, {}
    while msg[pos:pos + 4] != b"7777":
        length = struct.unpack(">I", msg[pos:pos + 4])[0]
        sec[msg[pos + 4]] = msg[pos:pos + length]
        pos += length
    s = sec[1]
    m["ref"] = dt.datetime(_u(s, 12, 2), s[14], s[15], s[16], s[17], s[18])
    g = sec[3]
    if _u(g, 12, 2) != 0:
        raise ValueError(f"grid template 3.{_u(g, 12, 2)} not supported")
    ni, nj = _u(g, 30, 4), _u(g, 34, 4)
    la1, lo1 = signed(_u(g, 46, 4), 4) / 1e6, _u(g, 50, 4) / 1e6
    la2, lo2 = signed(_u(g, 55, 4), 4) / 1e6, _u(g, 59, 4) / 1e6
    scan = g[71]
    if scan & 0x80 or scan & 0x20:                                # columns west to east, rows either way, row by row
        raise ValueError(f"scanning mode {scan} not supported")
    span = (lo2 - lo1) % 360 if ni > 1 else 0
    m.update(ni=ni, nj=nj, lats=np.linspace(la1, la2, nj), lons=(lo1 + np.linspace(0, span, ni)) % 360)
    s = sec[4]
    if _u(s, 7, 2) != 0:
        raise ValueError(f"product template 4.{_u(s, 7, 2)} not supported")
    m["category"], m["number"] = s[9], s[10]
    unit, ft = s[17], signed(_u(s, 18, 4), 4)
    step = {0: dt.timedelta(minutes=1), 1: dt.timedelta(hours=1), 2: dt.timedelta(days=1)}.get(unit)
    if step is None:
        raise ValueError(f"time unit {unit} not supported")
    m["lead_h"] = ft * step.total_seconds() / 3600
    m["valid"] = m["ref"] + dt.timedelta(hours=m["lead_h"])
    m["surface"] = (s[22], signed(_u(s, 24, 4), 4) / 10 ** signed(s[23], 1) if s[23] != 255 else _u(s, 24, 4))
    p, d = sec[5], sec[7][5:]
    n_packed, template = _u(p, 5, 4), _u(p, 9, 2)
    R = struct.unpack(">f", p[11:15])[0]
    E, D, nbits = signed(_u(p, 15, 2), 2), signed(_u(p, 17, 2), 2), p[19]
    if template == 0:
        X = unpack_simple(d, n_packed, nbits)
    elif template == 3:
        X = unpack_complex(p, d, nbits)
    elif template == 40:
        X = unpack_jpeg2000(d, n_packed, nbits)
    else:
        raise ValueError(f"packing template 5.{template} not supported")
    vals = (R + X * 2.0 ** E) / 10.0 ** D
    full = np.full(ni * nj, np.nan)
    ind = sec[6][5] if 6 in sec else 255
    if ind == 0:                                                  # a bitmap: one bit per grid point, 1 = has data
        has = np.unpackbits(np.frombuffer(bytes(sec[6][6:]), dtype=np.uint8))[: ni * nj].astype(bool)
        full[has] = vals
    elif ind == 255:                                              # no bitmap: every point has data
        full[:] = vals
    else:
        raise ValueError(f"bitmap indicator {ind} not supported")
    m["values"] = full.reshape(nj, ni)
    return m


def messages(buf):
    """Yield one dict per GRIB2 message in buf (see the module notes)."""
    p = 0
    while True:
        p = buf.find(b"GRIB", p)
        if p < 0:
            return
        if buf[p + 7] != 2:
            raise ValueError("not GRIB edition 2")
        end = p + struct.unpack(">Q", buf[p + 8:p + 16])[0]
        yield _message(buf[p:end])
        p = end


def decode_grib2(msg):
    """One message's values as float32, rows from the south (the files store them north first; we flip)."""
    m = _message(msg)
    grid = m["values"].astype(np.float32)
    return grid[::-1] if m["lats"][0] > m["lats"][-1] else grid
