"""Views on disk (`/config/views/<id>/`), with the edits the UI makes: photo, planes, elements.

Each view is a folder with `view.json` and its photos. Manual placement and camera mapping both
end up here, as the same elements.
"""

from __future__ import annotations

import logging
import re
import shutil
import time
from collections.abc import Callable
from pathlib import Path

import cv2
import numpy as np

from ..inventory.model import Inventory, Kind
from ..store import JsonStore
from . import geometry
from .model import Element, Part, Plane, Station, View, World, new_id

log = logging.getLogger(__name__)

MAX_PHOTO_SIDE = 2048
PHOTO_QUALITY = 90
DEFAULT_RADIUS = 0.02
_ID = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


class SpatialError(ValueError):
    pass


def encode_photo(data: bytes, max_side: int = MAX_PHOTO_SIDE) -> tuple[bytes, np.ndarray]:
    """Decode any image the browser sends, shrink it, and store it as JPEG."""
    img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise SpatialError("not an image")
    scale = max_side / max(img.shape[:2])
    if scale < 1:
        img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, PHOTO_QUALITY])
    if not ok:
        raise SpatialError("could not encode the photo")
    return buf.tobytes(), img


class SpatialService:
    def __init__(self, config_dir: Path, inventory: Callable[[], Inventory]):
        self.root = config_dir / "views"
        self.root.mkdir(parents=True, exist_ok=True)
        self._inventory = inventory
        self._cache: dict[str, View] = {}

    # ---- storage --------------------------------------------------------------------------

    def folder(self, view_id: str) -> Path:
        if not _ID.match(view_id):
            raise KeyError(view_id)
        return self.root / view_id

    def list(self) -> list[View]:
        views = []
        for d in sorted(self.root.iterdir()):
            if d.is_dir() and (d / "view.json").exists():
                try:
                    views.append(self.get(d.name))
                except (KeyError, ValueError) as err:
                    log.warning("Skipping view %s: %s", d.name, err)
        return sorted(views, key=lambda v: v.created)

    def get(self, view_id: str) -> View:
        if view_id in self._cache:
            return self._cache[view_id]
        folder = self.folder(view_id)
        data = JsonStore(folder).load("view") if folder.exists() else None
        if not data:
            raise KeyError(view_id)
        view = View.from_dict(data)
        self._cache[view_id] = view
        return view

    def save(self, view: View) -> View:
        view.updated = time.time()
        folder = self.folder(view.id)
        folder.mkdir(parents=True, exist_ok=True)
        JsonStore(folder).save("view", view.to_dict())
        self._cache[view.id] = view
        return view

    # ---- views ----------------------------------------------------------------------------

    def create(self, name: str) -> View:
        name = (name or "").strip()[:80] or "Front of house"
        return self.save(View(id=new_id("view"), name=name))

    def rename(self, view_id: str, name: str) -> View:
        view = self.get(view_id)
        view.name = (name or "").strip()[:80] or view.name
        return self.save(view)

    def delete(self, view_id: str) -> None:
        folder = self.folder(view_id)
        self.get(view_id)
        self._cache.pop(view_id, None)
        shutil.rmtree(folder, ignore_errors=True)

    # ---- photos ---------------------------------------------------------------------------

    def photo_path(self, view_id: str, name: str | None = None) -> Path:
        view = self.get(view_id)
        file = name or (view.photo or {}).get("file")
        if not file or not re.match(r"^[A-Za-z0-9_.-]+\.jpg$", file):
            raise KeyError("no photo")
        path = self.folder(view_id) / file
        if not path.exists():
            raise KeyError("no photo")
        return path

    def write_file(self, view_id: str, name: str, data: bytes) -> None:
        path = self.folder(view_id) / name
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)

    def set_photo(self, view_id: str, data: bytes, *, register: bool = True) -> dict:
        """Replace the view's photo. Elements and planes placed on the old photo are carried over
        when the two photos can be matched; otherwise they keep their coordinates and are marked
        for checking."""
        view = self.get(view_id)
        jpeg, img = encode_photo(data)
        old_file = (view.photo or {}).get("file")
        H = None
        has_content = bool(view.elements or view.planes)
        if register and old_file and has_content:
            old = cv2.imread(str(self.folder(view_id) / old_file))
            if old is not None:
                H = geometry.register(old, img)
        file = f"photo_{int(time.time() * 1000)}.jpg"
        self.write_file(view_id, file, jpeg)
        view.photo = {"file": file, "width": img.shape[1], "height": img.shape[0]}
        moved = 0
        if H is not None:
            moved = self._transform_view(view, H)
        elif has_content and old_file:
            for el in view.elements:
                el.note = "check position: the photo changed"
        self.save(view)
        if old_file and old_file != file:
            (self.folder(view_id) / old_file).unlink(missing_ok=True)
        return {"photo": view.photo, "registered": H is not None, "moved": moved}

    def _transform_view(self, view: View, H: np.ndarray) -> int:
        def tr(points):
            return [
                [min(1, max(0, x)), min(1, max(0, y))]
                for x, y in geometry.transform_points(H, points)
            ]

        for pl in view.planes:
            pl.points = geometry.transform_points(H, pl.points)
        for el in view.elements:
            el.region = tr(el.region)
            if el.centroid:
                el.centroid = tr([el.centroid])[0]
            if el.line:
                el.line = tr(el.line)
            for part in el.parts:
                if part.centroid:
                    part.centroid = tr([part.centroid])[0]
                if part.region:
                    part.region = tr(part.region)
        return len(view.elements)

    # ---- planes ---------------------------------------------------------------------------

    def add_plane(self, view_id: str, data: dict) -> Plane:
        view = self.get(view_id)
        data = {**data, "id": new_id("pl")}
        plane = Plane.from_dict(data)
        view.planes.append(plane)
        self._assign_planes(view)
        self._update_world(view)
        self.save(view)
        return plane

    def update_plane(self, view_id: str, plane_id: str, data: dict) -> Plane:
        view = self.get(view_id)
        old = view.plane(plane_id)
        merged = {
            "id": old.id,
            "name": old.name,
            "kind": old.kind,
            "points": old.points,
            "size": old.size,
            **{k: v for k, v in data.items() if k != "id"},
        }
        plane = Plane.from_dict(merged)
        view.planes[view.planes.index(old)] = plane
        self._update_world(view)
        self.save(view)
        return plane

    def delete_plane(self, view_id: str, plane_id: str) -> None:
        view = self.get(view_id)
        view.planes.remove(view.plane(plane_id))
        for el in view.elements:
            if el.plane == plane_id:
                el.plane = None
        self._update_world(view)
        self.save(view)

    # ---- elements -------------------------------------------------------------------------

    def _member_names(self) -> dict[str, str]:
        inv = self._inventory()
        names = {eid: lt.name for eid, lt in inv.lights.items()}
        names.update({fid: f.name for fid, f in inv.fixtures.items()})
        return names

    def check_member(self, member: str) -> None:
        inv = self._inventory()
        if member in inv.fixtures:
            return
        light = inv.lights.get(member)
        if light is None:
            raise SpatialError(f"unknown light or fixture {member}")
        if light.kind not in (Kind.LIGHT, Kind.SWITCH, Kind.SEGMENT):
            raise SpatialError(f"{light.name} is not a light")
        if light.fixture:
            raise SpatialError(f"{light.name} is part of a fixture: place the fixture")

    def _check_members(self, view: View, members: list[str], allow: str | None = None) -> None:
        if len(set(members)) != len(members):
            raise SpatialError("a light can only be in an element once")
        placed = view.placed_members()
        inv = self._inventory()
        for m in members:
            self.check_member(m)
            if m in placed and placed[m] != allow:
                raise SpatialError(f"{m} is already placed in this view")
            light = inv.lights.get(m)
            if light is not None and light.parent and light.parent in placed:
                if placed[light.parent] != allow:
                    raise SpatialError(f"{light.parent} is already placed in this view")
            if light is not None and any(placed.get(s, allow) != allow for s in light.segments):
                raise SpatialError(f"segments of {m} are already placed in this view")

    def _name_for(self, members: list[str]) -> str:
        names = self._member_names()
        first = names.get(members[0], members[0])
        return first if len(members) == 1 else f"{first} + {len(members) - 1}"

    def add_element(self, view_id: str, data: dict) -> Element:
        view = self.get(view_id)
        parts = data.get("parts") or [{"member": m} for m in data.get("members") or []]
        el = Element.from_dict({**data, "parts": parts, "id": new_id("el")})
        self._check_members(view, el.members)
        if not el.name:
            el.name = self._name_for(el.members)
        self._fill_shape(el)
        if el.plane is not None:
            view.plane(el.plane)
        view.elements.append(el)
        self._assign_planes(view, [el])
        self._update_world(view)
        self.save(view)
        return el

    def update_element(self, view_id: str, element_id: str, data: dict) -> Element:
        """Move, rename, change mode or plane, or replace the parts of an element."""
        view = self.get(view_id)
        old = view.element(element_id)
        merged = old.to_dict()
        moved_to = data.get("centroid")
        for key in ("name", "mode", "region", "centroid", "plane", "line", "note", "world"):
            if key in data:
                merged[key] = data[key]
        if "parts" in data or "members" in data:
            merged["parts"] = data.get("parts") or [{"member": m} for m in data["members"]]
        el = Element.from_dict(merged)
        self._check_members(view, el.members, allow=element_id)
        if el.plane is not None:
            view.plane(el.plane)
        if moved_to is not None and "region" not in data and old.centroid:
            # dragging moves the outline and the parts with the centre
            dx, dy = el.centroid[0] - old.centroid[0], el.centroid[1] - old.centroid[1]
            el.region = _shift(old.region, dx, dy)
            for p in el.parts:
                if p.centroid:
                    p.centroid = _shift([p.centroid], dx, dy)[0]
                if p.region:
                    p.region = _shift(p.region, dx, dy)
            if el.line:
                el.line = _shift(el.line, dx, dy)
            if el.world and el.world.method in ("triangulated", "ray"):
                el.world = None  # moved by hand: the measured position no longer applies
            el.note = ""
        if "line" in data and el.line:
            self._spread_along_line(el)
        self._fill_shape(el)
        view.elements[view.elements.index(old)] = el
        self._update_world(view)
        self.save(view)
        return el

    def delete_element(self, view_id: str, element_id: str) -> None:
        view = self.get(view_id)
        view.elements.remove(view.element(element_id))
        self.save(view)

    def merge(self, view_id: str, element_ids: list[str], mode: str = "single") -> Element:
        view = self.get(view_id)
        if len(set(element_ids)) < 2:
            raise SpatialError("pick at least two elements to merge")
        els = [view.element(e) for e in element_ids]
        parts = [p for el in els for p in _parts_with_positions(el)]
        if mode == "segments":
            parts.sort(key=lambda p: (p.centroid or [0, 0])[0])
        pts = [pt for el in els for pt in (el.region or ([el.centroid] if el.centroid else []))]
        region = geometry.hull(pts) if pts else []
        planes = {el.plane for el in els}
        merged = Element(
            id=new_id("el"),
            name=els[0].name
            if len(els[0].parts) > 1
            else self._name_for([p.member for p in parts]),
            mode=mode if mode in ("single", "segments") else "single",
            parts=parts,
            region=region,
            centroid=geometry.polygon_centroid(region) if len(region) >= 3 else None,
            plane=planes.pop() if len(planes) == 1 else None,
            source="mapping" if all(el.source == "mapping" for el in els) else "manual",
        )
        self._fill_shape(merged)
        index = min(view.elements.index(el) for el in els)
        for el in els:
            view.elements.remove(el)
        view.elements.insert(index, merged)
        self._update_world(view)
        self.save(view)
        return merged

    def split(self, view_id: str, element_id: str) -> list[Element]:
        view = self.get(view_id)
        el = view.element(element_id)
        if len(el.parts) < 2:
            raise SpatialError("only an element with two or more lights can be split")
        out = []
        for part in _parts_with_positions(el):
            centroid = part.centroid or el.centroid
            new = Element(
                id=new_id("el"),
                name=self._name_for([part.member]),
                parts=[Part(part.member, latency_ms=part.latency_ms, confidence=part.confidence)],
                region=part.region or (geometry.circle(centroid) if centroid else []),
                centroid=centroid,
                plane=el.plane,
                world=part.world,
                source=el.source,
                confidence=part.confidence,
            )
            out.append(new)
        index = view.elements.index(el)
        view.elements[index : index + 1] = out
        self._update_world(view)
        self.save(view)
        return out

    def reorder(self, view_id: str, element_id: str, members: list[str]) -> Element:
        """Put the segments of an element in a new order (positions stay where they are, unless
        they were spread along a drawn line)."""
        view = self.get(view_id)
        el = view.element(element_id)
        if sorted(members) != sorted(el.members):
            raise SpatialError("the new order must list the same lights")
        by = {p.member: p for p in el.parts}
        el.parts = [by[m] for m in members]
        if el.line:
            self._spread_along_line(el)
        self.save(view)
        return el

    # ---- shapes, planes and world positions -----------------------------------------------

    def _spread_along_line(self, el: Element) -> None:
        """Segments are ordered along the drawn line. A segmented light (a Govee strip) placed
        alone becomes its segments."""
        inv = self._inventory()
        if len(el.parts) == 1:
            light = inv.lights.get(el.parts[0].member)
            if light is not None and light.segments:
                el.parts = [Part(s) for s in light.segments]
        el.mode = "segments" if len(el.parts) > 1 else "single"
        assert el.line is not None
        for part, pt in zip(el.parts, geometry.along_line(el.line, len(el.parts)), strict=True):
            part.centroid = pt
            part.region = None
            part.world = None
        (x0, y0), (x1, y1) = el.line
        el.centroid = [round((x0 + x1) / 2, 5), round((y0 + y1) / 2, 5)]
        el.region = _band(el.line)

    def _fill_shape(self, el: Element) -> None:
        if el.centroid is None and el.region:
            el.centroid = geometry.polygon_centroid(el.region)
        if el.centroid is None:
            pts = [p.centroid for p in el.parts if p.centroid]
            if pts:
                el.centroid = [round(float(v), 5) for v in np.mean(pts, axis=0)]
        if not el.region and el.centroid is not None:
            el.region = geometry.circle(el.centroid, DEFAULT_RADIUS)

    def _assign_planes(self, view: View, elements: list[Element] | None = None) -> None:
        """An element without a plane gets the plane its centre is in (ground first)."""
        order = sorted(view.planes, key=lambda p: (p.kind != "ground", p.kind != "wall"))
        for el in elements if elements is not None else view.elements:
            if el.plane is not None or el.centroid is None:
                continue
            if el.world is not None and el.world.method == "triangulated":
                continue
            for pl in order:
                if geometry.point_in_polygon(el.centroid, pl.points):
                    el.plane = pl.id
                    break

    def _update_world(self, view: View) -> None:
        """Plane positions for elements on a plane and not triangulated."""
        planes = {p.id: p for p in view.planes}
        for el in view.elements:
            if el.world is not None and el.world.method in ("triangulated", "ray", "manual"):
                continue
            pl = planes.get(el.plane or "")
            if pl is None or el.centroid is None:
                if el.world is not None and el.world.method == "plane":
                    el.world = None
                continue
            u, v = geometry.picture_to_plane(pl.points, pl.size, el.centroid)
            el.world = World(
                "plane", plane=pl.id, u=round(u, 4), v=round(v, 4), metric=bool(pl.size)
            )
            for part in el.parts:
                if part.centroid is not None and (
                    part.world is None or part.world.method == "plane"
                ):
                    pu, pv = geometry.picture_to_plane(pl.points, pl.size, part.centroid)
                    part.world = World(
                        "plane", plane=pl.id, u=round(pu, 4), v=round(pv, 4), metric=bool(pl.size)
                    )

    # ---- whole-view replacement (camera mapping) -----------------------------------------

    def apply_capture(
        self,
        view_id: str,
        *,
        photo_jpeg: bytes | None,
        elements: list[Element],
        stations: list[Station],
        station_photos: dict[str, bytes],
        mapping: dict,
    ) -> dict:
        """Put a capture's results into a view. Mapped lights replace their old placements;
        manual placements of other lights are carried over to the new photo where possible."""
        view = self.get(view_id)
        result: dict = {"registered": None}
        if photo_jpeg is not None:
            keep = [
                el
                for el in view.elements
                if not set(el.members) & {m for e in elements for m in e.members}
            ]
            view.elements = keep
            info = self.set_photo(view_id, photo_jpeg)
            result["registered"] = info["registered"]
            view = self.get(view_id)
        else:
            mapped = {m for e in elements for m in e.members}
            view.elements = [el for el in view.elements if not set(el.members) & mapped]
        for name, data in station_photos.items():
            self.write_file(view_id, f"station_{name}.jpg", data)
        for st in stations:
            if st.name in station_photos:
                st.photo = f"station_{st.name}.jpg"
        view.stations = stations
        view.mapping = mapping
        view.elements.extend(elements)
        self._assign_planes(view, elements)
        self._update_world(view)
        self.save(view)
        result["elements"] = len(elements)
        return result


def _shift(points: list, dx: float, dy: float) -> list[list[float]]:
    return [[round(min(1, max(0, x + dx)), 5), round(min(1, max(0, y + dy)), 5)] for x, y in points]


def _band(line: list, half_width: float = 0.012) -> list[list[float]]:
    (x0, y0), (x1, y1) = line
    d = np.array([x1 - x0, y1 - y0], float)
    n = np.array([-d[1], d[0]]) / max(np.linalg.norm(d), 1e-9) * half_width
    pts = [
        [x0 + n[0], y0 + n[1]],
        [x1 + n[0], y1 + n[1]],
        [x1 - n[0], y1 - n[1]],
        [x0 - n[0], y0 - n[1]],
    ]
    return [[round(min(1, max(0, x)), 5), round(min(1, max(0, y)), 5)] for x, y in pts]


def _parts_with_positions(el: Element) -> list[Part]:
    """The element's parts, each with a position (the element's, when a part has none)."""
    out = []
    for p in el.parts:
        part = Part.from_dict(p.to_dict())
        if part.centroid is None:
            part.centroid = el.centroid
        if part.world is None and len(el.parts) == 1:
            part.world = el.world
        out.append(part)
    return out
