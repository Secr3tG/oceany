"""Weakly compressible SPH (WCSPH) solver for a 2D vertical slice (x horizontal, z up).

Method summary
--------------
* Kernel: Wendland C2, 2D normalisation 7/(4 pi h^2), support radius 2h.
* EOS: Tait, p = B((rho/rho0)^gamma - 1), B = rho0 c0^2 / gamma, gamma = 7.
* Density: continuity equation  d rho_i/dt = rho_i sum_j V_j (v_i - v_j).grad_i W_ij
  plus delta-SPH diffusion (Molteni & Colagrossi 2009) with the hydrostatic part of the
  density difference removed (Fourtakas et al. 2019 / DualSPHysics "DDT2" idea), so the
  diffusion term does not fight the hydrostatic density gradient.
* Momentum: a_i = -sum_j m_j (p_i + p_j)/(rho_i rho_j) grad_i W_ij + Pi_ij + g, with the
  Monaghan artificial viscosity Pi_ij (fluid-fluid pairs only).
* Walls: fixed dummy particles (several layers) with the Adami, Hu & Adams (2012) wall
  treatment: wall pressure is extrapolated from neighbouring fluid particles including the
  hydrostatic term, wall density follows from the inverse EOS. Free-slip (no viscous
  coupling to the wall).
* Time integration: kick-drift-kick leapfrog with predicted velocity/density for the force
  evaluation (one force evaluation per step), adaptive dt from CFL (sound speed + flow
  speed) and force (sqrt(h/|a|)) conditions.
* Neighbour search: cell-linked list (cell size 2h), rebuilt each step; force loops are
  gather-type and run with numba prange.
"""
import math
import numpy as np
from numba import njit, prange

G = 9.81


# ----------------------------------------------------------------------------- neighbour grid
@njit(cache=True)
def build_cells(x, z, xmin, zmin, cs, ncx, ncz):
    n = x.shape[0]
    ncell = ncx * ncz
    cid = np.empty(n, np.int64)
    count = np.zeros(ncell + 1, np.int64)
    for i in range(n):
        ci = int((x[i] - xmin) / cs)
        cj = int((z[i] - zmin) / cs)
        if ci < 0:
            ci = 0
        elif ci >= ncx:
            ci = ncx - 1
        if cj < 0:
            cj = 0
        elif cj >= ncz:
            cj = ncz - 1
        c = cj * ncx + ci
        cid[i] = c
        count[c + 1] += 1
    for c in range(ncell):
        count[c + 1] += count[c]
    start = count.copy()
    fill = count[:-1].copy()
    order = np.empty(n, np.int64)
    for i in range(n):
        c = cid[i]
        order[fill[c]] = i
        fill[c] += 1
    return start, order


@njit(inline="always")
def cell_of(xi, zi, xmin, zmin, cs, ncx, ncz):
    ci = int((xi - xmin) / cs)
    cj = int((zi - zmin) / cs)
    if ci < 0:
        ci = 0
    elif ci >= ncx:
        ci = ncx - 1
    if cj < 0:
        cj = 0
    elif cj >= ncz:
        cj = ncz - 1
    return ci, cj


# ----------------------------------------------------------------------------- wall pressure
@njit(parallel=True, cache=True)
def wall_pressure(x, z, rho, p, awx, nf, h, rho0, B, gam, start, order,
                  xmin, zmin, cs, ncx, ncz):
    """Adami et al. (2012) pressure extrapolation onto wall particles.

    awx is the horizontal acceleration of each wall particle (non-zero only for a moving
    piston); the extrapolation uses (g - a_w) . (x_w - x_f)."""
    n = x.shape[0]
    ad = 7.0 / (4.0 * math.pi * h * h)
    h2 = 4.0 * h * h
    for w in prange(nf, n):
        xw = x[w]
        zw = z[w]
        aw = awx[w]
        ci, cj = cell_of(xw, zw, xmin, zmin, cs, ncx, ncz)
        sw = 0.0
        sp = 0.0
        for dj in range(-1, 2):
            cy = cj + dj
            if cy < 0 or cy >= ncz:
                continue
            for di in range(-1, 2):
                cx = ci + di
                if cx < 0 or cx >= ncx:
                    continue
                c = cy * ncx + cx
                for k in range(start[c], start[c + 1]):
                    j = order[k]
                    if j >= nf:
                        continue
                    dx = xw - x[j]
                    dz = zw - z[j]
                    r2 = dx * dx + dz * dz
                    if r2 >= h2:
                        continue
                    q = math.sqrt(r2) / h
                    t = 1.0 - 0.5 * q
                    W = ad * t * t * t * t * (2.0 * q + 1.0)
                    sw += W
                    # p_f + rho_f * g * (z_f - z_w)
                    sp += (p[j] + rho[j] * (G * (z[j] - zw) - aw * (xw - x[j]))) * W
        if sw > 1e-12:
            pw = sp / sw
            if pw < 0.0:
                pw = 0.0
        else:
            pw = 0.0
        p[w] = pw
        rho[w] = rho0 * (1.0 + pw / B) ** (1.0 / gam)


# ----------------------------------------------------------------------------- fluid forces
@njit(parallel=True, cache=True)
def fluid_rates(x, z, u, w, rho, p, nf, mass, h, rho0, c0, B, gam, alpha, delta,
                start, order, xmin, zmin, cs, ncx, ncz, ax, az, drho):
    ad = 7.0 / (4.0 * math.pi * h * h)
    fac = -5.0 * ad / (h * h)          # grad_i W = r_ij * fac * (1-q/2)^3
    h2 = 4.0 * h * h
    eta2 = 0.01 * h * h
    dcoef = 2.0 * delta * h * c0
    rhs = rho0 * G / B
    ig = 1.0 / gam
    for i in prange(nf):
        xi = x[i]
        zi = z[i]
        ui = u[i]
        wi = w[i]
        ri = rho[i]
        pi_ = p[i]
        ci, cj = cell_of(xi, zi, xmin, zmin, cs, ncx, ncz)
        sax = 0.0
        saz = 0.0
        sdr = 0.0
        sdd = 0.0
        for dj in range(-1, 2):
            cy = cj + dj
            if cy < 0 or cy >= ncz:
                continue
            for di in range(-1, 2):
                cx = ci + di
                if cx < 0 or cx >= ncx:
                    continue
                c = cy * ncx + cx
                for k in range(start[c], start[c + 1]):
                    j = order[k]
                    if j == i:
                        continue
                    dx = xi - x[j]
                    dz = zi - z[j]
                    r2 = dx * dx + dz * dz
                    if r2 >= h2 or r2 < 1e-18:
                        continue
                    q = math.sqrt(r2) / h
                    t = 1.0 - 0.5 * q
                    F = fac * t * t * t
                    gx = dx * F
                    gz = dz * F
                    rj = rho[j]
                    mj = mass[j]
                    Vj = mj / rj
                    du = ui - u[j]
                    dw = wi - w[j]
                    sdr += Vj * (du * gx + dw * gz)
                    pij = mj * (pi_ + p[j]) / (ri * rj)
                    sax -= pij * gx
                    saz -= pij * gz
                    if j < nf:
                        vr = du * dx + dw * dz
                        if vr < 0.0:
                            mu = h * vr / (r2 + eta2)
                            Pi = -alpha * c0 * mu / (0.5 * (ri + rj))
                            sax -= mj * Pi * gx
                            saz -= mj * Pi * gz
                        # delta-SPH with hydrostatic component removed
                        dH = rho0 * ((1.0 + rhs * (z[j] - zi)) ** ig - 1.0)
                        sdd += Vj * ((ri - rho[j]) - dH) * F
        ax[i] = sax
        az[i] = saz - G
        drho[i] = ri * sdr + dcoef * sdd


@njit(parallel=True, cache=True)
def fluid_rates_brk(x, z, u, w, rho, p, nf, mass, h, rho0, c0, B, gam, alpha, delta,
                    start, order, xmin, zmin, cs, ncx, ncz, ax, az, drho, nu, ksum):
    """fluid_rates plus (1) a laminar-form eddy-viscosity term (Morris 1997 / Lo & Shao 2002
    operator) with a per-particle eddy viscosity nu_i, pair value nu_ij = (nu_i + nu_j)/2, fluid
    pairs only, and (2) the kernel sum ksum_i = sum_j V_j W_ij (fluid + wall, self included), used
    to detect free-surface particles. Identical to fluid_rates when nu = 0 (ksum is extra output)."""
    ad = 7.0 / (4.0 * math.pi * h * h)
    fac = -5.0 * ad / (h * h)
    h2 = 4.0 * h * h
    eta2 = 0.01 * h * h
    dcoef = 2.0 * delta * h * c0
    rhs = rho0 * G / B
    ig = 1.0 / gam
    for i in prange(nf):
        xi = x[i]
        zi = z[i]
        ui = u[i]
        wi = w[i]
        ri = rho[i]
        pi_ = p[i]
        nui = nu[i]
        ci, cj = cell_of(xi, zi, xmin, zmin, cs, ncx, ncz)
        sax = 0.0
        saz = 0.0
        sdr = 0.0
        sdd = 0.0
        sk = mass[i] / ri * ad
        for dj in range(-1, 2):
            cy = cj + dj
            if cy < 0 or cy >= ncz:
                continue
            for di in range(-1, 2):
                cx = ci + di
                if cx < 0 or cx >= ncx:
                    continue
                c = cy * ncx + cx
                for k in range(start[c], start[c + 1]):
                    j = order[k]
                    if j == i:
                        continue
                    dx = xi - x[j]
                    dz = zi - z[j]
                    r2 = dx * dx + dz * dz
                    if r2 >= h2 or r2 < 1e-18:
                        continue
                    q = math.sqrt(r2) / h
                    t = 1.0 - 0.5 * q
                    F = fac * t * t * t
                    gx = dx * F
                    gz = dz * F
                    rj = rho[j]
                    mj = mass[j]
                    Vj = mj / rj
                    sk += Vj * ad * t * t * t * t * (2.0 * q + 1.0)
                    du = ui - u[j]
                    dw = wi - w[j]
                    sdr += Vj * (du * gx + dw * gz)
                    pij = mj * (pi_ + p[j]) / (ri * rj)
                    sax -= pij * gx
                    saz -= pij * gz
                    if j < nf:
                        vr = du * dx + dw * dz
                        if vr < 0.0:
                            mu = h * vr / (r2 + eta2)
                            Pi = -alpha * c0 * mu / (0.5 * (ri + rj))
                            sax -= mj * Pi * gx
                            saz -= mj * Pi * gz
                        nuij = 0.5 * (nui + nu[j])
                        if nuij > 0.0:
                            vc = mj * 4.0 * nuij / (ri + rj) * r2 * F / (r2 + eta2)
                            sax += vc * du
                            saz += vc * dw
                        dH = rho0 * ((1.0 + rhs * (z[j] - zi)) ** ig - 1.0)
                        sdd += Vj * ((ri - rho[j]) - dH) * F
        ax[i] = sax
        az[i] = saz - G
        drho[i] = ri * sdr + dcoef * sdd
        ksum[i] = sk


@njit(cache=True)
def column_top(x, z, nf, tx0, tdx, top):
    """Highest particle z in each column [tx0 + k tdx, tx0 + (k+1) tdx) (clamped to the array)."""
    nt = top.shape[0]
    for k in range(nt):
        top[k] = -1e9
    for i in range(nf):
        k = int(math.floor((x[i] - tx0) / tdx))
        if k < 0:
            k = 0
        elif k >= nt:
            k = nt - 1
        if z[i] > top[k]:
            top[k] = z[i]


@njit(parallel=True, cache=True)
def update_breaking(x, z, u, w, ksum, nf, b, D, nu, dt, beta, t_mem, M, ks_surf, nu_max,
                    bx0, bdx, bz, dmin, top, tx0, tdx, use_top):
    """Breaking indicator and eddy viscosity (see WCSPH.set_breaking).

    A free-surface particle (kernel sum < ks_surf) whose speed exceeds beta * sqrt(g d), with d its
    height above the bed (for a surface particle, the local water depth), is marked breaking: b = 1 and
    the depth scale D = d is stored. Otherwise b decays as exp(-dt / t_mem) (Lagrangian turbulence
    memory). d is floored at dmin (the smoothing length) so slow noise at the waterline does not
    trigger. Eddy viscosity nu = M * b * D * sqrt(g D), capped at nu_max."""
    nb = bz.shape[0]
    fdec = math.exp(-dt / t_mem)
    for i in prange(nf):
        fi = (x[i] - bx0) / bdx
        k0 = int(math.floor(fi))
        if k0 < 0:
            zb = bz[0]
        elif k0 >= nb - 1:
            zb = bz[nb - 1]
        else:
            a = fi - k0
            zb = bz[k0] * (1.0 - a) + bz[k0 + 1] * a
        if use_top:
            # roller mode: every particle, d = local water depth (column top - bed)
            kt = int(math.floor((x[i] - tx0) / tdx))
            if kt < 0:
                kt = 0
            elif kt >= top.shape[0]:
                kt = top.shape[0] - 1
            d = top[kt] - zb
            surf = True
        else:
            d = z[i] - zb
            surf = ksum[i] < ks_surf
        if d < dmin:
            d = dmin
        sp2 = u[i] * u[i] + w[i] * w[i]
        if surf and sp2 > beta * beta * G * d:
            b[i] = 1.0
            D[i] = d
        else:
            b[i] *= fdec
        v = M * b[i] * D[i] * math.sqrt(G * D[i])
        if v > nu_max:
            v = nu_max
        nu[i] = v


@njit(parallel=True, cache=True)
def eos(rho, p, nf, rho0, B, gam):
    for i in prange(nf):
        p[i] = B * ((rho[i] / rho0) ** gam - 1.0)


# ----------------------------------------------------------------------------- driver
class WCSPH:
    def __init__(self, xf, zf, uf, wf, rhof, xb, zb, dp, h, c0, rho0=1000.0, gam=7.0,
                 alpha=0.01, delta=0.1, cfl=0.2, domain=None, mass_f=None):
        self.nf = xf.size
        self.x = np.concatenate([xf, xb]).astype(np.float64)
        self.z = np.concatenate([zf, zb]).astype(np.float64)
        n = self.x.size
        self.u = np.zeros(n)
        self.w = np.zeros(n)
        self.u[:self.nf] = uf
        self.w[:self.nf] = wf
        self.rho = np.full(n, rho0)
        self.rho[:self.nf] = rhof
        self.p = np.zeros(n)
        self.dp, self.h, self.c0, self.rho0, self.gam = dp, h, c0, rho0, gam
        self.B = rho0 * c0 * c0 / gam
        self.m = rho0 * dp * dp
        self.mass = np.full(n, self.m)
        if mass_f is not None:
            self.mass[:self.nf] = mass_f
        self.damp_tau = None      # if set, velocities relax with this time scale (settling)
        self.awx = np.zeros(n)
        self.piston_idx = None    # indices of moving wall particles (piston wavemaker)
        self.piston_x0 = None
        self.piston_motion = None  # function t -> (X, U, A)
        self.piston_t0 = 0.0
        self.alpha, self.delta, self.cfl = alpha, delta, cfl
        xmin, xmax, zmin, zmax = domain
        self.cs = 2.0 * h
        self.xmin, self.zmin = xmin, zmin
        self.ncx = int(math.ceil((xmax - xmin) / self.cs)) + 1
        self.ncz = int(math.ceil((zmax - zmin) / self.cs)) + 1
        self.ax = np.zeros(self.nf)
        self.az = np.zeros(self.nf)
        self.drho = np.zeros(self.nf)
        self.t = 0.0
        self.nstep = 0
        self.brk = None           # breaking eddy-viscosity model, off by default (set_breaking)
        self._rates(self.u, self.w, self.rho)

    def set_breaking(self, bed_x, bed_z, M=0.03, beta=0.85, t_mem=1.5, ks_surf=0.75,
                     nu_max=1.0, roller=False):
        """Opt-in breaking dissipation: stands in for the turbulence and air a 2D single-phase
        model cannot resolve. Off unless called, so runs without it are unchanged.

        Breaking detection: kinematic criterion, surface particle speed > beta * local
        long-wave celerity sqrt(g d) (beta = 0.85: Barthelemy et al. 2018, Saket et al. 2017;
        the same u/c ratio is the usual onset threshold). Eddy viscosity in breaking water:
        nu_t = M d sqrt(g d), the surf-zone scaling of Battjes (1975) / Svendsen (1987) with M a
        dimensionless coefficient (published 0.01-0.1). Each breaking particle keeps the
        turbulence for a memory time t_mem (exp decay), so the bore stays turbulent behind the
        front. bed_x must be uniform; bed_z is the bed elevation there.

        roller=True: the u/c test is applied to every particle (not only the free surface) with d the
        local water depth (highest particle in a 2h-wide column minus the bed), so the whole fast
        roller / bore front is flagged, not just a one-particle skin."""
        bx = np.asarray(bed_x, np.float64)
        self.brk = dict(M=float(M), beta=float(beta), t_mem=float(t_mem), ks_surf=float(ks_surf),
                        nu_max=float(nu_max), bx0=float(bx[0]), bdx=float(bx[1] - bx[0]),
                        bz=np.ascontiguousarray(bed_z, dtype=np.float64), roller=bool(roller))
        self.b_brk = np.zeros(self.nf)
        self.D_brk = np.zeros(self.nf)
        self.nu = np.zeros(self.nf)
        self.ksum = np.ones(self.nf)
        self._rates(self.u, self.w, self.rho)

    def _rates(self, u, w, rho):
        nf = self.nf
        eos(rho, self.p, nf, self.rho0, self.B, self.gam)
        start, order = build_cells(self.x, self.z, self.xmin, self.zmin, self.cs,
                                   self.ncx, self.ncz)
        wall_pressure(self.x, self.z, rho, self.p, self.awx, nf, self.h, self.rho0, self.B,
                      self.gam, start, order, self.xmin, self.zmin, self.cs,
                      self.ncx, self.ncz)
        if self.brk is None:
            fluid_rates(self.x, self.z, u, w, rho, self.p, nf, self.mass, self.h, self.rho0,
                        self.c0, self.B, self.gam, self.alpha, self.delta, start, order,
                        self.xmin, self.zmin, self.cs, self.ncx, self.ncz,
                        self.ax, self.az, self.drho)
        else:
            fluid_rates_brk(self.x, self.z, u, w, rho, self.p, nf, self.mass, self.h,
                            self.rho0, self.c0, self.B, self.gam, self.alpha, self.delta,
                            start, order, self.xmin, self.zmin, self.cs, self.ncx, self.ncz,
                            self.ax, self.az, self.drho, self.nu, self.ksum)

    def set_piston(self, t):
        if self.piston_motion is None:
            return
        X, U, A = self.piston_motion(t - self.piston_t0)
        i = self.piston_idx
        self.x[i] = self.piston_x0 + X
        self.u[i] = U
        self.awx[i] = A
        self.piston_X = X

    def timestep(self):
        nf = self.nf
        vmax = math.sqrt(np.max(self.u[:nf] ** 2 + self.w[:nf] ** 2))
        amax = math.sqrt(np.max(self.ax ** 2 + self.az ** 2))
        dt_c = self.h / (self.c0 + vmax)
        dt_f = math.sqrt(self.h / max(amax, 1e-12))
        dt = self.cfl * min(dt_c, dt_f)
        if self.brk is not None:
            numax = float(np.max(self.nu)) if self.nf else 0.0
            if numax > 0.0:
                dt = min(dt, 0.125 * self.h * self.h / numax)
        return dt

    def step(self, dt_max=None):
        nf = self.nf
        dt = self.timestep()
        if dt_max is not None:
            dt = min(dt, dt_max)
        u, w, rho = self.u, self.w, self.rho
        # half kick
        uh = u[:nf] + 0.5 * dt * self.ax
        wh = w[:nf] + 0.5 * dt * self.az
        rh = rho[:nf] + 0.5 * dt * self.drho
        # drift
        self.x[:nf] += dt * uh
        self.z[:nf] += dt * wh
        self.set_piston(self.t + dt)
        # predicted end-of-step state for force evaluation
        u[:nf] = uh + 0.5 * dt * self.ax
        w[:nf] = wh + 0.5 * dt * self.az
        rho[:nf] = rh + 0.5 * dt * self.drho
        self._rates(u, w, rho)
        # second half kick with new rates
        u[:nf] = uh + 0.5 * dt * self.ax
        w[:nf] = wh + 0.5 * dt * self.az
        rho[:nf] = rh + 0.5 * dt * self.drho
        if self.damp_tau is not None:
            f = math.exp(-dt / self.damp_tau)
            u[:nf] *= f
            w[:nf] *= f
        eos(rho, self.p, nf, self.rho0, self.B, self.gam)
        if self.brk is not None and self.damp_tau is None:
            k = self.brk
            if k["roller"]:
                tdx = 2.0 * self.h
                tx0 = k["bx0"]
                if k.get("top") is None:
                    k["top"] = np.empty(int((k["bx0"] + k["bdx"] * (k["bz"].shape[0] - 1) - tx0) / tdx) + 2)
                top = k["top"]
                column_top(self.x, self.z, nf, tx0, tdx, top)
                use_top = True
            else:
                top, tx0, tdx, use_top = np.zeros(1), 0.0, 1.0, False
            update_breaking(self.x, self.z, u, w, self.ksum, nf, self.b_brk, self.D_brk,
                            self.nu, dt, k["beta"], k["t_mem"], k["M"], k["ks_surf"],
                            k["nu_max"], k["bx0"], k["bdx"], k["bz"], self.h,
                            top, tx0, tdx, use_top)
        self.t += dt
        self.nstep += 1
        return dt
