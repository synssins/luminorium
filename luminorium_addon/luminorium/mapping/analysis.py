"""Offline analysis of a guided mapping capture (DESIGN.md section 8), ported from the prototype in
proto/mapping/analyze.py (its README has the reasoning and the measured results).

Per station: align every frame to a reference (rotation + scale model), normalise exposure in
software, find the clock offset (the phone-clock handshake, checked against the sync blink, or the
blink alone), then for every single-light step difference "settled just before the command"
against "settled just before the next command", keep filled regions (not shake edges or parallax),
and measure latency.

Across stations: the identified lights are the correspondences; essential matrix with RANSAC, PnP
for further stations, triangulation, and a small bundle adjustment that refines the focal length.

Differences from the prototype: frames can be a lazy sequence (decoded from the recording one at
a time) and the per-frame masks are bit-packed, to keep memory down on the HA box; SciPy is
replaced by `lm.least_squares`; the clock can come from the phone handshake.
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field

import cv2
import numpy as np

from . import lm
from . import motion as motion_mod

LUT = ((np.arange(256) / 255.0) ** 2.2).astype(np.float32)
LUMA = np.array([0.2126, 0.7152, 0.0722], np.float32)
SAT_LEVEL = 240


@dataclass
class Params:
    lead_frames: int = 8  # still frames before any command (the reference)
    sync_latency: float = 0.10  # assumed latency of the sync light, when only the blink is known
    sync_search: float = 4.0  # s after the reference in which the sync blink must start
    # With a phone-clock handshake: how far the blink may disagree before the handshake is doubted
    handshake_tolerance: float = 0.3
    frame_mid: float | None = None  # timestamp to mid-exposure; unknown on the web: half a frame
    win: float = 0.25  # before/after window length
    guard: float = 0.05  # frames up to this long after a command are still "before"
    z_thresh: float = 4.0
    min_area: int = 10
    min_mean_z: float = 6.0
    min_snr: float = 8.0  # mean |z| over the final region; true lights score >= 10 synthetically
    region_frac: float = 0.2  # region = |D| >= frac * peak
    hfov_guess: float = 70.0
    min_conf: float = 0.15
    max_reproj: float = 4.0  # px, bundle-adjustment outlier threshold
    min_latency: float = 0.03  # nothing on the network answers faster; earlier = previous step


# ------------------------------------------------------------------------------- alignment
class Aligner:
    """Tracks reference features into each frame (pyramidal LK), rejects outliers with a RANSAC
    homography, then fits a rotation + scale model H = S K R K^-1 to the inliers. Hand shake is
    mostly rotation; the constrained model stays stable at the image edges where a free homography
    bends when the features are unevenly spread."""

    def __init__(self, ref_gray: np.ndarray, exclude: np.ndarray | None = None, hfov: float = 70.0):
        self.ref = ref_gray
        self.ref_mean = float(ref_gray.mean())
        h, w = ref_gray.shape
        f = (w / 2) / math.tan(math.radians(hfov) / 2)
        self.K = np.array([[f, 0, (w - 1) / 2], [0, f, (h - 1) / 2], [0, 0, 1.0]])
        self.Ki = np.linalg.inv(self.K)
        det = cv2.createCLAHE(2.0, (8, 8)).apply(ref_gray)
        mask = np.full(ref_gray.shape, 255, np.uint8)
        if exclude is not None:
            mask[exclude] = 0
        b = 12
        mask[:b], mask[-b:], mask[:, :b], mask[:, -b:] = 0, 0, 0, 0
        pts = cv2.goodFeaturesToTrack(det, 600, 0.01, 8, mask=mask, blockSize=5)
        self.pts = pts.astype(np.float32) if pts is not None else np.zeros((0, 1, 2), np.float32)
        self.theta = np.zeros(4)
        self.H = np.eye(3)

    def model(self, th: np.ndarray) -> np.ndarray:
        R = cv2.Rodrigues(np.asarray(th[:3], float).reshape(3, 1))[0]
        S = np.diag([math.exp(th[3]), math.exp(th[3]), 1.0])
        c = self.K[:2, 2]
        T = np.array([[1, 0, c[0]], [0, 1, c[1]], [0, 0, 1.0]])
        Ti = np.array([[1, 0, -c[0]], [0, 1, -c[1]], [0, 0, 1.0]])
        return T @ S @ Ti @ self.K @ R @ self.Ki

    def _fit(self, p: np.ndarray, q: np.ndarray) -> np.ndarray:
        ph = np.hstack([p, np.ones((len(p), 1))])

        def res(th):
            x = ph @ self.model(th).T
            return (x[:, :2] / x[:, 2:3] - q).ravel()

        return lm.least_squares(res, self.theta, max_iter=50)

    def align(self, gray: np.ndarray) -> tuple[np.ndarray, dict]:
        g = gray.astype(np.float32) * (self.ref_mean / max(float(gray.mean()), 1e-3))
        g = np.clip(g, 0, 255).astype(np.uint8)
        if len(self.pts) < 8:
            return self.H, {"ok": False, "inliers": 0, "resid": np.inf}
        init = cv2.perspectiveTransform(self.pts, self.H).astype(np.float32)
        nxt, st, _ = cv2.calcOpticalFlowPyrLK(
            self.ref,
            g,
            self.pts,
            init.copy(),
            winSize=(21, 21),
            maxLevel=3,
            flags=cv2.OPTFLOW_USE_INITIAL_FLOW,
            criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
        )
        ok = st.ravel() == 1
        if ok.sum() < 12:
            return self.H, {"ok": False, "inliers": int(ok.sum()), "resid": np.inf}
        Hm, inl = cv2.findHomography(
            self.pts[ok], nxt[ok], cv2.RANSAC, 2.0, maxIters=2000, confidence=0.995
        )
        if Hm is None or inl is None or inl.sum() < 12:
            n = 0 if inl is None else int(inl.sum())
            return self.H, {"ok": False, "inliers": n, "resid": np.inf}
        inl = inl.ravel().astype(bool)
        p = self.pts[ok][inl].reshape(-1, 2).astype(np.float64)
        q = nxt[ok][inl].reshape(-1, 2).astype(np.float64)
        th = self._fit(p, q)
        Hr = self.model(th)
        proj = cv2.perspectiveTransform(p.reshape(-1, 1, 2), Hr).reshape(-1, 2)
        e = np.linalg.norm(proj - q, axis=1)
        keep = e < max(2.0, 3 * np.median(e))
        if keep.sum() >= 12 and not keep.all():
            th = self._fit(p[keep], q[keep])
            Hr = self.model(th)
            proj = cv2.perspectiveTransform(p[keep].reshape(-1, 1, 2), Hr).reshape(-1, 2)
            e = np.linalg.norm(proj - q[keep], axis=1)
        resid = float(np.sqrt(np.mean(e**2)))
        self.theta, self.H = th, Hr
        return Hr, {"ok": True, "inliers": int(len(e)), "frac": float(inl.mean()), "resid": resid}


def _lin(frame: np.ndarray) -> np.ndarray:
    return LUT[frame] @ LUMA


def _warp(img: np.ndarray, Hm: np.ndarray, border=0) -> np.ndarray:
    h, w = img.shape[:2]
    return cv2.warpPerspective(
        img,
        Hm,
        (w, h),
        flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=border,
    )


# ------------------------------------------------------------------------------ results
@dataclass
class LightResult:
    id: str
    detected: bool = False
    region: np.ndarray | None = None
    centroid: tuple | None = None
    rise: bool | None = None
    latency: float | None = None
    confidence: float = 0.0
    snr: float = 0.0
    retake: bool = False  # the pass step was jolted / unsteady
    source: str = "pass"  # 'pass' or 'retake'
    note: str = ""


@dataclass
class StationResult:
    name: str
    ref_image: np.ndarray  # gamma RGB reference for overlays
    size: tuple = (640, 360)  # (w, h)
    lights: dict = field(default_factory=dict)  # id -> LightResult
    clock_offset: float = 0.0  # video = app + offset
    clock_source: str = "blink"  # 'handshake' or 'blink'
    sync_latency: float | None = None  # measured, when the handshake gave the clock
    steps: list = field(default_factory=list)  # per-step diagnostics
    align_fail: int = 0
    align_resid: float = 0.0
    gains: np.ndarray | None = None
    restore_residual: int = 0
    groups: dict = field(default_factory=dict)
    sync_debug: dict = field(default_factory=dict)

    def detected(self, min_conf: float = Params.min_conf) -> list[str]:
        return [k for k, r in self.lights.items() if r.detected and r.confidence >= min_conf]


# ----------------------------------------------------------------------- station analysis
class _Bits:
    """A stack of per-frame boolean masks, bit-packed (1/8 of the memory)."""

    def __init__(self, n: int, h: int, w: int):
        self.h, self.w = h, w
        self.data = np.zeros((n, (h * w + 7) // 8), np.uint8)

    def __setitem__(self, k: int, mask: np.ndarray) -> None:
        self.data[k] = np.packbits(mask.ravel())

    def _unpack(self, packed: np.ndarray) -> np.ndarray:
        return np.unpackbits(packed, count=self.h * self.w).reshape(self.h, self.w).astype(bool)

    def any(self, idx) -> np.ndarray:
        return self._unpack(np.bitwise_or.reduce(self.data[idx], axis=0))

    def all(self, idx) -> np.ndarray:
        return self._unpack(np.bitwise_and.reduce(self.data[idx], axis=0))


class _Stack:
    """Aligned, exposure-normalised linear luminance for one station."""

    def __init__(self, frames: Sequence[np.ndarray], p: Params):
        n = len(frames)
        lead = [frames[k] for k in range(min(p.lead_frames, n))]
        h, w = lead[0].shape[:2]
        self.n, self.h, self.w = n, h, w
        grays = [cv2.cvtColor(f, cv2.COLOR_RGB2GRAY) for f in lead]
        # reference: average the still lead-in, aligned to its first frame
        a0 = Aligner(grays[0])
        acc_g = np.zeros((h, w), np.float32)
        acc_l = np.zeros((h, w), np.float32)
        for k, f in enumerate(lead):
            Hm, _ = a0.align(grays[k])
            acc_g += _warp(grays[k].astype(np.float32), Hm)
            acc_l += _warp(_lin(f), Hm)
        ref_gray = np.clip(acc_g / len(lead), 0, 255).astype(np.uint8)
        self.ref = acc_l / len(lead)
        self.ref_rgb = lead[0].copy()
        sat0 = (
            cv2.dilate((lead[0].max(2) >= SAT_LEVEL).astype(np.uint8), np.ones((9, 9), np.uint8))
            > 0
        )
        aligner = Aligner(ref_gray, exclude=sat0)

        # stable pixels for exposure normalisation: mid-tones, flat, away from the border
        gx = cv2.Sobel(self.ref, cv2.CV_32F, 1, 0)
        gy = cv2.Sobel(self.ref, cv2.CV_32F, 0, 1)
        grad = np.sqrt(gx * gx + gy * gy) / (self.ref + 0.01)
        cand = (self.ref > 0.02) & (self.ref < 0.7) & ~sat0
        cand[:30], cand[-30:], cand[:, :30], cand[:, -30:] = False, False, False, False
        if cand.sum() < 200:  # a very dark picture: take what there is
            cand = (self.ref > 0.002) & ~sat0
        cand &= grad <= np.percentile(grad[cand], 60)
        idx = np.flatnonzero(cand)
        rng = np.random.default_rng(0)
        self.sidx = rng.choice(idx, min(30000, len(idx)), replace=False)

        self.N = np.empty((n, h, w), np.float16)
        self.sat = _Bits(n, h, w)
        self.vmask = _Bits(n, h, w)  # pixel inside the warped frame
        self.valid = np.ones((h, w), bool)  # inside every frame
        self.gain = np.ones(n)
        self.align_ok = np.ones(n, bool)
        self.resid = np.zeros(n)
        ref_s = self.ref.ravel()[self.sidx]
        ones = np.ones((h, w), np.uint8)
        k3, k5 = np.ones((3, 3), np.uint8), np.ones((5, 5), np.uint8)
        for k in range(n):
            frame = frames[k]
            gray = cv2.cvtColor(frame, cv2.COLOR_RGB2GRAY)
            Hm, st = aligner.align(gray)
            self.align_ok[k] = st["ok"]
            self.resid[k] = st["resid"]
            lin = _warp(_lin(frame), Hm)
            # near-saturated pixels do not scale with exposure: treat them as clipped
            satk = _warp(cv2.dilate((frame.max(2) >= SAT_LEVEL).astype(np.uint8), k3), Hm) > 0
            v = _warp(ones, Hm) > 0
            v = cv2.erode(v.astype(np.uint8), k5) > 0
            self.valid &= v
            self.vmask[k] = v
            s = lin.ravel()[self.sidx]
            r = s / np.maximum(ref_s, 1e-4)
            med = np.median(r)
            keep = np.abs(np.log(np.maximum(r, 1e-4) / med)) < 0.25
            if keep.sum() > 100:
                g = float(s[keep].sum() / max(ref_s[keep].sum(), 1e-6))
            else:
                g = float(med)
            g = max(g, 1e-4)
            self.gain[k] = g
            self.N[k] = lin / g
            self.sat[k] = satk


def _windows(t: np.ndarray, a: float, b: float) -> np.ndarray:
    return np.flatnonzero((t >= a) & (t <= b))


def _change_energy(stack: _Stack) -> np.ndarray:
    """Frame-to-frame change energy (filled blobs only), relative to a running baseline."""
    e = np.zeros(stack.n)
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    prev = stack.N[0].astype(np.float32)
    for k in range(1, stack.n):
        cur = stack.N[k].astype(np.float32)
        d = cv2.blur(cur - prev, (3, 3))
        d[~stack.valid] = 0
        s = 1.4826 * np.median(np.abs(d[stack.valid])) + 1e-6
        m = cv2.morphologyEx((np.abs(d) > 5 * s).astype(np.uint8), cv2.MORPH_OPEN, k3)
        e[k] = np.abs(d)[m > 0].sum()
        prev = cur
    base = np.array([np.median(e[max(1, k - 15) : k + 15]) for k in range(stack.n)])
    return e / (base + 1e-3 * e.max() + 1e-9)


def _difference(stack: _Stack, before: np.ndarray, after: np.ndarray):
    B = np.median(stack.N[before].astype(np.float32), axis=0)
    A = np.median(stack.N[after].astype(np.float32), axis=0)
    invalid = stack.sat.any(before) & stack.sat.any(after)
    valid = stack.vmask.all(before) & stack.vmask.all(after)
    D = A - B
    D[invalid | ~valid] = 0.0
    M = (A + B) / 2
    # brightness-binned robust noise
    sig = np.full(D.shape, 1e-3, np.float32)
    v = valid & ~invalid
    qs = np.quantile(M[v], np.linspace(0, 1, 11))
    bins = np.clip(np.searchsorted(qs, M, side="right") - 1, 0, 9)
    for bi in range(10):
        m = v & (bins == bi)
        if m.sum() > 50:
            d = D[m]
            sig[bins == bi] = max(1.4826 * np.median(np.abs(d - np.median(d))), 1e-4)
    return D, D / sig, A, B


def _shift_explained(
    A: np.ndarray, B: np.ndarray, win: np.ndarray, box: tuple, max_shift: int = 4
) -> float:
    """Fraction of the difference inside `win` that a pure shift of B (up to max_shift px) removes.
    Parallax and residual shake move edges; a light change cannot be shifted away."""
    x0, y0, x1, y1 = box
    m = max_shift + 1
    X0, Y0 = max(0, x0 - m), max(0, y0 - m)
    X1, Y1 = min(A.shape[1], x1 + m), min(A.shape[0], y1 + m)
    a = A[Y0:Y1, X0:X1]
    b = B[Y0:Y1, X0:X1]
    w = np.zeros(a.shape, bool)
    w[y0 - Y0 : y1 - Y0, x0 - X0 : x1 - X0] = win
    base = float(((a - b)[w] ** 2).sum())
    if base <= 0:
        return 0.0

    def cost(dx, dy):
        M = np.float32([[1, 0, dx], [0, 1, dy]])
        bs = cv2.warpAffine(
            b, M, (b.shape[1], b.shape[0]), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE
        )
        return float(((a - bs)[w] ** 2).sum())

    best = (base, 0.0, 0.0)
    for dy in range(-max_shift, max_shift + 1):
        for dx in range(-max_shift, max_shift + 1):
            c = cost(dx, dy)
            if c < best[0]:
                best = (c, dx, dy)
    _, bx, by = best
    for dy in (-0.5, 0, 0.5):
        for dx in (-0.5, 0, 0.5):
            c = cost(bx + dx, by + dy)
            if c < best[0]:
                best = (c, bx + dx, by + dy)
    return 1.0 - best[0] / base


def _components(D, Z, A, B, p: Params):
    """Filled regions of one sign that look like a light change, not a shake edge."""
    out = []
    # shake model: a residual misalignment by delta gives D ~ -grad(I) . delta
    Ms = cv2.GaussianBlur((A + B) / 2, (0, 0), 0.7)
    gx = cv2.Sobel(Ms, cv2.CV_32F, 1, 0, ksize=3) / 8
    gy = cv2.Sobel(Ms, cv2.CV_32F, 0, 1, ksize=3) / 8
    k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    k5 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    k9 = np.ones((9, 9), np.uint8)
    for sign in (1, -1):
        m = (sign * Z > p.z_thresh).astype(np.uint8)
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, k3)
        m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, k5)
        opp = -sign * Z > p.z_thresh
        n, lab, stats, cents = cv2.connectedComponentsWithStats(m, connectivity=8)
        for i in range(1, n):
            area = stats[i, cv2.CC_STAT_AREA]
            if area < p.min_area:
                continue
            x, y, w, h = stats[i, :4]
            x0, y0 = max(0, x - 6), max(0, y - 6)
            x1, y1 = min(D.shape[1], x + w + 6), min(D.shape[0], y + h + 6)
            cm = lab[y0:y1, x0:x1] == i
            dd = np.abs(D[y0:y1, x0:x1])
            energy = float(dd[cm].sum())
            thick = float(cv2.distanceTransform(cm.astype(np.uint8), cv2.DIST_L2, 3).max())
            win = cv2.dilate(cm.astype(np.uint8), k9) > 0
            ring = win & ~cm
            opp_e = float(dd[ring & opp[y0:y1, x0:x1]].sum())
            X = np.stack([-gx[y0:y1, x0:x1][win], -gy[y0:y1, x0:x1][win]], 1)
            yv = D[y0:y1, x0:x1][win]
            delta = np.linalg.lstsq(X, yv, rcond=None)[0]
            nd = float(np.hypot(*delta))
            if nd > 3.0:
                delta *= 3.0 / nd
            shake_r2 = float(1 - ((yv - X @ delta) ** 2).sum() / max((yv**2).sum(), 1e-12))
            mean_z = float(np.abs(Z[y0:y1, x0:x1][cm]).mean())
            opp_ratio = opp_e / max(energy, 1e-9)
            filled = thick >= 1.5 and shake_r2 < 0.5 and opp_ratio < 0.8 and mean_z >= p.min_mean_z
            shift_expl = 0.0
            if filled:
                shift_expl = _shift_explained(A, B, win, (x0, y0, x1, y1))
                filled = shift_expl < 0.6
            edge_score = max(0.0, shake_r2, shift_expl)
            out.append(
                dict(
                    sign=sign,
                    label=i,
                    lab=lab,
                    area=int(area),
                    energy=energy,
                    thick=thick,
                    opp=opp_ratio,
                    shake_r2=shake_r2,
                    delta=delta,
                    shift=shift_expl,
                    mean_z=mean_z,
                    edge=edge_score,
                    cent=cents[i],
                    filled=filled,
                )
            )
    return out


def _detect(D, Z, A, B, p: Params):
    comps = _components(D, Z, A, B, p)
    good = [c for c in comps if c["filled"] and c["mean_z"] >= p.min_mean_z]
    if not good:
        return None
    top = max(good, key=lambda c: c["energy"])
    keep = [
        c
        for c in good
        if c["sign"] == top["sign"]
        and c["energy"] >= 0.15 * top["energy"]
        and np.hypot(*(c["cent"] - top["cent"])) < 120
    ]
    U = np.zeros(D.shape, bool)
    for c in keep:
        U |= c["lab"] == c["label"]
    Ud = cv2.dilate(U.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    s = top["sign"]
    vals = s * D[Ud]
    peak = float(np.percentile(vals, 99))
    region = Ud & (s * D >= p.region_frac * peak)
    region = (
        cv2.morphologyEx(region.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8)) > 0
    )
    core = region & (s * D >= 0.5 * peak)
    wgt = np.where(core, s * D, 0.0)
    vv, uu = np.nonzero(core)
    tot = wgt[vv, uu].sum()
    if tot <= 0:
        return None
    cent = (float((uu * wgt[vv, uu]).sum() / tot), float((vv * wgt[vv, uu]).sum() / tot))
    snr = float(np.abs(Z[region]).mean())
    if snr < p.min_snr:
        return None
    return dict(
        region=region,
        sign=s,
        centroid=cent,
        snr=snr,
        edge=top["edge"],
        peak=peak,
        n_comp=len(keep),
    )


def _crossing(
    series: np.ndarray,
    times: np.ndarray,
    before_lvl: float,
    after_lvl: float,
    t_from: float,
    t_to: float = np.inf,
):
    half = (before_lvl + after_lvl) / 2
    s = np.sign(after_lvl - before_lvl)
    for k in range(1, len(series)):
        if times[k] < t_from:
            continue
        if times[k] > t_to:
            return None
        if s * (series[k] - half) > 0:
            a, b = series[k - 1], series[k]
            if s * (a - half) > 0 or b == a:
                return times[k]
            f = (half - a) / (b - a)
            return times[k - 1] + f * (times[k] - times[k - 1])
    return None


def _series(stack: _Stack, region: np.ndarray, idx: np.ndarray, D: np.ndarray) -> np.ndarray:
    w = np.abs(D) * region
    w = w / max(w.sum(), 1e-12)
    vv, uu = np.nonzero(region)
    ww = w[vv, uu]
    return np.array([(stack.N[k][vv, uu].astype(np.float32) * ww).sum() for k in idx])


def _sync_check(stack: _Stack, tm: np.ndarray, s_t: np.ndarray, o: float, p: Params) -> int:
    period = float(np.median(np.diff(s_t))) if len(s_t) > 1 else 0.4
    good, ref, prev_sign = 0, None, 0
    for st in s_t:
        a = st + o
        before = _windows(tm, a - 0.15, a + p.guard)
        after = _windows(tm, a + period - 0.15, a + period + p.guard)
        if not (len(before) and len(after)):
            continue
        det = _detect(*_difference(stack, before, after), p)
        if det is None:
            continue
        if ref is None:
            ref = det["region"]
        elif _overlap(ref, det["region"]) < 0.5 or det["sign"] == prev_sign:
            continue
        prev_sign = det["sign"]
        good += 1
    # the sync region must be still just before the first toggle (rules out a match that is one
    # toggle late, where the "fourth" toggle is really the sync light's own pass step)
    if ref is not None:
        a = s_t[0] + o
        before = _windows(tm, a - 0.55, a - 0.35)
        after = _windows(tm, a - 0.15, a + p.guard)
        if len(before) and len(after):
            det = _detect(*_difference(stack, before, after), p)
            if det is not None and _overlap(ref, det["region"]) >= 0.5:
                good -= 2
    return good


def _sync_crossings(stack: _Stack, tm: np.ndarray, s_t: np.ndarray, o: float, p: Params) -> list:
    """Times (video clock) at which the sync light's region crosses 50 % at each toggle, given a
    rough offset; the coarse offset can be ~0.15 s off, so retry with shifted windows."""
    period = float(np.median(np.diff(s_t))) if len(s_t) > 1 else 0.4

    def refine(o):
        before = _windows(tm, s_t[0] + o - p.win, s_t[0] + o)
        after = _windows(tm, s_t[0] + o + period - 0.15, s_t[0] + o + period)
        if not (len(before) and len(after)):
            return []
        D, Z, A, B = _difference(stack, before, after)
        det = _detect(D, Z, A, B, p)
        if det is None:
            return []
        idx = _windows(tm, s_t[0] + o - 0.4, s_t[-1] + o + period)
        ser = _series(stack, det["region"], idx, D)
        out = []
        lvl = float(np.median(_series(stack, det["region"], before, D)))
        for st in s_t:
            a = st + o
            w_after = _windows(tm, a + period - 0.15, a + period)
            if not len(w_after):
                continue
            after_lvl = float(np.median(_series(stack, det["region"], w_after, D)))
            c = _crossing(ser, tm[idx], lvl, after_lvl, a - 0.1, a + period)
            if c is not None:
                out.append(c - st)
            lvl = after_lvl
        return out

    offs: list = []
    for shift in (0.0, 0.1, -0.1, 0.2, -0.2):
        offs = refine(o + shift)
        if len(offs) >= len(s_t) - 1:
            break
    return offs


def _blink_search(stack, tm, s_t, p: Params, lo: float, hi: float):
    """Best offset for the blink in [lo, hi], verified region by region. (offset, check, score)"""
    e = _change_energy(stack)
    if hi <= lo:
        hi = lo + 1 / 60
    cands = np.arange(lo, hi, 1 / 60)
    score = np.zeros(len(cands))
    for i, cand in enumerate(cands):
        for st in s_t:
            k = _windows(tm, st + cand, st + cand + 0.35)
            score[i] += math.log(0.05 + (e[k].max() if len(k) else 0.0))
    # verify the best few peaks: the sync light must flip the same region with alternating sign
    order = np.argsort(-score)
    picked: list = []
    for i in order:
        if all(abs(cands[i] - cands[j]) > 0.1 for j in picked):
            picked.append(i)
        if len(picked) == 6:
            break
    best = None
    for i in picked:
        v = _sync_check(stack, tm, s_t, cands[i], p)
        key = (v, score[i])
        if best is None or key > best[0]:
            best = (key, cands[i])
    assert best is not None
    return float(best[1]), int(best[0][0])


def _sync_offset(stack: _Stack, tm: np.ndarray, s_t: np.ndarray, p: Params, handshake):
    """video = app + offset. Returns (offset, source, measured sync latency, debug).

    With the phone-clock handshake the offset is known: the blink only confirms it (within
    `handshake_tolerance`) and gives the sync light's latency. Without it (an uploaded recording),
    the offset comes from the blink: search the change energy for the pattern, then 50 % crossings
    of the sync light's own region minus its assumed latency."""
    if len(s_t) == 0:
        if handshake is None:
            return 0.0, "none", None, {"error": "no sync blink and no handshake"}
        return handshake, "handshake", None, {}
    if handshake is not None:
        tol = p.handshake_tolerance
        o, check = _blink_search(stack, tm, s_t, p, handshake - tol, handshake + tol)
        dbg = {"coarse": o, "check": check, "handshake": handshake}
        offs = _sync_crossings(stack, tm, s_t, handshake, p) if check >= 2 else []
        dbg["offs"] = offs
        if offs:
            lat = float(np.median(offs)) - handshake
            if p.min_latency <= lat <= tol + p.sync_latency:
                return handshake, "handshake", lat, dbg
        if check >= 3:
            dbg["note"] = "handshake disagrees with the blink; using the blink"
        else:
            dbg["note"] = "blink not confirmed; using the handshake"
            return handshake, "handshake", None, dbg
    # the app starts the sync blink within a few seconds of the reference
    lo = tm[min(p.lead_frames, len(tm) - 1)] - s_t[0]
    hi = min(tm[-1] - s_t[-1] - 1.0, lo + p.sync_search)
    o, check = _blink_search(stack, tm, s_t, p, lo, hi)
    dbg = {"coarse": o, "check": check, **({"handshake": handshake} if handshake else {})}
    offs = _sync_crossings(stack, tm, s_t, o, p)
    dbg["offs"] = offs
    if not offs:
        return o, "blink", None, dbg
    return float(np.median(offs)) - p.sync_latency, "blink", None, dbg


def analyze_station(
    name: str,
    frames,
    t_video: np.ndarray,
    motion: dict,
    commands: list[dict],
    inventory: list[dict],
    p: Params | None = None,
    handshake: float | None = None,
) -> StationResult:
    """Analyse one station. `frames`: RGB uint8 frames (an array, or any sequence that decodes on
    access); `t_video`: their timestamps (phone clock, s); `commands`: the command log (app clock);
    `handshake`: the phone-clock offset (phone = app + offset) if the phone measured it."""
    p = p or Params()
    cmds = sorted([c for c in commands if c["station"] == name], key=lambda c: c["t"])
    stack = frames if isinstance(frames, _Stack) else _Stack(frames, p)
    t_video = np.asarray(t_video, float)
    frame_mid = p.frame_mid if p.frame_mid is not None else 0.5 * float(np.median(np.diff(t_video)))
    tm = t_video + frame_mid  # mid-exposure times, video clock
    res = StationResult(name, stack.ref_rgb, size=(stack.w, stack.h))
    res.gains = stack.gain
    res.align_fail = int((~stack.align_ok).sum())
    res.align_resid = (
        float(np.median(stack.resid[stack.align_ok])) if stack.align_ok.any() else float("inf")
    )

    # ---- clock
    s_t = np.array([c["t"] for c in cmds if c["action"] == "sync"])
    offset, source, sync_lat, res.sync_debug = _sync_offset(stack, tm, s_t, p, handshake)
    res.clock_offset, res.clock_source, res.sync_latency = offset, source, sync_lat

    # ---- steps
    step_cmds = [c for c in cmds if c["action"] in ("invert", "revert")]
    all_t = [c["t"] for c in cmds]
    t_end_video = tm[-1]
    by_light: dict[str, list] = {}
    prev_det = None
    for c in step_cmds:
        a = c["t"] + offset
        later = [t for t in all_t if t > c["t"] + 1e-6]
        b = (later[0] + offset) if later else t_end_video
        before = _windows(tm, a - p.win, a + p.guard)
        after = _windows(tm, b - p.win, b + p.guard)
        info = dict(light=c["light"], action=c["action"], t=a, dur=b - a)
        rot, acc = motion_mod.jolt_score(motion, a - 0.1, b + 0.1)
        jolt = rot > motion_mod.ROT_THRESH or acc > motion_mod.ACC_THRESH
        win_idx = np.concatenate([before, after])
        unsteady = (
            bool((~stack.align_ok[win_idx]).any() or (stack.resid[win_idx] > 2.5).any())
            if len(win_idx)
            else True
        )
        info.update(jolt=jolt, rot=rot, acc=acc, unsteady=unsteady)
        lr = LightResult(c["light"], source="pass" if c["action"] == "invert" else "retake")
        lr.retake = jolt or unsteady
        det = None
        if len(before) and len(after):
            D, Z, A, B = _difference(stack, before, after)
            det = _detect(D, Z, A, B, p)
            if det is not None:
                lr.detected = True
                lr.region = det["region"]
                lr.centroid = det["centroid"]
                observed_rise = det["sign"] > 0
                lr.rise = observed_rise if c["action"] == "invert" else not observed_rise
                lr.snr = det["snr"]
                idx = _windows(tm, a - p.win - 0.1, b + p.guard)
                ser = _series(stack, det["region"], idx, D)
                bl = float(np.median(_series(stack, det["region"], before, D)))
                al = float(np.median(_series(stack, det["region"], after, D)))
                cross = _crossing(ser, tm[idx], bl, al, a - 0.1)
                lat_ok = cross is not None and p.min_latency <= cross - a <= (b - a) + p.guard
                # the tail of the previous light's change (slower than its step) is not this light
                if (
                    prev_det is not None
                    and det["sign"] == prev_det["sign"]
                    and _overlap(det["region"], prev_det["region"]) >= 0.5
                    and (cross is None or cross - a < 0.1)
                ):
                    lat_ok = False
                    lr.note = "leftover of the previous step"
                    info["leftover"] = True
                lr.latency = (cross - a) if cross is not None else None
                conf = min(1.0, max(0.0, (det["snr"] - 4.0) / 10.0)) * (1 - 0.5 * det["edge"])
                conf *= 1.0 if lat_ok else 0.05  # outside the latency window: not this light
                # a jolt spoils the step; frames that merely align worse than 2.5 px (common in
                # heavy shake) cost less: the shift test and the latency window still apply
                conf *= 0.3 if jolt else 0.6 if unsteady else 1.0
                lr.confidence = float(conf)
                info.update(snr=det["snr"], edge=det["edge"], area=int(det["region"].sum()))
        prev_det = det
        res.steps.append(info)
        by_light.setdefault(c["light"], []).append(lr)

    for inv in inventory:
        cands = by_light.get(inv["id"], [])
        if not cands:
            res.lights[inv["id"]] = LightResult(inv["id"], note="not flashed")
            continue
        pass_r = cands[0]
        chosen = pass_r
        retakes = [r for r in cands[1:] if not r.retake]
        if pass_r.retake and retakes:
            chosen = retakes[0]
            chosen.note = "pass step jolted; used retake"
            chosen.retake = True
        elif pass_r.retake:
            chosen.note = "jolted or unsteady, no retake"
        res.lights[inv["id"]] = chosen
        if not chosen.detected:
            chosen.note = chosen.note or "not visible from this station"

    # ---- restore check: after restore_all everything should match the reference
    rest = [c for c in cmds if c["action"] == "restore_all"]
    if rest:
        a = rest[0]["t"] + offset
        after = _windows(tm, a + 2.0, tm[-1])
        before = np.arange(min(p.lead_frames, stack.n))
        if len(after):
            D, Z, A, B = _difference(stack, before, after)
            comps = _components(D, Z, A, B, p)
            res.restore_residual = sum(
                1 for c in comps if c["filled"] and c["mean_z"] >= p.min_mean_z
            )
    res.groups = group_regions(res, p)
    return res


# -------------------------------------------------------------------------------- grouping
def _overlap(a: np.ndarray, b: np.ndarray) -> float:
    inter = np.logical_and(a, b).sum()
    return float(inter / max(1, min(a.sum(), b.sum())))


def _bbox(m: np.ndarray):
    vv, uu = np.nonzero(m)
    return uu.min(), uu.max(), vv.min(), vv.max()


def _side_by_side(a: np.ndarray, b: np.ndarray) -> bool:
    if _overlap(a, b) >= 0.6:
        return False
    sa, sb = a.sum(), b.sum()
    if max(sa, sb) > 2.0 * min(sa, sb):
        return False
    da = cv2.dilate(a.astype(np.uint8), np.ones((7, 7), np.uint8)) > 0
    if not np.logical_and(da, b).any():
        return False
    ax0, ax1, ay0, ay1 = _bbox(a)
    bx0, bx1, by0, by1 = _bbox(b)
    vo = (min(ay1, by1) - max(ay0, by0)) / max(1, min(ay1 - ay0, by1 - by0))
    ho = (min(ax1, bx1) - max(ax0, bx0)) / max(1, min(ax1 - ax0, bx1 - bx0))
    if max(vo, ho) < 0.6:
        return False
    # segments share a long boundary (one lit area split up), not just a touching point
    k5 = np.ones((5, 5), np.uint8)
    contact = (
        np.logical_and(cv2.dilate(a.astype(np.uint8), k5), cv2.dilate(b.astype(np.uint8), k5)).sum()
        / 5.0
    )
    extent = min(ay1 - ay0, by1 - by0) if vo >= ho else min(ax1 - ax0, bx1 - bx0)
    if contact < 0.5 * extent:
        return False
    # and together they fill a rectangle-like area (a window, a strip), unlike two touching blobs
    u = np.logical_or(a, b)
    pts = np.argwhere(u)[:, ::-1].astype(np.float32)
    (_, _), (rw, rh), _ = cv2.minAreaRect(pts)
    return u.sum() / max(1.0, (rw + 1) * (rh + 1)) >= 0.75


class _UF:
    def __init__(self):
        self.p: dict = {}

    def find(self, x):
        self.p.setdefault(x, x)
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        self.p[self.find(a)] = self.find(b)


def group_regions(res: StationResult, p: Params) -> dict:
    ids = list(res.detected(p.min_conf))
    pairs_single, pairs_seg = set(), set()
    for i, a in enumerate(ids):
        for b in ids[i + 1 :]:
            ra, rb = res.lights[a].region, res.lights[b].region
            if _overlap(ra, rb) >= 0.6:
                pairs_single.add((a, b))
            elif _side_by_side(ra, rb):
                pairs_seg.add((a, b))
    return {"single": pairs_single, "segments": pairs_seg}


def merge_groups(results: list[StationResult]) -> list[dict]:
    """Elements across stations: 'single' if regions overlap wherever both are seen,
    'segments' if side by side in at least half the stations where both are seen."""
    ids = sorted({k for r in results for k in r.detected()})

    def both(a, b):
        return [r for r in results if a in r.detected() and b in r.detected()]

    def has(pairs, a, b):
        return (a, b) in pairs or (b, a) in pairs

    uf_single, uf_seg = _UF(), _UF()
    for i, a in enumerate(ids):
        for b in ids[i + 1 :]:
            rs = both(a, b)
            if not rs:
                continue
            n_single = sum(1 for r in rs if has(r.groups["single"], a, b))
            n_seg = sum(1 for r in rs if has(r.groups["segments"], a, b))
            if n_single == len(rs):
                uf_single.union(a, b)
            elif n_seg + n_single >= len(rs) / 2 and n_seg > 0:
                uf_seg.union(a, b)
    elements = []
    single_sets: dict = {}
    for k in ids:
        single_sets.setdefault(uf_single.find(k), []).append(k)
    # a 'single' element is the unit inside a segments group
    unit_of = {k: uf_single.find(k) for k in ids}
    seg_sets: dict = {}
    for k in ids:
        seg_sets.setdefault(uf_seg.find(k), set()).add(unit_of[k])
    seen_units: set = set()
    if not results:
        return []
    ref = max(results, key=lambda r: len(r.detected()))
    for units in seg_sets.values():
        units = sorted(units)
        if len(units) >= 2:

            def key(u):
                cs = [ref.lights[m].centroid for m in single_sets[u] if m in ref.detected()]
                cs = cs or [
                    r.lights[m].centroid
                    for r in results
                    for m in single_sets[u]
                    if m in r.detected()
                ]
                return np.mean(cs, axis=0)[0]

            units.sort(key=key)
            elements.append({"mode": "segments", "segments": [single_sets[u] for u in units]})
            seen_units.update(units)
    for u, members in single_sets.items():
        if u not in seen_units:
            elements.append({"mode": "single", "lights": members})
    return elements


# ----------------------------------------------------------------------------- 3D geometry
def _K(f, w, h):
    return np.array([[f, 0, (w - 1) / 2], [0, f, (h - 1) / 2], [0, 0, 1.0]])


def _triangulate(obs: list, Ks, Rs, ts) -> np.ndarray:
    A = []
    for s, uv in obs:
        P = Ks[s] @ np.hstack([Rs[s], ts[s].reshape(3, 1)])
        A.append(uv[0] * P[2] - P[0])
        A.append(uv[1] * P[2] - P[1])
    _, _, Vt = np.linalg.svd(np.array(A))
    X = Vt[-1]
    return X[:3] / X[3]


@dataclass
class Solution:
    f: float
    R: dict  # station -> world(=first station camera) to camera rotation
    t: dict  # station -> translation
    points: dict  # light -> 3D point (first station camera frame)
    method: dict  # light -> 'triangulated' | 'single-station' | 'inconsistent' | 'none'
    rays: dict  # light -> (origin, direction) for single-station lights
    reproj_rms: float
    scale_known: bool
    n_obs: dict
    size: tuple = (640, 360)
    note: str = ""

    def centre(self, s):
        return -self.R[s].T @ self.t[s]


def solve_3d(
    results: list[StationResult],
    size=(640, 360),
    p: Params | None = None,
    known_distance: tuple | None = None,
) -> Solution:
    p = p or Params()
    w, h = size
    f0 = (w / 2) / math.tan(math.radians(p.hfov_guess) / 2)
    K0 = _K(f0, w, h)
    names = [r.name for r in results]
    ref = names[0]
    obs = {
        r.name: {k: np.array(r.lights[k].centroid) for k in r.detected(p.min_conf)} for r in results
    }
    R = {ref: np.eye(3)}
    t = {ref: np.zeros(3)}
    pts: dict = {}
    note = []
    for s in names[1:]:
        common = sorted(set(obs[ref]) & set(obs[s]))
        known = [k for k in common if k in pts]
        if len(known) >= 6:
            X = np.array([pts[k] for k in known])
            x = np.array([obs[s][k] for k in known])
            ok, rv, tv, inl = cv2.solvePnPRansac(
                X, x, K0, None, reprojectionError=4.0, flags=cv2.SOLVEPNP_ITERATIVE
            )
            if ok:
                R[s], t[s] = cv2.Rodrigues(rv)[0], tv.ravel()
        if s not in R:
            if len(common) < 6:
                note.append(f"{s}: only {len(common)} lights shared with {ref}")
                continue
            x0 = np.array([obs[ref][k] for k in common])
            x1 = np.array([obs[s][k] for k in common])
            E, m = cv2.findEssentialMat(x0, x1, K0, cv2.RANSAC, 0.999, 3.0)
            if E is None:
                continue
            E = E[:3]
            _, Rr, tr, _ = cv2.recoverPose(E, x0, x1, K0, mask=m.copy())
            R[s], t[s] = Rr, tr.ravel()
            if pts:  # fix scale against already-triangulated points
                sh = [k for k in common if k in pts]
                if sh:
                    Ks = {ref: K0, s: K0}
                    ratios = []
                    for k in sh:
                        Xn = _triangulate([(ref, obs[ref][k]), (s, obs[s][k])], Ks, R, t)
                        if Xn[2] > 0:
                            ratios.append(np.linalg.norm(pts[k]) / max(np.linalg.norm(Xn), 1e-9))
                    if ratios:
                        t[s] = t[s] * float(np.median(ratios))
        Ks = {k: K0 for k in R}
        for k in common:
            if k not in pts and s in R:
                pts[k] = _triangulate([(ref, obs[ref][k]), (s, obs[s][k])], Ks, R, t)
    solved = [s for s in names if s in R]
    Ks = {k: K0 for k in solved}
    for k in sorted({k for s in solved for k in obs[s]}):
        views = [(s, obs[s][k]) for s in solved if k in obs[s]]
        if len(views) >= 2 and k not in pts:
            pts[k] = _triangulate(views, Ks, R, t)

    # ---- bundle adjustment: focal, poses of non-reference stations, points
    def run_ba(pts, R, t, f, obs_list):
        lids = sorted(pts)
        cams = [s for s in solved if s != ref]
        li = {k: i for i, k in enumerate(lids)}
        ci = {s: i for i, s in enumerate(cams)}
        x0 = [f]
        for s in cams:
            x0 += list(cv2.Rodrigues(R[s])[0].ravel()) + list(t[s])
        for k in lids:
            x0 += list(pts[k])
        x0 = np.array(x0, float)
        ob = [(s, k, uv) for (s, k, uv) in obs_list if k in li]
        cx, cy = (w - 1) / 2, (h - 1) / 2
        gauge_cam = cams[0] if cams else None
        gnorm = np.linalg.norm(t[gauge_cam]) if gauge_cam else 1.0
        o_cam = np.array([ci[s] if s != ref else -1 for s, _, _ in ob])
        o_pt = np.array([li[k] for _, k, _ in ob])
        o_uv = np.array([uv for _, _, uv in ob], float).reshape(-1, 2)

        def unpack(x):
            fx = x[0]
            Rs, ts = {ref: np.eye(3)}, {ref: np.zeros(3)}
            for s in cams:
                o = 1 + 6 * ci[s]
                Rs[s] = cv2.Rodrigues(np.asarray(x[o : o + 3], float))[0]
                ts[s] = x[o + 3 : o + 6]
            P = x[1 + 6 * len(cams) :].reshape(-1, 3)
            return fx, Rs, ts, P

        def resid(x):
            fx, Rs, ts, P = unpack(x)
            Xc = np.empty((len(ob), 3))
            for s in [ref, *cams]:
                sel = o_cam == (ci[s] if s != ref else -1)
                if sel.any():
                    Xc[sel] = P[o_pt[sel]] @ Rs[s].T + ts[s]
            z = np.where(np.abs(Xc[:, 2]) > 1e-6, Xc[:, 2], 1e-6)
            r = np.empty((len(ob), 2))
            r[:, 0] = fx * Xc[:, 0] / z + cx - o_uv[:, 0]
            r[:, 1] = fx * Xc[:, 1] / z + cy - o_uv[:, 1]
            extra = []
            if gauge_cam:
                extra.append(100.0 * (np.linalg.norm(ts[gauge_cam]) - gnorm))
            extra.append((fx - f0) / (0.3 * f0))
            return np.concatenate([r.ravel(), extra])

        xs = lm.least_squares(resid, x0, loss="soft_l1", f_scale=1.5, max_iter=200)
        fx, Rs, ts, P = unpack(xs)
        rr = resid(xs)[: 2 * len(ob)].reshape(-1, 2)
        errs = np.linalg.norm(rr, axis=1)
        return (
            fx,
            Rs,
            ts,
            {k: P[li[k]] for k in lids},
            [(o[0], o[1], e) for o, e in zip(ob, errs, strict=True)],
        )

    obs_list = [(s, k, obs[s][k]) for s in solved for k in obs[s] if k in pts]
    inconsistent: set = set()
    f = f0
    rms = float("nan")
    if len(solved) >= 2 and pts:
        f, R, t, pts, errs = run_ba(pts, R, t, f0, obs_list)
        # drop gross outliers (a wrong detection or a mis-measured centroid) and re-run. With three
        # views the worst observation goes; with two, the rays disagree and the point is not placed.
        for _ in range(3):
            bad = {(s, k) for s, k, e in errs if e > p.max_reproj}
            if not bad:
                break
            cnt: dict = {}
            for _s, k, _ in obs_list:
                cnt[k] = cnt.get(k, 0) + 1
            worst: dict = {}
            for s, k, e in errs:
                if (s, k) in bad and e > worst.get(k, (None, 0))[1]:
                    worst[k] = (s, e)
            keep = []
            for s, k, uv in obs_list:
                if k in worst and (cnt[k] <= 2 or worst[k][0] == s):
                    continue
                keep.append((s, k, uv))
            for k in worst:
                if cnt[k] <= 2:
                    pts.pop(k, None)
                    inconsistent.add(k)
                    note.append(f"{k}: views disagree, not placed")
            obs_list = keep
            if not pts:
                break
            f, R, t, pts, errs = run_ba(pts, R, t, f, obs_list)
        rms = float(np.sqrt(np.mean([e * e for _, _, e in errs]))) if errs else float("nan")
    n_obs: dict = {}
    for _, k, _ in obs_list:
        n_obs[k] = n_obs.get(k, 0) + 1
    method, rays = {}, {}
    all_ids = sorted({k for s in names for k in obs[s]})
    Kf = _K(f, w, h)
    for k in all_ids:
        if k in pts and n_obs.get(k, 0) >= 2:
            method[k] = "triangulated"
        elif k in inconsistent:
            method[k] = "inconsistent"
        else:
            pts.pop(k, None)
            views = [s for s in solved if k in obs[s]]
            if views:
                s = views[0]
                d = R[s].T @ np.linalg.inv(Kf) @ np.array([*obs[s][k], 1.0])
                rays[k] = (-R[s].T @ t[s], d / np.linalg.norm(d))
                method[k] = "single-station"
            else:
                method[k] = "none"
    scale_known = False
    if known_distance and known_distance[0] in pts and known_distance[1] in pts:
        d = np.linalg.norm(pts[known_distance[0]] - pts[known_distance[1]])
        sc = known_distance[2] / d
        pts = {k: v * sc for k, v in pts.items()}
        t = {k: v * sc for k, v in t.items()}
        rays = {k: (o * sc, d_) for k, (o, d_) in rays.items()}
        scale_known = True
    return Solution(f, R, t, pts, method, rays, rms, scale_known, n_obs, (w, h), "; ".join(note))
