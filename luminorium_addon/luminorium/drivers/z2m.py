"""Zigbee2MQTT over MQTT: publish straight to `<base>/<friendly name>/set` on Mosquitto.

- Device names come from the retained `<base>/bridge/devices`, by IEEE address (HA's device
  identifier is `zigbee2mqtt_<ieee>`), never from HA's device name: z2m names can differ, and one
  in this house has a trailing space.
- z2m groups (`<base>/bridge/groups`) carry simultaneous changes: lights that exactly make up a
  group get one message to the group.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any

from ..inventory.model import Light
from ..net.mqtt import MQTTClient, MQTTEndpoint
from .base import DirectDriver, LightState
from .color import state_kelvin

log = logging.getLogger(__name__)

# HA's unique id for a z2m light: <ieee>_light[_<endpoint>]_zigbee2mqtt
UNIQUE_RE = re.compile(r"^(0x[0-9a-fA-F]+)_light(?:_(\w+?))?_zigbee2mqtt$")


def ieee_of(light: Light) -> str | None:
    for domain, ident in light.device_identifiers:
        if domain == "mqtt" and ident.startswith("zigbee2mqtt_0x"):
            return ident.removeprefix("zigbee2mqtt_").lower()
    return None


def endpoint_of(light: Light) -> str | None:
    """z2m's endpoint name for multi-endpoint devices (`state_l1`), else None."""
    match = UNIQUE_RE.match(light.unique_id or "")
    return match.group(2) if match else None


def set_payload(light: Light, state: LightState, transition_ms: int | None) -> dict[str, Any]:
    caps = light.profile.capabilities if light.profile else None
    out: dict[str, Any] = {"state": "ON" if state.on else "OFF"}
    if state.on:
        if state.brightness is not None and (caps is None or caps.dimming):
            out["brightness"] = max(0, min(254, int(state.brightness)))
        kelvin = state_kelvin(state)
        if kelvin:
            out["color_temp"] = round(1_000_000 / kelvin)  # mired
        elif state.color is not None:
            value = state.color
            if state.color_mode == "xy":
                out["color"] = {"x": float(value[0]), "y": float(value[1])}
            elif state.color_mode == "hs":
                out["color"] = {"hue": float(value[0]), "saturation": float(value[1])}
            elif state.color_mode in ("rgb", "rgbw", "rgbww"):
                out["color"] = {"r": int(value[0]), "g": int(value[1]), "b": int(value[2])}
        if state.effect and (caps is None or state.effect in caps.effects):
            out["effect"] = state.effect
    if transition_ms is not None and (caps is None or caps.transition == "native"):
        out["transition"] = round(transition_ms / 1000, 3)
    ep = endpoint_of(light)
    if ep:
        # Multi-endpoint devices take state_l1, brightness_l1, ...; transition stays global
        out = {(k if k == "transition" else f"{k}_{ep}"): v for k, v in out.items()}
    return out


class Z2MDriver(DirectDriver):
    name = "z2m"
    network_name = "zigbee"

    def __init__(
        self,
        endpoint: MQTTEndpoint | None,
        *,
        base_topic: str = "zigbee2mqtt",
        read_only: bool = False,
        client_id: str = "luminorium",
    ):
        super().__init__(read_only=read_only)
        self.base = base_topic.rstrip("/")
        self.mqtt = MQTTClient(endpoint, client_id) if endpoint else None
        self.names: dict[str, str] = {}  # ieee -> friendly name
        self.groups: list[dict] = []  # [{"name", "members": frozenset of ieee}]
        self.bridge_online: bool | None = None
        if endpoint is None:
            self.error = "no MQTT broker (Mosquitto not found)"

    async def start(self) -> None:
        if not self.mqtt:
            return
        await self.mqtt.subscribe(f"{self.base}/bridge/devices", self._devices)
        await self.mqtt.subscribe(f"{self.base}/bridge/groups", self._groups)
        await self.mqtt.subscribe(f"{self.base}/bridge/state", self._bridge_state)
        self.mqtt.on_connect(self._link_changed)
        self.mqtt.on_disconnect(self._link_changed)
        self.mqtt.start()

    async def stop(self) -> None:
        if self.mqtt:
            await self.mqtt.close()

    def _link_changed(self) -> None:
        assert self.mqtt is not None
        self.connected = self.mqtt.connected
        self.error = self.mqtt.error
        self.changed()

    def _devices(self, topic: str, payload: bytes, retain: bool) -> None:
        try:
            devices = json.loads(payload)
        except ValueError:
            log.warning("z2m: unreadable %s", topic)
            return
        self.names = {
            d["ieee_address"].lower(): d["friendly_name"]
            for d in devices
            if d.get("type") != "Coordinator" and d.get("ieee_address") and "friendly_name" in d
        }
        log.info("z2m: %d devices", len(self.names))
        self.changed()

    def _groups(self, topic: str, payload: bytes, retain: bool) -> None:
        try:
            groups = json.loads(payload)
        except ValueError:
            log.warning("z2m: unreadable %s", topic)
            return
        self.groups = [
            {
                "name": g["friendly_name"],
                "members": frozenset(m["ieee_address"].lower() for m in g.get("members") or []),
            }
            for g in groups
            if g.get("friendly_name") and g.get("members")
        ]

    def _bridge_state(self, topic: str, payload: bytes, retain: bool) -> None:
        text = payload.decode("utf-8", "replace").strip()
        try:
            text = json.loads(text).get("state", text)
        except (ValueError, AttributeError):
            pass
        self.bridge_online = text == "online"
        self.changed()

    # ---- Driver -------------------------------------------------------------------------------

    def handles(self, light: Light) -> bool:
        if not (self.mqtt and self.mqtt.connected) or self.bridge_online is False:
            return False
        if not light.entity_id.startswith("light."):
            return False
        ieee = ieee_of(light)
        return ieee is not None and ieee in self.names

    def endpoint(self, light: Light) -> str | None:
        name = self.names.get(ieee_of(light) or "")
        return f"z2m '{name}'" if name is not None else None

    async def set(
        self, light: Light, state: LightState, transition_ms: int | None = None
    ) -> str | None:
        self.check_writable()
        name = self.names.get(ieee_of(light) or "")
        if name is None or not self.mqtt:
            raise ConnectionError(f"z2m doesn't know {light.entity_id}")
        await self._publish(name, set_payload(light, state, transition_ms))
        return None

    def batches(self, lights: list[Light], state: LightState) -> list[list[Light]]:
        """Cover the lights with z2m groups whose members are all among them (largest first);
        the rest go one by one. Endpoint lights never use a group."""
        by_ieee: dict[str, Light] = {}
        singles: list[Light] = []
        for light in lights:
            ieee = ieee_of(light)
            if ieee and not endpoint_of(light) and ieee not in by_ieee:
                by_ieee[ieee] = light
            else:
                singles.append(light)
        out: list[list[Light]] = []
        left = set(by_ieee)
        for group in sorted(self.groups, key=lambda g: -len(g["members"])):
            members = group["members"]
            if len(members) >= 2 and members <= left:
                out.append([by_ieee[i] for i in sorted(members)])
                left -= members
        out.extend([by_ieee[i]] for i in sorted(left))
        out.extend([light] for light in singles)
        return out

    def group_for(self, lights: list[Light]) -> str | None:
        ieees = frozenset(ieee_of(lt) or "" for lt in lights)
        for group in self.groups:
            if group["members"] == ieees:
                return group["name"]
        return None

    async def set_batch(
        self, lights: list[Light], state: LightState, transition_ms: int | None = None
    ) -> str | None:
        if len(lights) == 1:
            return await self.set(lights[0], state, transition_ms)
        self.check_writable()
        group = self.group_for(lights)
        if group is None:
            raise ValueError("no z2m group has exactly these lights")
        # Capabilities can differ inside a group: send what the most capable member takes, as
        # z2m forwards the attributes each member understands
        best = max(lights, key=_capability_score)
        await self._publish(group, set_payload(best, state, transition_ms))
        return None

    async def _publish(self, name: str, payload: dict) -> None:
        assert self.mqtt is not None
        await self.mqtt.publish(f"{self.base}/{name}/set", json.dumps(payload))

    def status(self) -> dict[str, Any]:
        out = super().status()
        out.update(
            devices=len(self.names), groups=len(self.groups), bridge_online=self.bridge_online
        )
        return out


def _capability_score(light: Light) -> tuple:
    caps = light.profile.capabilities if light.profile else None
    if caps is None:
        return (0, 0, 0)
    return (len(caps.color_modes), caps.white is not None, len(caps.effects))
