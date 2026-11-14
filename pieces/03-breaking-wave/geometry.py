"""Wall-particle generation for a bed given as a polyline (x increasing)."""
import numpy as np
from scipy.spatial import cKDTree


def polyline_wall(px, pz, dp, n_layers):
    """Layers of wall particles below a polyline bed.

    Each segment is split into round(L/dp) equal pieces so that particles meet the segment
    ends without gaps; layer k sits (k + 0.5) dp below the bed along the segment normal.
    Near-duplicates (closer than 0.6 dp, at concave corners) are removed and gaps at convex
    corners are filled with extra points on the corner's angle bisector arc.
    """
    bx, bz = [], []
    px = np.asarray(px, float)
    pz = np.asarray(pz, float)
    for a in range(px.size - 1):
        dx, dz = px[a + 1] - px[a], pz[a + 1] - pz[a]
        L = np.hypot(dx, dz)
        n = max(1, int(round(L / dp)))
        tx, tz = dx / L, dz / L
        nx, nz = tz, -tx                       # normal pointing into the solid (below)
        sarc = (np.arange(n) + 0.5) * L / n
        for k in range(n_layers):
            off = (k + 0.5) * dp
            bx.append(px[a] + sarc * tx + off * nx)
            bz.append(pz[a] + sarc * tz + off * nz)
    # fill convex corners (bed bending downward in the direction of travel)
    for a in range(1, px.size - 1):
        t1 = np.array([px[a] - px[a - 1], pz[a] - pz[a - 1]])
        t2 = np.array([px[a + 1] - px[a], pz[a + 1] - pz[a]])
        t1 /= np.linalg.norm(t1)
        t2 /= np.linalg.norm(t2)
        n1 = np.array([t1[1], -t1[0]])
        n2 = np.array([t2[1], -t2[0]])
        a1, a2 = np.arctan2(n1[1], n1[0]), np.arctan2(n2[1], n2[0])
        da = (a2 - a1 + np.pi) % (2 * np.pi) - np.pi
        for k in range(n_layers):
            r = (k + 0.5) * dp
            m = int(abs(da) * r / dp)
            for j in range(1, m + 1):
                ang = a1 + da * j / (m + 1)
                bx.append(np.array([px[a] + r * np.cos(ang)]))
                bz.append(np.array([pz[a] + r * np.sin(ang)]))
    bx = np.concatenate(bx)
    bz = np.concatenate(bz)
    return dedupe(bx, bz, dp)


def dedupe(bx, bz, dp, frac=0.6):
    keep = np.ones(bx.size, bool)
    tree = cKDTree(np.c_[bx, bz])
    for i, j in sorted(tree.query_pairs(frac * dp)):
        if keep[i] and keep[j]:
            keep[j] = False
    return bx[keep], bz[keep]
