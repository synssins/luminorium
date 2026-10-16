"""Build the inventory from HA's registries and states. Pure: no I/O, easy to test."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

from .model import (
    NO_AREA,
    NO_FLOOR,
    Area,
    Fixture,
    FixtureSuggestion,
    Floor,
    Inventory,
    Kind,
    Light,
)
from .profiles import build_profile

# Integrations whose lights are not house lights
EXCLUDED_PLATFORMS = {
    "browser_mod": "browser screen",
    "signalrgb": "PC lighting",
}
SEGMENT_RE = re.compile(r"_segment_(\d+)$")
LIGHTISH = re.compile(r"\b(light|lights|lamp|lamps|sconce|flood|chandelier)\b", re.I)
NOT_LIGHTISH = re.compile(r"\b(indication|indicator|identify|fan|garage door|permit join)\b", re.I)


@dataclass
class UserChoices:
    """What the user decided in the UI. Stored in /data, applied over the defaults."""

    include: dict[str, bool] = field(default_factory=dict)  # entity_id -> included?
    # Fixtures: {"id", "name", "members": [entity_id, ...]}
    fixtures: list[dict] = field(default_factory=list)
    # Fixture suggestions the user said no to, as sorted member lists
    dismissed: list[list[str]] = field(default_factory=list)
    # entity_id -> driver the user picked ("ha", "z2m", ...); absent means automatic
    drivers: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict | None) -> UserChoices:
        data = data or {}
        return cls(
            include={k: bool(v) for k, v in (data.get("include") or {}).items()},
            drivers={k: str(v) for k, v in (data.get("drivers") or {}).items()},
            fixtures=[
                {"id": f["id"], "name": f["name"], "members": list(f["members"])}
                for f in data.get("fixtures") or []
            ],
            dismissed=[sorted(m) for m in data.get("dismissed") or []],
        )

    def to_dict(self) -> dict:
        return {
            "include": dict(sorted(self.include.items())),
            "fixtures": self.fixtures,
            "dismissed": self.dismissed,
            "drivers": dict(sorted(self.drivers.items())),
        }


def _integration(platform: str, device: dict | None) -> str:
    if platform != "mqtt" or not device:
        return platform
    for domain, ident in device.get("identifiers") or []:
        if domain != "mqtt":
            continue
        if ident.startswith("zigbee2mqtt_"):
            return "zigbee2mqtt"
        if ident.startswith("gv2mqtt-"):
            return "govee2mqtt"
    return "mqtt"


def _name(entity: dict, state: dict | None, device: dict | None) -> str:
    if state and state.get("attributes", {}).get("friendly_name"):
        return state["attributes"]["friendly_name"]
    if entity.get("name"):
        return entity["name"]
    if device:
        return device.get("name_by_user") or device.get("name") or entity["entity_id"]
    return entity["entity_id"]


def _sku(model: str | None) -> str | None:
    """A product code that identifies the same hardware across integrations (e.g. H60B0)."""
    if not model:
        return None
    match = re.search(r"\b([A-Z]{1,3}\d[0-9A-Z]{3,6})\b", model)
    return match.group(1) if match else None


def build(
    floors: list[dict],
    areas: list[dict],
    devices: list[dict],
    entities: list[dict],
    states: list[dict],
    zwave_nodes: dict[str, dict] | None = None,
    choices: UserChoices | None = None,
) -> Inventory:
    choices = choices or UserChoices()
    zwave_nodes = zwave_nodes or {}
    inv = Inventory()

    for f in sorted(floors, key=lambda f: -(f.get("level") or 0)):
        inv.floors[f["floor_id"]] = Floor(f["floor_id"], f["name"], f.get("level"))
    inv.floors[NO_FLOOR] = Floor(NO_FLOOR, "Outside / no floor")
    inv.floors[NO_AREA] = Floor(NO_AREA, "No area")
    for a in sorted(areas, key=lambda a: a["name"].lower()):
        floor_id = a.get("floor_id") if a.get("floor_id") in inv.floors else NO_FLOOR
        inv.areas[a["area_id"]] = Area(a["area_id"], a["name"], floor_id)
    inv.areas[NO_AREA] = Area(NO_AREA, "No area", NO_AREA)

    device_by_id = {d["id"]: d for d in devices}
    state_by_id = {s["entity_id"]: s for s in states}
    # Devices that are voice satellites: their lights are status LEDs
    # Devices that have a light entity: their switches are settings of that light, not relays
    light_devices = {
        e.get("device_id")
        for e in entities
        if e["entity_id"].startswith("light.")
        and not _is_zwave_basic_mirror(e)
        and not _is_stale(state_by_id.get(e["entity_id"]))
    }
    satellite_devices = {
        e.get("device_id")
        for e in entities
        if e["entity_id"].startswith("assist_satellite.") and e.get("device_id")
    }

    for e in entities:
        eid = e["entity_id"]
        domain = eid.split(".")[0]
        if domain not in ("light", "switch") or e.get("disabled_by"):
            continue
        device = device_by_id.get(e.get("device_id") or "")
        state = state_by_id.get(eid)
        area_id = e.get("area_id") or (device or {}).get("area_id") or NO_AREA
        if area_id not in inv.areas:
            area_id = NO_AREA
        light = Light(
            entity_id=eid,
            name=_name(e, state, device),
            platform=e["platform"],
            integration=_integration(e["platform"], device),
            kind=Kind.LIGHT if domain == "light" else Kind.SWITCH,
            area_id=area_id,
            floor_id=inv.areas[area_id].floor_id,
            device_id=e.get("device_id"),
            device_name=(device or {}).get("name_by_user") or (device or {}).get("name"),
            manufacturer=(device or {}).get("manufacturer"),
            model=(device or {}).get("model"),
            state=(state or {}).get("state", "unknown"),
            attributes=dict((state or {}).get("attributes") or {}),
            unique_id=e.get("unique_id"),
            device_identifiers=[list(i) for i in (device or {}).get("identifiers") or []],
            device_connections=[list(c) for c in (device or {}).get("connections") or []],
            device_url=(device or {}).get("configuration_url"),
        )
        reason = _default_exclusion(light, e, device, satellite_devices)
        if (
            light.kind == Kind.SWITCH
            and light.device_id in light_devices
            and not reason.startswith("stale")
        ):
            # Gradient toggle, sync, nightlight...: a setting of a light, never a relay
            light.kind = Kind.SETTING
            reason = "a setting of a light, not a light"
        light.included = reason is None
        light.exclude_reason = reason
        inv.lights[eid] = light

    _fold_segments(inv)
    _find_duplicates(inv)

    for light in inv.lights.values():
        if light.entity_id in choices.include and light.kind not in (Kind.SEGMENT, Kind.SETTING):
            light.user_choice = choices.include[light.entity_id]
            light.included = light.user_choice
            if light.included:
                light.exclude_reason = None
            elif light.exclude_reason is None:
                light.exclude_reason = "excluded by you"
        if (
            light.kind == Kind.SWITCH
            and light.user_choice is None
            and not light.attributes.get("restored")
        ):
            if LIGHTISH.search(light.name) and not NOT_LIGHTISH.search(light.name):
                light.hint = "looks like a light relay"
        node = zwave_nodes.get(light.device_id or "")
        light.profile = build_profile(light, node, relay=light.kind == Kind.SWITCH)
        light.profile.driver_override = choices.drivers.get(light.entity_id)

    _apply_fixtures(inv, choices.fixtures)
    inv.suggestions = _suggest_fixtures(inv, choices.dismissed)
    return inv


def fixture_member_ok(light: Light | None) -> bool:
    """Lights and switches can be in a fixture; segments, groups and settings can't."""
    return light is not None and light.kind in (Kind.LIGHT, Kind.SWITCH)


def _apply_fixtures(inv: Inventory, stored: list[dict]) -> None:
    for f in stored:
        members = [
            eid
            for eid in f["members"]
            if fixture_member_ok(inv.get(eid)) and inv.lights[eid].fixture is None
        ]
        if len(members) < 2:
            continue  # members gone from HA; kept in storage in case they come back
        # The fixture lives in the area most of its lights are in
        areas = [inv.lights[eid].area_id for eid in members]
        area_id = max(set(areas), key=lambda a: (areas.count(a), a != NO_AREA))
        fixture = Fixture(f["id"], f["name"], area_id, inv.areas[area_id].floor_id, members)
        inv.fixtures[fixture.id] = fixture
        for eid in members:
            inv.lights[eid].fixture = fixture.id


TRAILING_NUMBER = re.compile(r"[\s_-]*\d+\s*$")


def _suggest_fixtures(inv: Inventory, dismissed: list[list[str]]) -> list[FixtureSuggestion]:
    """Same area, same product, names that differ only by a trailing number
    ('Office Fan RGB1', 'Office Fan RGB2'). Only a suggestion: the user decides."""
    groups: dict[tuple, list[Light]] = {}
    for light in inv.lights.values():
        if light.kind != Kind.LIGHT or not light.included or light.fixture:
            continue
        stem = TRAILING_NUMBER.sub("", light.name).strip()
        if not stem or stem.lower() == light.name.strip().lower():
            continue  # no trailing number
        key = (light.area_id, light.manufacturer, light.model, stem.lower())
        groups.setdefault(key, []).append(light)
    dismissed_keys = {tuple(sorted(m)) for m in dismissed}
    out = []
    for (area_id, _, model, _), lights in sorted(groups.items(), key=lambda kv: kv[0][3]):
        members = sorted(lt.entity_id for lt in lights)
        if len(members) < 2 or tuple(members) in dismissed_keys:
            continue
        stem = TRAILING_NUMBER.sub("", lights[0].name).strip()
        out.append(
            FixtureSuggestion(
                stem, area_id, members, f"same room, same model ({model}), numbered names"
            )
        )
    return out


def _default_exclusion(
    light: Light, entity: dict, device: dict | None, satellites: set
) -> str | None:
    # Most specific reason first
    if _is_zwave_basic_mirror(entity):
        return "Z-Wave Basic mirror"
    if light.platform in EXCLUDED_PLATFORMS:
        return EXCLUDED_PLATFORMS[light.platform]
    if light.platform == "group" and light.kind == Kind.LIGHT:
        light.kind = Kind.GROUP
        light.members = list(light.attributes.get("entity_id") or [])
        return "light group"
    if light.integration == "zigbee2mqtt" and (device or {}).get("model") == "Group":
        light.kind = Kind.GROUP
        return "Zigbee2MQTT group"
    if light.device_id and light.device_id in satellites:
        return "voice assistant LEDs"
    if _is_stale({"attributes": light.attributes}):
        return "stale: HA no longer provides this entity"
    if light.kind == Kind.SWITCH:
        return "switch: include it if it's a light relay"
    return None


def _is_stale(state: dict | None) -> bool:
    """HA keeps a 'restored' placeholder state for an entity its integration stopped providing."""
    return bool(state and (state.get("attributes") or {}).get("restored"))


def _is_zwave_basic_mirror(entity: dict) -> bool:
    """A Basic command class (32) entity mirroring a switch or dimmer that has its own entity."""
    return entity["platform"] == "zwave_js" and "-32-" in (entity.get("unique_id") or "")


def _fold_segments(inv: Inventory) -> None:
    """Govee strips: '<light>_segment_NNN' entities become segments of the device's main light."""
    by_device: dict[str, list[Light]] = {}
    for light in inv.lights.values():
        if light.device_id and light.entity_id.startswith("light."):
            by_device.setdefault(light.device_id, []).append(light)
    for lights in by_device.values():
        segments = [lt for lt in lights if SEGMENT_RE.search(lt.entity_id)]
        parents = [lt for lt in lights if not SEGMENT_RE.search(lt.entity_id)]
        if not segments or len(parents) != 1:
            continue
        parent = parents[0]
        segments.sort(key=lambda lt: int(SEGMENT_RE.search(lt.entity_id).group(1)))  # type: ignore[union-attr]
        for seg in segments:
            seg.kind = Kind.SEGMENT
            seg.parent = parent.entity_id
            seg.segment_index = int(SEGMENT_RE.search(seg.entity_id).group(1))  # type: ignore[union-attr]
            seg.included = parent.included
            seg.exclude_reason = None if parent.included else "segment of an excluded light"
        parent.segments = [s.entity_id for s in segments]


def _find_duplicates(inv: Inventory) -> None:
    """Suggest 'same light' for one product code seen in two integrations (Matter + govee2mqtt)."""
    by_sku: dict[str, list[Light]] = {}
    for light in inv.lights.values():
        if light.kind != Kind.LIGHT:
            continue
        sku = _sku(light.model)
        if sku:
            by_sku.setdefault(sku, []).append(light)
    for lights in by_sku.values():
        integrations = {lt.integration for lt in lights}
        if len(integrations) < 2:
            continue
        for light in lights:
            light.duplicates = [o.entity_id for o in lights if o.integration != light.integration]
