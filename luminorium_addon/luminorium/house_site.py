"""The top view of the house map: a satellite (or drone) photo, squared up and scaled from the
front photo's roofline, with what's traced on it: the roof outline (and from it, with the eaves,
the outside walls), the yard (paths, driveways, patios, pools, beds, trees, bushes), and each
level's floor plan (interior walls, doors, rooms).

Everything traced is kept in house metres (x across the front, y back from the front wall), so
the photo can be swapped without losing the drawing. The photo's own placement (scale, turn,
position) is kept as `xf`, worked out by the page from the two lines the user draws.
"""

from __future__ import annotations

import math
from typing import Any

# Stud depths and wall finishes, in metres
STUDS = {"2x4": 0.0889, "2x6": 0.1397, "2x8": 0.1842}
FINISH = {"drywall": 0.0127, "plaster": 0.01905}
# Outside walls: studs, drywall inside, sheathing and siding outside
SHEATHING_SIDING_M = 0.0111 + 0.019
YARD_KINDS = ("path", "driveway", "patio", "pool", "bed", "lawn", "tree", "bush", "other")
WALL_DEFAULT = {"studs": "2x4", "finish": "drywall"}


class SiteError(ValueError):
    pass


def interior_thickness(studs: str, finish: str) -> float:
    return STUDS[studs] + 2 * FINISH[finish]


def exterior_thickness(studs: str) -> float:
    return STUDS[studs] + FINISH["drywall"] + SHEATHING_SIDING_M


def _num(v: Any, lo: float = -1000, hi: float = 1000) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError) as err:
        raise SiteError(f"not a number: {v!r}") from err
    if math.isnan(f) or math.isinf(f) or not lo <= f <= hi:
        raise SiteError(f"out of range: {v!r}")
    return round(f, 4)


def _pt(p: Any, lo: float = -1000, hi: float = 1000) -> list[float]:
    if not isinstance(p, list | tuple) or len(p) != 2:
        raise SiteError("a point is [x, y]")
    return [_num(p[0], lo, hi), _num(p[1], lo, hi)]


def _pts(v: Any, least: int, most: int, lo: float = -1000, hi: float = 1000) -> list[list[float]]:
    if not isinstance(v, list) or not least <= len(v) <= most:
        raise SiteError(f"expected {least} to {most} points")
    return [_pt(p, lo, hi) for p in v]


def _list(v: Any, most: int) -> list[dict]:
    if v is None:
        return []
    if not isinstance(v, list) or len(v) > most or not all(isinstance(x, dict) for x in v):
        raise SiteError(f"expected a list of at most {most}")
    return v


def _id(v: Any, n: int = 40) -> str:
    return str(v or "")[:n]


def clean_site(body: dict, photo: dict | None, floors: set[str], areas: set[str]) -> dict:
    """Check and tidy a top-view drawing sent by the page."""
    out: dict[str, Any] = {"photo": photo}
    xf = body.get("xf")
    if xf:
        out["xf"] = {
            "s": _num(xf.get("s"), 1e-6, 10),
            "theta": _num(xf.get("theta"), -10, 10),
            "tx": _num(xf.get("tx"), -1e5, 1e5),
            "ty": _num(xf.get("ty"), -1e5, 1e5),
        }
    sq = body.get("square")
    if sq:
        runs = sq.get("runs") or "across"
        if runs not in ("across", "depth"):
            raise SiteError("a square-up line runs across or front to back")
        out["square"] = {
            "a": _pt(sq.get("a"), -1e5, 1e5),
            "b": _pt(sq.get("b"), -1e5, 1e5),
            "runs": runs,
        }
    turns = int(_num(body.get("turns", 0), 0, 3))
    out["turns"] = turns
    # a small extra turn (radians) that squares the roof outline to the house
    out["trim"] = _num(body.get("trim", 0), -0.5, 0.5)
    for key in ("ref", "check"):
        r = body.get(key)
        if r:
            ref: dict[str, Any] = {"pts": _pts(r.get("pts"), 2, 60, -1e5, 1e5)}
            if r.get("length") not in (None, ""):
                ref["length"] = _num(r["length"], 0.5, 500)
            out[key] = ref
    if body.get("outline"):
        out["outline"] = _pts(body["outline"], 3, 200)
    ext = body.get("ext_wall") or "2x6"
    if ext not in STUDS:
        raise SiteError(f"unknown wall {ext}")
    out["ext_wall"] = ext

    yard = []
    for y in _list(body.get("yard"), 300):
        kind = y.get("kind") or "other"
        if kind not in YARD_KINDS:
            raise SiteError(f"unknown yard shape {kind}")
        shape: dict[str, Any] = {
            "id": _id(y.get("id")),
            "kind": kind,
            "name": _id(y.get("name"), 60),
        }
        if kind in ("tree", "bush"):
            shape["c"] = _pt(y.get("c"))
            shape["r"] = _num(y.get("r"), 0.1, 30)
            if y.get("h") not in (None, ""):
                shape["h"] = _num(y["h"], 0.1, 60)
        else:
            shape["pts"] = _pts(y.get("pts"), 2 if kind == "path" else 3, 200)
            shape["smooth"] = bool(y.get("smooth"))
            # Shapes merged into this one: more lines (a path) or outlines (an area), drawn and
            # moved with it as one
            parts = y.get("parts")
            if parts:
                if not isinstance(parts, list) or len(parts) > 20:
                    raise SiteError("a yard shape has at most 20 parts")
                shape["parts"] = [_pts(q, 2 if kind == "path" else 3, 200) for q in parts]
            if kind == "path" and y.get("width") not in (None, ""):
                shape["width"] = _num(y["width"], 0.1, 10)
        yard.append(shape)
    out["yard"] = yard

    walls = []
    for w in _list(body.get("walls"), 400):
        level = str(w.get("level") or "")
        if level not in floors:
            raise SiteError(f"unknown level {level}")
        studs = w.get("studs") or WALL_DEFAULT["studs"]
        finish = w.get("finish") or WALL_DEFAULT["finish"]
        if studs not in STUDS or finish not in FINISH:
            raise SiteError("unknown wall build")
        a, b = _pt(w.get("a")), _pt(w.get("b"))
        if math.dist(a, b) < 0.1:
            raise SiteError("a wall is too short")
        walls.append(
            {
                "id": _id(w.get("id")),
                "level": level,
                "a": a,
                "b": b,
                "studs": studs,
                "finish": finish,
                **({"angled": True} if w.get("angled") else {}),  # not kept square to the house
            }
        )
    out["walls"] = walls
    wall_ids = {w["id"] for w in walls}
    doors = []
    for d in _list(body.get("doors"), 400):
        if d.get("wall") not in wall_ids:
            raise SiteError("a door must be on a wall")
        doors.append(
            {
                "id": _id(d.get("id")),
                "wall": d["wall"],
                "at": _num(d.get("at", 0), 0, 100),
                "width": _num(d.get("width", 0.8128), 0.4, 5),
            }
        )
    out["doors"] = doors
    rooms = []
    for r in _list(body.get("rooms"), 200):
        level = str(r.get("level") or "")
        if level not in floors:
            raise SiteError(f"unknown level {level}")
        area = r.get("area") or None
        if area and area not in areas:
            raise SiteError(f"unknown area {area}")
        rooms.append(
            {
                "id": _id(r.get("id")),
                "level": level,
                "at": _pt(r.get("at")),
                "area": area,
                "name": _id(r.get("name"), 60),
            }
        )
    out["rooms"] = rooms
    stairs = []
    for t in _list(body.get("stairs"), 60):
        level, to = str(t.get("level") or ""), str(t.get("to") or "")
        if level not in floors or (to and to not in floors):
            raise SiteError("stairs go between two levels")
        direction = t.get("dir") or "y+"
        if direction not in ("x+", "x-", "y+", "y-"):
            raise SiteError("stairs go along x or y")
        x0, x1 = sorted((_num(t.get("x0")), _num(t.get("x1"))))
        y0, y1 = sorted((_num(t.get("y0")), _num(t.get("y1"))))
        if x1 - x0 < 0.3 or y1 - y0 < 0.3:
            raise SiteError("stairs are at least 1 ft each way")
        st = {
            "id": _id(t.get("id")),
            "level": level,
            "to": to or None,
            "dir": direction,
            "x0": x0,
            "x1": x1,
            "y0": y0,
            "y1": y1,
        }
        # How many steps (treads, not the floor at the top) and how high each is, when typed;
        # otherwise they follow from the levels' heights
        if t.get("steps") is not None:
            st["steps"] = int(_num(t.get("steps"), 1, 60))
        if t.get("riser") is not None:
            st["riser"] = _num(t.get("riser"), 0.05, 0.4)
        stairs.append(st)
    out["stairs"] = stairs
    return out


# ---- geometry ---------------------------------------------------------------------------------


def signed_area(poly: list[list[float]]) -> float:
    a = 0.0
    for i in range(len(poly)):
        x0, y0 = poly[i - 1]
        x1, y1 = poly[i]
        a += x0 * y1 - x1 * y0
    return a / 2


def inset(poly: list[list[float]], d: float) -> list[list[float]]:
    """The polygon moved inward by d (each edge shifted, corners where they meet)."""
    if d == 0 or len(poly) < 3:
        return [list(p) for p in poly]
    sign = 1.0 if signed_area(poly) > 0 else -1.0  # counter-clockwise: inward is to the left
    n = len(poly)
    lines = []
    for i in range(n):
        (x0, y0), (x1, y1) = poly[i], poly[(i + 1) % n]
        dx, dy = x1 - x0, y1 - y0
        length = math.hypot(dx, dy) or 1.0
        nx, ny = -dy / length * sign, dx / length * sign
        lines.append(((x0 + nx * d, y0 + ny * d), (dx, dy)))
    out = []
    for i in range(n):
        (p, r), (q, s) = lines[i - 1], lines[i]
        cross = r[0] * s[1] - r[1] * s[0]
        if abs(cross) < 1e-9:
            out.append([round(q[0], 4), round(q[1], 4)])
            continue
        t = ((q[0] - p[0]) * s[1] - (q[1] - p[1]) * s[0]) / cross
        out.append([round(p[0] + t * r[0], 4), round(p[1] + t * r[1], 4)])
    return out


def clip_x(poly: list[list[float]], x0: float, x1: float) -> list[list[float]]:
    """The part of a polygon between x0 and x1 (Sutherland-Hodgman against two lines)."""

    def clip(pts, keep, cut):
        out = []
        for i in range(len(pts)):
            a, b = pts[i - 1], pts[i]
            ka, kb = keep(a), keep(b)
            if kb:
                if not ka:
                    out.append(cut(a, b))
                out.append(b)
            elif ka:
                out.append(cut(a, b))
        return out

    def at_x(x):
        def cut(a, b):
            t = (x - a[0]) / (b[0] - a[0]) if b[0] != a[0] else 0
            return [x, a[1] + t * (b[1] - a[1])]

        return cut

    pts = clip(poly, lambda p: p[0] >= x0, at_x(x0))
    return clip(pts, lambda p: p[0] <= x1, at_x(x1)) if pts else []


def depth_over(poly: list[list[float]], x0: float, x1: float) -> tuple[float, float] | None:
    """How far forward and back a plan goes between x0 and x1: (front y, back y)."""
    part = clip_x(poly, x0, x1)
    if not part:
        return None
    ys = [p[1] for p in part]
    return min(ys), max(ys)


def plan_of(site: dict, eave: float) -> list[list[float]] | None:
    """The outside face of the outside walls: the roof outline, pulled in by the eaves."""
    outline = site.get("outline")
    if not outline:
        return None
    return inset(outline, eave)


def photo_to_house(xf: dict, u: float, v: float) -> tuple[float, float]:
    """A top-view photo point (px) in house metres, as the page places the photo."""
    c, s = math.cos(xf["theta"]), math.sin(xf["theta"])
    x, y = u, -v
    return (c * x - s * y) * xf["s"] + xf["tx"], (s * x + c * y) * xf["s"] + xf["ty"]


def inside(poly: list[list[float]], x: float, y: float) -> bool:
    hit = False
    for i in range(len(poly)):
        (x0, y0), (x1, y1) = poly[i - 1], poly[i]
        if (y0 > y) != (y1 > y) and x < (x1 - x0) * (y - y0) / (y1 - y0) + x0:
            hit = not hit
    return hit


def walls_3d(site: dict) -> list[dict]:
    """Interior walls with their thickness, for the 3D view."""
    out = []
    for w in site.get("walls") or []:
        out.append({**w, "thick": round(interior_thickness(w["studs"], w["finish"]), 4)})
    return out
