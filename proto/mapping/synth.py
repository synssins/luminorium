"""Synthetic house scene and guided-capture renderer for the mapping prototype.

World frame: metres, x to the right (as seen from the street), y up, z towards the street.
The house front is the plane z = 0, the ground is y = 0, the anchor is the front door.
Cameras follow OpenCV conventions: x right, y down, z forward; X_cam = R (X_world - C).

The capture follows DESIGN.md section 8: three stations (centre, ~45 deg left, ~45 deg right),
each with a still lead-in (reference photo), a sync blink, then the fast pass (invert one light
at a time and leave it inverted, fast lights first), retakes for jolted steps (a single revert),
and a restore of everything at the end.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import cv2
import numpy as np

import motion as motion_mod

W, H = 640, 360
ANCHOR = np.array([0.0, 1.05, 0.0])
HOUSE_HALF = 7.0
WALL_TOP = 6.0
GABLE = 2.5
HOUSE_DEPTH = 8.0
TREE_MIN = np.array([-2.75, 0.0, 6.0])
TREE_MAX = np.array([-1.95, 1.8, 6.8])
STREETLIGHT = np.array([-8.0, 5.0, 2.0])
LONG_WIN = (0.8, 6.6, 3.8, 5.0)
LONG_MULLIONS = (0.8 + 5.8 / 3, 0.8 + 2 * 5.8 / 3)
FRAME_W = 0.06
LUMA = np.array([0.2126, 0.7152, 0.0722])

AMB_FRONT, AMB_SIDE, AMB_GROUND, AMB_TREE = 0.04, 0.025, 0.035, 0.03


# --------------------------------------------------------------------------------------- lights
@dataclass
class Light:
    id: str
    kind: str                 # 'window' or 'lamp'
    driver: str               # 'fast' (WLED/WiZ/Govee/z2m) or 'slow' (Z-Wave)
    color: tuple
    latency: float            # s, command to start of change
    ramp: float               # s, duration of the change
    initial_on: bool
    window: tuple | None = None    # (x0, x1, y0, y1) on the house front
    seg: tuple | None = None       # (centre x, half width) inside a long window
    skew: float = 0.0
    intensity: float = 0.12        # window emission
    pos: tuple | None = None       # lamp head centre
    radius: float = 0.08
    head: float = 1.5
    glow: float = 0.08
    pool: float = 0.0              # ground pool intensity
    pool_sigma: float = 0.35
    wash: float = 0.0              # wall wash intensity
    wash_sigma: float = 0.5
    wash_plane: str = "front"      # 'front' or 'side_r'

    @property
    def latency_half(self) -> float:
        """Command to 50 % of the change: what the analysis measures."""
        return self.latency + self.ramp / 2


def default_lights() -> list[Light]:
    warm = (1.0, 0.78, 0.5)
    seg_hw = 5.8 / 6
    segc = [0.8 + seg_hw * (2 * j + 1) for j in range(3)]
    bed = (-4.6, -3.4, 3.8, 5.0)
    return [
        Light("porch", "lamp", "fast", warm, 0.12, 0.04, True, pos=(0.9, 2.2, 0.15),
              radius=0.09, head=1.5, glow=0.12, wash=0.08, wash_sigma=0.5),
        Light("w_den", "window", "fast", (1.0, 0.78, 0.52), 0.25, 0.08, False,
              window=(-6.4, -5.1, 0.9, 2.2), intensity=0.12),
        Light("w_bed2", "window", "fast", (0.9, 0.85, 1.0), 0.30, 0.10, False,
              window=bed, intensity=0.07, skew=0.3),
        Light("long1", "window", "fast", (1.0, 0.75, 0.45), 0.35, 0.10, False,
              window=LONG_WIN, seg=(segc[0], seg_hw), intensity=0.12),
        Light("long3", "window", "fast", (0.6, 0.75, 1.0), 0.20, 0.06, False,
              window=LONG_WIN, seg=(segc[2], seg_hw), intensity=0.12),
        Light("path1", "lamp", "fast", warm, 0.28, 0.10, True, pos=(-1.0, 0.4, 3.5),
              radius=0.07, head=1.2, glow=0.06, pool=0.05),
        Light("path2", "lamp", "fast", warm, 0.31, 0.10, False, pos=(1.0, 0.4, 3.5),
              radius=0.07, head=1.2, glow=0.06, pool=0.05),
        Light("path3", "lamp", "fast", warm, 0.26, 0.10, True, pos=(-1.0, 0.4, 6.5),
              radius=0.07, head=1.2, glow=0.06, pool=0.05),
        Light("path4", "lamp", "fast", warm, 0.33, 0.10, False, pos=(1.0, 0.4, 6.5),
              radius=0.07, head=1.2, glow=0.06, pool=0.05),
        Light("drive_l", "lamp", "fast", (0.35, 0.45, 1.0), 0.40, 0.12, False,
              pos=(3.6, 1.2, 2.5), radius=0.1, head=1.2, glow=0.10),
        Light("drive_r", "lamp", "fast", (0.35, 0.45, 1.0), 0.45, 0.12, False,
              pos=(6.6, 1.2, 2.5), radius=0.1, head=1.2, glow=0.10),
        Light("post", "lamp", "fast", warm, 0.30, 0.08, False, pos=(-3.0, 1.0, 4.0),
              radius=0.1, head=1.3, glow=0.10),
        Light("w_bed1", "window", "slow", (1.0, 0.8, 0.6), 0.90, 0.30, True,
              window=bed, intensity=0.07, skew=-0.3),
        Light("long2", "window", "slow", (1.0, 0.8, 0.55), 1.10, 0.35, True,
              window=LONG_WIN, seg=(segc[1], seg_hw), intensity=0.12),
        Light("w_kitchen", "window", "slow", (1.0, 0.85, 0.65), 1.30, 0.25, True,
              window=(1.9, 3.1, 0.9, 2.2), intensity=0.12),
        Light("side", "lamp", "slow", warm, 0.80, 0.20, False, pos=(7.15, 2.3, -1.5),
              radius=0.09, head=1.3, glow=0.10, wash=0.07, wash_sigma=0.6, wash_plane="side_r"),
    ]


def pass_order(lights: list[Light]) -> list[str]:
    """Fast lights first, slow (Z-Wave) last, as DESIGN.md section 8 step 3."""
    return [l.id for l in lights if l.driver == "fast"] + [l.id for l in lights if l.driver == "slow"]


def _glass(light: Light, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    x0, x1, y0, y1 = light.window
    m = (x > x0 + FRAME_W) & (x < x1 - FRAME_W) & (y > y0 + FRAME_W) & (y < y1 - FRAME_W)
    if light.window == LONG_WIN:
        for mx in LONG_MULLIONS:
            m &= np.abs(x - mx) > FRAME_W / 2
    return m


def window_emission(light: Light, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Emission (scalar, times colour later) of a window light at house-front points."""
    x0, x1, y0, y1 = light.window
    if light.seg is not None:
        c, hw = light.seg
        prof = np.clip((hw + 0.2 - np.abs(x - c)) / 0.4, 0.0, 1.0)
    else:
        cx, w = (x0 + x1) / 2, (x1 - x0)
        prof = np.clip(1.0 + light.skew * (x - cx) / w * 2, 0.2, 2.0)
    vert = 0.85 + 0.15 * (y - y0) / (y1 - y0)
    return light.intensity * prof * vert * _glass(light, x, y)


def light_position_gt(light: Light) -> np.ndarray:
    """3D 'position' of what a viewer sees: lamp head, or the bright part of a lit window."""
    if light.kind == "lamp":
        return np.array(light.pos, float)
    x0, x1, y0, y1 = light.window
    xs, ys = np.meshgrid(np.linspace(x0, x1, 400), np.linspace(y0, y1, 120))
    e = window_emission(light, xs, ys)
    m = e >= 0.5 * e.max()
    wgt = e * m
    return np.array([(xs * wgt).sum() / wgt.sum(), (ys * wgt).sum() / wgt.sum(), 0.0])


# ------------------------------------------------------------------------------------- textures
def _noise(rng, shape, cell):
    small = rng.random((max(2, shape[0] // cell + 2), max(2, shape[1] // cell + 2))).astype(np.float32)
    return cv2.resize(small, (shape[1], shape[0]), interpolation=cv2.INTER_CUBIC)


def _fbm(rng, shape, cells=(64, 16, 4)):
    out = np.zeros(shape, np.float32)
    amp, tot = 1.0, 0.0
    for c in cells:
        out += amp * _noise(rng, shape, c)
        tot += amp
        amp *= 0.5
    return out / tot


GROUND_EXT = (-30.0, 30.0, -30.0, 40.0)   # x0, x1, z0, z1
GROUND_RES = 0.04
FRONT_EXT = (-7.0, 7.0, 0.0, 8.5)          # x0, x1, y0, y1
FRONT_RES = 0.02
SIDE_EXT = (-HOUSE_DEPTH, 0.0, 0.0, WALL_TOP)  # z0, z1, y0, y1
SIDE_RES = 0.02


def make_ground_texture(rng) -> np.ndarray:
    x0, x1, z0, z1 = GROUND_EXT
    nx, nz = int((x1 - x0) / GROUND_RES), int((z1 - z0) / GROUND_RES)
    xs = x0 + (np.arange(nx) + 0.5) * GROUND_RES
    zs = z0 + (np.arange(nz) + 0.5) * GROUND_RES
    X, Z = np.meshgrid(xs, zs)
    n = _fbm(rng, (nz, nx))
    tex = np.empty((nz, nx, 3), np.float32)
    lawn = np.array([0.22, 0.32, 0.16], np.float32)
    tex[:] = lawn * (0.55 + 0.9 * n)[..., None]
    # flower bed along the house
    bed = (Z > 0) & (Z < 1.2) & (np.abs(X) < 7.5)
    tex[bed] = np.array([0.12, 0.1, 0.08]) * (0.7 + 0.6 * n[bed])[:, None]
    # path pavers
    path = (np.abs(X) < 0.6) & (Z > 0) & (Z < 13.5)
    grout = (np.mod(Z, 0.4) < 0.03) | (np.mod(X + 0.6, 0.4) < 0.03)
    tex[path] = np.array([0.55, 0.52, 0.47]) * (0.85 + 0.3 * n[path])[:, None]
    tex[path & grout] *= 0.45
    # driveway with expansion joints
    drive = (X > 3.0) & (X < 8.0) & (Z > -2) & (Z < 13.5)
    tex[drive] = np.array([0.5, 0.5, 0.48]) * (0.8 + 0.4 * n[drive])[:, None]
    joint = drive & ((np.mod(Z, 3.0) < 0.04) | (np.abs(X - 5.5) < 0.02))
    tex[joint] *= 0.4
    # sidewalk and road
    walk = (Z >= 13.5) & (Z < 16.0)
    tex[walk] = np.array([0.6, 0.6, 0.58]) * (0.85 + 0.3 * n[walk])[:, None]
    tex[walk & (np.mod(X, 1.5) < 0.03)] *= 0.4
    road = Z >= 16.0
    tex[road] = np.array([0.12, 0.12, 0.13]) * (0.8 + 0.4 * n[road])[:, None]
    tex[road & (np.abs(Z - 21) < 0.06) & (np.mod(X, 3.0) < 1.5)] = (0.7, 0.65, 0.3)
    # scattered stones on the lawn (features)
    k = 600
    sx = rng.integers(0, nx, k)
    sz = rng.integers(0, nz, k)
    for i in range(k):
        if lawn_like(tex[sz[i], sx[i]]):
            cv2.circle(tex, (int(sx[i]), int(sz[i])), int(rng.integers(2, 5)), (0.75, 0.72, 0.68), -1)
    return tex


def lawn_like(c) -> bool:
    return c[1] > c[0] * 1.2


def make_front_texture(rng, lights: list[Light]) -> np.ndarray:
    x0, x1, y0, y1 = FRONT_EXT
    nx, ny = int((x1 - x0) / FRONT_RES), int((y1 - y0) / FRONT_RES)
    xs = x0 + (np.arange(nx) + 0.5) * FRONT_RES
    ys = y1 - (np.arange(ny) + 0.5) * FRONT_RES     # row 0 is the top
    X, Y = np.meshgrid(xs, ys)
    n = _fbm(rng, (ny, nx), (32, 8))
    tex = np.empty((ny, nx, 3), np.float32)
    tex[:] = np.array([0.7, 0.67, 0.6]) * (0.9 + 0.2 * n)[..., None]
    tex[np.mod(Y, 0.2) < 0.025] *= 0.7                     # siding shadow lines
    top = WALL_TOP + GABLE * (1 - np.abs(X) / HOUSE_HALF)
    tex[(top - Y) < 0.18] = (0.12, 0.11, 0.1)              # fascia along the gable
    tex[np.abs(Y - WALL_TOP) < 0.08] = (0.85, 0.85, 0.82)  # frieze board
    tex[np.abs(np.abs(X) - 6.9) < 0.1] = (0.88, 0.88, 0.85)  # corner boards
    tex[Y < 0.35] = np.array([0.35, 0.35, 0.36]) * (0.8 + 0.4 * n[Y < 0.35])[:, None]  # foundation
    wins = {l.window for l in lights if l.kind == "window"}
    for (a, b, c, d) in wins:
        inside = (X > a) & (X < b) & (Y > c) & (Y < d)
        tex[inside] = (0.9, 0.9, 0.88)                     # frame
        glass = (X > a + FRAME_W) & (X < b - FRAME_W) & (Y > c + FRAME_W) & (Y < d - FRAME_W)
        tex[glass] = np.array([0.05, 0.055, 0.06]) * (0.7 + 0.6 * n[glass])[:, None]
        if (a, b, c, d) == LONG_WIN:
            for mx in LONG_MULLIONS:
                tex[inside & (np.abs(X - mx) < FRAME_W / 2)] = (0.9, 0.9, 0.88)
        tex[(X > a - 0.1) & (X < b + 0.1) & (Y > c - 0.12) & (Y < c)] = (0.92, 0.92, 0.9)  # sill
    door = (np.abs(X) < 0.5) & (Y < 2.1)
    tex[(np.abs(X) < 0.6) & (Y < 2.2)] = (0.9, 0.9, 0.88)
    tex[door] = (0.35, 0.08, 0.06)
    panels = door & ((np.abs(np.abs(X) - 0.22) < 0.02) | (np.abs(Y - 1.05) < 0.02))
    tex[panels] = (0.2, 0.05, 0.04)
    tex[(np.abs(X - 0.35) < 0.04) & (np.abs(Y - 1.0) < 0.04)] = (0.8, 0.7, 0.3)  # knob
    return tex


def make_side_texture(rng) -> np.ndarray:
    z0, z1, y0, y1 = SIDE_EXT
    nz, ny = int((z1 - z0) / SIDE_RES), int((y1 - y0) / SIDE_RES)
    ys = y1 - (np.arange(ny) + 0.5) * SIDE_RES
    zs = z0 + (np.arange(nz) + 0.5) * SIDE_RES
    Z, Y = np.meshgrid(zs, ys)
    n = _fbm(rng, (ny, nz), (32, 8))
    tex = np.empty((ny, nz, 3), np.float32)
    tex[:] = np.array([0.7, 0.67, 0.6]) * (0.9 + 0.2 * n)[..., None]
    tex[np.mod(Y, 0.2) < 0.025] *= 0.7
    tex[Y < 0.35] = (0.3, 0.3, 0.31)
    win = (Z > -5.5) & (Z < -4.3) & (Y > 1.0) & (Y < 2.2)
    tex[win] = (0.9, 0.9, 0.88)
    tex[win & (Z > -5.44) & (Z < -4.36) & (Y > 1.06) & (Y < 2.14)] = (0.05, 0.05, 0.06)
    tex[np.abs(Z + 0.1) < 0.1] = (0.88, 0.88, 0.85)
    return tex


# --------------------------------------------------------------------------------------- camera
@dataclass
class Camera:
    K: np.ndarray
    R: np.ndarray
    C: np.ndarray

    def project(self, X: np.ndarray):
        Xc = self.R @ (np.asarray(X, float) - self.C)
        x = self.K @ Xc
        return x[:2] / x[2], Xc[2]


def intrinsics(hfov_deg: float, w: int = W, h: int = H) -> np.ndarray:
    f = (w / 2) / math.tan(math.radians(hfov_deg) / 2)
    return np.array([[f, 0, (w - 1) / 2], [0, f, (h - 1) / 2], [0, 0, 1.0]])


def look_at(C: np.ndarray, target: np.ndarray) -> np.ndarray:
    fwd = target - C
    fwd /= np.linalg.norm(fwd)
    right = np.cross(fwd, [0.0, 1.0, 0.0])
    right /= np.linalg.norm(right)
    down = np.cross(fwd, right)
    return np.stack([right, down, fwd])


def small_rotation(angles_rad: np.ndarray) -> np.ndarray:
    return cv2.Rodrigues(np.asarray(angles_rad, float).reshape(3, 1))[0]


# ------------------------------------------------------------------------------------- renderer
class Renderer:
    def __init__(self, lights: list[Light], seed: int = 0, w: int = W, h: int = H):
        self.lights = lights
        self.w, self.h = w, h
        rng = np.random.default_rng(seed)
        self.tex_ground = make_ground_texture(rng)
        self.tex_front = make_front_texture(rng, lights)
        self.tex_side = make_side_texture(rng)
        u, v = np.meshgrid(np.arange(w, dtype=np.float64), np.arange(h, dtype=np.float64))
        self.pix = np.stack([u.ravel(), v.ravel(), np.ones(w * h)])
        self.spheres = [(np.array(l.pos), l.radius, i) for i, l in enumerate(lights) if l.kind == "lamp"]
        self.spheres.append((STREETLIGHT, 0.2, -1))

    # surfaces: 0 sky, 1 ground, 2 front, 3 side right, 4 side left, 5 tree, 10+k lamp k, 9 streetlight
    def trace(self, cam: Camera):
        d = (cam.R.T @ np.linalg.inv(cam.K) @ self.pix).astype(np.float32)
        d /= np.sqrt((d * d).sum(0))
        C = cam.C.astype(np.float32)
        N = d.shape[1]
        tb = np.full(N, np.inf, np.float32)
        sid = np.zeros(N, np.int16)

        def upd(t, valid, s, idx=None):
            if idx is None:
                m = valid & (t > 1e-3) & (t < tb)
                tb[m] = t[m]
                sid[m] = s
            else:
                m = valid & (t > 1e-3) & (t < tb[idx])
                tb[idx[m]] = t[m]
                sid[idx[m]] = s

        with np.errstate(divide="ignore", invalid="ignore"):
            t = -C[1] / d[1]
            x, z = C[0] + t * d[0], C[2] + t * d[2]
            upd(t, (d[1] < 0) & (x > GROUND_EXT[0]) & (x < GROUND_EXT[1]) & (z > GROUND_EXT[2]) & (z < GROUND_EXT[3]), 1)
            if C[2] > 0:
                t = -C[2] / d[2]
                x, y = C[0] + t * d[0], C[1] + t * d[1]
                top = WALL_TOP + GABLE * (1 - np.abs(x) / HOUSE_HALF)
                upd(t, (d[2] < 0) & (np.abs(x) <= HOUSE_HALF) & (y >= 0) & (y <= top), 2)
            for sign, s in ((1, 3), (-1, 4)):
                px = sign * HOUSE_HALF
                if sign * C[0] > HOUSE_HALF:
                    t = (px - C[0]) / d[0]
                    y, z = C[1] + t * d[1], C[2] + t * d[2]
                    upd(t, (y >= 0) & (y <= WALL_TOP) & (z <= 0) & (z >= -HOUSE_DEPTH), s)
            # tree box (slab method)
            t0 = (TREE_MIN[:, None] - C[:, None]) / d
            t1 = (TREE_MAX[:, None] - C[:, None]) / d
            tn = np.nanmax(np.minimum(t0, t1), axis=0)
            tf = np.nanmin(np.maximum(t0, t1), axis=0)
            upd(tn, (tn <= tf) & (tf > 0), 5)
            # spheres, only near their projection
            for P0, r, k in self.spheres:
                uv, depth = cam.project(P0)
                if depth <= 0.1:
                    continue
                rad = r * cam.K[0, 0] / depth + 3
                u0, u1 = int(max(0, uv[0] - rad)), int(min(self.w - 1, uv[0] + rad))
                v0, v1 = int(max(0, uv[1] - rad)), int(min(self.h - 1, uv[1] + rad))
                if u0 > u1 or v0 > v1:
                    continue
                uu, vv = np.meshgrid(np.arange(u0, u1 + 1), np.arange(v0, v1 + 1))
                idx = (vv * self.w + uu).ravel()
                dd = d[:, idx]
                oc = (C - P0)[:, None]
                b = (dd * oc).sum(0)
                c = (oc * oc).sum() - r * r
                disc = b * b - c
                tt = -b - np.sqrt(np.maximum(disc, 0))
                upd(tt, disc > 0, 9 if k < 0 else 10 + k, idx)
        return d, tb, sid

    def render(self, cam: Camera, levels: np.ndarray, ambient: bool = True) -> np.ndarray:
        """Linear radiance image (H, W, 3), float32."""
        d, tb, sid = self.trace(cam)
        C = cam.C
        N = d.shape[1]
        P = cam.C.astype(np.float32)[:, None] + np.where(np.isfinite(tb), tb, 0) * d
        rad = np.zeros((N, 3), np.float32)
        amb = 1.0 if ambient else 0.0

        sky = sid == 0
        if ambient:
            el = np.clip(-d[1, sky], 0, 1)
            rad[sky] = (np.array([0.5, 0.6, 1.0]) * (0.004 + 0.006 * (1 - el))[:, None]).astype(np.float32)

        def sample(tex, ext, res, a, b, sel, flip_rows):
            mx = np.full(N, -10, np.float32)
            my = np.full(N, -10, np.float32)
            mx[sel] = (a - ext[0]) / res - 0.5
            my[sel] = ((ext[3] - b) if flip_rows else (b - ext[2])) / res - 0.5
            out = cv2.remap(tex, mx.reshape(self.h, self.w), my.reshape(self.h, self.w),
                            cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
            return out.reshape(N, 3)[sel]

        g = sid == 1
        if g.any():
            gx, gz = P[0, g], P[2, g]
            alb = sample(self.tex_ground, GROUND_EXT, GROUND_RES, gx, gz, g, False)
            col = alb * AMB_GROUND * amb
            # streetlight pool (static)
            if ambient:
                r2 = (gx - STREETLIGHT[0]) ** 2 + (gz - STREETLIGHT[2]) ** 2
                col = col + alb * (0.25 * np.exp(-r2 / (2 * 3.0 ** 2)))[:, None] * np.array([1.0, 0.75, 0.4], np.float32)
            for i, l in enumerate(self.lights):
                if l.pool > 0 and levels[i] > 0:
                    r2 = (gx - l.pos[0]) ** 2 + (gz - l.pos[2]) ** 2
                    near = r2 < (4 * l.pool_sigma) ** 2
                    if near.any():
                        col[near] += (levels[i] * l.pool * np.exp(-r2[near] / (2 * l.pool_sigma ** 2)))[:, None] \
                            * np.array(l.color, np.float32)
            rad[g] = col

        f = sid == 2
        if f.any():
            fx, fy = P[0, f], P[1, f]
            col = sample(self.tex_front, FRONT_EXT, FRONT_RES, fx, fy, f, True) * AMB_FRONT * amb
            for i, l in enumerate(self.lights):
                if levels[i] <= 0:
                    continue
                if l.kind == "window":
                    x0, x1, y0, y1 = l.window
                    near = (fx > x0) & (fx < x1) & (fy > y0) & (fy < y1)
                    if near.any():
                        col[near] += (levels[i] * window_emission(l, fx[near], fy[near]))[:, None] \
                            * np.array(l.color, np.float32)
                elif l.wash > 0 and l.wash_plane == "front":
                    r2 = (fx - l.pos[0]) ** 2 + (fy - l.pos[1]) ** 2
                    near = r2 < (4 * l.wash_sigma) ** 2
                    col[near] += (levels[i] * l.wash * np.exp(-r2[near] / (2 * l.wash_sigma ** 2)))[:, None] \
                        * np.array(l.color, np.float32)
            rad[f] = col

        for s in (3, 4):
            m = sid == s
            if m.any():
                sz, sy = P[2, m], P[1, m]
                col = sample(self.tex_side, SIDE_EXT, SIDE_RES, sz, sy, m, True) * AMB_SIDE * amb
                if s == 3:
                    for i, l in enumerate(self.lights):
                        if l.wash > 0 and l.wash_plane == "side_r" and levels[i] > 0:
                            r2 = (sz - l.pos[2]) ** 2 + (sy - l.pos[1]) ** 2
                            col += (levels[i] * l.wash * np.exp(-r2 / (2 * l.wash_sigma ** 2)))[:, None] \
                                * np.array(l.color, np.float32)
                rad[m] = col

        t = sid == 5
        if t.any() and ambient:
            q = P[:, t]
            tex = 0.7 + 0.3 * np.sin(q[0] * 23.0) * np.sin(q[1] * 17.0 + q[2] * 13.0)
            rad[t] = np.array([0.05, 0.09, 0.04]) * (AMB_TREE / 0.03) * tex[:, None]

        for P0, r, k in self.spheres:
            m = sid == (9 if k < 0 else 10 + k)
            if not m.any():
                continue
            if k < 0:
                rad[m] = np.array([1.0, 0.75, 0.4]) * 3.0 * amb
            else:
                l = self.lights[k]
                rad[m] = np.array(l.color) * l.head * levels[k] + 0.03 * amb * (1 - levels[k])

        img = rad.reshape(self.h, self.w, 3)
        # glows (screen-space bloom), only if the source centre is not occluded
        tbi = tb.reshape(self.h, self.w)
        glows = [(STREETLIGHT, 0.2, 0.3, (1.0, 0.75, 0.4), amb)]
        glows += [(np.array(l.pos), l.radius, l.glow, l.color, levels[i])
                  for i, l in enumerate(self.lights) if l.kind == "lamp"]
        for P0, r, gamp, colr, lv in glows:
            if lv <= 0:
                continue
            uv, depth = cam.project(P0)
            if depth <= 0.1:
                continue
            ui, vi = int(round(uv[0])), int(round(uv[1]))
            dist = np.linalg.norm(P0 - C)
            sig = 3.0 + 1.5 * r * cam.K[0, 0] / depth
            ext = int(4 * sig)
            inside = 0 <= ui < self.w and 0 <= vi < self.h
            if not inside and not (-ext < ui < self.w + ext and -ext < vi < self.h + ext):
                continue
            if inside and tbi[vi, ui] < dist - 2.0 * r:
                continue        # source hidden (bloom of an off-frame source still spills in)
            u0, u1 = max(0, ui - ext), min(self.w, ui + ext + 1)
            v0, v1 = max(0, vi - ext), min(self.h, vi + ext + 1)
            uu, vv = np.meshgrid(np.arange(u0, u1), np.arange(v0, v1))
            gk = np.exp(-((uu - uv[0]) ** 2 + (vv - uv[1]) ** 2) / (2 * sig * sig))
            amp = gamp * lv * min(4.0, (10.0 / dist) ** 2)
            img[v0:v1, u0:u1] += (amp * gk)[..., None] * np.array(colr, np.float32)
        return img


# ---------------------------------------------------------------------------- shake and motion
SHAKE = {
    "none": dict(rot_tremor=0.0, rot_drift=0.0, tr_tremor=0.0, tr_drift=0.0),
    "normal": dict(rot_tremor=0.06, rot_drift=0.4, tr_tremor=0.0001, tr_drift=0.02),
    "heavy": dict(rot_tremor=0.2, rot_drift=1.2, tr_tremor=0.0003, tr_drift=0.05),
}
MOTION_FS = 240.0


def _band_noise(rng, n, fs, lo, hi, dims=3):
    x = rng.standard_normal((dims, n))
    X = np.fft.rfft(x, axis=1)
    f = np.fft.rfftfreq(n, 1 / fs)
    mask = (f >= lo) & (f <= hi)
    y = np.fft.irfft(X * mask, n, axis=1)
    return y / (y.std(axis=1, keepdims=True) + 1e-12)


@dataclass
class Shake:
    t: np.ndarray        # app clock
    ang: np.ndarray      # (n, 3) rad: rotation vector in camera frame
    trans: np.ndarray    # (n, 3) m, world

    def at(self, t: float):
        a = np.array([np.interp(t, self.t, self.ang[:, k]) for k in range(3)])
        tr = np.array([np.interp(t, self.t, self.trans[:, k]) for k in range(3)])
        return a, tr

    def rate(self, t: float) -> np.ndarray:
        i = int(np.clip(np.searchsorted(self.t, t), 1, len(self.t) - 1))
        return (self.ang[i] - self.ang[i - 1]) / (self.t[i] - self.t[i - 1])


def make_shake(rng, t0: float, dur: float, kind: str, jolts: list[float]) -> Shake:
    p = SHAKE[kind]
    n = int(dur * MOTION_FS)
    t = t0 + np.arange(n) / MOTION_FS
    deg = math.pi / 180
    ang = (p["rot_tremor"] * _band_noise(rng, n, MOTION_FS, 3, 10)
           + p["rot_drift"] * _band_noise(rng, n, MOTION_FS, 0.01, 0.25)).T * deg
    trans = (p["tr_tremor"] * _band_noise(rng, n, MOTION_FS, 3, 10)
             + p["tr_drift"] * _band_noise(rng, n, MOTION_FS, 0.01, 0.25)).T
    for tj in jolts:
        s = t - tj
        rise = np.clip(s / 0.12, 0, 1)
        rise = rise * rise * (3 - 2 * rise)
        bump = np.where(s < 0, 0, rise * np.exp(-np.maximum(s - 0.12, 0) / 0.8))
        ang += np.outer(bump, np.array([6.0, 4.0, 2.0]) * deg)
        trans += np.outer(bump, [0.015, -0.03, 0.01])
    return Shake(t, ang, trans)


def motion_samples(rng, shake: Shake, R_nom: np.ndarray, t_offset: float, fs: float = 60.0) -> dict:
    step = int(MOTION_FS / fs)
    dt = 1 / MOTION_FS
    rate = np.gradient(shake.ang, dt, axis=0)[::step] * 180 / math.pi
    acc_w = np.gradient(np.gradient(shake.trans, dt, axis=0), dt, axis=0)
    acc_w = cv2.GaussianBlur(acc_w.astype(np.float64), (1, 9), 0)[::step]
    acc = acc_w @ R_nom.T
    t = shake.t[::step] + t_offset
    rate = rate + rng.normal(0, 0.3, rate.shape)
    acc = acc + rng.normal(0, 0.08, acc.shape)
    return {"t": t, "rot_rate": rate, "acc": acc}


# ----------------------------------------------------------------------------------- scenario
@dataclass
class Scenario:
    name: str = "clean"
    seed: int = 0
    shake: str = "normal"            # none | normal | heavy
    exposure: str = "auto"           # auto | drift
    jolt: tuple | None = None        # (station, light id): jolt during that light's pass step
    noise: float = 1.0
    hfov_true: float = 66.0
    fps: float = 15.0
    exposure_time: float = 0.05
    fast_step: float = 0.8
    slow_step: float = 2.2
    lead_in: float = 1.5
    sync_light: str = "porch"
    stations: tuple = ("centre", "left", "right")


SCENARIOS = {
    "clean": Scenario("clean", seed=1),
    "heavy_shake": Scenario("heavy_shake", seed=2, shake="heavy"),
    "exposure_drift": Scenario("exposure_drift", seed=3, exposure="drift"),
    "jolt": Scenario("jolt", seed=4, jolt=("centre", "long1")),
}

STATION_ANGLE = {"centre": 0.0, "left": -45.0, "right": 45.0}


@dataclass
class Command:
    t: float          # app clock
    station: str
    light: str | None
    action: str       # 'sync' | 'invert' | 'revert' | 'restore_all'
    step: int


@dataclass
class StationPlan:
    name: str
    t0: float
    t_end: float
    cam_nom: Camera
    shake: Shake
    video_offset: float          # video_t = app_t - t0 + video_offset
    motion: dict
    commands: list[Command]
    transitions: dict            # light id -> list of (t_start, ramp, target level)
    retakes: list[str]
    jolt_t: list[float]


class Simulation:
    """Plans the guided capture, renders frames on demand and holds the ground truth."""

    def __init__(self, sc: Scenario):
        self.sc = sc
        self.lights = default_lights()
        self.ids = [l.id for l in self.lights]
        self.by_id = {l.id: l for l in self.lights}
        self.renderer = Renderer(self.lights, seed=1000 + sc.seed)
        self.K = intrinsics(sc.hfov_true)
        rng = np.random.default_rng(sc.seed)
        self.rng = rng
        self.plans: list[StationPlan] = []
        t0 = 0.0
        for name in sc.stations:
            plan = self._plan_station(name, t0, rng)
            self.plans.append(plan)
            t0 = plan.t_end + 20.0          # walking to the next station
        self.commands = [c for p in self.plans for c in p.commands]
        self._gt = None

    @property
    def gt(self) -> dict:
        if self._gt is None:
            self._gt = self.ground_truth()
        return self._gt

    # -------------------------------------------------------------------------- planning
    def _plan_station(self, name: str, t0: float, rng) -> StationPlan:
        sc = self.sc
        th = math.radians(STATION_ANGLE[name] + rng.uniform(-4, 4) * (name != "centre") + rng.uniform(-1.5, 1.5))
        r = 15.0 + rng.uniform(-1.0, 1.0)
        C = np.array([ANCHOR[0] + r * math.sin(th), 1.5 + rng.uniform(-0.1, 0.1), ANCHOR[2] + r * math.cos(th)])
        aim = ANCHOR + rng.normal(0, 0.12, 3)
        cam_nom = Camera(self.K, look_at(C, aim), C)

        # nominal pass timeline (needed to place the jolt and to decide retakes)
        cmds: list[Command] = []
        t = t0 + sc.lead_in
        step = 0
        for k in range(4):
            cmds.append(Command(t + 0.4 * k, name, sc.sync_light, "sync", step))
            step += 1
        t += 1.2 + 0.8
        pass_steps = []
        for lid in pass_order(self.lights):
            cmds.append(Command(t, name, lid, "invert", step))
            dur = sc.fast_step if self.by_id[lid].driver == "fast" else sc.slow_step
            pass_steps.append((lid, t, t + dur))
            step += 1
            t += dur
        jolt_t = []
        if sc.jolt and sc.jolt[0] == name:
            for lid, a, b in pass_steps:
                if lid == sc.jolt[1]:
                    jolt_t.append(a + 0.25)
        dur_total = (t - t0) + 12.0
        shake = make_shake(rng, t0, dur_total, sc.shake, jolt_t)
        video_offset = float(rng.uniform(0.3, 2.0))
        mot = motion_samples(rng, shake, cam_nom.R, video_offset - t0)
        # the live controller flags jolted steps from the motion stream and retakes them
        retakes = []
        for lid, a, b in pass_steps:
            if motion_mod.is_jolt(mot, a - t0 + video_offset - 0.1, b - t0 + video_offset + 0.1):
                retakes.append(lid)
        for lid in retakes:
            cmds.append(Command(t, name, lid, "revert", step))
            step += 1
            t += sc.fast_step if self.by_id[lid].driver == "fast" else sc.slow_step
        cmds.append(Command(t, name, None, "restore_all", step))
        t_end = t + 2.6

        # light transitions from the command list
        trans = {lid: [] for lid in self.ids}
        state = {l.id: (1.0 if l.initial_on else 0.0) for l in self.lights}
        for c in cmds:
            targets = []
            if c.action in ("sync", "invert", "revert"):
                targets = [c.light]
            elif c.action == "restore_all":
                targets = [l.id for l in self.lights if state[l.id] != (1.0 if l.initial_on else 0.0)]
            for lid in targets:
                l = self.by_id[lid]
                new = 1.0 - state[lid]
                lat = l.latency + rng.normal(0, 0.01)
                trans[lid].append((c.t + max(0.02, lat), l.ramp, new))
                state[lid] = new
        return StationPlan(name, t0, t_end, cam_nom, shake, video_offset, mot, cmds, trans, retakes, jolt_t)

    def level(self, plan: StationPlan, lid: str, t: float) -> float:
        lvl = 1.0 if self.by_id[lid].initial_on else 0.0
        for ts, ramp, tgt in plan.transitions[lid]:
            if t < ts:
                break
            if ramp <= 0 or t >= ts + ramp:
                lvl = tgt
            else:
                lvl = lvl + (tgt - lvl) * (t - ts) / ramp
                break
        return lvl

    def levels(self, plan: StationPlan, t0: float, t1: float) -> np.ndarray:
        ts = np.linspace(t0, t1, 5)
        return np.array([np.mean([self.level(plan, lid, t) for t in ts]) for lid in self.ids], np.float32)

    def camera_at(self, plan: StationPlan, t: float) -> Camera:
        a, tr = plan.shake.at(t)
        return Camera(self.K, small_rotation(a) @ plan.cam_nom.R, plan.cam_nom.C + tr)

    # ---------------------------------------------------------------------------- frames
    def frame_times(self, plan: StationPlan) -> np.ndarray:
        n = int((plan.t_end - plan.t0) * self.sc.fps)
        jitter = np.random.default_rng(self.sc.seed + 77).normal(0, 0.002, n)
        jitter[0] = 0
        return plan.t0 + np.arange(n) / self.sc.fps + jitter

    def render_station(self, idx: int) -> dict:
        """Render one station. Returns frames (N,H,W,3) uint8 RGB, video timestamps, motion."""
        sc = self.sc
        plan = self.plans[idx]
        rng = np.random.default_rng(sc.seed * 101 + idx)
        times = self.frame_times(plan)
        frames = np.empty((len(times), H, W, 3), np.uint8)
        gain = None
        drift = self._exposure_drift(rng, plan)
        for k, t in enumerate(times):
            tm = t + sc.exposure_time / 2
            cam = self.camera_at(plan, tm)
            lv = self.levels(plan, t, t + sc.exposure_time)
            rad = self.renderer.render(cam, lv)
            rad = cv2.GaussianBlur(rad, (0, 0), 0.8)
            rad = self._motion_blur(rad, plan.shake.rate(tm), cam.K[0, 0])
            m = float((rad @ LUMA).mean())
            target = 0.09 / max(m, 1e-4)
            if gain is None:
                gain = target
            else:
                alpha = 1 - math.exp(-(1 / sc.fps) / 0.6)
                gain += alpha * (target - gain)
            g = gain * drift(t)
            frames[k] = self._sensor(rad * g, rng)
        motion = plan.motion
        return {"frames": frames, "t": times - plan.t0 + plan.video_offset, "motion": motion,
                "name": plan.name}

    def _exposure_drift(self, rng, plan: StationPlan):
        if self.sc.exposure != "drift":
            return lambda t: 1.0
        p1, p2 = rng.uniform(0, 2 * math.pi, 2)
        steps = np.sort(rng.uniform(plan.t0 + 3, plan.t_end, 4))
        facs = rng.choice([0.8, 0.85, 1.18, 1.25], 4)

        def f(t):
            v = math.exp(0.15 * math.sin(2 * math.pi * t / 5.3 + p1) + 0.08 * math.sin(2 * math.pi * t / 1.7 + p2))
            for s, fa in zip(steps, facs):
                if t >= s:
                    v *= fa
            return v
        return f

    def _motion_blur(self, img, rate, f):
        dx = rate[1] * f * self.sc.exposure_time      # yaw -> horizontal
        dy = rate[0] * f * self.sc.exposure_time      # pitch -> vertical
        L = math.hypot(dx, dy)
        if L < 0.7:
            return img
        n = int(math.ceil(L)) | 1
        n += 2
        k = np.zeros((n, n), np.float32)
        c = n // 2
        cv2.line(k, (int(round(c - dx / 2)), int(round(c - dy / 2))),
                 (int(round(c + dx / 2)), int(round(c + dy / 2))), 1.0, 1)
        k /= k.sum()
        return cv2.filter2D(img, -1, k)

    def _sensor(self, lin, rng):
        read, shot = 0.004 * self.sc.noise, 0.0015 * self.sc.noise
        sigma = np.sqrt(read ** 2 + shot * np.maximum(lin, 0))
        lin = lin + rng.standard_normal(lin.shape, dtype=np.float32) * sigma
        out = np.power(np.clip(lin, 0, 1), 1 / 2.2) * 255.0
        return np.clip(out + 0.5, 0, 255).astype(np.uint8)

    # ----------------------------------------------------------------------- ground truth
    def ground_truth(self, stations: dict | None = None) -> dict:
        """Full ground truth. `stations` may carry per-station parts computed elsewhere."""
        sc = self.sc
        pos = {l.id: light_position_gt(l) for l in self.lights}
        P = np.array(list(pos.values()))
        size = float(np.linalg.norm(P.max(0) - P.min(0)))
        stations = dict(stations or {})
        for i, plan in enumerate(self.plans):
            if plan.name not in stations:
                stations[plan.name] = self.gt_station(i)
        return {
            "lights": {l.id: {"pos": pos[l.id], "latency": l.latency_half, "rise": not l.initial_on,
                              "driver": l.driver, "kind": l.kind} for l in self.lights},
            "stations": stations,
            "scene_size": size,
            "f": float(self.K[0, 0]),
            "jolt": sc.jolt,
            "groups": {"single": [["w_bed1", "w_bed2"]], "segments": [["long1", "long2", "long3"]]},
            "known_distance": ("drive_l", "drive_r",
                               float(np.linalg.norm(pos["drive_l"] - pos["drive_r"]))),
        }

    def gt_station(self, idx: int) -> dict:
        sc = self.sc
        plan = self.plans[idx]
        pos = {l.id: light_position_gt(l) for l in self.lights}
        t_ref = plan.t0 + sc.exposure_time / 2
        cam = self.camera_at(plan, t_ref)
        base = np.array([1.0 if l.initial_on else 0.0 for l in self.lights], np.float32)
        rad0 = cv2.GaussianBlur(self.renderer.render(cam, base), (0, 0), 0.8)
        g = 0.09 / float((rad0 @ LUMA).mean())
        masks, visible, cents = {}, [], {}
        for i, l in enumerate(self.lights):
            on, off = base.copy(), base.copy()
            on[i], off[i] = 1.0, 0.0
            a = cv2.GaussianBlur(self.renderer.render(cam, on), (0, 0), 0.8) * g
            b = cv2.GaussianBlur(self.renderer.render(cam, off), (0, 0), 0.8) * g
            dimg = np.abs(np.clip(a, 0, 1) @ LUMA - np.clip(b, 0, 1) @ LUMA)
            peak = float(dimg.max())
            m = dimg > max(0.2 * peak, 0.01)
            masks[l.id] = m
            uv, depth = cam.project(pos[l.id])
            cents[l.id] = uv
            if m.sum() >= 6:
                visible.append(l.id)
        return {
            "K": self.K, "R": cam.R, "C": cam.C, "R_nom": plan.cam_nom.R, "C_nom": plan.cam_nom.C,
            "masks": masks, "visible": visible, "centroid2d": cents,
            "video_offset": plan.video_offset - plan.t0, "retakes": list(plan.retakes),
            "jolt_t": [t - plan.t0 + plan.video_offset for t in plan.jolt_t],
        }

    def command_log(self) -> list[dict]:
        return [dict(t=c.t, station=c.station, light=c.light, action=c.action, step=c.step)
                for c in self.commands]

    def inventory(self) -> list[dict]:
        """What the add-on knows before mapping: ids and driver class, nothing spatial."""
        return [{"id": l.id, "driver": l.driver} for l in self.lights]
