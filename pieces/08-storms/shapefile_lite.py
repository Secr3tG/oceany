"""Read the few shapefile types NHC's GIS zips use, with the standard library only (no GDAL, no pyshp).

A shapefile is three files with one name: .shp (the shapes), .shx (an index, not needed here) and .dbf (one row of
attributes per shape). NHC's forecast and best-track zips hold points (the track fixes), lines (the track) and
polygons (the cone). Coordinates are plain longitude/latitude in degrees (the .prj says WGS 84 / NAD 83).

    read_zip(zip_bytes) -> {"al142024-012_5day_pts": [(shape, attrs), ...], ...}
    shape: ("point", (lon, lat)) | ("line", [[(lon, lat), ...], ...]) | ("polygon", [[(lon, lat), ...], ...])
    attrs: {FIELD: value}; numbers come back as float or int, text as str (stripped).

Plumbing: Benn does not need to read this file. The format is documented by Esri ("ESRI Shapefile Technical
Description", 1998) and dBase III.
"""
import io, struct, zipfile


def _dbf(data):
    n, header_len, rec_len = struct.unpack("<xxxxIHH", data[:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:                       # field descriptors end with a 0x0D byte
        name = data[pos:pos + 11].split(b"\0")[0].decode("ascii", "replace")
        ftype, flen, fdec = chr(data[pos + 11]), data[pos + 16], data[pos + 17]
        fields.append((name, ftype, flen, fdec))
        pos += 32
    rows, pos = [], header_len
    for _ in range(n):
        rec = data[pos:pos + rec_len]; pos += rec_len
        if rec[:1] == b"*":                        # deleted record
            rows.append(None); continue
        off, row = 1, {}
        for name, ftype, flen, fdec in fields:
            raw = rec[off:off + flen].decode("latin-1").strip(); off += flen
            if ftype in "NF":
                try:
                    row[name] = (float(raw) if (fdec or "." in raw) else int(raw)) if raw else None
                except ValueError:
                    row[name] = None
            else:
                row[name] = raw
        rows.append(row)
    return rows


def _parts(rec, n_parts, n_points, at):
    starts = list(struct.unpack(f"<{n_parts}i", rec[at:at + 4 * n_parts]))
    pts_at = at + 4 * n_parts
    xy = struct.unpack(f"<{2 * n_points}d", rec[pts_at:pts_at + 16 * n_points])
    pts = [(xy[2 * i], xy[2 * i + 1]) for i in range(n_points)]
    return [pts[s:e] for s, e in zip(starts, starts[1:] + [n_points])]


def _shp(data):
    shapes, pos = [], 100                          # 100-byte file header
    while pos + 8 <= len(data):
        _num, length = struct.unpack(">ii", data[pos:pos + 8])
        rec = data[pos + 8:pos + 8 + 2 * length]; pos += 8 + 2 * length
        kind = struct.unpack("<i", rec[:4])[0]
        if kind == 0:
            shapes.append(None)
        elif kind in (1, 11, 21):                  # point (Z / M variants: x, y come first)
            shapes.append(("point", struct.unpack("<dd", rec[4:20])))
        elif kind in (3, 5, 13, 15, 23, 25):       # polyline / polygon: box, nParts, nPoints, parts, points
            n_parts, n_points = struct.unpack("<ii", rec[36:44])
            shapes.append(("line" if kind in (3, 13, 23) else "polygon", _parts(rec, n_parts, n_points, 44)))
        else:
            shapes.append(None)
    return shapes


def read_zip(zip_bytes):
    out = {}
    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as z:
        names = {n.lower(): n for n in z.namelist()}
        for low, real in names.items():
            if not low.endswith(".shp"):
                continue
            stem = low[:-4]
            dbf = names.get(stem + ".dbf")
            shapes = _shp(z.read(real))
            rows = _dbf(z.read(dbf)) if dbf else [{}] * len(shapes)
            out[real.rsplit("/", 1)[-1][:-4]] = [(s, r) for s, r in zip(shapes, rows) if s and r is not None]
    return out
