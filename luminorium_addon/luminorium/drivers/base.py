"""The driver interface and the light state it carries."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass
from typing import Any

from ..inventory.model import Light

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
