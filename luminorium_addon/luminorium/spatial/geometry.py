"""Picture and plane geometry for views (normalised picture coordinates throughout)."""

from __future__ import annotations

import math

import cv2
import numpy as np

UNIT_SQUARE = np.float32([[0, 0], [1, 0], [1, 1], [0, 1]])


def plane_homography(points: list, size: list | None = None) -> np.ndarray:
    """Picture → plane. The plane's corners (top-left, top-right, bottom-right, bottom-left) map
    to (0,0), (w,0), (w,h), (0,h): metres if the size is known, else 0-1."""
    w, h = size if size else (1.0, 1.0)
    dst = UNIT_SQUARE * np.float32([w, h])
    return cv2.getPerspectiveTransform(np.float32(points), dst)


def picture_to_plane(points: list, size: list | None, pt: list) -> tuple[float, float]:
    H = plane_homography(points, size)
    u, v = cv2.perspectiveTransform(np.float32([[pt]]), H)[0, 0]
    return float(u), float(v)


def point_in_polygon(pt: list, polygon: list) -> bool:
    if len(polygon) < 3:
        return False
    return cv2.pointPolygonTest(np.float32(polygon), (float(pt[0]), float(pt[1])), False) >= 0


def polygon_centroid(polygon: list) -> list[float]:
    p = np.asarray(polygon, float)
    if len(p) < 3:
        return [round(float(v), 5) for v in p.mean(0)]
    m = cv2.moments(np.float32(p))
    if abs(m["m00"]) < 1e-12:
        return [round(float(v), 5) for v in p.mean(0)]
    return [round(m["m10"] / m["m00"], 5), round(m["m01"] / m["m00"], 5)]


def circle(centre: list, radius: float = 0.02, n: int = 12) -> list[list[float]]:
    cx, cy = centre
    return [
        [
            round(min(1, max(0, cx + radius * math.cos(2 * math.pi * k / n))), 5),
            round(min(1, max(0, cy + radius * math.sin(2 * math.pi * k / n))), 5),
        ]
        for k in range(n)
    ]


def hull(points: list) -> list[list[float]]:
    """Convex hull of a set of points (used when elements are merged)."""
    p = np.float32(points).reshape(-1, 1, 2)
    if len(p) < 3:
        return [[round(float(x), 5), round(float(y), 5)] for x, y in p.reshape(-1, 2)]
    return [[round(float(x), 5), round(float(y), 5)] for x, y in cv2.convexHull(p).reshape(-1, 2)]


def along_line(line: list, n: int) -> list[list[float]]:
    """n points spread evenly along a line, each at the centre of its share."""
    (x0, y0), (x1, y1) = line
    return [
        [round(x0 + (x1 - x0) * (k + 0.5) / n, 5), round(y0 + (y1 - y0) * (k + 0.5) / n, 5)]
        for k in range(n)
    ]


def project_on_line(line: list, pt: list) -> float:
    """Where a point falls along a line (0 at its start, 1 at its end)."""
    a, b, p = (np.asarray(v, float) for v in (line[0], line[1], pt))
    d = b - a
    return float((p - a) @ d / max(d @ d, 1e-12))


def mask_polygon(mask: np.ndarray, max_points: int = 40) -> list[list[float]]:
    """Outline of a region mask, normalised to the mask's size."""
    h, w = mask.shape
    cnts, _ = cv2.findContours(mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not cnts:
        return []
    c = max(cnts, key=cv2.contourArea)
    eps = 0.5
    approx = c
    while len(approx) > max_points:
        approx = cv2.approxPolyDP(c, eps, True)
        eps *= 1.5
    pts = approx.reshape(-1, 2).astype(float)
    # pixel centres → normalised; a pixel spans [x, x + 1)
    return [[round((x + 0.5) / w, 5), round((y + 0.5) / h, 5)] for x, y in pts]


def register(old_img: np.ndarray, new_img: np.ndarray) -> np.ndarray | None:
    """Homography from old picture to new picture, normalised coordinates, or None when the two
    pictures can't be matched (ORB features + RANSAC)."""

    def gray(img):
        g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
        scale = 1024 / max(g.shape)
        if scale < 1:
            g = cv2.resize(g, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
        return cv2.createCLAHE(2.0, (8, 8)).apply(g)

    a, b = gray(old_img), gray(new_img)
    orb = cv2.ORB_create(3000)
    ka, da = orb.detectAndCompute(a, None)
    kb, db = orb.detectAndCompute(b, None)
    if da is None or db is None or len(ka) < 20 or len(kb) < 20:
        return None
    matches = cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da, db, k=2)
    good = [m[0] for m in matches if len(m) == 2 and m[0].distance < 0.75 * m[1].distance]
    if len(good) < 20:
        return None
    pa = np.float32([ka[m.queryIdx].pt for m in good]) / np.float32([a.shape[1], a.shape[0]])
    pb = np.float32([kb[m.trainIdx].pt for m in good]) / np.float32([b.shape[1], b.shape[0]])
    H, inl = cv2.findHomography(pa, pb, cv2.RANSAC, 0.005)
    if H is None or inl is None or inl.sum() < 15:
        return None
    return H


def transform_points(H: np.ndarray, points: list) -> list[list[float]]:
    if not points:
        return []
    out = cv2.perspectiveTransform(np.float32(points).reshape(-1, 1, 2), H).reshape(-1, 2)
    return [[round(float(x), 5), round(float(y), 5)] for x, y in out]


def camera_from_plane(
    points: list, size: list, focal_px: float, img_size: tuple[int, int]
) -> tuple[np.ndarray, np.ndarray] | None:
    """Pose of a camera relative to a plane rectangle of known size: (R, t) with
    X_cam = R @ X_plane + t, plane coordinates (u across, v down the rectangle, 0 on the plane) in
    metres. None if it can't be solved."""
    w, h = img_size
    K = np.array([[focal_px, 0, (w - 1) / 2], [0, focal_px, (h - 1) / 2], [0, 0, 1.0]])
    obj = np.float32([[0, 0, 0], [size[0], 0, 0], [size[0], size[1], 0], [0, size[1], 0]])
    img = np.float32(points) * np.float32([w, h]) - 0.5
    ok, rv, tv = cv2.solvePnP(obj, img, K, None, flags=cv2.SOLVEPNP_IPPE)
    if not ok:
        return None
    return cv2.Rodrigues(rv)[0], tv.ravel()


def ray_plane(origin: np.ndarray, direction: np.ndarray, R: np.ndarray, t: np.ndarray):
    """Where a camera-frame ray meets the plane z_plane = 0 (pose from camera_from_plane), as a
    camera-frame point, or None if it misses (parallel, or behind)."""
    n = R[:, 2]  # plane normal in the camera frame
    p0 = t  # a point on the plane (its origin), camera frame
    denom = float(n @ direction)
    if abs(denom) < 1e-9:
        return None
    s = float(n @ (p0 - origin)) / denom
    if s <= 0:
        return None
    return origin + s * direction
