"""Live step detection for adaptive step advance (DESIGN.md section 8, step 3).

During a pass step, every new frame is compared with the settled frames just before the command:
a cheap version of the offline analysis at half resolution. Frames are aligned to that baseline
with the analysis's rotation + scale model; changes are z-scored per brightness bin after removing
each bin's median change (that follows auto-exposure, the noise floor and the phone's tone
curve); candidate blobs must be filled and must not be explained by a small shift (parallax and
residual shake). The step can advance once a change has been seen and has stopped changing for a
few frames. Only the timing depends on this; the offline analysis decides what each light is.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

import cv2
import numpy as np

from .analysis import LUT, Aligner, _shift_explained, _warp

SIZE = (320, 180)
Z_THRESH = 5.0
MIN_AREA = 6  # px at SIZE
MIN_MEAN_Z = 8.0  # to lock onto a change, and to call it settled
LOST_Z = 6.0  # a locked change this weak over three frames was noise or texture: look again
MAX_SHIFT_EXPLAINED = 0.6
SETTLE_FRAMES = 5  # frames without a trend before a step counts as settled (~0.33 s at 15 fps)
SETTLE_TOL = 0.08  # relative drift allowed over them
NOISE_BINS = 8
CLIP = 235  # 8-bit: near-saturated pixels don't follow the exposure
QUIET_BEFORE = 0.35  # a region varying this much (of the change) before the command is busy
LEFTOVER_S = 0.5  # a change where the last step's was, this soon: the last light finishing
BORDER = 8  # px at SIZE: warping and interpolation make the frame edge unreliable
# px at SIZE: two frames aligned worse than this make the step unsteady (it gets a retake).
# Stricter (the analysis's 2.5 px at full size) retook many steps under heavy shake, and each
# extra step is another chance to pick up parallax.
MAX_RESID = 2.0


@dataclass
class StepStatus:
    changed: bool = False
    settled: bool = False
    unsteady: bool = False
    frames: int = 0  # frames seen since the command
    bad_frames: int = 0  # frames that couldn't be aligned
    first_change: float | None = None  # phone time of the first frame showing the change
    last_frame: float | None = None  # phone time of the newest frame
    signal: list = field(default_factory=list)


def prepare(img: np.ndarray) -> np.ndarray:
    """A frame as half-resolution 8-bit gray."""
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    if gray.shape[1] != SIZE[0] or gray.shape[0] != SIZE[1]:
        gray = cv2.resize(gray, SIZE, interpolation=cv2.INTER_AREA)
    return gray


class LiveDetector:
    def __init__(self, keep_s: float = 3.0):
        self.frames: deque = deque()  # (t_phone, gray)
        self.keep_s = keep_s
        self.status = StepStatus()
        self._t_cmd: float | None = None
        self._aligner: Aligner | None = None
        self._base: np.ndarray | None = None  # linear
        self._base_clip: np.ndarray | None = None
        self._bins: np.ndarray | None = None
        self._mask: np.ndarray | None = None
        self._sign = 0
        self._peak = 0.0
        self._min_latency = 0.03
        self._previous: np.ndarray | None = None  # the last step's change
        self._before: list = []  # the frames the baseline came from (linear)
        self._gx: np.ndarray | None = None
        self._gy: np.ndarray | None = None

    # ---- frames ---------------------------------------------------------------------------

    def add(self, t_phone: float, img: np.ndarray) -> None:
        gray = prepare(img)
        self.frames.append((t_phone, gray))
        while self.frames and self.frames[0][0] < t_phone - self.keep_s:
            self.frames.popleft()
        if self._t_cmd is not None:
            self._update(t_phone, gray)

    @property
    def last_t(self) -> float | None:
        return self.frames[-1][0] if self.frames else None

    # ---- steps ----------------------------------------------------------------------------

    def begin(self, t_cmd_phone: float, min_latency: float = 0.03) -> None:
        """A command went out at this phone time: compare from here on."""
        self._t_cmd = t_cmd_phone
        self._min_latency = min_latency
        self.status = StepStatus()
        self._mask, self._sign, self._peak = None, 0, 0.0
        self._aligner = None
        before = [g for t, g in self.frames if t_cmd_phone - 0.3 <= t <= t_cmd_phone + 0.05]
        if not before:
            before = [g for _, g in list(self.frames)[-3:]]
        self._before = [LUT[g] for g in before]
        if before:
            self._set_base(np.median(np.stack(before), axis=0).astype(np.uint8))
        for t, g in list(self.frames):
            if t > t_cmd_phone + 0.05:
                self._update(t, g)

    def end(self) -> StepStatus:
        status = self.status
        self._previous = self._mask
        self._t_cmd = None
        self._aligner = None
        return status

    def _set_base(self, gray: np.ndarray) -> None:
        clip = cv2.dilate((gray >= CLIP).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
        self._aligner = Aligner(gray, exclude=clip)
        self._base = LUT[gray]
        self._base_clip = clip
        edges = np.quantile(self._base, np.linspace(0, 1, NOISE_BINS + 1))
        self._bins = np.clip(
            np.searchsorted(edges, self._base, side="right") - 1, 0, NOISE_BINS - 1
        )
        smooth = cv2.GaussianBlur(self._base, (0, 0), 0.7)
        self._gx = cv2.Sobel(smooth, cv2.CV_32F, 1, 0, ksize=3) / 8
        self._gy = cv2.Sobel(smooth, cv2.CV_32F, 0, 1, ksize=3) / 8

    def _normalise(self, D: np.ndarray, ok: np.ndarray) -> np.ndarray:
        """z-scores per brightness bin, after removing each bin's median change (in place in D).
        A global gain can't normalise everything: dark pixels sit on the noise floor and 8-bit
        steps, and a phone's tone curve isn't linear. Per-bin medians follow any of that; a light
        changes only a small part of each bin."""
        assert self._bins is not None
        Z = np.zeros(D.shape, np.float32)
        for b in range(NOISE_BINS):
            m = (self._bins == b) & ok
            if m.sum() > 50:
                d = D[m]
                med = float(np.median(d))
                sig = max(1.4826 * float(np.median(np.abs(d - med))), 1e-5)
                D[m] = d - med
                Z[m] = (d - med) / sig
        D[~ok] = 0  # clipped, outside the frame or at its edge: never a change
        return Z

    def _update(self, t: float, gray: np.ndarray) -> None:
        st = self.status
        st.last_frame = t
        if self._aligner is None:
            self._set_base(gray)
            return
        assert self._t_cmd is not None and self._base is not None
        if t < self._t_cmd + self._min_latency:
            return
        st.frames += 1
        H, info = self._aligner.align(gray)
        if not info["ok"]:
            st.bad_frames += 1
            st.unsteady = True
            return
        if info["resid"] > MAX_RESID:
            st.bad_frames += 1
            if st.bad_frames >= 2:
                st.unsteady = True
        cur = _warp(LUT[gray], H)
        valid = _warp(np.ones(gray.shape, np.uint8), H)
        valid = cv2.erode(valid, np.ones((5, 5), np.uint8)) > 0
        clip = _warp((gray >= CLIP).astype(np.uint8), H) > 0
        clip = cv2.dilate((clip | self._base_clip).astype(np.uint8), np.ones((3, 3), np.uint8)) > 0
        ok = valid & ~clip
        b = BORDER
        ok[:b], ok[-b:], ok[:, :b], ok[:, -b:] = False, False, False, False
        D = cur - self._base
        Z = self._normalise(D, ok)
        if self._mask is None:
            self._find_change(t, D, Z, cur)
            if self._mask is None:
                return
        value = self._sign * float(D[self._mask].mean())
        zmean = self._sign * float(Z[self._mask].mean())
        st.signal.append((t, value, zmean))
        if len(st.signal) >= 3 and np.median([z for _, _, z in st.signal[-3:]]) < LOST_Z:
            # what we locked onto went away (shake, a flicker): look again
            self._mask, self._sign, self._peak = None, 0, 0.0
            st.changed, st.settled, st.first_change, st.signal = False, False, None, []
            return
        vals = [v for _, v, _ in st.signal[-3:]]
        self._peak = max(self._peak, float(np.median(vals)))  # a noisy blob's max overshoots
        st.settled = self._flat(st.signal[-SETTLE_FRAMES:])

    def _flat(self, recent: list) -> bool:
        """The change has stopped: no trend over the last frames beyond the noise, near the
        peak, and still clearly there."""
        if len(recent) < SETTLE_FRAMES:
            return False
        t = np.array([r[0] for r in recent])
        v = np.array([r[1] for r in recent])
        z = np.array([r[2] for r in recent])
        tc = t - t.mean()
        denom = float((tc * tc).sum())
        if denom <= 0:
            return False
        slope = float((tc * (v - v.mean())).sum() / denom)
        resid = v - v.mean() - slope * tc
        se = float(np.sqrt((resid * resid).sum() / max(len(v) - 2, 1) / denom))
        drift = abs(slope) * float(t[-1] - t[0])
        flat = drift <= SETTLE_TOL * abs(float(v.mean())) or abs(slope) <= 2 * se
        return bool(
            flat and float(v.mean()) >= 0.6 * self._peak and float(np.median(z)) >= MIN_MEAN_Z
        )

    def _busy_before(self, region: np.ndarray, change: float) -> bool:
        """A light only starts changing after its command. A region that moved about in the
        frames just before it (the last light finishing, parallax, a passing car) is not this
        light, even if it is still changing now."""
        if len(self._before) < 2 or change <= 0:
            return False
        means = [float(f[region].mean()) for f in self._before]
        return max(means) - min(means) > QUIET_BEFORE * change

    def _moved(self, cur: np.ndarray, win: np.ndarray, box: tuple) -> bool:
        """Is the difference in this window explained by the picture moving? Two tests, as in
        the analysis: a linear sub-pixel model (D = -grad(I) . delta, for shifts well under a
        pixel: half resolution makes parallax tiny) and a search over shifts up to 2 px."""
        assert self._base is not None
        x0, y0, x1, y1 = box
        d = (cur - self._base)[y0:y1, x0:x1][win]
        X = np.stack([-self._gx[y0:y1, x0:x1][win], -self._gy[y0:y1, x0:x1][win]], 1)
        delta = np.linalg.lstsq(X, d, rcond=None)[0]
        n = float(np.hypot(*delta))
        if n > 1.5:
            delta *= 1.5 / n
        r2 = 1 - float(((d - X @ delta) ** 2).sum()) / max(float((d * d).sum()), 1e-12)
        if r2 >= 0.5:
            return True
        return _shift_explained(cur, self._base, win, box, 2) >= MAX_SHIFT_EXPLAINED

    def _find_change(self, t: float, D: np.ndarray, Z: np.ndarray, cur: np.ndarray) -> None:
        assert self._base is not None
        k3 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
        k7 = np.ones((7, 7), np.uint8)
        cands = []
        for sign in (1, -1):
            m = cv2.morphologyEx((sign * Z > Z_THRESH).astype(np.uint8), cv2.MORPH_OPEN, k3)
            n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
            for i in range(1, n):
                if stats[i, cv2.CC_STAT_AREA] < MIN_AREA:
                    continue
                cm = lab == i
                zmean = float(sign * Z[cm].mean())
                if zmean < MIN_MEAN_Z:
                    continue
                cands.append((float(sign * D[cm].sum()), sign, cm, stats[i, :4]))
        early = self._t_cmd is not None and t < self._t_cmd + LEFTOVER_S
        for _energy, sign, cm, (x, y, w, h) in sorted(cands, key=lambda c: -c[0])[:4]:
            prev = self._previous
            if early and prev is not None and (cm & prev).sum() >= 0.5 * min(cm.sum(), prev.sum()):
                continue  # the previous light still finishing its change, not this one
            x0, y0 = max(0, x - 4), max(0, y - 4)
            x1, y1 = min(SIZE[0], x + w + 4), min(SIZE[1], y + h + 4)
            win = cv2.dilate(cm[y0:y1, x0:x1].astype(np.uint8), k7) > 0
            if self._busy_before(cm, sign * float(D[cm].mean())):
                continue  # this region was already changing before the command
            if self._moved(cur, win, (x0, y0, x1, y1)):
                continue  # parallax or shake: texture or an edge that moved, not a light
            self._mask = cv2.dilate(cm.astype(np.uint8), k3) > 0
            self._sign = sign
            self.status.changed = True
            self.status.first_change = t
            return
