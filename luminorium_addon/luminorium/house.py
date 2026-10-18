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

from . import house_site
from .house_site import SiteError
from .inventory.model import Inventory, Kind, Light
from .store import JsonStore

OUTSIDE = "_outside"
# A standard front door: 36" x 80"
DOOR_W_M = 0.9144
DOOR_H_M = 2.032
# How a roof, drawn as its outline seen from the street, goes back from the front:
# extrude: the same shape all the way back (a gable facing the street, a flat roof)
# ridge: the outline is the front slope, up to a ridge `ridge_y` back, then down the back
#        (drawn as a trapezoid it's a hip; as a rectangle with the gable ends at the sides)
# shed: one slope, from the front up to the back
ROOF_BACKS = ("extrude", "ridge", "shed")
OPENINGS = ("window", "door", "garage")
PHOTO_MAX_BYTES = 15 * 1024 * 1024
# Lights that point somewhere, and their usual beam width (degrees)
AIM_KINDS = {"flood": 90, "spot": 25, "wall": 180}
# Soffits stick out about 24" past the walls on most houses
EAVE_M = 0.6096
# Joists and subfloor between a ceiling and the floor above it: about 12"
FLOOR_DEPTH_M = 0.3048
STOREY_M = 2.7
CEILING_M = 2.4
# The deepest a floor goes by default: one storey below the ground
BASEMENT_DEPTH_M = 2.4
# Mount types and the height above the floor (m) each suggests; ceiling-hung ones follow the ceiling
MOUNTS: dict[str, dict[str, Any]] = {
    "ceiling": {"label": "Ceiling", "below_ceiling": 0.05},
    "flush": {"label": "Flush mount", "below_ceiling": 0.12},
    "can": {"label": "Can (recessed)", "below_ceiling": 0.0},
    "fan": {"label": "Ceiling fan", "below_ceiling": 0.45},
    "pendant": {"label": "Pendant", "below_ceiling": 0.6},
    "wall": {"label": "Wall", "h": 1.8},
    "floor_lamp": {"label": "Floor lamp", "h": 1.5},
    "table": {"label": "Tabletop", "h": 0.8},
    "under_cabinet": {"label": "Under cabinet", "h": 1.3716},  # 36" counter + 18"
    "soffit": {"label": "Under the eaves", "h": 2.6},
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


def _fit_unset(floors: dict[str, dict], known: set[str]) -> None:
    """Move the floors the user hasn't set to fit the ones they have. Floors are in level order
    (as default_floors gives them); one between two set floors goes evenly between them, one
    beyond them keeps going at the step between its nearest two set floors (one storey when only
    one is set). Without this, a floor line drawn for Main at +3' 8" left the levels under it
    where the first guess put them, with Main at 0."""
    order = list(floors)
    idx = [i for i, fid in enumerate(order) if fid in known]
    if not idx or len(idx) == len(order):
        return
    z = {i: floors[order[i]]["elevation"] for i in idx}

    def step(a: int, b: int) -> float:
        return (z[b] - z[a]) / (b - a)

    for i, fid in enumerate(order):
        if fid in known:
            continue
        below = [k for k in idx if k < i]
        above = [k for k in idx if k > i]
        if below and above:
            a, b = below[-1], above[0]
            elevation = z[a] + step(a, b) * (i - a)
        elif below:
            a = below[-1]
            s = step(below[-2], a) if len(below) > 1 else STOREY_M
            elevation = z[a] + s * (i - a)
        else:
            b = above[0]
            s = step(b, above[1]) if len(above) > 1 else STOREY_M
            elevation = z[b] - s * (b - i)
        floors[fid]["elevation"] = round(elevation, 2)


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
        _migrate_roofs(self.data.get("facade"))

    # ---- floors ---------------------------------------------------------------------------

    def floors(self) -> dict[str, dict]:
        inv: Inventory = self.inventory.inventory
        merged = default_floors(inv)
        for fid, saved in self.data["floors"].items():
            if fid in merged:
                merged[fid].update(
                    {k: v for k, v in saved.items() if k in ("elevation", "ceiling", "x0", "x1")}
                )
        known = {fid for fid, s in self.data["floors"].items() if "elevation" in s}
        _fit_unset(merged, known)
        for fid, f in merged.items():
            f["set"] = fid in known  # False: guessed from the others
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
                    # a group can be several fixtures too (two cabinet lights grouped)
                    self._fixture_parts(fx.id),
                )
            )
        for lt in inv.lights.values():
            if lt.kind not in (Kind.LIGHT, Kind.SWITCH) or not lt.included or lt.fixture:
                continue
            if lt.integration == "wled" and _wled_seg(lt) is not None and _wled_mac(lt) in masters:
                continue
            out.append(
                self._target(
                    lt.entity_id,
                    "light",
                    lt.name,
                    lt.area_id,
                    lt.floor_id,
                    lt,
                    self.parts_for(lt) or self._fixture_parts(lt.entity_id),
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
            # several fixtures run by one switch (cans on one dimmer): each is a part
            "fixtures": (item or {}).get("fixtures", 0),
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
        aim = item.get("aim")
        if aim and aim.get("at"):
            # still pointing at what it was aimed at
            pointed = _aim_towards(self.world(tid), aim["at"])
            if pointed:
                aim.update(pointed)
        self._save()
        return item

    def mount_height(self, mount: str, floor: str) -> float:
        m = MOUNTS[mount]
        if "below_ceiling" in m:
            return round(max(0.0, self.ceiling(floor) - m["below_ceiling"]), 2)
        return float(m["h"])

    def set_aim(self, tid: str, aim: dict | None) -> dict:
        """Where a light points. kind: flood, spot or wall (a half dome); beam: its width in
        degrees; tilt: -90 (straight down) to 90 (straight up); heading: degrees clockwise seen
        from above, 0 facing the street. None: it lights all around (nothing to aim)."""
        self._check_target(tid)
        item = self.data["items"].get(tid)
        if item is None:
            raise HouseError("place the light first")
        if not aim:
            item.pop("aim", None)
        else:
            kind = aim.get("kind")
            if kind not in AIM_KINDS:
                raise HouseError(f"unknown beam {kind}")
            beam = _num(aim.get("beam", AIM_KINDS[kind]))
            tilt = _num(aim.get("tilt", 0))
            heading = _num(aim.get("heading", 0)) % 360
            if not 2 <= beam <= 180 or not -90 <= tilt <= 90:
                raise HouseError("a beam is 2-180° wide, tilted -90° to 90°")
            new = {"kind": kind, "beam": beam, "tilt": tilt, "heading": round(heading, 1)}
            at = aim.get("at")
            if at:
                # aimed at a spot (a wall, the ground, a tree): it stays aimed there when moved
                new["at"] = {k: _num(at.get(k)) for k in ("x", "y", "z")}
                pointed = _aim_towards(self.world(tid), new["at"])
                if pointed is None:
                    raise HouseError("that's where the light is")
                new.update(pointed)
            if aim.get("what"):
                new["what"] = str(aim["what"])[:60]  # what it's aimed at, in words
            item["aim"] = new
        self._save()
        return item

    def remove(self, tid: str) -> None:
        if self.data["items"].pop(tid, None) is None:
            raise KeyError(tid)
        self._save()

    def _fixture_parts(self, tid: str) -> list[Part]:
        n = (self.data["items"].get(tid) or {}).get("fixtures", 0)
        return [Part(i, f"Fixture {i + 1}") for i in range(n)]

    def set_form(self, tid: str, form: dict | None) -> dict:
        """What a light looks like: a bulb (the default), or a bar or strip with a length (m),
        which way it lies (rot: degrees clockwise from above, 0 across the house) and which way it
        shines (face: down, up, or side, toward rot + 90°). None: a bulb again."""
        self._check_target(tid)
        item = self.data["items"].get(tid)
        if item is None:
            raise HouseError("place the light first")
        if not form or form.get("form", "bulb") == "bulb":
            item.pop("form", None)
        else:
            kind = form.get("form")
            if kind not in ("bar", "strip"):
                raise HouseError(f"unknown light form {kind}")
            length = _num(form.get("length", 1.0 if kind == "bar" else 2.0))
            if not 0.05 <= length <= 30:
                raise HouseError("a bar or strip is 2 in to 100 ft long")
            face = form.get("face", "down")
            if face not in ("down", "up", "side"):
                raise HouseError(f"unknown facing {face}")
            item["form"] = {
                "form": kind,
                "length": length,
                "rot": _num(form.get("rot", 0)) % 360,
                "face": face,
            }
        self._save()
        return self.view()

    def set_fixtures(self, tid: str, count: int) -> dict:
        """A light that is several fixtures on one switch (cans on one dimmer): `count` parts,
        each placed on its own. New ones start in a row from the light, 4 ft apart; 0 makes it
        one fixture again."""
        target = self._check_target(tid)
        if target["kind"] not in ("light", "fixture"):
            raise HouseError("only a light or a group of lights can be several fixtures")
        if any(p["entity_id"] or not p["label"].startswith("Fixture") for p in target["parts"]):
            raise HouseError("this light's parts are its own segments")
        item = self.data["items"].get(tid)
        if item is None:
            raise HouseError("place the light first")
        count = int(_num(count))
        if count != 0 and not 2 <= count <= 50:
            raise HouseError("2 to 50 fixtures")
        parts = item.setdefault("parts", {})
        if count == 0:
            item.pop("fixtures", None)
            item.pop("parts", None)
        else:
            had = item.get("fixtures", 0)
            for i in range(count):
                if str(i) not in parts:
                    # the first one where the light is, the rest in a row beside it
                    parts[str(i)] = {
                        "x": round(item["x"] + 1.2192 * i, 3),
                        "y": item["y"],
                        "h": item["h"],
                    }
            for i in range(count, max(had, count)):
                parts.pop(str(i), None)
            item["fixtures"] = count
        self._save()
        return item

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
        if item.get("fixtures"):
            # one switch, several fixtures: the light itself is in the middle of them
            item["x"] = round(sum(q["x"] for q in parts.values()) / len(parts), 3)
            item["y"] = round(sum(q["y"] for q in parts.values()) / len(parts), 3)
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

    def photo_path(self, which: str = "front") -> Path:
        return self.store.directory / ("house_top.img" if which == "top" else "house_front.img")

    def set_photo(self, data: bytes, width: int, height: int, which: str = "front") -> dict:
        if not data or len(data) > PHOTO_MAX_BYTES:
            raise HouseError("the photo must be under 15 MB")
        if photo_type(data) is None:
            raise HouseError("the photo must be a JPEG, PNG or WebP image")
        if not (16 <= width <= 20000 and 16 <= height <= 20000):
            raise HouseError("bad photo size")
        path = self.photo_path(which)
        tmp = path.with_suffix(".tmp")
        tmp.write_bytes(data)
        tmp.replace(path)
        if which == "top":
            site = self.data.get("site") or {}
            # A new photo needs squaring up and scaling again; the drawing (in metres) is kept
            for key in ("xf", "square", "ref", "check"):
                site.pop(key, None)
            site["photo"] = {"w": int(width), "h": int(height)}
            self.data["site"] = site
            self._save()
            return site
        facade = self.data.get("facade") or {}
        # A new photo needs the door marked again; the drawing is in metres, so it's kept
        facade.update({"photo": {"w": int(width), "h": int(height)}, "door": None})
        self.data["facade"] = facade
        self._save()
        return facade

    # ---- the top view ----------------------------------------------------------------------

    def set_site(self, body: dict) -> dict:
        """Save the top view (placement, roof outline, yard, floor plans) and apply it: the plan
        sets how deep the house is."""
        site = self.data.get("site") or {}
        inv: Inventory = self.inventory.inventory
        try:
            out = house_site.clean_site(body, site.get("photo"), set(self.floors()), set(inv.areas))
        except SiteError as err:
            raise HouseError(str(err)) from err
        self.data["site"] = out
        plan = self.plan()
        if plan:
            back = max(p[1] for p in plan)
            if back > 1:
                self.data["size"]["depth"] = round(min(200.0, back), 3)
        self._save()
        return out

    def clear_site(self) -> None:
        self.photo_path("top").unlink(missing_ok=True)
        self.data["site"] = None
        self._save()

    def plan(self) -> list[list[float]] | None:
        """The outside walls: the roof outline on the top view, less the eaves."""
        site = self.data.get("site") or {}
        eave = (self.data.get("facade") or {}).get("eave", EAVE_M)
        return house_site.plan_of(site, eave)

    def top(self) -> dict | None:
        """The top view's drawing as the 3D view and the page use it."""
        site = self.data.get("site")
        if not site:
            return None
        ext = site.get("ext_wall", "2x6")
        return {
            "plan": self.plan(),
            "outline": site.get("outline"),
            "ext_thick": round(house_site.exterior_thickness(ext), 4),
            "yard": site.get("yard") or [],
            "walls": house_site.walls_3d(site),
            "doors": site.get("doors") or [],
            "rooms": site.get("rooms") or [],
            "stairs": site.get("stairs") or [],
        }

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
        if facade.get("ox") is not None:
            out["ox"] = facade["ox"]
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
            recess = _num(door.get("recess", 0))
            if not 0 <= recess <= 5:
                raise HouseError("a door is set back 0-15 ft")
            out["door"] = {"pts": clean, "w": dw, "h": dh, "recess": recess}
        else:
            out["door"] = None
        ground = body.get("ground")
        out["ground"] = None if ground is None else {"z": _num(ground.get("z", 0))}
        if ground and ground.get("pts"):
            # the traced ground line (photo px) and where each point is on the ground
            pts = ground["pts"]
            if not isinstance(pts, list) or not 2 <= len(pts) <= 40:
                raise HouseError("the ground line needs 2 to 40 points")
            out["ground"]["pts"] = [[_num(p[0], 1e5), _num(p[1], 1e5)] for p in pts]
            foot = ground.get("footprint")
            if foot:
                if not isinstance(foot, list) or len(foot) != len(pts):
                    raise HouseError("the ground footprint doesn't match the ground line")
                out["ground"]["footprint"] = [[_num(p[0]), _num(p[1])] for p in foot]
        eave = _num(body.get("eave", EAVE_M))
        if not 0 <= eave <= 2:
            raise HouseError("eaves stick out 0-6 ft")
        out["eave"] = eave
        edges = []
        for e in _list(body.get("edges"), 20):
            pts = e.get("pts") or []
            if not isinstance(pts, list) or not 2 <= len(pts) <= 60:
                raise HouseError("a roof edge line needs 2 to 60 points")
            edges.append(
                {"id": str(e.get("id") or "")[:40], "pts": [[_num(p[0]), _num(p[1])] for p in pts]}
            )
        out["edges"] = edges
        # 2: roof edge lines measured at the eaves (before, by mistake, on the wall's plane)
        out["edges_v"] = 2 if body.get("edges_v") == 2 else 1
        floor_depth = _num(body.get("floor_depth", FLOOR_DEPTH_M))
        if not 0 <= floor_depth <= 1:
            raise HouseError("a floor is 0-3 ft thick")
        out["floor_depth"] = floor_depth

        def rect(r: dict) -> dict:
            x0, x1 = sorted((_num(r.get("x0")), _num(r.get("x1"))))
            z0, z1 = sorted((_num(r.get("z0")), _num(r.get("z1"))))
            if x1 - x0 < 0.05 or z1 - z0 < 0.05:
                raise HouseError("a shape is too small")
            return {"x0": x0, "x1": x1, "z0": z0, "z1": z1}

        def ident(v: Any, n: int = 40) -> str:
            return str(v or "")[:n]

        blocks = []
        floors = self.floors()
        _migrate_roofs(body)  # a page from before roofs were their own shapes
        for b in _list(body.get("blocks"), 50):
            blk = {"id": ident(b.get("id")), "name": ident(b.get("name"), 60), **rect(b)}
            if b.get("behind"):
                blk["behind"] = True  # behind another block: not on the photo
            if b.get("group"):
                blk["group"] = ident(b["group"])  # joined with the blocks in the same group
            for key in ("floor", "level"):
                # level: the HA floor this part of the house belongs to; floor: the HA floor
                # whose floor is this block's bottom (a basement in the ground)
                if b.get(key):
                    if b[key] not in floors:
                        raise HouseError(f"unknown floor {b[key]}")
                    blk[key] = str(b[key])
            if b.get("face"):
                if b["face"] not in ("line", "out", "back", "auto"):
                    raise HouseError(f"unknown front face {b['face']}")
                blk["face"] = b["face"]
            if b.get("offset") not in (None, ""):
                off = _num(b["offset"])
                if not -5 <= off <= 5:
                    raise HouseError("a space's floor is within 15 ft of its level's")
                blk["offset"] = off
            for key, lo, hi in (("depth", 0.5, 200), ("y0", -50, 50), ("below", 0, 10)):
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
        roofs = []
        for r in _list(body.get("roofs"), 30):
            back = r.get("back") or "ridge"
            if back not in ROOF_BACKS:
                raise HouseError(f"unknown roof shape {back}")
            pts = r.get("pts") or []
            if not isinstance(pts, list) or not 3 <= len(pts) <= 40:
                raise HouseError("a roof outline needs 3 to 40 points")
            roof = {
                "id": ident(r.get("id")),
                "name": ident(r.get("name"), 60),
                "pts": [[_num(p[0]), _num(p[1])] for p in pts],
                "back": back,
            }
            zs = [p[1] for p in roof["pts"]]
            xs = [p[0] for p in roof["pts"]]
            if max(xs) - min(xs) < 0.1 or max(zs) - min(zs) < 0.05:
                raise HouseError("a roof outline is too small")
            for key, lo, hi in (("depth", 0.3, 200), ("y0", -50, 50), ("ridge_y", 0, 200)):
                if r.get(key) not in (None, ""):
                    v = _num(r[key])
                    if not lo <= v <= hi:
                        raise HouseError(f"roof {key} out of range")
                    roof[key] = v
            roofs.append(roof)
        out["roofs"] = roofs
        lines = []
        for ln in _list(body.get("lines"), 30):
            fid = str(ln.get("floor") or "")
            if fid and fid not in floors:
                raise HouseError(f"unknown floor {fid}")
            x0, x1 = sorted((_num(ln.get("x0")), _num(ln.get("x1"))))
            at = ln.get("at") or "floor"
            if at not in ("floor", "below"):
                raise HouseError("a floor line marks the floor, or the ceiling below it")
            lines.append(
                {
                    "id": ident(ln.get("id")),
                    "floor": fid or None,
                    "x0": x0,
                    "x1": x1,
                    "z": _num(ln.get("z")),
                    "at": at,
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
        blocks = [b for b in f.get("blocks") or [] if not b.get("behind")]
        ox = f["ox"] if f.get("ox") is not None else min((b["x0"] for b in blocks), default=0.0)
        gz = (f.get("ground") or {}).get("z", 0.0)
        return ox, gz

    def _apply_facade(self) -> None:
        f = self.data["facade"]
        if not f.get("door"):
            return
        blocks = f.get("blocks") or []
        if blocks and f.get("ox") is None:
            # fix the house's left edge once there are blocks
            f["ox"] = (
                min(b["x0"] for b in blocks if not b.get("behind"))
                if any(not b.get("behind") for b in blocks)
                else min(b["x0"] for b in blocks)
            )
        ox, gz = self.facade_origin()
        if blocks:
            width = round(max(b["x1"] for b in blocks) - min(ox, *(b["x0"] for b in blocks)), 3)
            self.data["size"]["width"] = min(200.0, max(1.0, width))
        width = self.data["size"]["width"]
        depth = f.get("floor_depth", FLOOR_DEPTH_M)
        placed = []  # (elevation, x0, x1, floor id)
        for ln in f.get("lines") or []:
            if not ln["floor"]:
                continue
            x0, x1 = max(0.0, ln["x0"] - ox), min(width, ln["x1"] - ox)
            whole = x1 - x0 >= 0.95 * width
            # A line on the ceiling below: the floor itself is the joists' depth higher
            elevation = ln["z"] - gz + (depth if ln.get("at") == "below" else 0.0)
            saved = self.data["floors"].setdefault(ln["floor"], {})
            saved.update(
                {
                    "elevation": round(elevation, 3),
                    "x0": None if whole else round(x0, 3),
                    "x1": None if whole else round(x1, 3),
                }
            )
            placed.append((elevation, x0, x1, ln["floor"]))
        # A block whose bottom is a floor (a basement): that floor sits there, unless a line
        # says otherwise
        lined = {fid for _, _, _, fid in placed}
        for b in blocks:
            fid = b.get("floor")
            if not fid or fid in lined:
                continue
            x0, x1 = max(0.0, b["x0"] - ox), min(width, b["x1"] - ox)
            whole = x1 - x0 >= 0.95 * width
            elevation = b["z0"] - gz - b.get("below", 0.0)
            self.data["floors"].setdefault(fid, {}).update(
                {
                    "elevation": round(elevation, 3),
                    "x0": None if whole else round(x0, 3),
                    "x1": None if whole else round(x1, 3),
                }
            )
            placed.append((elevation, x0, x1, fid))
            lined.add(fid)
        # A floor's ceiling is the underside of the next floor drawn above it, over the same part
        # of the house
        for elevation, x0, x1, fid in placed:
            above = [
                e
                for e, a0, a1, _ in placed
                if e > elevation + 1.5 and min(x1, a1) - max(x0, a0) > 0.5
            ]
            if above:
                ceiling = round(min(above) - depth - elevation, 3)
                if 1.5 <= ceiling <= 12:
                    self.data["floors"][fid]["ceiling"] = ceiling

    # ---- changing blocks in 3D ------------------------------------------------------------

    def _block(self, bid: str) -> dict:
        f = self.data.get("facade") or {}
        for b in f.get("blocks") or []:
            if b.get("id") == bid:
                return b
        raise KeyError(f"block {bid}")

    def _block_depth(self, b: dict) -> float:
        m = self.massing() or {}
        for w in m.get("blocks") or []:
            if w["id"] == b.get("id"):
                return w["depth"]
        return b.get("depth", self.data["size"]["depth"])

    def set_block(self, bid: str, change: dict) -> dict:
        """Move a block's faces, in house metres: x0, x1 (left, right), z1 (top), z0 (bottom),
        y0 (front; only for a block behind another), depth (to its back)."""
        b = self._block(bid)
        ox, gz = self.facade_origin()
        new = dict(b)
        if "x0" in change:
            new["x0"] = _num(change["x0"]) + ox
        if "x1" in change:
            new["x1"] = _num(change["x1"]) + ox
        if "z1" in change:
            new["z1"] = _num(change["z1"]) + gz
        if "z0" in change:
            new["z0"] = _num(change["z0"]) + gz + new.get("below", 0.0)
        if "y0" in change:
            new["y0"] = _num(change["y0"])
            if not b.get("behind"):
                # a block on the photo: its front wall now sticks out, is set back, or is in line
                y0 = new["y0"]
                new["face"] = "line" if abs(y0) < 0.005 else "out" if y0 < 0 else "back"
        if "depth" in change:
            depth = _num(change["depth"])
            if not 0.3 <= depth <= 200:
                raise HouseError("a block is 1-650 ft deep")
            new["depth"] = depth
        if "name" in change:
            new["name"] = str(change["name"] or "")[:60]
        if "group" in change:
            # joined to other blocks (one shape, moved together), or not
            if change["group"]:
                new["group"] = str(change["group"])[:40]
            else:
                new.pop("group", None)
        if "level" in change:
            if change["level"] and change["level"] not in self.floors():
                raise HouseError(f"unknown floor {change['level']}")
            if change["level"]:
                new["level"] = change["level"]
            else:
                for k in ("level", "offset", "floor"):
                    new.pop(k, None)
        if "offset" in change:
            off = _num(change["offset"] or 0)
            if not -5 <= off <= 5:
                raise HouseError("a space's floor is within 15 ft of its level's")
            if off:
                new["offset"] = off
            else:
                new.pop("offset", None)
        if new["x1"] - new["x0"] < 0.3 or new["z1"] - new["z0"] < 0.3:
            raise HouseError("a block is at least 1 ft each way")
        b.clear()
        b.update({k: round(v, 3) if isinstance(v, float) else v for k, v in new.items()})
        self._apply_facade()
        self._save()
        return b

    def add_block(self, body: dict) -> dict:
        """A new block made in 3D (house metres: x0, x1, y0, depth, z0, z1; name; level). It isn't
        on the front photo."""
        f = self.data.get("facade") or {}
        if not f.get("door"):
            raise HouseError("measure the house from the front photo first")
        ox, gz = self.facade_origin()
        x0, x1 = sorted((_num(body.get("x0", 0)), _num(body.get("x1", 3))))
        z0, z1 = sorted((_num(body.get("z0", 0)), _num(body.get("z1", 2.4))))
        depth = _num(body.get("depth", 3))
        if x1 - x0 < 0.3 or z1 - z0 < 0.3 or not 0.3 <= depth <= 200:
            raise HouseError("a block is at least 1 ft each way")
        blocks = f.setdefault("blocks", [])
        n = len(blocks) + 1
        while any(b.get("id") == f"b{n}" for b in blocks):
            n += 1
        block = {
            "id": f"b{n}",
            "name": str(body.get("name") or f"Block {n}")[:60],
            "x0": round(x0 + ox, 3),
            "x1": round(x1 + ox, 3),
            "z0": round(z0 + gz, 3),
            "z1": round(z1 + gz, 3),
            "y0": _num(body.get("y0", 0)),
            "depth": depth,
            "behind": True,
            "face": "back",
        }
        if body.get("level"):
            if body["level"] not in self.floors():
                raise HouseError(f"unknown floor {body['level']}")
            block["level"] = body["level"]
        blocks.append(block)
        self._apply_facade()
        self._save()
        return block

    def remove_block(self, bid: str) -> None:
        f = self.data.get("facade") or {}
        b = self._block(bid)
        f["blocks"].remove(b)
        self._apply_facade()
        self._save()

    def split_block(self, bid: str, front_depth: float) -> dict:
        """Split a block front to back: the front part keeps `front_depth`, a new block behind
        it takes the rest, with the same left, right, top, bottom and level to start with."""
        b = self._block(bid)
        total = self._block_depth(b)
        front_depth = _num(front_depth)
        if not 0.3 <= front_depth <= total - 0.3:
            raise HouseError("split somewhere inside the block, at least 1 ft from each end")
        back = {k: v for k, v in b.items() if k not in ("id", "name", "face", "depth", "floor")}
        back.update(
            {
                "id": f"{b.get('id', 'b')}-{len((self.data['facade'] or {}).get('blocks') or [])}",
                "name": f"{b.get('name') or 'Block'} (back)",
                "behind": True,
                "face": "back",
                "y0": round(b.get("y0", 0.0) + front_depth, 3),
                "depth": round(total - front_depth, 3),
            }
        )
        b["depth"] = round(front_depth, 3)
        self.data["facade"]["blocks"].append(back)
        self._apply_facade()
        self._save()
        return back

    def massing(self) -> dict | None:
        """The drawn house in house coordinates, for the 3D view."""
        f = self.data.get("facade") or {}
        if not f.get("door") or not f.get("blocks"):
            return None
        ox, gz = self.facade_origin()
        depth = self.data["size"]["depth"]
        plan = self.plan()

        def depth_of(b: dict) -> float:
            # a block without its own depth goes back as far as the plan does over its width
            if "depth" in b:
                return b["depth"]
            if plan:
                span = house_site.depth_over(plan, b["x0"] - ox, b["x1"] - ox)
                if span and span[1] - b.get("y0", 0.0) > 0.5:
                    return round(span[1] - b.get("y0", 0.0), 3)
            return depth

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
                "id": b.get("id", ""),
                "name": b.get("name", ""),
                "behind": bool(b.get("behind")),
                **world(b),
                "y0": b.get("y0", 0.0),
                "depth": depth_of(b),
            }
            if b.get("below"):
                # It goes on into the ground (a basement): its bottom is that far under its
                # drawn bottom
                w["z0"] = round(w["z0"] - b["below"], 3)
                w["below"] = b["below"]
            if b.get("group"):
                w["group"] = b["group"]
            if b.get("level"):
                # a space inside a level, with its own floor (a landing, storage over the entry)
                w["level"] = b["level"]
                w["offset"] = b.get("offset", 0.0)
            blocks.append(w)
        roofs = []
        for r in f.get("roofs") or []:
            d = r.get("depth", depth)
            roofs.append(
                {
                    "name": r.get("name", ""),
                    "pts": [[round(x - ox, 3), round(z - gz, 3)] for x, z in r["pts"]],
                    "back": r["back"],
                    "y0": r.get("y0", 0.0),
                    "depth": d,
                    "ridge_y": min(d, r.get("ridge_y", d / 2)),
                }
            )

        # Each window or door sits on the front wall of the block it's drawn in (as the front
        # photo has it): the one around its middle, across and up
        def wall_y(o: dict) -> float:
            x, z = (o["x0"] + o["x1"]) / 2, (o["z0"] + o["z1"]) / 2
            for b in f["blocks"]:
                if b.get("behind"):
                    continue
                if b["x0"] <= x <= b["x1"] and b["z0"] - 0.05 <= z <= b["z1"] + 0.05:
                    return b.get("y0", 0.0)
            return 0.0

        openings = [
            {"id": o.get("id", ""), "kind": o["kind"], **world(o), "y": wall_y(o)}
            for o in f.get("openings") or []
        ]
        foot = (f.get("ground") or {}).get("footprint")
        edges = f.get("edges") or []
        xs = [p[0] for e in edges for p in e["pts"]]
        return {
            "blocks": blocks,
            "openings": openings,
            "roofs": roofs,
            # the front of the house along the ground, from the ground line's bends
            "footprint": [[round(x - ox, 3), round(y, 3)] for x, y in foot] if foot else None,
            "roofline": round(max(xs) - min(xs), 3) if xs else None,
            "eave": f.get("eave", EAVE_M),
        }

    def master_of(self, entity_id: str) -> str | None:
        """The house-map target a light is placed as: itself, or a WLED segment light's main
        light (segment lights fold into it)."""
        if entity_id in self.data["items"]:
            return entity_id
        inv: Inventory = self.inventory.inventory
        light = inv.lights.get(entity_id)
        if light is None or light.integration != "wled" or _wled_seg(light) is None:
            return None
        mac = _wled_mac(light)
        for other in inv.lights.values():
            if (
                other.kind == Kind.LIGHT
                and other.integration == "wled"
                and _wled_seg(other) is None
                and _wled_mac(other) == mac
            ):
                return other.entity_id
        return None

    def position_of(self, element: str) -> dict | None:
        """Where a show element (a light or a fixture) is, for animations; None if not placed."""
        target = self.master_of(element) or element
        return self.world(target)

    # ---- checks ----------------------------------------------------------------------------
    #
    # Plain arithmetic, no guessing: numbers that should agree and don't, and things not done
    # yet that the map is guessing instead. Each says what to look at and where (`tab`).

    def checks(self) -> list[dict]:
        out: list[dict] = []

        def add(level: str, tab: str, text: str) -> None:
            out.append({"level": level, "tab": tab, "text": text})

        inv: Inventory = self.inventory.inventory
        f = self.data.get("facade") or {}
        site = self.data.get("site") or {}
        floors = self.floors()
        if f.get("photo") and not f.get("door"):
            add(
                "info",
                "photo",
                "Mark the front door on the front photo: everything is measured from it.",
            )
        if f.get("door") and not f.get("ground"):
            add("warn", "photo", "No ground line yet, so heights are measured from the door sill.")
        # the roofline from the front against the roof outline from above
        m = self.massing()
        if m and m.get("roofline") and site.get("outline"):
            xs = [p[0] for p in site["outline"]]
            above = max(xs) - min(xs)
            front = m["roofline"]
            if abs(above - front) / front > 0.03:
                add(
                    "warn",
                    "top",
                    f"The roof is {_ft(above)} across from above but {_ft(front)} on the front "
                    "photo. Check the roof edge lines on both, or the roof outline's corners.",
                )
        # the front-to-back check line on the top view
        chk, xf = site.get("check"), site.get("xf")
        if chk and xf and chk.get("length") and len(chk.get("pts") or []) >= 2:
            a = house_site.photo_to_house(xf, *chk["pts"][0])
            b = house_site.photo_to_house(xf, *chk["pts"][-1])
            deep = abs(b[1] - a[1])
            err = (deep - chk["length"]) / chk["length"]
            if abs(err) > 0.03:
                add(
                    "warn",
                    "top",
                    f"Front to back, the top view measures {_ft(deep)}, not the "
                    f"{_ft(chk['length'])} given ({err:+.0%}). The photo may lean, or the scale "
                    "line is off.",
                )
        # floors: in Home Assistant's order, with room for their ceilings
        real = sorted(
            (fl for fl in inv.floors.values() if fl.id in floors and fl.level is not None),
            key=lambda fl: fl.level,
        )
        for lo, hi in zip(real, real[1:], strict=False):
            if floors[hi.id]["elevation"] <= floors[lo.id]["elevation"]:
                add(
                    "warn",
                    "floors",
                    f"{hi.name} is at or below {lo.name}, but Home Assistant has it above.",
                )
        for fl in real:
            if floors[fl.id]["ceiling"] < 1.83:
                add("warn", "floors", f"{fl.name}'s ceiling is under 6 ft.")
        unset = [fl.name for fl in real if "elevation" not in self.data["floors"].get(fl.id, {})]
        if unset and len(unset) < len(real):
            add(
                "info",
                "photo",
                f"Guessed from the others: {', '.join(unset)}. Draw a floor line for each, or "
                "set a block's bottom as its floor.",
            )
        # lights against the walls from above
        plan = self.plan()
        if plan:
            for tid, item in self.data["items"].items():
                if item["floor"] == OUTSIDE:
                    continue
                if not house_site.inside(plan, item["x"], item["y"]):
                    name = next((t["name"] for t in self.targets() if t["id"] == tid), tid)
                    add("warn", "top", f"{name} is inside on the map, but outside the walls.")
            for w in site.get("walls") or []:
                for x, y in (w["a"], w["b"]):
                    if not house_site.inside(house_site.inset(plan, -0.3), x, y):
                        add("warn", "top", "A wall on the floor plan goes outside the house.")
                        break
        return out

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
            "site": self.data.get("site"),
            "top": self.top(),
            "checks": self.checks(),
        }

    def _save(self) -> None:
        self.store.save("house", self.data)


def _aim_towards(src: dict | None, at: dict) -> dict | None:
    """Heading (clockwise from above, 0 toward the street) and tilt (up from level) from a light
    to a spot."""
    if not src:
        return None
    dx, dy, dz = at["x"] - src["x"], at["y"] - src["y"], at["z"] - src["z"]
    flat = math.hypot(dx, dy)
    if flat < 1e-6 and abs(dz) < 1e-6:
        return None
    heading = math.degrees(math.atan2(-dx, -dy)) % 360 if flat > 1e-6 else 0.0
    tilt = math.degrees(math.atan2(dz, flat))
    return {"heading": round(heading, 1), "tilt": round(tilt, 1)}


def _ft(m: float) -> str:
    """A length as feet and inches, for the checks' wording."""
    inches = round(m / 0.0254)
    return f"{inches // 12}' {inches % 12}\""


def _migrate_roofs(facade: dict | None) -> None:
    """Blocks used to carry one roof each (a gable facing the street, or a ridge along the
    front); those become roof outlines of their own."""
    if not facade:
        return
    roofs = facade.setdefault("roofs", [])
    for b in facade.get("blocks") or []:
        kind = b.pop("roof", None)
        peak_x, peak_z = b.pop("peak_x", None), b.pop("peak_z", None)
        if kind not in ("gable", "ridge") or peak_z is None:
            continue
        x0, x1, z1 = b["x0"], b["x1"], b["z1"]
        roof = {"id": f"{b.get('id', '')}r", "name": f"{b.get('name') or 'Block'} roof"}
        if kind == "gable":
            px = peak_x if peak_x is not None else (x0 + x1) / 2
            roof.update(pts=[[x0, z1], [px, peak_z], [x1, z1]], back="extrude")
        else:
            roof.update(pts=[[x0, z1], [x1, z1], [x1, peak_z], [x0, peak_z]], back="ridge")
        for key in ("depth", "y0"):
            if key in b:
                roof[key] = b[key]
        roofs.append(roof)


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
