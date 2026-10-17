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
from typing import Any

from .inventory.model import Inventory, Kind, Light
from .store import JsonStore

OUTSIDE = "_outside"
STOREY_M = 2.7
CEILING_M = 2.4
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
    """A first guess: one storey per HA level, the 'main' level at the ground."""
    real = [f for f in inv.floors.values() if not f.id.startswith("_")]
    levels = sorted({f.level for f in real if f.level is not None})
    ref = next((f.level for f in real if "main" in f.name.lower() and f.level is not None), None)
    if ref is None:
        ref = next((lv for lv in levels if lv >= 0), levels[0] if levels else 0)
    out = {}
    for i, f in enumerate(sorted(real, key=lambda f: (f.level is None, f.level or 0))):
        level = f.level if f.level is not None else i
        out[f.id] = {
            "elevation": round((level - ref) * STOREY_M, 2),
            "ceiling": CEILING_M,
            "x0": None,
            "x1": None,
        }
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
        }

    def _save(self) -> None:
        self.store.save("house", self.data)


def _num(v: Any) -> float:
    try:
        f = float(v)
    except (TypeError, ValueError) as err:
        raise HouseError(f"not a number: {v!r}") from err
    if math.isnan(f) or math.isinf(f) or abs(f) > 1000:
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
