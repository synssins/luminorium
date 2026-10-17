"""Views, planes, elements and stations.

Picture coordinates are normalised to the view's photo: (0, 0) top left, (1, 1) bottom right, so
the phone's resolution doesn't matter. Manual placement and camera mapping produce the same
structures.
"""

from __future__ import annotations

import math
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import Any

MODES = ("single", "segments")
PLANE_KINDS = ("ground", "wall", "other")
WORLD_METHODS = ("triangulated", "plane", "ray", "manual")

Point = list[float]  # [x, y], normalised


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


def _pt(value: Any) -> Point:
    x, y = (float(v) for v in value)
    if not (math.isfinite(x) and math.isfinite(y)):
        raise ValueError("coordinates must be finite")
    return [round(x, 5), round(y, 5)]


def _clamped(value: Any) -> Point:
    x, y = _pt(value)
    return [min(1.0, max(0.0, x)), min(1.0, max(0.0, y))]


@dataclass
class Plane:
    """A flat surface marked by four picture points forming a rectangle in the world, in order
    top-left, top-right, bottom-right, bottom-left (as seen on the surface)."""

    id: str
    name: str
    kind: str = "other"  # ground | wall | other
    points: list[Point] = field(default_factory=list)
    size: list[float] | None = None  # real width and height in metres (along points 0→1, 1→2)

    @classmethod
    def from_dict(cls, d: dict) -> Plane:
        plane = cls(
            id=str(d.get("id") or new_id("pl")),
            name=str(d.get("name") or "Plane")[:80],
            kind=d.get("kind") if d.get("kind") in PLANE_KINDS else "other",
            points=[_pt(p) for p in d.get("points") or []],
            size=[float(v) for v in d["size"]] if d.get("size") else None,
        )
        if len(plane.points) != 4:
            raise ValueError("a plane needs four points")
        if plane.size is not None and (len(plane.size) != 2 or min(plane.size) <= 0):
            raise ValueError("a plane's size is two positive lengths in metres")
        return plane


@dataclass
class World:
    """Where an element is in the real world.

    - triangulated: x, y, z in the view's 3D frame (metres if `metric`), from two or more stations
    - plane: u, v on `plane` (metres if the plane has a size, else 0-1 across it)
    - ray: seen from one station only; `origin` and `direction` in the view's 3D frame
    - manual: placed by hand
    """

    method: str
    x: float | None = None
    y: float | None = None
    z: float | None = None
    plane: str | None = None
    u: float | None = None
    v: float | None = None
    origin: list[float] | None = None
    direction: list[float] | None = None
    metric: bool = False

    @classmethod
    def from_dict(cls, d: dict | None) -> World | None:
        if not d:
            return None
        if d.get("method") not in WORLD_METHODS:
            raise ValueError(f"unknown world method {d.get('method')!r}")
        keys = ("x", "y", "z", "u", "v")
        values = {k: (float(d[k]) if d.get(k) is not None else None) for k in keys}
        return cls(
            method=d["method"],
            plane=d.get("plane"),
            origin=[float(v) for v in d["origin"]] if d.get("origin") else None,
            direction=[float(v) for v in d["direction"]] if d.get("direction") else None,
            metric=bool(d.get("metric")),
            **values,
        )

    def to_dict(self) -> dict:
        return {k: v for k, v in asdict(self).items() if v is not None}


@dataclass
class Part:
    """One member of an element: a light, a fixture (lights in one physical fixture, as one) or a
    segment of a segmented light. In a `segments` element the parts are the segments, in order."""

    member: str  # entity_id or fixture id
    centroid: Point | None = None
    region: list[Point] | None = None
    world: World | None = None
    latency_ms: float | None = None
    confidence: float | None = None

    @classmethod
    def from_dict(cls, d: dict | str) -> Part:
        if isinstance(d, str):
            d = {"member": d}
        return cls(
            member=str(d["member"]),
            centroid=_clamped(d["centroid"]) if d.get("centroid") is not None else None,
            region=[_clamped(p) for p in d["region"]] if d.get("region") else None,
            world=World.from_dict(d.get("world")),
            latency_ms=float(d["latency_ms"]) if d.get("latency_ms") is not None else None,
            confidence=float(d["confidence"]) if d.get("confidence") is not None else None,
        )

    def to_dict(self) -> dict:
        out: dict[str, Any] = {"member": self.member}
        for key in ("centroid", "region", "latency_ms", "confidence"):
            if getattr(self, key) is not None:
                out[key] = getattr(self, key)
        if self.world:
            out["world"] = self.world.to_dict()
        return out


@dataclass
class Element:
    """What a viewer sees change: one or more lights with a region in the view."""

    id: str
    name: str
    mode: str = "single"  # single: all parts act as one; segments: each part is a segment, in order
    parts: list[Part] = field(default_factory=list)
    region: list[Point] = field(default_factory=list)  # polygon
    centroid: Point | None = None
    plane: str | None = None  # None: free (off any plane)
    world: World | None = None
    line: list[Point] | None = None  # the drawn line segments are ordered along (manual)
    source: str = "manual"  # manual | mapping
    confidence: float | None = None
    note: str = ""

    @property
    def members(self) -> list[str]:
        return [p.member for p in self.parts]

    @classmethod
    def from_dict(cls, d: dict) -> Element:
        el = cls(
            id=str(d.get("id") or new_id("el")),
            name=str(d.get("name") or "")[:80],
            mode=d.get("mode") if d.get("mode") in MODES else "single",
            parts=[Part.from_dict(p) for p in d.get("parts") or []],
            region=[_clamped(p) for p in d.get("region") or []],
            centroid=_clamped(d["centroid"]) if d.get("centroid") is not None else None,
            plane=d.get("plane") or None,
            world=World.from_dict(d.get("world")),
            line=[_clamped(p) for p in d["line"]] if d.get("line") else None,
            source=d.get("source") if d.get("source") in ("manual", "mapping") else "manual",
            confidence=float(d["confidence"]) if d.get("confidence") is not None else None,
            note=str(d.get("note") or "")[:200],
        )
        if not el.parts:
            raise ValueError("an element needs at least one light")
        if el.line is not None and len(el.line) != 2:
            raise ValueError("a segment line has two points")
        return el

    def to_dict(self) -> dict:
        out = {
            "id": self.id,
            "name": self.name,
            "mode": self.mode,
            "parts": [p.to_dict() for p in self.parts],
            "region": self.region,
            "centroid": self.centroid,
            "plane": self.plane,
            "world": self.world.to_dict() if self.world else None,
            "line": self.line,
            "source": self.source,
            "confidence": self.confidence,
            "note": self.note,
        }
        return out


@dataclass
class Station:
    """A capture position. The first station's camera is the view's 3D frame."""

    name: str
    rotation: list[list[float]] | None = None  # world → camera
    centre: list[float] | None = None  # camera position in the view's 3D frame
    focal_px: float | None = None
    size: list[int] | None = None  # frame width, height
    session: str | None = None
    photo: str | None = None  # file name in the view folder

    @classmethod
    def from_dict(cls, d: dict) -> Station:
        return cls(
            name=str(d["name"]),
            rotation=d.get("rotation"),
            centre=d.get("centre"),
            focal_px=d.get("focal_px"),
            size=d.get("size"),
            session=d.get("session"),
            photo=d.get("photo"),
        )

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class View:
    id: str
    name: str
    photo: dict | None = None  # {"file", "width", "height"}
    planes: list[Plane] = field(default_factory=list)
    elements: list[Element] = field(default_factory=list)
    stations: list[Station] = field(default_factory=list)
    mapping: dict | None = None  # the last applied capture: session, focal, metric, notes
    created: float = field(default_factory=time.time)
    updated: float = field(default_factory=time.time)

    @classmethod
    def from_dict(cls, d: dict) -> View:
        return cls(
            id=str(d["id"]),
            name=str(d.get("name") or "View"),
            photo=d.get("photo"),
            planes=[Plane.from_dict(p) for p in d.get("planes") or []],
            elements=[Element.from_dict(e) for e in d.get("elements") or []],
            stations=[Station.from_dict(s) for s in d.get("stations") or []],
            mapping=d.get("mapping"),
            created=float(d.get("created") or time.time()),
            updated=float(d.get("updated") or time.time()),
        )

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "photo": self.photo,
            "planes": [asdict(p) for p in self.planes],
            "elements": [e.to_dict() for e in self.elements],
            "stations": [s.to_dict() for s in self.stations],
            "mapping": self.mapping,
            "created": self.created,
            "updated": self.updated,
        }

    def summary(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "photo": bool(self.photo),
            "elements": len(self.elements),
            "planes": len(self.planes),
            "stations": [s.name for s in self.stations],
            "updated": self.updated,
        }

    def element(self, element_id: str) -> Element:
        for el in self.elements:
            if el.id == element_id:
                return el
        raise KeyError(element_id)

    def plane(self, plane_id: str) -> Plane:
        for pl in self.planes:
            if pl.id == plane_id:
                return pl
        raise KeyError(plane_id)

    def placed_members(self) -> dict[str, str]:
        """member → element id, for every light already in this view."""
        return {p.member: el.id for el in self.elements for p in el.parts}
