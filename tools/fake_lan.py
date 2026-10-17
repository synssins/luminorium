"""Fake LAN lights on loopback: a WiZ bulb (UDP), a WLED controller (HTTP + DDP over UDP) and a
Govee device (UDP). Each answers like the real firmware and records what it receives, with
timestamps.

The WiZ bulb follows Bifrost's fake (bifrost/tests/wiz.rs): getPilot, getSystemConfig,
getUserConfig, and setPilot merged into its state.
"""

from __future__ import annotations

import asyncio
import json
import struct
import time
from dataclasses import dataclass, field

from aiohttp import web


class _UDP(asyncio.DatagramProtocol):
    def __init__(self, handler):
        self.handler = handler
        self.transport: asyncio.DatagramTransport | None = None

    def connection_made(self, transport):  # type: ignore[override]
        self.transport = transport

    def datagram_received(self, data, addr):  # type: ignore[override]
        self.handler(data, addr)


async def _udp(handler, host: str, port: int) -> _UDP:
    loop = asyncio.get_running_loop()
    _, proto = await loop.create_datagram_endpoint(lambda: _UDP(handler), local_addr=(host, port))
    return proto


@dataclass
class Received:
    at: float
    message: dict


# ---- WiZ --------------------------------------------------------------------------------------


@dataclass
class FakeWiZBulb:
    mac: str = "a8bb50000001"
    module: str = "ESP01_SHRGB1C_31"
    host: str = "127.0.0.1"
    answer: bool = True  # False: the bulb is unplugged
    state: dict = field(
        default_factory=lambda: {
            "rssi": -50,
            "src": "",
            "state": False,
            "sceneId": 0,
            "temp": 2700,
            "dimming": 50,
        }
    )
    received: list[Received] = field(default_factory=list)
    port: int = 0
    _proto: _UDP | None = None

    async def start(self, port: int = 0) -> int:
        self._proto = await _udp(self._datagram, self.host, port)
        self.port = self._proto.transport.get_extra_info("sockname")[1]  # type: ignore[union-attr]
        return self.port

    def stop(self) -> None:
        if self._proto and self._proto.transport:
            self._proto.transport.close()

    @property
    def addr(self) -> str:
        return f"{self.host}:{self.port}"

    def set_pilots(self) -> list[dict]:
        return [r.message["params"] for r in self.received if r.message.get("method") == "setPilot"]

    def _datagram(self, data: bytes, addr) -> None:
        try:
            req = json.loads(data)
        except ValueError:
            return
        self.received.append(Received(time.monotonic(), req))
        if not self.answer:
            return
        method = req.get("method")
        if method == "getPilot":
            result = {"mac": self.mac, **self.state}
        elif method == "getSystemConfig":
            result = {
                "mac": self.mac,
                "homeId": 1,
                "roomId": 2,
                "moduleName": self.module,
                "fwVersion": "1.30.0",
            }
        elif method == "getUserConfig":
            result = {"whiteRange": [2700, 6500], "extRange": [2200, 6500]}
        elif method == "setPilot":
            self.state.update(req.get("params") or {})
            result = {"success": True}
        else:
            return
        reply = {"method": method, "env": "pro", "result": result}
        assert self._proto and self._proto.transport
        self._proto.transport.sendto(json.dumps(reply).encode(), addr)


# ---- WLED -------------------------------------------------------------------------------------


@dataclass
class FakeWLED:
    mac: str = "d48afca1d67c"
    name: str = "Front pathway lights"
    leds: int = 8
    segments: list[dict] = field(
        default_factory=lambda: [{"id": 0, "start": 0, "stop": 4}, {"id": 1, "start": 4, "stop": 8}]
    )
    effects: list[str] = field(default_factory=lambda: ["Solid", "Blink", "Breathe", "Fire 2012"])
    palettes: list[str] = field(default_factory=lambda: ["Default", "Forest", "Ocean"])
    posts: list[Received] = field(default_factory=list)
    ddp: list[tuple[float, bytes]] = field(default_factory=list)
    http_port: int = 0
    ddp_port: int = 0
    _runner: web.AppRunner | None = None
    _udp: _UDP | None = None

    @property
    def host(self) -> str:
        return f"127.0.0.1:{self.http_port}"

    async def start(self) -> None:
        app = web.Application()
        app.router.add_get("/json/info", self._info)
        app.router.add_get("/json/eff", self._effects)
        app.router.add_get("/json/pal", self._palettes)
        app.router.add_get("/json/state", self._state)
        app.router.add_post("/json/state", self._post)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        self.http_port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        self._udp = await _udp(lambda d, a: self.ddp.append((time.monotonic(), d)), "127.0.0.1", 0)
        self.ddp_port = self._udp.transport.get_extra_info("sockname")[1]  # type: ignore[union-attr]

    async def stop(self) -> None:
        if self._udp and self._udp.transport:
            self._udp.transport.close()
        if self._runner:
            await self._runner.cleanup()

    async def _info(self, request):
        return web.json_response(
            {"name": self.name, "mac": self.mac, "ver": "17.0.0-dev", "leds": {"count": self.leds}}
        )

    async def _effects(self, request):
        return web.json_response(self.effects)

    async def _palettes(self, request):
        return web.json_response(self.palettes)

    async def _state(self, request):
        return web.json_response({"on": True, "bri": 128, "seg": self.segments})

    async def _post(self, request):
        body = await request.json()
        self.posts.append(Received(time.monotonic(), body))
        return web.json_response({"success": True})

    def ddp_pixels(self) -> list[tuple[int, int, bytes]]:
        """(flags, offset, data) of each DDP packet received."""
        out = []
        for _, packet in self.ddp:
            flags, _, _, _, offset, length = struct.unpack("!BBBBIH", packet[:10])
            out.append((flags, offset, packet[10 : 10 + length]))
        return out


# ---- Govee ------------------------------------------------------------------------------------


@dataclass
class FakeGovee:
    """A Govee device with LAN Control on. Real devices listen on 4001 (scan) and 4003
    (control) and answer to the sender's port 4002; here the ports are chosen by the test and
    replies go to `reply_port`."""

    device: str = "1B:C8:BC:54:70:05:3F:C2"
    sku: str = "H7055"
    host: str = "127.0.0.1"
    reply_port: int = 4002
    answer_multicast: bool = False
    status: dict = field(
        default_factory=lambda: {
            "onOff": 0,
            "brightness": 100,
            "color": {"r": 255, "g": 255, "b": 255},
            "colorTemInKelvin": 7200,
        }
    )
    received: list[Received] = field(default_factory=list)
    scan_port: int = 0
    control_port: int = 0
    _scan: _UDP | None = None
    _control: _UDP | None = None

    async def start(self) -> None:
        self._scan = await _udp(self._on_scan, self.host, 0)
        self._control = await _udp(self._on_control, self.host, 0)
        self.scan_port = self._scan.transport.get_extra_info("sockname")[1]  # type: ignore[union-attr]
        self.control_port = self._control.transport.get_extra_info("sockname")[1]  # type: ignore[union-attr]

    def stop(self) -> None:
        for proto in (self._scan, self._control):
            if proto and proto.transport:
                proto.transport.close()

    def commands(self, cmd: str | None = None) -> list[dict]:
        return [
            r.message["msg"]
            for r in self.received
            if cmd is None or r.message.get("msg", {}).get("cmd") == cmd
        ]

    def _reply(self, proto: _UDP, addr, msg: dict) -> None:
        assert proto.transport
        proto.transport.sendto(json.dumps({"msg": msg}).encode(), (addr[0], self.reply_port))

    def _on_scan(self, data: bytes, addr) -> None:
        msg = json.loads(data)
        self.received.append(Received(time.monotonic(), msg))
        if msg.get("msg", {}).get("cmd") == "scan" and self._scan:
            data = {
                "ip": self.host,
                "device": self.device,
                "sku": self.sku,
                "bleVersionHard": "3.01.01",
                "wifiVersionSoft": "1.02.11",
            }
            self._reply(self._scan, addr, {"cmd": "scan", "data": data})

    def _on_control(self, data: bytes, addr) -> None:
        msg = json.loads(data)
        self.received.append(Received(time.monotonic(), msg))
        body = msg.get("msg") or {}
        cmd, data_ = body.get("cmd"), body.get("data") or {}
        if cmd == "turn":
            self.status["onOff"] = data_.get("value")
        elif cmd == "brightness":
            self.status["brightness"] = data_.get("value")
        elif cmd == "colorwc":
            self.status["color"] = data_.get("color")
            self.status["colorTemInKelvin"] = data_.get("colorTemInKelvin")
        elif cmd == "devStatus" and self._control:
            self._reply(self._control, addr, {"cmd": "devStatus", "data": dict(self.status)})
