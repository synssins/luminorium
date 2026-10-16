"""Z-Wave JS server websocket (the Z-Wave JS add-on, `ws://core-zwave-js:3000`).

- `node.set_value` on Multilevel Switch (38) or Binary Switch (37) `targetValue`, with a
  `transitionDuration` only where the dimmer has Multilevel Switch v2 or later (the GE 12724s
  are v1: no duration).
- `multicast_group.set_value` for several nodes getting the same value: one frame on the mesh.
  zwave-js multicasts only within one security class, so batches are split by class; S0 nodes
  can't multicast at all. Multicast is unacknowledged, so the driver reads the value back
  afterwards and resends by unicast to any node that missed it.
- Every frame the driver sends, read-backs included, takes a token from the Z-Wave network
  budget (the governor hands the driver `acquire`); a multicast takes one.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
import re
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp

from ..inventory.model import Light
from .base import DirectDriver, LightState

log = logging.getLogger(__name__)

CC_BINARY_SWITCH = 37
CC_MULTILEVEL_SWITCH = 38
NODE_DEAD = 3
# The schema this driver is written against (zwave-js-server 1.x, schema 35+ works the same for
# the commands used here). The server's own range is respected.
WANTED_SCHEMA = 35
# HA's unique id for the value behind a light: <home id>.<node>-<cc>-<endpoint>-currentValue
UNIQUE_RE = re.compile(r"^\d+\.(\d+)-(\d+)-(\d+)-currentValue$")
# Security classes that can't multicast, or that we don't know
NO_MULTICAST = {"S0 Legacy", "unknown", None}
VERIFY_AFTER_S = 1.5
LEVEL_TOLERANCE = 2


def value_of(light: Light) -> tuple[int, int, int] | None:
    """(node id, command class, endpoint) of the value behind a light, from HA's unique id."""
    match = UNIQUE_RE.match(light.unique_id or "")
    if not match:
        return None
    node, cc, endpoint = (int(g) for g in match.groups())
    if cc not in (CC_BINARY_SWITCH, CC_MULTILEVEL_SWITCH):
        return None
    return node, cc, endpoint


def target_value(cc: int, state: LightState) -> int | bool:
    if cc == CC_BINARY_SWITCH:
        return bool(state.on)
    if not state.on:
        return 0
    if state.brightness is None:
        return 255  # Multilevel Switch: "on at the previous level"
    if state.brightness <= 0:
        return 0
    return max(1, min(99, round(state.brightness * 99 / 255)))


def duration_ok(light: Light) -> bool:
    details = light.profile.details if light.profile else {}
    version = details.get("multilevel_switch_version")
    return bool(version and version >= 2)


def duration(ms: int) -> str:
    """zwave-js duration string; Z-Wave counts whole seconds below two minutes."""
    seconds = max(0, round(ms / 1000))
    return f"{seconds}s" if seconds < 120 else f"{round(seconds / 60)}m"


class ZWaveError(Exception):
    pass


class ZWaveDriver(DirectDriver):
    name = "zwave_js"
    network_name = "zwave"

    def __init__(
        self,
        urls: list[str],
        *,
        read_only: bool = False,
        verify_multicast: bool = True,
        verify_after_s: float = VERIFY_AFTER_S,
    ):
        super().__init__(read_only=read_only)
        self.urls = [u for u in dict.fromkeys(urls) if u]
        self.url: str | None = None
        self.verify_multicast = verify_multicast
        self.verify_after_s = verify_after_s
        # Network budget: the governor's token bucket for "zwave", for frames sent outside it
        self.acquire: Callable[[], Awaitable[None]] | None = None
        self.nodes: dict[int, dict] = {}  # node id -> {"status": int, "ready": bool}
        self.server_version: str | None = None
        self.multicasts = 0
        self.read_back_misses = 0
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._session: aiohttp.ClientSession | None = None
        self._runner: asyncio.Task | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._ids = itertools.count(1)
        self._seq: dict[int, int] = {}  # node -> sequence number of the last value sent
        self._verifiers: set[asyncio.Task] = set()
        if not self.urls:
            self.error = "no Z-Wave JS server found"

    # ---- connection ---------------------------------------------------------------------------

    async def start(self) -> None:
        if not self.urls:
            return
        self._session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, connect=10))
        self._runner = asyncio.create_task(self._run(), name="zwave-js")

    async def stop(self) -> None:
        for task in list(self._verifiers):
            task.cancel()
        if self._runner:
            self._runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._runner
        if self._ws:
            await self._ws.close()
        if self._session:
            await self._session.close()

    async def _run(self) -> None:
        delay = 1.0
        while True:
            for url in self.urls:
                try:
                    await self._connect(url)
                    delay = 1.0
                except asyncio.CancelledError:
                    raise
                except (aiohttp.ClientError, OSError, TimeoutError, ZWaveError) as err:
                    self.error = f"{url}: {err or type(err).__name__}"
                    log.debug("Z-Wave JS %s", self.error)
                self._lost()
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    def _lost(self) -> None:
        self._ws = None
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError("Z-Wave JS link lost"))
        self._pending.clear()
        if self.connected:
            self.connected = False
            self.changed()

    async def _connect(self, url: str) -> None:
        assert self._session is not None
        async with self._session.ws_connect(url, heartbeat=30, max_msg_size=0) as ws:
            hello = await asyncio.wait_for(ws.receive_json(), 10)
            if hello.get("type") != "version":
                raise ZWaveError(f"unexpected first message {hello.get('type')}")
            self.server_version = hello.get("serverVersion")
            schema = max(
                int(hello.get("minSchemaVersion", 0)),
                min(WANTED_SCHEMA, int(hello.get("maxSchemaVersion", WANTED_SCHEMA))),
            )
            self._ws = ws
            reader = asyncio.create_task(self._read(ws))
            try:
                await self._command({"command": "set_api_schema", "schemaVersion": schema})
                result = await self._command({"command": "start_listening"})
                nodes = ((result or {}).get("state") or {}).get("nodes") or []
                self.nodes = {
                    n["nodeId"]: {"status": n.get("status"), "ready": n.get("ready")}
                    for n in nodes
                    if "nodeId" in n
                }
                self.url, self.error, self.connected = url, None, True
                log.info("Z-Wave JS %s at %s: %d nodes", self.server_version, url, len(nodes))
                self.changed()
                await reader
            finally:
                reader.cancel()

    async def _read(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for raw in ws:
            if raw.type != aiohttp.WSMsgType.TEXT:
                break
            msg = raw.json()
            if msg.get("type") == "result":
                fut = self._pending.pop(str(msg.get("messageId")), None)
                if fut and not fut.done():
                    if msg.get("success"):
                        fut.set_result(msg.get("result"))
                    else:
                        fut.set_exception(
                            ZWaveError(msg.get("errorCode") or msg.get("message") or "failed")
                        )
            elif msg.get("type") == "event":
                self._event(msg.get("event") or {})

    def _event(self, event: dict) -> None:
        node = self.nodes.get(event.get("nodeId"))  # type: ignore[arg-type]
        if event.get("source") != "node" or node is None:
            return
        kind = event.get("event")
        if kind in ("dead", "alive", "sleep", "wake up"):
            node["status"] = {"dead": NODE_DEAD, "alive": 4, "sleep": 1, "wake up": 2}[kind]
            self.changed()

    async def _command(self, payload: dict, timeout: float = 15.0) -> Any:
        if self._ws is None:
            raise ConnectionError("Z-Wave JS not connected")
        message_id = f"lum-{next(self._ids)}"
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[message_id] = fut
        try:
            await self._ws.send_json({"messageId": message_id, **payload})
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(message_id, None)

    # ---- Driver -------------------------------------------------------------------------------

    def handles(self, light: Light) -> bool:
        if not self.connected:
            return False
        value = value_of(light)
        if value is None:
            return False
        node = self.nodes.get(value[0])
        return node is not None and node.get("status") != NODE_DEAD

    def endpoint(self, light: Light) -> str | None:
        value = value_of(light)
        return f"Z-Wave node {value[0]}" if value else None

    async def set(
        self, light: Light, state: LightState, transition_ms: int | None = None
    ) -> str | None:
        self.check_writable()
        value = value_of(light)
        if value is None:
            raise ValueError(f"{light.entity_id} isn't a Z-Wave switch value")
        node, cc, endpoint = value
        target = target_value(cc, state)
        self._seq[node] = self._seq.get(node, 0) + 1
        await self._set_value(node, cc, endpoint, target, self._options(light, cc, transition_ms))
        return None

    def batches(self, lights: list[Light], state: LightState) -> list[list[Light]]:
        """Group by security class, command class and endpoint (one value id per multicast)
        and, when a transition is asked for, by whether the duration is honoured."""
        groups: dict[tuple, list[Light]] = {}
        singles: list[list[Light]] = []
        for light in lights:
            value = value_of(light)
            security = (light.profile.details if light.profile else {}).get("security")
            if value is None or security in NO_MULTICAST:
                singles.append([light])
                continue
            key = (
                security,
                value[1],
                value[2],
                value[1] == CC_MULTILEVEL_SWITCH and duration_ok(light),
            )
            groups.setdefault(key, []).append(light)
        out = []
        for members in groups.values():
            if len(members) >= 2:
                out.append(members)
            else:
                singles.append(members)
        return out + singles

    async def set_batch(
        self, lights: list[Light], state: LightState, transition_ms: int | None = None
    ) -> str | None:
        if len(lights) == 1:
            return await self.set(lights[0], state, transition_ms)
        self.check_writable()
        values = [value_of(lt) for lt in lights]
        if any(v is None for v in values):
            raise ValueError("not all lights are Z-Wave switch values")
        nodes = [v[0] for v in values]  # type: ignore[index]
        _, cc, endpoint = values[0]  # type: ignore[misc]
        target = target_value(cc, state)
        options = self._options(lights[0], cc, transition_ms)
        payload: dict[str, Any] = {
            "command": "multicast_group.set_value",
            "nodeIDs": nodes,
            "valueId": {"commandClass": cc, "endpoint": endpoint, "property": "targetValue"},
            "value": target,
        }
        if options:
            payload["options"] = options
        seqs = {}
        for node in nodes:
            self._seq[node] = self._seq.get(node, 0) + 1
            seqs[node] = self._seq[node]
        await self._command(payload)
        self.multicasts += 1
        if self.verify_multicast:
            wait = self.verify_after_s + (transition_ms or 0) / 1000
            task = asyncio.create_task(self._verify(seqs, cc, endpoint, target, options, wait))
            self._verifiers.add(task)
            task.add_done_callback(self._verifiers.discard)
        return None

    def _options(self, light: Light, cc: int, transition_ms: int | None) -> dict | None:
        if transition_ms is None or cc != CC_MULTILEVEL_SWITCH or not duration_ok(light):
            return None
        return {"transitionDuration": duration(transition_ms)}

    async def _set_value(
        self, node: int, cc: int, endpoint: int, value: Any, options: dict | None
    ) -> None:
        payload: dict[str, Any] = {
            "command": "node.set_value",
            "nodeId": node,
            "valueId": {"commandClass": cc, "endpoint": endpoint, "property": "targetValue"},
            "value": value,
        }
        if options:
            payload["options"] = options
        await self._command(payload)

    async def _verify(
        self,
        seqs: dict[int, int],
        cc: int,
        endpoint: int,
        target: Any,
        options: dict | None,
        wait: float,
    ) -> None:
        """After a multicast: read each node's value back; resend by unicast where it missed.
        Skips nodes that got a newer command meanwhile (latest value wins)."""
        await asyncio.sleep(wait)
        for node, seq in seqs.items():
            if self._seq.get(node) != seq:
                continue
            try:
                if self.acquire:
                    await self.acquire()
                result = await self._command(
                    {
                        "command": "node.poll_value",
                        "nodeId": node,
                        "valueId": {
                            "commandClass": cc,
                            "endpoint": endpoint,
                            "property": "currentValue",
                        },
                    }
                )
                current = (result or {}).get("value")
                if _reached(current, target) or self._seq.get(node) != seq:
                    continue
                self.read_back_misses += 1
                log.info("Z-Wave node %s missed a multicast (%s, wanted %s)", node, current, target)
                if self.acquire:
                    await self.acquire()
                if self._seq.get(node) == seq and not self.read_only:
                    await self._set_value(node, cc, endpoint, target, options)
            except asyncio.CancelledError:
                raise
            except Exception as err:
                log.debug("Z-Wave read-back of node %s failed: %s", node, err)

    def status(self) -> dict[str, Any]:
        out = super().status()
        out.update(
            url=self.url,
            server=self.server_version,
            nodes=len(self.nodes),
            multicasts=self.multicasts,
            read_back_misses=self.read_back_misses,
        )
        return out


def _reached(current: Any, target: Any) -> bool:
    if isinstance(target, bool):
        return bool(current) == target
    if target == 255:
        return bool(current)  # "previous level": any level that's on
    if current is None:
        return False
    return abs(int(current) - int(target)) <= LEVEL_TOLERANCE
