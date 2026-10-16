"""Motion-sensor (DeviceMotionEvent-style) helpers shared by the capture controller and analysis.

A sample stream is a dict of arrays:
    t        (N,)   seconds, phone/video clock
    rot_rate (N,3)  deg/s about the device axes
    acc      (N,3)  m/s^2, gravity removed
"""
from __future__ import annotations

import numpy as np

ROT_THRESH = 45.0   # deg/s, smoothed magnitude
ACC_THRESH = 4.0    # m/s^2, smoothed magnitude
SMOOTH_S = 0.05


def _smoothed(t: np.ndarray, x: np.ndarray, win: float = SMOOTH_S) -> np.ndarray:
    mag = np.linalg.norm(x, axis=1)
    if len(t) < 2:
        return mag
    dt = float(np.median(np.diff(t)))
    n = max(1, int(round(win / dt)))
    k = np.ones(n) / n
    return np.convolve(mag, k, mode="same")


def jolt_score(motion: dict, t0: float, t1: float) -> tuple[float, float]:
    """Peak smoothed rotation rate (deg/s) and acceleration (m/s^2) in [t0, t1]."""
    t = motion["t"]
    m = (t >= t0) & (t <= t1)
    if not m.any():
        return 0.0, 0.0
    rot = _smoothed(t, motion["rot_rate"])[m]
    acc = _smoothed(t, motion["acc"])[m]
    return float(rot.max()), float(acc.max())


def is_jolt(motion: dict, t0: float, t1: float,
            rot_thresh: float = ROT_THRESH, acc_thresh: float = ACC_THRESH) -> bool:
    rot, acc = jolt_score(motion, t0, t1)
    return rot > rot_thresh or acc > acc_thresh
