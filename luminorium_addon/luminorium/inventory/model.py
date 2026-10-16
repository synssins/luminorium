"""Inventory data: floors, areas, lights and their profiles."""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from enum import StrEnum
from typing import Any

NO_FLOOR = "_no_floor"
NO_AREA = "_no_area"


class Kind(StrEnum):
    LIGHT = "light"  # a light the app can drive
    SEGMENT = "segment"  # one segment of a light (Govee strip segments); driven with its parent
    GROUP = "group"  # a group handle (HA light group, z2m group): not a light of its own
    SWITCH = "switch"  # a switch.* entity; a light only when the user opts it in
    SETTING = "setting"  # a switch.* that sets something on a light (gradient, sync): never a light


@dataclass
class Capabilities:
    on_off: bool = True
    dimming: bool = False
    white: tuple[int, int] | None = None  # kelvin range
    color_modes: list[str] = field(default_factory=list)  # e.g. ["xy"], ["rgb"], ["hs"]
    effects: list[str] = field(default_factory=list)  # native effect names, as HA lists them
    transition: str = "none"  # native | software | none
    segments: int = 0


@dataclass
class Profile:
    capabilities: Capabilities
    network: str  # shared budget the light draws from: zwave, zigbee, wiz, wled, govee_cloud, ...
    driver: str = "ha"
    max_rate_hz: float = 2.0
    latency_ms: int = 250
    relay: bool = False  # on/off relay: slow minimum toggle interval, never streamed
    details: dict[str, Any] = field(default_factory=dict)  # driver facts (Z-Wave node, CC version)
    # Drivers that can reach this light now, the chosen one first; "ha" always reaches it
    drivers: list[str] = field(default_factory=lambda: ["ha"])
    driver_override: str | None = None  # the user's choice of driver, if they made one
    driver_note: str | None = None  # why the chosen driver isn't the preferred one
    endpoint: str | None = None  # how the chosen driver reaches it ("WiZ 192.168.10.64")


@dataclass
class Floor:
    id: str
    name: str
    level: int | None = None


@dataclass
class Area:
    id: str
    name: str
    floor_id: str


@dataclass
class Light:
    entity_id: str
    name: str
    platform: str
    integration: str  # zigbee2mqtt, govee2mqtt, zwave_js, wiz, wled, esphome, matter, ...
    kind: Kind
    area_id: str
    floor_id: str
    device_id: str | None = None
    device_name: str | None = None
    manufacturer: str | None = None
    model: str | None = None
    state: str = "unknown"
    attributes: dict[str, Any] = field(default_factory=dict)
    included: bool = True
    exclude_reason: str | None = None
    user_choice: bool | None = None  # the user's include/exclude, if they made one
    hint: str | None = None  # e.g. "looks like a light relay"
    parent: str | None = None  # for segments
    segment_index: int | None = None
    segments: list[str] = field(default_factory=list)
    members: list[str] = field(default_factory=list)  # for groups
    duplicates: list[str] = field(default_factory=list)  # suggested: same light, other integration
    fixture: str | None = None  # id of the fixture this light is part of
    profile: Profile | None = None
    # How direct drivers find the light: HA's ids for the entity and its device
    unique_id: str | None = None
    device_identifiers: list[list[str]] = field(default_factory=list)
    device_connections: list[list[str]] = field(default_factory=list)
    device_url: str | None = None  # the device's configuration URL (WLED: its address)

    @property
    def available(self) -> bool:
        return self.state not in ("unavailable", "unknown")

    @property
    def is_on(self) -> bool:
        return self.state == "on"

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["available"] = self.available
        for key in ("attributes", "device_identifiers", "device_connections", "device_url"):
            data.pop(key)
        return data


@dataclass
class Fixture:
    """Lights in one physical fixture (two bulbs in a ceiling fan). Seen from outside they are one
    light, so they are tested, mapped and driven together."""

    id: str
    name: str
    area_id: str
    floor_id: str
    members: list[str]

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class FixtureSuggestion:
    name: str
    area_id: str
    members: list[str]
    reason: str

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class Inventory:
    floors: dict[str, Floor] = field(default_factory=dict)
    areas: dict[str, Area] = field(default_factory=dict)
    lights: dict[str, Light] = field(default_factory=dict)
    fixtures: dict[str, Fixture] = field(default_factory=dict)
    suggestions: list[FixtureSuggestion] = field(default_factory=list)

    def get(self, entity_id: str) -> Light | None:
        return self.lights.get(entity_id)

    def drivable(self) -> list[Light]:
        """Lights the app may command: included lights and opted-in switches."""
        return [
            light
            for light in self.lights.values()
            if light.included and light.kind in (Kind.LIGHT, Kind.SWITCH)
        ]
