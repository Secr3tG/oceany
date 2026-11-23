"""A small GRIB2 reader for what NOMADS serves for NCEP GFS-Wave: lat/lon grids (template 3.0), product template 4.0,
simple packing (template 5.0), with or without a bitmap. Anything else raises, so a format change shows up as a feed
"unavailable" instead of wrong numbers. No eccodes needed.

Checked 2026-11-23 on gfswave.t18z.global.0p25 (filter_gfswave.pl subregions): every message is 3.0 / 4.0 / 5.0.
Values: Y = (R + X * 2**E) / 10**D (WMO GRIB2 manual, section 5 template 5.0).
"""
import datetime as dt
import struct

import numpy as np


def _sm(v, nbytes):
    """GRIB sign-magnitude integer (top bit = sign)."""
    top = 1 << (8 * nbytes - 1)
    return -(v & ~top) if v & top else v


def _u(b, o, n):
    return int.from_bytes(b[o:o + n], "big")


def messages(buf):
    """Yield one dict per GRIB2 message: discipline, category, number, surface (type, value), ref (datetime),
    valid (datetime), lats (1-D, north->south or as stored), lons (1-D, 0..360), values (2-D float array, NaN = no data)."""
    p = 0
    while True:
        p = buf.find(b"GRIB", p)
        if p < 0:
            return
        if buf[p + 7] != 2:
            raise ValueError("not GRIB edition 2")
        disc = buf[p + 6]
        total = struct.unpack(">Q", buf[p + 8:p + 16])[0]
        end = p + total
        q = p + 16
        m = dict(discipline=disc)
        bitmap = None
        while q < end - 4:
            ln = _u(buf, q, 4)
            sn = buf[q + 4]
            s = buf[q:q + ln]
            if sn == 1:
                m["ref"] = dt.datetime(_u(s, 12, 2), s[14], s[15], s[16], s[17], s[18])
            elif sn == 3:
                if _u(s, 12, 2) != 0:
                    raise ValueError(f"grid template 3.{_u(s, 12, 2)} not supported")
                ni, nj = _u(s, 30, 4), _u(s, 34, 4)
                la1, lo1 = _sm(_u(s, 46, 4), 4) / 1e6, _u(s, 50, 4) / 1e6
                la2, lo2 = _sm(_u(s, 55, 4), 4) / 1e6, _u(s, 59, 4) / 1e6
                scan = s[71]
                if scan & 0x80 or scan & 0x20:
                    raise ValueError(f"scanning mode {scan} not supported")
                lats = np.linspace(la1, la2, nj)
                span = (lo2 - lo1) % 360 if ni > 1 else 0
                lons = (lo1 + np.linspace(0, span, ni)) % 360
                m.update(ni=ni, nj=nj, lats=lats, lons=lons)
            elif sn == 4:
                if _u(s, 7, 2) != 0:
                    raise ValueError(f"product template 4.{_u(s, 7, 2)} not supported")
                m["category"], m["number"] = s[9], s[10]
                unit, ft = s[17], _sm(_u(s, 18, 4), 4)
                step = {0: dt.timedelta(minutes=1), 1: dt.timedelta(hours=1), 2: dt.timedelta(days=1)}.get(unit)
                if step is None:
                    raise ValueError(f"time unit {unit} not supported")
                m["lead_h"] = ft * step.total_seconds() / 3600
                m["surface"] = (s[22], _sm(_u(s, 24, 4), 4) / 10 ** _sm(s[23], 1) if s[23] != 255 else _u(s, 24, 4))
            elif sn == 5:
                if _u(s, 9, 2) != 0:
                    raise ValueError(f"packing template 5.{_u(s, 9, 2)} not supported (only simple packing)")
                n_packed = _u(s, 5, 4)
                R = struct.unpack(">f", s[11:15])[0]
                E, D, nb = _sm(_u(s, 15, 2), 2), _sm(_u(s, 17, 2), 2), s[19]
                m.update(n_packed=n_packed, R=R, E=E, D=D, nbits=nb)
            elif sn == 6:
                ind = s[5]
                if ind == 0:
                    bitmap = np.unpackbits(np.frombuffer(s[6:], dtype=np.uint8))[: m["ni"] * m["nj"]].astype(bool)
                elif ind != 255:
                    raise ValueError(f"bitmap indicator {ind} not supported")
            elif sn == 7:
                n, nb = m["n_packed"], m["nbits"]
                if nb == 0:
                    x = np.zeros(n)
                else:
                    bits = np.unpackbits(np.frombuffer(s[5:], dtype=np.uint8))[: n * nb].reshape(n, nb)
                    x = bits.dot(1 << np.arange(nb - 1, -1, -1, dtype=np.int64)).astype(float)
                vals = (m["R"] + x * 2.0 ** m["E"]) / 10.0 ** m["D"]
                full = np.full(m["ni"] * m["nj"], np.nan)
                if bitmap is not None:
                    full[bitmap] = vals
                else:
                    full[:] = vals
                m["values"] = full.reshape(m["nj"], m["ni"])
            q += ln
        m["valid"] = m["ref"] + dt.timedelta(hours=m["lead_h"])
        yield m
        p = end
