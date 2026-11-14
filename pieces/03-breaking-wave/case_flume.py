"""case_flume: solitary wave shoaling and breaking on a 1:15 plane beach (solver validation).

Classic set-up after Grilli, Svendsen & Subramanya (1997): still depth h0 = 0.30 m on a flat
section, then a plane slope 1:15. Solitary wave H/h0 = 0.45, Grilli slope parameter
S0 = 1.521 s / sqrt(H/h0) = 0.151 -> plunging breaker expected (0.025 < S0 < 0.30).
"""
import math
import numpy as np

G = 9.81

CFG = dict(
    name="flume",
    h0=0.30,            # still water depth on the flat (m)
    H_over_h0=0.45,
    slope=1.0 / 15.0,
    x_toe=5.0,          # toe of the slope (m from the left wall); the solitary wave with
                        # H/h0 = 0.45 is long (eta < 1 % of H only beyond 1.9 m from the crest),
                        # so the flat must be ~5 m for the whole profile to fit
    x0=2.4,             # initial crest position (m)
    z_top_slope=0.50,   # slope ends this high above the still water line (m); end wall above it
    rho0=1000.0,
    c0_factor=12.0,     # c0 = c0_factor * sqrt(g (h0 + H))
    h_over_dp=1.3,
    alpha=0.01,
    delta=0.1,
    cfl=0.2,
    n_layers=3,
    t_end=5.5,
    t_settle=2.0,       # still-water settling before the wave is put in (s)
    settle_tau=0.1,     # velocity relaxation time during settling (s)
    dt_out=0.01,
)


def bed_z(x, c=CFG):
    """Bed elevation (z = 0 at the still water line)."""
    x = np.asarray(x, float)
    return np.where(x < c["x_toe"], -c["h0"], -c["h0"] + c["slope"] * (x - c["x_toe"]))


def solitary(x, c=CFG):
    """Rayleigh/Boussinesq solitary wave: eta, depth-mean u, d eta/dx and du/dx."""
    h0 = c["h0"]
    H = c["H_over_h0"] * h0
    cel = math.sqrt(G * (h0 + H))
    k = math.sqrt(3.0 * H / (4.0 * h0 * h0 * (h0 + H)))
    th = np.tanh(k * (x - c["x0"]))
    sech2 = 1.0 - th * th
    eta = H * sech2
    deta = -2.0 * H * k * sech2 * th
    u = cel * eta / (h0 + eta)
    dudx = cel * h0 / (h0 + eta) ** 2 * deta
    return eta, u, deta, dudx, cel, k


def build(dp, c=CFG, still=False):
    """Particles for the case. still=True gives still water only (for settling)."""
    h0 = c["h0"]
    H = c["H_over_h0"] * h0
    nl = c["n_layers"]
    x_end = c["x_toe"] + (h0 + c["z_top_slope"]) / c["slope"]
    # ---- fluid on a square lattice
    xs = (np.arange(int(x_end / dp)) + 0.5) * dp
    zs = -h0 + (np.arange(int((h0 + 1.2 * H) / dp) + 1) + 0.5) * dp
    X, Z = np.meshgrid(xs, zs, indexing="ij")
    X = X.ravel()
    Z = Z.ravel()
    eta, u, deta, dudx, cel, k = solitary(X, c)
    zb = bed_z(X, c)
    cos_t = np.where(X < c["x_toe"], 1.0, 1.0 / math.sqrt(1.0 + c["slope"] ** 2))
    if still:
        eta = np.zeros_like(eta)
        u = np.zeros_like(u)
        dudx = np.zeros_like(dudx)
    keep = (Z < eta) & ((Z - zb) * cos_t >= 0.5 * dp * 0.999)
    xf, zf = X[keep], Z[keep]
    eta, u, deta, dudx = eta[keep], u[keep], deta[keep], dudx[keep]
    uf = u
    wf = -(zf + h0) * dudx              # continuity with depth-uniform u
    # ---- boundary particles
    bx, bz = [], []
    # bed polyline: corner under the left wall, flat bed, toe, slope to its top
    from geometry import polyline_wall, dedupe
    pxs = [-nl * dp, c["x_toe"], x_end]
    pzs = [-h0, -h0, c["z_top_slope"]]
    bx_, bz_ = polyline_wall(pxs, pzs, dp, nl)
    bx.append(bx_)
    bz.append(bz_)
    # left wall
    zw = -h0 + (np.arange(int((h0 + 0.5) / dp)) + 0.5) * dp
    for kk in range(nl):
        bx.append(np.full_like(zw, -(kk + 0.5) * dp))
        bz.append(zw)
    # end wall above the top of the slope (stops swash from running off the domain)
    zt = c["z_top_slope"] + (np.arange(int(0.3 / dp)) + 0.5) * dp
    for kk in range(nl):
        bx.append(np.full_like(zt, x_end + (kk + 0.5) * dp))
        bz.append(zt)
    bx = np.concatenate(bx)
    bz = np.concatenate(bz)
    bx, bz = dedupe(bx, bz, dp)
    # ---- hydrostatic density under the local free surface
    c0 = c["c0_factor"] * math.sqrt(G * (h0 + H))
    B = c["rho0"] * c0 * c0 / 7.0
    p = c["rho0"] * G * (eta - zf)
    rhof = c["rho0"] * (1.0 + p / B) ** (1.0 / 7.0)
    domain = (-nl * dp - 0.05, x_end + nl * dp + 0.1, -h0 - nl * dp - 0.05, 1.2)
    info = dict(H=H, c_solitary=cel, k=k, c0=c0, x_end=x_end, S0=1.521 * c["slope"] / math.sqrt(c["H_over_h0"]))
    return xf, zf, uf, wf, rhof, bx, bz, c0, domain, info


def insert_wave(xf, zf, dp, c=CFG, rho0=1000.0, B=None):
    """Put the solitary wave onto settled still-water particles.

    Each water column is stretched vertically, z' = zb + (z - zb)(d + eta)/d with d the
    local still depth, and each particle's mass is scaled by the same factor so that the
    mass per unit area is exactly rho0 (d + eta). Velocities: u = c eta/(d + eta)
    (depth-uniform), w = -(z' - zb) du/dx (continuity). Density: hydrostatic under the
    local free surface.
    """
    zb = bed_z(xf, c)
    d = np.maximum(-zb, 1e-6)
    eta, _, deta, _, cel, k = solitary(xf, c)
    J = (d + eta) / d
    zn = zb + (zf - zb) * J
    u = cel * eta / (d + eta)
    dudx = cel * d / (d + eta) ** 2 * deta
    w = -(zn - zb) * dudx
    p = rho0 * G * np.maximum(eta - zn, 0.0)
    rho = rho0 * (1.0 + p / B) ** (1.0 / 7.0)
    mass = rho0 * dp * dp * J
    return zn, u, w, rho, mass
