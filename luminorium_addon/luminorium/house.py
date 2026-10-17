"""The house map: where each light is in 3D, placed by hand.

No floorplan: the house is a box of the user's size. Floors come from HA; the user says how high
each one sits (split levels are floors half a storey apart) and how high its ceiling is, and
optionally which part of the house it covers. Each light (or fixture) gets a floor, a spot across
and back, a height above that floor, and a mount type. Segmented lights (a WLED strip's LEDs,
a Govee strip's segments) stay one light, with their parts placeable one by one or along a line.

Coordinates, in metres: x across the front from its left corner, y back from the front wall
(negative: the yard, towards the street), z above the ground outside.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .inventory.model import Inventory, Kind, Light
from .store import JsonStore

OUTSIDE = "_outside"
# A standard front door: 36" x 80"
DOOR_W_M = 0.9144
DOOR_H_M = 2.032
ROOFS = (
    "flat",
    "gable",
    "ridge",
)  # gable: the triangle faces the street; ridge: runs along the front
OPENINGS = ("window", "door", "garage")
PHOTO_MAX_BYTES = 15 * 1024 * 1024
STOREY_M = 2.7
CEILING_M = 2.4
# The deepest a floor goes by default: one storey below the ground
BASEMENT_DEPTH_M = 2.4
# Mount types and the height above the floor (m) each suggests; ceiling-hung ones follow the ceiling
MOUNTS: dict[str, dict[str, Any]] = {
    "ceiling": {"label": "Ceiling", "below_ceiling": 0.05},
    "pendant": {"label": "Pendant", "below_ceiling": 0.6},
    "wall": {"label": "Wall", "h": 1.8},
    "floor_lamp": {"label": "Floor lamp", "h": 1.5},
    "table": {"label": "Tabletop", "h": 0.8},
    "under_cabinet": {"label": "Under cabinet", "h": 1.4},
    "strip": {"label": "Strip", "h": 1.0},
    "post": {"label": "Path or post", "h": 0.5},
    "ground": {"label": "In the ground", "h": 0.0},
    "other": {"label": "Other", "h": 1.5},
}


class HouseError(ValueError):
    pass


@dataclass
class Part:
    index: int
    label: str
    entity_id: str | None = None  # a Govee segment's own entity


def default_floors(inv: Inventory) -> dict[str, dict]:
    """A first guess, corrected by the user under Floors & size.

    The level named "main" (else the lowest above ground) is at 0. Nothing goes deeper than
    one storey below the ground: the floors under main share that depth evenly, so a split-level
    house (levels half a storey apart) comes out right. Above main, floors keep the same step in
    a split-level house, else one storey each.
    """
    real = sorted(
        (f for f in inv.floors.values() if not f.id.startswith("_")),
        key=lambda f: (f.level is None, f.level if f.level is not None else 0),
    )
    if not real:
        return {}
    main_i = next((i for i, f in enumerate(real) if "main" in f.name.lower()), None)
    if main_i is None:
        main_i = next((i for i, f in enumerate(real) if (f.level or 0) >= 0), 0)
    below = main_i  # floors under main, lowest first
    step_below = BASEMENT_DEPTH_M / below if below else STOREY_M
    step_above = step_below if below >= 2 else STOREY_M
    out = {}
    for i, f in enumerate(real):
        k = i - main_i
        elevation = k * step_below if k < 0 else k * step_above
        out[f.id] = {"elevation": round(elevation, 2), "ceiling": CEILING_M, "x0": None, "x1": None}
    return out


class HouseService:
    def __init__(self, store: JsonStore, inventory, parts_for=None):
        """parts_for(light) -> list[Part]: a segmented light's parts (WLED LEDs, Govee segments)."""
        self.store = store
        self.inventory = inventory  # InventoryService
        self.parts_for = parts_for or (lambda light: [])
        self.data: dict[str, Any] = store.load("house", None) or {}
        self.data.setdefault("size", {"width": 14.0, "depth": 10.0})
        self.data.setdefault("floors", {})
        self.data.setdefault("items", {})
        self.data.setdefault("facade", None)

    # ---- floors ---------------------------------------------------------------------------

    def floors(self) -> dict[str, dict]:
        inv: Inventory = self.inventory.inventory
        merged = default_floors(inv)
        for fid, saved in self.data["floors"].items():
            if fid in merged:
                merged[fid].update(
                    {k: v for k, v in saved.items() if k in ("elevation", "ceiling", "x0", "x1")}
                )
        return merged

    def floor_z(self, floor_id: str) -> float:
        if floor_id == OUTSIDE:
            return 0.0
        return float(self.floors().get(floor_id, {}).get("elevation", 0.0))

    def ceiling(self, floor_id: str) -> float:
        if floor_id == OUTSIDE:
            return 3.0
        return float(self.floors().get(floor_id, {}).get("ceiling", CEILING_M))

    # ---- what can be placed ----------------------------------------------------------------

    def targets(self) -> list[dict]:
        """Lights and fixtures to place. A WLED segment light is folded into its device's main
        light; segmented lights list their parts."""
        inv: Inventory = self.inventory.inventory
        masters = {
            _wled_mac(lt)
            for lt in inv.lights.values()
            if lt.integration == "wled" and lt.included and _wled_seg(lt) is None and _wled_mac(lt)
        }
        out = []
        for fx in inv.fixtures.values():
            members = [inv.lights[e] for e in fx.members if e in inv.lights]
            out.append(
                self._target(
                    fx.id,
                    "fixture",
                    fx.name,
                    fx.area_id,
                    fx.floor_id,
                    members[0] if members else None,
                    [],
                )
            )
        for lt in inv.lights.values():
            if lt.kind not in (Kind.LIGHT, Kind.SWITCH) or not lt.included or lt.fixture:
                continue
            if lt.integration == "wled" and _wled_seg(lt) is not None and _wled_mac(lt) in masters:
                continue
            out.append(
                self._target(
                    lt.entity_id, "light", lt.name, lt.area_id, lt.floor_id, lt, self.parts_for(lt)
                )
            )
        out.sort(key=lambda t: t["name"].lower())
        return out

    def _target(
        self, tid, kind, name, area_id, floor_id, light: Light | None, parts: list[Part]
    ) -> dict:
        item = self.data["items"].get(tid)
        placed_parts = (item or {}).get("parts", {})
        return {
            "id": tid,
            "kind": kind,
            "name": name,
            "area_id": area_id,
            "floor_id": floor_id,
            "integration": light.integration if light else None,
            "state": light.state if light else None,
            "placed": item is not None,
            "item": item,
            "world": self.world(tid),
            "parts": [
                {
                    "index": p.index,
                    "label": p.label,
                    "entity_id": p.entity_id,
                    "placed": str(p.index) in placed_parts,
                    "world": self.part_world(tid, p.index),
                }
                for p in parts
            ],
        }

    # ---- placing ---------------------------------------------------------------------------

    def _check_target(self, tid: str) -> dict:
        for t in self.targets():
            if t["id"] == tid:
                return t
        raise KeyError(tid)

    def _check_floor(self, floor: str) -> None:
        if floor != OUTSIDE and floor not in self.floors():
            raise HouseError(f"unknown floor {floor}")

    def place(
        self, tid: str, floor: str, x: float, y: float, h: float | None, mount: str | None
    ) -> dict:
        self._check_target(tid)
        self._check_floor(floor)
        mount = (
            mount
            or (self.data["items"].get(tid) or {}).get("mount")
            or ("post" if floor == OUTSIDE else "ceiling")
        )
        if mount not in MOUNTS:
            raise HouseError(f"unknown mount {mount}")
        if h is None:
            h = self.mount_height(mount, floor)
        item = self.data["items"].get(tid, {})
        item.update(
            {"floor": floor, "x": _num(x), "y": _num(y), "h": max(0.0, _num(h)), "mount": mount}
        )
        self.data["items"][tid] = item
        self._save()
        return item

    def mount_height(self, mount: str, floor: str) -> float:
        m = MOUNTS[mount]
        if "below_ceiling" in m:
            return round(max(0.0, self.ceiling(floor) - m["below_ceiling"]), 2)
        return float(m["h"])

    def remove(self, tid: str) -> None:
        if self.data["items"].pop(tid, None) is None:
            raise KeyError(tid)
        self._save()

    def place_part(self, tid: str, index: int, x: float, y: float, h: float | None) -> None:
        target = self._check_target(tid)
        if not any(p["index"] == index for p in target["parts"]):
            raise KeyError(f"{tid} part {index}")
        item = self.data["items"].get(tid)
        if item is None:
            raise HouseError("place the light itself first")
        parts = item.setdefault("parts", {})
        parts[str(index)] = {
            "x": _num(x),
            "y": _num(y),
            "h": max(0.0, _num(item["h"] if h is None else h)),
        }
        self._save()

    def remove_part(self, tid: str, index: int) -> None:
        item = self.data["items"].get(tid) or {}
        if (item.get("parts") or {}).pop(str(index), None) is None:
            raise KeyError(f"{tid} part {index}")
        self._save()

    def line(self, tid: str, start: dict, end: dict, indexes: list[int] | None = None) -> int:
        """Spread parts evenly from start to end ({x, y, h}); returns how many were placed."""
        target = self._check_target(tid)
        idx = indexes if indexes else [p["index"] for p in target["parts"]]
        if len(idx) < 2:
            raise HouseError("a line needs at least two parts")
        if tid not in self.data["items"]:
            mid = {k: (_num(start[k]) + _num(end[k])) / 2 for k in ("x", "y")}
            floor = target["floor_id"] if target["floor_id"] in self.floors() else OUTSIDE
            self.place(tid, floor, mid["x"], mid["y"], _num(start.get("h", 0)), None)
        parts = self.data["items"][tid].setdefault("parts", {})
        n = len(idx) - 1
        for k, i in enumerate(idx):
            t = k / n
            parts[str(i)] = {
                key: round(
                    _num(start.get(key, 0)) + (_num(end.get(key, 0)) - _num(start.get(key, 0))) * t,
                    3,
                )
                for key in ("x", "y", "h")
            }
        # The light itself sits at the middle of its parts
        item = self.data["items"][tid]
        item["x"] = round(sum(p["x"] for p in parts.values()) / len(parts), 3)
        item["y"] = round(sum(p["y"] for p in parts.values()) / len(parts), 3)
        self._save()
        return len(idx)

    def settings(self, size: dict | None = None, floors: dict | None = None) -> None:
        if size:
            w, d = (
                _num(size.get("width", self.data["size"]["width"])),
                _num(size.get("depth", self.data["size"]["depth"])),
            )
            if not (1 <= w <= 200 and 1 <= d <= 200):
                raise HouseError("the house must be 1–200 m each way")
            self.data["size"] = {"width": w, "depth": d}
        for fid, values in (floors or {}).items():
            self._check_floor(fid)
            if fid == OUTSIDE:
                continue
            saved = self.data["floors"].setdefault(fid, {})
            for key in ("elevation", "ceiling", "x0", "x1"):
                if key in values:
                    v = values[key]
                    saved[key] = None if v is None or v == "" else _num(v)
            if saved.get("ceiling") is not None and not 1.5 <= saved["ceiling"] <= 12:
                raise HouseError("a ceiling must be 1.5–12 m high")
        self._save()

    # ---- positions ---------------------------------------------------------------------------

    def world(self, tid: str) -> dict | None:
        item = self.data["items"].get(tid)
        if not item:
            return None
        return {
            "x": item["x"],
            "y": item["y"],
            "z": round(self.floor_z(item["floor"]) + item["h"], 3),
        }

    def part_world(self, tid: str, index: int) -> dict | None:
        item = self.data["items"].get(tid)
        part = ((item or {}).get("parts") or {}).get(str(index))
        if not part:
            return None
        return {
            "x": part["x"],
            "y": part["y"],
            "z": round(self.floor_z(item["floor"]) + part["h"], 3),
        }

    # ---- the front photo ---------------------------------------------------------------------
    #
    # The user marks the front door on a photo of the front of the house. Its four corners and
    # its real size (36" x 80" unless changed) fix the perspective, so everything else drawn on the
    # photo has real measurements. Shapes are kept in facade metres measured from the door's
    # bottom left corner (X across, Z up); the ground line and the leftmost wall turn them into
    # house coordinates. Drawing house blocks sets the house width; floor lines set each floor's
    # height and span.

    def photo_path(self) -> Path:
        return self.store.directory / "house_front.img"

    def set_photo(self, data: bytes, width: int, height: int) -> dict:
        if not data or len(data) > PHOTO_MAX_BYTES:
            raise HouseError("the photo must be under 15 MB")
        if photo_type(data) is None:
            raise HouseError("the photo must be a JPEG, PNG or WebP image")
        if not (16 <= width <= 20000 and 16 <= height <= 20000):
            raise HouseError("bad photo size")
        path = self.photo_path()
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
        facade = self.data.get("facade") or {}
        # A new photo needs the door marked again; the drawing is in metres, so it's kept
        facade.update({"photo": {"w": int(width), "h": int(height)}, "door": None})
        self.data["facade"] = facade
        self._save()
        return facade

    def clear_facade(self) -> None:
        self.photo_path().unlink(missing_ok=True)
        self.data["facade"] = None
        self._save()

    def set_facade(self, body: dict) -> dict:
        """Save the drawing (door, ground, blocks, openings, floor lines) and apply it."""
        facade = self.data.get("facade") or {}
        if not facade.get("photo"):
            raise HouseError("add a photo of the front first")
        pw, ph = facade["photo"]["w"], facade["photo"]["h"]
        out: dict[str, Any] = {"photo": facade["photo"]}
        door = body.get("door")
        if door:
            pts = door.get("pts") or []
            if len(pts) != 4:
                raise HouseError("the door needs four corners")
            clean = []
            for pt in pts:
                u, v = _num(pt[0], 1e5), _num(pt[1], 1e5)
                if not (-pw <= u <= 2 * pw and -ph <= v <= 2 * ph):
                    raise HouseError("a door corner is off the photo")
                clean.append([u, v])
            dw, dh = _num(door.get("w", DOOR_W_M)), _num(door.get("h", DOOR_H_M))
            if not (0.3 <= dw <= 6 and 0.3 <= dh <= 6):
                raise HouseError("the door must be 1-20 ft each way")
            out["door"] = {"pts": clean, "w": dw, "h": dh}
        else:
            out["door"] = None
        ground = body.get("ground")
        out["ground"] = None if ground is None else {"z": _num(ground.get("z", 0))}

        def rect(r: dict) -> dict:
            x0, x1 = sorted((_num(r.get("x0")), _num(r.get("x1"))))
            z0, z1 = sorted((_num(r.get("z0")), _num(r.get("z1"))))
            if x1 - x0 < 0.05 or z1 - z0 < 0.05:
                raise HouseError("a shape is too small")
            return {"x0": x0, "x1": x1, "z0": z0, "z1": z1}

        def ident(v: Any, n: int = 40) -> str:
            return str(v or "")[:n]

        blocks = []
        for b in _list(body.get("blocks"), 50):
            roof = b.get("roof") or "flat"
            if roof not in ROOFS:
                raise HouseError(f"unknown roof {roof}")
            blk = {
                "id": ident(b.get("id")),
                "name": ident(b.get("name"), 60),
                **rect(b),
                "roof": roof,
            }
            if roof != "flat":
                blk["peak_z"] = max(blk["z1"], _num(b.get("peak_z", blk["z1"] + 1.5)))
                blk["peak_x"] = min(
                    blk["x1"], max(blk["x0"], _num(b.get("peak_x", (blk["x0"] + blk["x1"]) / 2)))
                )
            for key, lo, hi in (("depth", 0.5, 200), ("y0", -50, 50)):
                if b.get(key) not in (None, ""):
                    v = _num(b[key])
                    if not lo <= v <= hi:
                        raise HouseError(f"{key} out of range")
                    blk[key] = v
            blocks.append(blk)
        out["blocks"] = blocks
        openings = []
        for o in _list(body.get("openings"), 300):
            kind = o.get("kind") or "window"
            if kind not in OPENINGS:
                raise HouseError(f"unknown opening {kind}")
            openings.append({"id": ident(o.get("id")), "kind": kind, **rect(o)})
        out["openings"] = openings
        lines = []
        floors = self.floors()
        for ln in _list(body.get("lines"), 30):
            fid = str(ln.get("floor") or "")
            if fid and fid not in floors:
                raise HouseError(f"unknown floor {fid}")
            x0, x1 = sorted((_num(ln.get("x0")), _num(ln.get("x1"))))
            lines.append(
                {
                    "id": ident(ln.get("id")),
                    "floor": fid or None,
                    "x0": x0,
                    "x1": x1,
                    "z": _num(ln.get("z")),
                }
            )
        out["lines"] = lines
        self.data["facade"] = out
        self._apply_facade()
        self._save()
        return out

    def facade_origin(self) -> tuple[float, float]:
        """Facade metres of the house's left edge and of the ground."""
        f = self.data.get("facade") or {}
        blocks = f.get("blocks") or []
        ox = min((b["x0"] for b in blocks), default=0.0)
        gz = (f.get("ground") or {}).get("z", 0.0)
        return ox, gz

    def _apply_facade(self) -> None:
        f = self.data["facade"]
        if not f.get("door"):
            return
        ox, gz = self.facade_origin()
        blocks = f.get("blocks") or []
        if blocks:
            width = round(max(b["x1"] for b in blocks) - ox, 3)
            self.data["size"]["width"] = min(200.0, max(1.0, width))
        width = self.data["size"]["width"]
        for ln in f.get("lines") or []:
            if not ln["floor"]:
                continue
            x0, x1 = max(0.0, ln["x0"] - ox), min(width, ln["x1"] - ox)
            whole = x1 - x0 >= 0.95 * width
            saved = self.data["floors"].setdefault(ln["floor"], {})
            saved.update(
                {
                    "elevation": round(ln["z"] - gz, 3),
                    "x0": None if whole else round(x0, 3),
                    "x1": None if whole else round(x1, 3),
                }
            )

    def massing(self) -> dict | None:
        """The drawn house in house coordinates, for the 3D view."""
        f = self.data.get("facade") or {}
        if not f.get("door") or not f.get("blocks"):
            return None
        ox, gz = self.facade_origin()
        depth = self.data["size"]["depth"]

        def world(r: dict) -> dict:
            return {
                "x0": round(r["x0"] - ox, 3),
                "x1": round(r["x1"] - ox, 3),
                "z0": round(r["z0"] - gz, 3),
                "z1": round(r["z1"] - gz, 3),
            }

        blocks = []
        for b in f["blocks"]:
            w = {
                "name": b.get("name", ""),
                **world(b),
                "roof": b["roof"],
                "y0": b.get("y0", 0.0),
                "depth": b.get("depth", depth),
            }
            if b["roof"] != "flat":
                w["peak_x"] = round(b["peak_x"] - ox, 3)
                w["peak_z"] = round(b["peak_z"] - gz, 3)
            blocks.append(w)
        openings = [{"kind": o["kind"], **world(o)} for o in f.get("openings") or []]
        return {"blocks": blocks, "openings": openings}

    def view(self) -> dict:
        inv: Inventory = self.inventory.inventory
        floors = self.floors()
        return {
            "size": self.data["size"],
            "floors": [
                {"id": fid, "name": inv.floors[fid].name, "level": inv.floors[fid].level, **f}
                for fid, f in sorted(floors.items(), key=lambda kv: -kv[1]["elevation"])
                if fid in inv.floors
            ],
            "outside": OUTSIDE,
            "mounts": [{"id": k, "label": v["label"]} for k, v in MOUNTS.items()],
            "targets": self.targets(),
            "lights": self.data["items"],
            "facade": self.data.get("facade"),
            "massing": self.massing(),
        }

    def _save(self) -> None:
        self.store.save("house", self.data)


def photo_type(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def _list(v: Any, most: int) -> list[dict]:
    if v is None:
        return []
    if not isinstance(v, list) or len(v) > most or not all(isinstance(x, dict) for x in v):
        raise HouseError(f"expected a list of at most {most} shapes")
    return v


def _num(v: Any, limit: float = 1000) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError) as err:
        raise HouseError(f"not a number: {v!r}") from err
    if math.isnan(f) or math.isinf(f) or abs(f) > limit:
        raise HouseError(f"out of range: {v!r}")
    return round(f, 3)


def _wled_mac(light: Light) -> str | None:
    from .drivers.wled import wled_ids

    ids = wled_ids(light)
    return ids[0] if ids else None


def _wled_seg(light: Light) -> int | None:
    from .drivers.wled import wled_ids

    ids = wled_ids(light)
    return ids[1] if ids else None
