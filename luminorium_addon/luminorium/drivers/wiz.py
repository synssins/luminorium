"""WiZ bulbs over their local UDP protocol (JSON on port 38899, no authentication).

- Found by a sweep: `getSystemConfig` to every address of the configured subnets (default
  192.168.10.0/24, the IoT VLAN; unicast routes there from the HA host's 192.168.1.x), matched to
  HA's devices by MAC address. A DHCP change only means the next sweep finds the bulb elsewhere.
- `setPilot`: state, dimming (10-100 %: WiZ's minimum is 10), r/g/b or temp, sceneId + speed.
  No transitions (the firmware has none; fades are done in software later).
- `getPilot` polling keeps track of which bulbs answer; three missed polls in a row and the
  bulb goes back to HA until it answers again.
See Bifrost's notes (bifrost/doc/wiz.md) for the protocol and the rates learned there.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

from ..inventory.model import Light
from ..net.udp import Addr, JsonDatagrams, parse_hostport, sweep_hosts
from .base import DirectDriver, LightState
from .color import percent, state_kelvin, state_rgb

log = logging.getLogger(__name__)

WIZ_PORT = 38899
MIN_DIMMING = 10
MISSED_POLLS_OFFLINE = 3

# WiZ firmware scenes (pywizlight's table, which HA's WiZ integration uses for effect_list)
SCENES = {
    1: "Ocean",
    2: "Romance",
    3: "Sunset",
    4: "Party",
    5: "Fireplace",
    6: "Cozy",
    7: "Forest",
    8: "Pastel colors",
    9: "Wake-up",
    10: "Bedtime",
    11: "Warm white",
    12: "Daylight",
    13: "Cool white",
    14: "Night light",
    15: "Focus",
    16: "Relax",
    17: "True colors",
    18: "TV time",
    19: "Plantgrowth",
    20: "Spring",
    21: "Summer",
    22: "Fall",
    23: "Deep dive",
    24: "Jungle",
    25: "Mojito",
    26: "Club",
    27: "Christmas",
    28: "Halloween",
    29: "Candlelight",
    30: "Golden white",
    31: "Pulse",
    32: "Steampunk",
    33: "Diwali",
    34: "White",
    35: "Alarm",
}


def _norm(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", name.lower())


SCENE_IDS = {_norm(name): scene for scene, name in SCENES.items()}


def scene_id(effect: str | None) -> int | None:
    return SCENE_IDS.get(_norm(effect)) if effect else None


def mac_of(light: Light) -> str | None:
    for kind, value in light.device_connections:
        if kind == "mac":
            return _norm(value)
    return None


def pilot_params(state: LightState, white_range: tuple[int, int] | None = None) -> dict[str, Any]:
    """setPilot params for a state."""
    if not state.on:
        return {"state": False}
    params: dict[str, Any] = {"state": True}
    if state.brightness is not None:
        params["dimming"] = percent(state.brightness, MIN_DIMMING)
    scene = scene_id(state.effect)
    if scene:
        params["sceneId"] = scene
        return params
    rgb = state_rgb(state)
    kelvin = state_kelvin(state)
    if rgb is not None:
        params.update(r=rgb[0], g=rgb[1], b=rgb[2])
    elif kelvin is not None:
        lo, hi = white_range or (2200, 6500)
        params["temp"] = max(lo, min(hi, kelvin))
    return params


@dataclass
class Bulb:
    mac: str
    addr: Addr
    module: str = ""
    pilot: dict | None = None
    last_seen: float = 0.0
    missed: int = 0

    @property
    def online(self) -> bool:
        return self.missed < MISSED_POLLS_OFFLINE


class WiZDriver(DirectDriver):
    name = "wiz"
    network_name = "wiz"

    def __init__(
        self,
        *,
        subnets: list[str],
        hosts: list[str] | None = None,
        port: int = WIZ_PORT,
        read_only: bool = False,
        sweep_every_s: float = 600.0,
        poll_every_s: float = 30.0,
        timeout_s: float = 1.0,
    ):
        super().__init__(read_only=read_only)
        self.subnets = list(subnets)
        self.hosts = list(hosts or [])
        self.port = port
        self.sweep_every_s = sweep_every_s
        self.poll_every_s = poll_every_s
        self.timeout_s = timeout_s
        self.bulbs: dict[str, Bulb] = {}  # mac -> bulb
        self.sock: JsonDatagrams | None = None
        self._tasks: list[asyncio.Task] = []
        self._sweep_now = asyncio.Event()

    async def start(self) -> None:
        try:
            self.sock = await JsonDatagrams.open(("0.0.0.0", 0))
        except OSError as err:
            self.error = f"can't open a UDP socket: {err}"
            return
        self.connected = True
        self._tasks = [
            asyncio.create_task(self._sweeper(), name="wiz-sweep"),
            asyncio.create_task(self._poller(), name="wiz-poll"),
        ]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if self.sock:
            self.sock.close()

    def rescan(self) -> None:
        self._sweep_now.set()

    async def _sweeper(self) -> None:
        while True:
            try:
                await self.sweep()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("WiZ sweep failed")
            self._sweep_now.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._sweep_now.wait(), self.sweep_every_s)

    async def sweep(self) -> int:
        """Ask every address for its system config; returns how many bulbs answered."""
        assert self.sock is not None
        targets = [parse_hostport(h, self.port) for h in self.hosts]
        targets += [(h, self.port) for h in sweep_hosts(self.subnets)]
        found: dict[str, Bulb] = {}

        def on_reply(msg: dict, addr: Addr) -> None:
            if msg.get("method") != "getSystemConfig":
                return
            result = msg.get("result") or {}
            mac = _norm(str(result.get("mac", "")))
            if mac:
                found[mac] = Bulb(mac, addr, str(result.get("moduleName", "")), None, time.time())

        self.sock.on_message = on_reply
        try:
            for i, addr in enumerate(dict.fromkeys(targets)):
                self.sock.send({"method": "getSystemConfig", "params": {}}, addr)
                if i % 32 == 31:
                    await asyncio.sleep(0.01)  # don't burst 254 packets into Wi-Fi at once
            await asyncio.sleep(self.timeout_s)
        finally:
            self.sock.on_message = None
        changed = False
        for mac, bulb in found.items():
            old = self.bulbs.get(mac)
            if old is None or old.addr != bulb.addr or not old.online:
                changed = True
                log.info("WiZ %s at %s (%s)", mac, bulb.addr[0], bulb.module)
            if old:
                old.addr, old.missed, old.last_seen = bulb.addr, 0, bulb.last_seen
            else:
                self.bulbs[mac] = bulb
        if changed:
            self.changed()
        return len(found)

    async def _poller(self) -> None:
        while True:
            await asyncio.sleep(self.poll_every_s)
            for bulb in list(self.bulbs.values()):
                try:
                    await self.poll(bulb)
                except asyncio.CancelledError:
                    raise
                except Exception as err:
                    log.debug("WiZ poll of %s failed: %s", bulb.mac, err)

    async def poll(self, bulb: Bulb) -> dict | None:
        """getPilot; marks the bulb offline after three misses in a row."""
        was_online = bulb.online
        try:
            reply = await self._request(bulb.addr, "getPilot", {})
        except TimeoutError:
            bulb.missed += 1
            if was_online and not bulb.online:
                log.info("WiZ %s stopped answering", bulb.mac)
                self.changed()
                self.rescan()  # maybe it moved
            return None
        bulb.pilot, bulb.last_seen, bulb.missed = reply.get("result"), time.time(), 0
        if not was_online:
            self.changed()
        return bulb.pilot

    async def _request(self, addr: Addr, method: str, params: dict) -> dict:
        assert self.sock is not None
        return await self.sock.request(
            {"method": method, "params": params},
            addr,
            lambda m, a: a == addr and m.get("method") == method,
            timeout=self.timeout_s,
            attempts=2,
        )

    # ---- Driver -------------------------------------------------------------------------------

    def bulb_for(self, light: Light) -> Bulb | None:
        mac = mac_of(light)
        bulb = self.bulbs.get(mac) if mac else None
        return bulb if bulb and bulb.online else None

    def handles(self, light: Light) -> bool:
        return light.entity_id.startswith("light.") and self.bulb_for(light) is not None

    def endpoint(self, light: Light) -> str | None:
        bulb = self.bulb_for(light)
        return f"WiZ {bulb.addr[0]}" if bulb else None

    def supports(self, light: Light, state: LightState) -> bool:
        return not state.effect or scene_id(state.effect) is not None

    async def set(
        self, light: Light, state: LightState, transition_ms: int | None = None
    ) -> str | None:
        self.check_writable()
        bulb = self.bulb_for(light)
        if bulb is None:
            raise ConnectionError(f"WiZ bulb for {light.entity_id} not found")
        white = light.profile.capabilities.white if light.profile else None
        params = pilot_params(state, white)
        reply = await self._request(bulb.addr, "setPilot", params)
        if not (reply.get("result") or {}).get("success", True):
            raise RuntimeError(f"WiZ refused {params}: {reply}")
        return None

    async def effect(self, light: Light, name: str, speed: int | None = None) -> None:
        """A firmware scene, with its speed (10-200 %)."""
        self.check_writable()
        bulb = self.bulb_for(light)
        scene = scene_id(name)
        if bulb is None or scene is None:
            raise ValueError(f"no WiZ scene {name!r} for {light.entity_id}")
        params: dict[str, Any] = {"state": True, "sceneId": scene}
        if speed is not None:
            params["speed"] = max(10, min(200, int(speed)))
        await self._request(bulb.addr, "setPilot", params)

    def status(self) -> dict[str, Any]:
        out = super().status()
        out.update(
            bulbs=sum(1 for b in self.bulbs.values() if b.online),
            subnets=self.subnets,
            found=[
                {"mac": b.mac, "ip": b.addr[0], "module": b.module, "online": b.online}
                for b in self.bulbs.values()
            ],
        )
        return out
