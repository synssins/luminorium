"""The driver interface and the light state it carries."""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from collections.abc import Callable
from dataclasses import asdict, dataclass
from typing import Any

from ..ha.client import ReadOnlyError
from ..inventory.model import Light

log = logging.getLogger(__name__)

# The colour attribute HA reports for each colour mode
COLOR_ATTR = {
    "xy": "xy_color",
    "hs": "hs_color",
    "rgb": "rgb_color",
    "rgbw": "rgbw_color",
    "rgbww": "rgbww_color",
    "color_temp": "color_temp_kelvin",
}
NO_EFFECT = {None, "", "none", "None", "off"}


@dataclass
class LightState:
    on: bool
    brightness: int | None = None  # 0-255
    color_mode: str | None = None  # a key of COLOR_ATTR
    color: Any = None  # value in that mode: [x, y], [h, s], [r, g, b], kelvin, ...
    effect: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> LightState:
        return cls(
            **{k: data.get(k) for k in ("on", "brightness", "color_mode", "color", "effect")}
        )

    @classmethod
    def from_ha(cls, ha_state: str, attributes: dict) -> LightState:
        """What HA reports now, as a state that can be sent back to restore it."""
        if ha_state != "on":
            return cls(on=False)
        mode = attributes.get("color_mode")
        color = attributes.get(COLOR_ATTR[mode]) if mode in COLOR_ATTR else None
        effect = attributes.get("effect")
        return cls(
            on=True,
            brightness=attributes.get("brightness"),
            color_mode=mode if color is not None else None,
            color=color,
            effect=None if effect in NO_EFFECT else effect,
        )


class Driver(ABC):
    name: str

    @abstractmethod
    async def set(
        self, light: Light, state: LightState, transition_ms: int | None = None
    ) -> str | None:
        """Apply a state. Returns the context id of the change, when the driver knows it."""

    async def snapshot(self, light: Light) -> LightState:
        return LightState.from_ha(light.state, light.attributes)

    async def restore(self, light: Light, state: LightState) -> str | None:
        return await self.set(light, state, transition_ms=None)

    def network(self, light: Light) -> str:
        """The shared budget this driver's commands to the light draw from."""
        return light.profile.network if light.profile else "other"

    def supports(self, light: Light, state: LightState) -> bool:
        """False when this driver can't carry this state (the governor then uses HA)."""
        return True

    def batches(self, lights: list[Light], state: LightState) -> list[list[Light]]:
        """Split lights getting the same state into groups that each go out as one message
        (Z-Wave multicast, a z2m group). The default: one message per light."""
        return [[light] for light in lights]

    async def set_batch(
        self, lights: list[Light], state: LightState, transition_ms: int | None = None
    ) -> str | None:
        """Send one state to a group from batches() as one message."""
        if len(lights) != 1:
            raise NotImplementedError(f"{self.name} can't send to several lights at once")
        return await self.set(lights[0], state, transition_ms)

    def can_stream(self, light: Light) -> bool:
        """True if stream() can send per-pixel or per-segment frames to this light."""
        return False

    async def stream(self, light: Light, pixels: list[tuple[int, int, int]]) -> None:
        """Send one frame of RGB values (one per LED or segment). No reply, no rate limit:
        the caller paces frames."""
        raise NotImplementedError(f"{self.name} can't stream")


class DirectDriver(Driver):
    """A driver that talks to devices or their hub itself, without HA in between.

    It finds what it can reach in the background; `handles()` says whether it can reach a
    light right now. When that changes, it calls the `on_change` listeners so the router can
    move lights between it and HA.
    """

    network_name: str = "other"

    def __init__(self, *, read_only: bool = False):
        self.read_only = read_only
        self.connected = False
        self.error: str | None = None
        self._listeners: list[Callable[[], None]] = []

    def on_change(self, listener: Callable[[], None]) -> None:
        self._listeners.append(listener)

    def changed(self) -> None:
        for listener in self._listeners:
            try:
                listener()
            except Exception:
                log.exception("driver change listener failed")

    def network(self, light: Light) -> str:
        return self.network_name

    async def start(self) -> None:
        """Start connecting and discovering in the background. Never raises for an unreachable
        device or hub: it retries, and `handles()` stays False meanwhile."""

    async def stop(self) -> None:
        pass

    @abstractmethod
    def handles(self, light: Light) -> bool:
        """Whether this driver can reach the light now."""

    def endpoint(self, light: Light) -> str | None:
        """A short description of how the light is reached, for the UI."""
        return None

    def status(self) -> dict[str, Any]:
        return {"connected": self.connected, "error": self.error}

    def check_writable(self) -> None:
        if self.read_only:
            raise ReadOnlyError(f"{self.name}: blocked, read-only mode")
