"""The fallback driver: HA's light and switch services. Reaches every light."""

from __future__ import annotations

from ..ha.client import HAClient
from ..inventory.model import Light
from ..inventory.profiles import INTEGRATION_NETWORK
from .base import COLOR_ATTR, Driver, LightState


class HADriver(Driver):
    name = "ha"

    def __init__(self, ha: HAClient):
        self.ha = ha

    def network(self, light: Light) -> str:
        # Through HA a light uses its integration's own path (govee2mqtt: the cloud), whichever
        # driver its profile prefers
        if light.integration in INTEGRATION_NETWORK:
            return INTEGRATION_NETWORK[light.integration]
        return super().network(light)

    async def set(
        self, light: Light, state: LightState, transition_ms: int | None = None
    ) -> str | None:
        domain = light.entity_id.split(".")[0]
        if domain == "switch" or not state.on:
            service = "turn_on" if state.on else "turn_off"
            data: dict = {}
            if domain == "light" and transition_ms is not None and _transition_ok(light):
                data["transition"] = transition_ms / 1000
            return await self.ha.call_service(domain, service, data, entity_ids=[light.entity_id])

        data = {}
        caps = light.profile.capabilities if light.profile else None
        if state.brightness is not None and (caps is None or caps.dimming):
            data["brightness"] = max(0, min(255, int(state.brightness)))
        if state.color_mode in COLOR_ATTR and state.color is not None:
            data[COLOR_ATTR[state.color_mode]] = state.color
        if state.effect and (caps is None or state.effect in caps.effects):
            data["effect"] = state.effect
        if transition_ms is not None and _transition_ok(light):
            data["transition"] = transition_ms / 1000
        return await self.ha.call_service("light", "turn_on", data, entity_ids=[light.entity_id])


def _transition_ok(light: Light) -> bool:
    return light.profile is None or light.profile.capabilities.transition == "native"
