"""Govee LAN API: UDP, no authentication. "LAN Control" must be on for each device (Govee app).

- Discovery: `scan` to the multicast group 239.255.255.250:4001, and (because multicast rarely
  crosses Wi-Fi or VLANs) unicast to every address of the configured subnets. Devices answer
  on UDP 4002, so the driver listens there.
- Matched to HA by device id: govee2mqtt's device identifier is `gv2mqtt-<id>`, the LAN reply
  carries the same id with colons.
- Control on UDP 4003: `turn`, `brightness` (1-100), `colorwc` (RGB or kelvin). No replies.
  `devStatus` is answered on 4002; it is polled to know which devices are reachable.
- Native scenes are not in the LAN API: commands with an effect fall back to HA (govee2mqtt).
- Segments: `razer` streaming (the DreamView / desktop-sync mode OpenRGB uses) sends one colour
  per segment in one frame. The frame layout is reverse-engineered and unverified on these
  models, so it is off unless the device's model is listed in `razer_models`.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import logging
import time
from dataclasses import dataclass
from functools import reduce
from typing import Any

from ..inventory.model import Light
from ..net.udp import Addr, JsonDatagrams, parse_hostport, sweep_hosts
from .base import DirectDriver, LightState
from .color import percent, state_kelvin, state_rgb

log = logging.getLogger(__name__)

MULTICAST = "239.255.255.250"
SCAN_PORT = 4001
LISTEN_PORT = 4002
CONTROL_PORT = 4003
MISSED_POLLS_OFFLINE = 3


def device_id_of(light: Light) -> str | None:
    for domain, ident in light.device_identifiers:
        if domain == "mqtt" and ident.startswith("gv2mqtt-"):
            return _norm(ident.removeprefix("gv2mqtt-"))
    return None


def _norm(device_id: str) -> str:
    return device_id.replace(":", "").upper()


def _xor(data: bytes) -> int:
    return reduce(lambda a, b: a ^ b, data, 0)


def razer_enable(on: bool) -> str:
    pkt = bytes([0xBB, 0x00, 0x01, 0xB1, 0x01 if on else 0x00])
    return base64.b64encode(pkt + bytes([_xor(pkt)])).decode()


def razer_frame(colors: list[tuple[int, int, int]]) -> str:
    """One frame: BB, length (2 + 3n, big-endian), B0, 01, n, RGB × n, XOR checksum."""
    n = min(len(colors), 255)
    length = 2 + 3 * n
    body = bytes([0xBB, length >> 8, length & 0xFF, 0xB0, 0x01, n])
    body += bytes(max(0, min(255, int(c))) for rgb in colors[:n] for c in rgb[:3])
    return base64.b64encode(body + bytes([_xor(body)])).decode()


def commands_for(state: LightState) -> list[dict]:
    """The LAN messages for a state, in order."""
    if not state.on:
        return [{"cmd": "turn", "data": {"value": 0}}]
    out: list[dict] = [{"cmd": "turn", "data": {"value": 1}}]
    rgb, kelvin = state_rgb(state), state_kelvin(state)
    if rgb is not None:
        r, g, b = rgb
        out.append(
            {"cmd": "colorwc", "data": {"color": {"r": r, "g": g, "b": b}, "colorTemInKelvin": 0}}
        )
    elif kelvin is not None:
        out.append(
            {
                "cmd": "colorwc",
                "data": {"color": {"r": 0, "g": 0, "b": 0}, "colorTemInKelvin": int(kelvin)},
            }
        )
    if state.brightness is not None:
        out.append({"cmd": "brightness", "data": {"value": percent(state.brightness, 1)}})
    return out


@dataclass
class GoveeDevice:
    device_id: str
    ip: str
    sku: str = ""
    status: dict | None = None
    last_seen: float = 0.0
    missed: int = 0
    razer_on: bool = False

    @property
    def online(self) -> bool:
        return self.missed < MISSED_POLLS_OFFLINE


class GoveeDriver(DirectDriver):
    name = "govee"
    network_name = "govee_lan"

    def __init__(
        self,
        *,
        subnets: list[str],
        hosts: list[str] | None = None,
        multicast: bool = True,
        razer_models: list[str] | None = None,
        read_only: bool = False,
        listen: Addr = ("0.0.0.0", LISTEN_PORT),
        scan_port: int = SCAN_PORT,
        control_port: int = CONTROL_PORT,
        multicast_group: str = MULTICAST,
        scan_every_s: float = 600.0,
        poll_every_s: float = 60.0,
        timeout_s: float = 1.5,
    ):
        super().__init__(read_only=read_only)
        self.subnets = list(subnets)
        self.hosts = list(hosts or [])
        self.multicast = multicast
        self.razer_models = {m.strip().upper() for m in razer_models or [] if m.strip()}
        self.listen = listen
        self.scan_port = scan_port
        self.control_port = control_port
        self.multicast_group = multicast_group
        self.scan_every_s = scan_every_s
        self.poll_every_s = poll_every_s
        self.timeout_s = timeout_s
        self.devices: dict[str, GoveeDevice] = {}  # device id (no colons) -> device
        self.sock: JsonDatagrams | None = None
        self._tasks: list[asyncio.Task] = []
        self._scan_now = asyncio.Event()

    async def start(self) -> None:
        try:
            self.sock = await JsonDatagrams.open(self.listen, self._message)
        except OSError as err:
            # govee2mqtt on host networking may hold 4002 already
            self.error = f"can't listen on UDP {self.listen[1]}: {err}"
            log.warning("Govee LAN off: %s", self.error)
            return
        self.connected = True
        self._tasks = [
            asyncio.create_task(self._scanner(), name="govee-scan"),
            asyncio.create_task(self._poller(), name="govee-poll"),
        ]

    async def stop(self) -> None:
        for task in self._tasks:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        if self.sock:
            self.sock.close()

    def _message(self, msg: dict, addr: Addr) -> None:
        body = msg.get("msg") or {}
        if body.get("cmd") != "scan":
            return
        data = body.get("data") or {}
        device_id = _norm(str(data.get("device", "")))
        if not device_id:
            return
        ip = str(data.get("ip") or addr[0])
        old = self.devices.get(device_id)
        if old and old.ip == ip and old.online:
            old.last_seen = time.time()
            return
        if old:
            old.ip, old.missed, old.last_seen = ip, 0, time.time()
        else:
            self.devices[device_id] = GoveeDevice(device_id, ip, str(data.get("sku", "")))
            self.devices[device_id].last_seen = time.time()
        log.info("Govee %s (%s) at %s", device_id, data.get("sku"), ip)
        self.changed()

    async def _scanner(self) -> None:
        while True:
            try:
                await self.scan()
            except asyncio.CancelledError:
                raise
            except Exception:
                log.exception("Govee scan failed")
            self._scan_now.clear()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._scan_now.wait(), self.scan_every_s)

    async def scan(self) -> None:
        assert self.sock is not None
        msg = {"msg": {"cmd": "scan", "data": {"account_topic": "reserve"}}}
        if self.multicast:
            with contextlib.suppress(OSError, ConnectionError):
                self.sock.send(msg, (self.multicast_group, self.scan_port))
        targets = [parse_hostport(h, self.scan_port) for h in self.hosts]
        targets += [(h, self.scan_port) for h in sweep_hosts(self.subnets)]
        for i, addr in enumerate(dict.fromkeys(targets)):
            with contextlib.suppress(OSError, ConnectionError):
                self.sock.send(msg, addr)
            if i % 32 == 31:
                await asyncio.sleep(0.01)
        await asyncio.sleep(self.timeout_s)

    async def _poller(self) -> None:
        while True:
            await asyncio.sleep(self.poll_every_s)
            for device in list(self.devices.values()):
                with contextlib.suppress(Exception):
                    await self.dev_status(device)

    async def dev_status(self, device: GoveeDevice) -> dict | None:
        """devStatus: on/off, brightness, colour. Three misses in a row and the device goes
        back to HA until it answers again."""
        assert self.sock is not None
        was_online = device.online
        try:
            reply = await self.sock.request(
                {"msg": {"cmd": "devStatus", "data": {}}},
                (device.ip, self.control_port),
                lambda m, a: a[0] == device.ip and (m.get("msg") or {}).get("cmd") == "devStatus",
                timeout=self.timeout_s,
                attempts=2,
            )
        except TimeoutError:
            device.missed += 1
            if was_online and not device.online:
                log.info("Govee %s stopped answering", device.device_id)
                self.changed()
                self._scan_now.set()
            return None
        device.status = (reply.get("msg") or {}).get("data")
        device.last_seen, device.missed = time.time(), 0
        if not was_online:
            self.changed()
        return device.status

    # ---- Driver -------------------------------------------------------------------------------

    def device_for(self, light: Light) -> GoveeDevice | None:
        device_id = device_id_of(light)
        device = self.devices.get(device_id) if device_id else None
        return device if device and device.online else None

    def handles(self, light: Light) -> bool:
        return light.entity_id.startswith("light.") and self.device_for(light) is not None

    def endpoint(self, light: Light) -> str | None:
        device = self.device_for(light)
        return f"Govee LAN {device.ip}" if device else None

    def supports(self, light: Light, state: LightState) -> bool:
        return not state.effect  # scenes aren't in the LAN API: HA (govee2mqtt) does those

    async def set(
        self, light: Light, state: LightState, transition_ms: int | None = None
    ) -> str | None:
        self.check_writable()
        device = self.device_for(light)
        if device is None or self.sock is None:
            raise ConnectionError(f"Govee device for {light.entity_id} not on the LAN")
        if device.razer_on:
            self._razer(device, False)
        for cmd in commands_for(state):
            self.sock.send({"msg": cmd}, (device.ip, self.control_port))
        return None

    def can_stream(self, light: Light) -> bool:
        device = self.device_for(light)
        return bool(device and device.sku.upper() in self.razer_models)

    async def stream(self, light: Light, pixels: list[tuple[int, int, int]]) -> None:
        """One colour per segment, as one razer frame. Only for models in razer_models."""
        self.check_writable()
        device = self.device_for(light)
        if device is None or self.sock is None or not self.can_stream(light):
            raise ConnectionError(f"Govee streaming isn't enabled for {light.entity_id}")
        if not device.razer_on:
            self._razer(device, True)
        self.sock.send(
            {"msg": {"cmd": "razer", "data": {"pt": razer_frame(pixels)}}},
            (device.ip, self.control_port),
        )

    def end_stream(self, light: Light) -> None:
        device = self.device_for(light)
        if device and device.razer_on and self.sock:
            self._razer(device, False)

    def _razer(self, device: GoveeDevice, on: bool) -> None:
        assert self.sock is not None
        self.sock.send(
            {"msg": {"cmd": "razer", "data": {"pt": razer_enable(on)}}},
            (device.ip, self.control_port),
        )
        device.razer_on = on

    def status(self) -> dict[str, Any]:
        out = super().status()
        out.update(
            devices=sum(1 for d in self.devices.values() if d.online),
            subnets=self.subnets,
            razer_models=sorted(self.razer_models),
            # What each device last answered to devStatus (polled every minute)
            found=[
                {
                    "device": d.device_id,
                    "sku": d.sku,
                    "ip": d.ip,
                    "online": d.online,
                    "status": d.status,
                }
                for d in self.devices.values()
            ],
        )
        return out
