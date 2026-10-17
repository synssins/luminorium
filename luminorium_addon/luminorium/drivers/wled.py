"""WLED: the JSON API for state, effects and palettes; DDP (UDP 4048) for per-LED frames.

A WLED device is found from its HA device: the configuration URL is its address, and the MAC
in HA's identifier must match the one the device reports. HA's lights map to it as:
- unique id `<mac>`: the master light (global on and brightness)
- unique id `<mac>_<n>`: segment n. With one segment, HA shows no master light, so on/off and
  brightness go to the whole device, as HA's WLED integration does.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import struct
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlparse

import aiohttp

from ..inventory.model import Light
from .base import DirectDriver, LightState
from .color import kelvin_to_rgb, state_kelvin, state_rgb

log = logging.getLogger(__name__)

DDP_PORT = 4048
DDP_MAX_PIXELS = 480  # 1440 data bytes per packet, as WLED and xLights send
DDP_VERSION_1 = 0x40
DDP_PUSH = 0x01
DDP_TYPE_RGB8 = 0x0B  # 00 001 011: RGB, 8 bits per channel
DDP_ID_DISPLAY = 1


def ddp_packets(
    pixels: list[tuple[int, int, int]], offset_px: int = 0, seq: int = 1
) -> list[bytes]:
    """DDP packets for a frame: 10-byte header (flags, sequence, type, id, offset, length)."""
    data = bytes(max(0, min(255, int(c))) for px in pixels for c in px[:3])
    out = []
    step = DDP_MAX_PIXELS * 3
    chunks = [data[i : i + step] for i in range(0, len(data), step)] or [b""]
    for i, chunk in enumerate(chunks):
        flags = DDP_VERSION_1 | (DDP_PUSH if i == len(chunks) - 1 else 0)
        offset = offset_px * 3 + i * step
        header = struct.pack(
            "!BBBBIH", flags, seq & 0x0F, DDP_TYPE_RGB8, DDP_ID_DISPLAY, offset, len(chunk)
        )
        out.append(header + chunk)
    return out


def segment_leds(segment: dict) -> list[int]:
    """The physical LEDs a WLED segment drives: from start to stop, `grp` LEDs on then `spc`
    skipped, over and over."""
    start, stop = int(segment.get("start", 0)), int(segment.get("stop", 0))
    grp = max(1, int(segment.get("grp") or 1))
    spc = max(0, int(segment.get("spc") or 0))
    return [i for i in range(start, stop) if (i - start) % (grp + spc) < grp]


def _mac(text: str) -> str:
    return re.sub(r"[^0-9a-f]", "", text.lower())


def wled_ids(light: Light) -> tuple[str, int | None] | None:
    """(mac, segment or None for the master light) from HA's ids."""
    mac = next((_mac(i) for d, i in light.device_identifiers if d == "wled"), None)
    if not mac:
        return None
    uid = light.unique_id or ""
    if uid == mac or _mac(uid) == mac:
        return mac, None
    match = re.match(r"^([0-9a-fA-F]+)_(\d+)$", uid)
    if match and _mac(match.group(1)) == mac:
        return mac, int(match.group(2))
    return None


def host_of(light: Light) -> str | None:
    if not light.device_url:
        return None
    parsed = urlparse(light.device_url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    return parsed.netloc


@dataclass
class WLEDDevice:
    host: str  # host[:port] for HTTP
    mac: str = ""
    name: str = ""
    leds: int = 0
    effects: list[str] = field(default_factory=list)
    palettes: list[str] = field(default_factory=list)
    # [{"id", "name", "start", "stop", "grp", "spc"}]: grouping and spacing as WLED has them
    segments: list[dict] = field(default_factory=list)
    online: bool = False

    @property
    def ip(self) -> str:
        return urlparse(f"http://{self.host}").hostname or self.host


class WLEDDriver(DirectDriver):
    name = "wled"
    network_name = "wled"

    def __init__(
        self,
        *,
        read_only: bool = False,
        refresh_every_s: float = 300.0,
        ddp_port: int = DDP_PORT,
        timeout_s: float = 3.0,
    ):
        super().__init__(read_only=read_only)
        self.devices: dict[str, WLEDDevice] = {}  # mac -> device
        self.refresh_every_s = refresh_every_s
        self.ddp_port = ddp_port
        self.timeout_s = timeout_s
        self._wanted: dict[str, str] = {}  # mac -> host, from HA
        self._session: aiohttp.ClientSession | None = None
        self._task: asyncio.Task | None = None
        self._ddp: asyncio.DatagramTransport | None = None
        self._seq = 0
        self._wake = asyncio.Event()

    def watch(self, lights: list[Light]) -> None:
        """Tell the driver which WLED devices HA has (called with the inventory's lights)."""
        wanted = {}
        for light in lights:
            ids, host = wled_ids(light), host_of(light)
            if ids and host:
                wanted[ids[0]] = host
        if wanted != self._wanted:
            self._wanted = wanted
            self._wake.set()

    async def start(self) -> None:
        self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.timeout_s))
        loop = asyncio.get_running_loop()
        self._ddp, _ = await loop.create_datagram_endpoint(
            asyncio.DatagramProtocol, local_addr=("0.0.0.0", 0)
        )
        self.connected = True
        self._task = asyncio.create_task(self._refresher(), name="wled")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
        if self._ddp:
            self._ddp.close()
        if self._session:
            await self._session.close()

    async def _refresher(self) -> None:
        while True:
            self._wake.clear()
            await self.refresh()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(self._wake.wait(), self.refresh_every_s)

    async def refresh(self) -> None:
        results = await asyncio.gather(
            *(self._probe(mac, host) for mac, host in self._wanted.items())
        )
        if any(results):
            self.changed()

    async def _probe(self, mac: str, host: str) -> bool:
        """Read a device's info, effects, palettes and segments. True if anything changed."""
        old = self.devices.get(mac)
        try:
            info = await self._get(host, "/json/info")
            if _mac(str(info.get("mac", ""))) != mac:
                raise ValueError(f"{host} reports MAC {info.get('mac')}, HA has {mac}")
            effects = await self._get(host, "/json/eff")
            palettes = await self._get(host, "/json/pal")
            state = await self._get(host, "/json/state")
        except (aiohttp.ClientError, TimeoutError, ValueError, OSError) as err:
            if old and old.online:
                log.info("WLED %s (%s) not reachable: %s", mac, host, err)
                old.online = False
                return True
            return False
        device = WLEDDevice(
            host=host,
            mac=mac,
            name=str(info.get("name", "")),
            leds=int((info.get("leds") or {}).get("count", 0)),
            effects=[str(e) for e in effects],
            palettes=[str(p) for p in palettes],
            segments=[
                {
                    "id": s.get("id", i),
                    "name": str(s.get("n") or ""),
                    "start": s.get("start", 0),
                    "stop": s.get("stop", 0),
                    "grp": s.get("grp", 1),
                    "spc": s.get("spc", 0),
                }
                for i, s in enumerate(state.get("seg") or [])
            ],
            online=True,
        )
        self.devices[mac] = device
        if old is None or not old.online or old.host != host:
            log.info(
                "WLED %s at %s: %d LEDs, %d effects",
                device.name,
                host,
                device.leds,
                len(device.effects),
            )
            return True
        return False

    async def _get(self, host: str, path: str) -> Any:
        assert self._session is not None
        async with self._session.get(f"http://{host}{path}") as resp:
            resp.raise_for_status()
            return await resp.json(content_type=None)

    async def _post_state(self, host: str, body: dict) -> dict:
        assert self._session is not None
        async with self._session.post(f"http://{host}/json/state", json=body) as resp:
            resp.raise_for_status()
            return await resp.json(content_type=None)

    # ---- Driver -------------------------------------------------------------------------------

    def device_for(self, light: Light) -> tuple[WLEDDevice, int | None] | None:
        ids = wled_ids(light)
        if not ids:
            return None
        device = self.devices.get(ids[0])
        if device is None or not device.online:
            return None
        return device, ids[1]

    def handles(self, light: Light) -> bool:
        return self.device_for(light) is not None

    def endpoint(self, light: Light) -> str | None:
        found = self.device_for(light)
        if not found:
            return None
        device, seg = found
        return f"WLED {device.ip}" + (f" segment {seg}" if seg is not None else "")

    def supports(self, light: Light, state: LightState) -> bool:
        found = self.device_for(light)
        return not state.effect or bool(found and state.effect in found[0].effects)

    def state_body(
        self, device: WLEDDevice, seg: int | None, state: LightState, transition_ms: int | None
    ) -> dict[str, Any]:
        body: dict[str, Any] = {}
        if transition_ms is not None:
            body["tt"] = max(0, round(transition_ms / 100))  # this call only, in 100 ms
        whole = seg is None or len(device.segments) <= 1
        if whole:
            body["on"] = state.on
            if state.on and state.brightness is not None:
                body["bri"] = max(1, min(255, int(state.brightness)))
        if seg is None:
            return body
        segment: dict[str, Any] = {"id": seg}
        if not whole:
            segment["on"] = state.on
            if state.on and state.brightness is not None:
                segment["bri"] = max(1, min(255, int(state.brightness)))
        if state.on:
            rgb = state_rgb(state)
            kelvin = state_kelvin(state)
            if rgb is None and kelvin is not None:
                rgb = kelvin_to_rgb(kelvin)
            if rgb is not None:
                segment["col"] = [list(rgb)]
            if state.effect and state.effect in device.effects:
                segment["fx"] = device.effects.index(state.effect)
        body["seg"] = [segment]
        return body

    async def set(
        self, light: Light, state: LightState, transition_ms: int | None = None
    ) -> str | None:
        self.check_writable()
        found = self.device_for(light)
        if found is None:
            raise ConnectionError(f"WLED device for {light.entity_id} not reachable")
        device, seg = found
        await self._post_state(device.host, self.state_body(device, seg, state, transition_ms))
        return None

    async def effect(
        self,
        light: Light,
        name: str,
        *,
        palette: str | None = None,
        speed: int | None = None,
        intensity: int | None = None,
    ) -> None:
        """A native effect on the light's segment (segment 0 for the master light)."""
        self.check_writable()
        found = self.device_for(light)
        if found is None:
            raise ConnectionError(f"WLED device for {light.entity_id} not reachable")
        device, seg = found
        if name not in device.effects:
            raise ValueError(f"WLED {device.name} has no effect {name!r}")
        segment: dict[str, Any] = {"id": seg or 0, "fx": device.effects.index(name)}
        if palette is not None:
            if palette not in device.palettes:
                raise ValueError(f"WLED {device.name} has no palette {palette!r}")
            segment["pal"] = device.palettes.index(palette)
        if speed is not None:
            segment["sx"] = max(0, min(255, int(speed)))
        if intensity is not None:
            segment["ix"] = max(0, min(255, int(intensity)))
        await self._post_state(device.host, {"on": True, "seg": [segment]})

    def can_stream(self, light: Light) -> bool:
        return self.device_for(light) is not None

    def leds(self, light: Light) -> list[int]:
        """The light's physical LEDs, in order: the whole strip for the master light, else its
        segment's (two segments can interleave, every other LED each, with spacing)."""
        found = self.device_for(light)
        if not found:
            return []
        device, seg = found
        segment = next((s for s in device.segments if s["id"] == seg), None)
        if segment is None:
            return list(range(device.leds))
        return segment_leds(segment)

    def pixel_count(self, light: Light) -> int:
        return len(self.leds(light))

    async def stream(self, light: Light, pixels: list[tuple[int, int, int]]) -> None:
        """One DDP frame for the light's LEDs (its segment's range). WLED shows it in realtime
        mode and goes back to its own state a few seconds after frames stop."""
        self.check_writable()
        found = self.device_for(light)
        if found is None or self._ddp is None:
            raise ConnectionError(f"WLED device for {light.entity_id} not reachable")
        device, _ = found
        leds = self.leds(light)[: len(pixels)]
        if not leds:
            return
        # One run from the first LED to the last; LEDs in between that aren't the light's are dark
        start = min(leds)
        frame = [(0, 0, 0)] * (max(leds) - start + 1)
        for led, px in zip(leds, pixels, strict=False):
            frame[led - start] = px
        self._seq = self._seq % 15 + 1
        for data in ddp_packets(frame, start, self._seq):
            self._ddp.sendto(data, (device.ip, self.ddp_port))

    def status(self) -> dict[str, Any]:
        out = super().status()
        out.update(devices=sum(1 for d in self.devices.values() if d.online))
        return out
