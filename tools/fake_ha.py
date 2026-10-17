"""A fake Home Assistant websocket server for tests and for running the UI on a PC.

It serves the scrubbed fixtures in tests/fixtures/ha, applies light and switch service calls to
its own copy of the states, emits ``state_changed`` events with the caller's context, and records
every call with a timestamp.

Run on its own:  python tools/fake_ha.py [--port 8124]
"""

from __future__ import annotations

import argparse
import asyncio
import copy
import json
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from aiohttp import WSMsgType, web

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "ha"
TOKEN = "fake-token"


@dataclass
class Call:
    at: float
    domain: str
    service: str
    entity_ids: list[str]
    data: dict
    context_id: str


@dataclass
class FakeHA:
    fixtures: Path = FIXTURES
    token: str = TOKEN
    floors: list = field(default_factory=list)
    areas: list = field(default_factory=list)
    devices: list = field(default_factory=list)
    entities: list = field(default_factory=list)
    states: dict = field(default_factory=dict)
    zwave: dict = field(default_factory=dict)
    calls: list[Call] = field(default_factory=list)
    # Seconds between a service call and its state change (per entity id, else the default).
    latency: dict = field(default_factory=dict)
    default_latency: float = 0.0
    # What zwave_js/network_status reports as the Z-Wave JS server HA uses
    zwave_server_url: str = "ws://core-zwave-js:3000"
    _clients: list = field(default_factory=list)
    _runner: web.AppRunner | None = None
    port: int = 0

    def __post_init__(self) -> None:
        def load(name: str):
            return json.loads((self.fixtures / f"{name}.json").read_text(encoding="utf-8"))

        self.floors, self.areas = load("floors"), load("areas")
        self.devices, self.entities = load("devices"), load("entities")
        self.states = {s["entity_id"]: s for s in load("states")}
        self.zwave = load("zwave")

    # ---- server lifecycle -------------------------------------------------------------------

    async def start(self, port: int = 0, host: str = "127.0.0.1") -> str:
        app = web.Application()
        app.router.add_get("/api/websocket", self._handle)
        self._runner = web.AppRunner(app)
        await self._runner.setup()
        site = web.TCPSite(self._runner, host, port)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        return f"ws://{host}:{self.port}/api/websocket"

    async def stop(self) -> None:
        for client in list(self._clients):
            await client["ws"].close()
        if self._runner:
            await self._runner.cleanup()

    async def drop_clients(self) -> None:
        """Close every connection, as HA does when it restarts."""
        for client in list(self._clients):
            await client["ws"].close()

    # ---- test helpers -----------------------------------------------------------------------

    async def external_change(self, entity_id: str, state: str, **attributes) -> None:
        """Change a light as a wall switch or an automation would (a context that isn't ours)."""
        await self._set_state(entity_id, state, attributes, context_id=uuid.uuid4().hex)

    def calls_for(self, entity_id: str) -> list[Call]:
        return [c for c in self.calls if entity_id in c.entity_ids]

    # ---- websocket protocol -----------------------------------------------------------------

    async def _handle(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        await ws.send_json({"type": "auth_required", "ha_version": "2026.9.2"})
        msg = await ws.receive_json()
        if msg.get("type") != "auth" or msg.get("access_token") != self.token:
            await ws.send_json({"type": "auth_invalid", "message": "Invalid access token"})
            await ws.close()
            return ws
        await ws.send_json({"type": "auth_ok", "ha_version": "2026.9.2"})
        client = {"ws": ws, "subs": {}}
        self._clients.append(client)
        try:
            async for raw in ws:
                if raw.type != WSMsgType.TEXT:
                    break
                await self._command(client, json.loads(raw.data))
        finally:
            self._clients.remove(client)
        return ws

    async def _command(self, client: dict, msg: dict) -> None:
        ws: web.WebSocketResponse = client["ws"]
        msg_id, kind = msg.get("id"), msg.get("type")

        async def ok(result=None):
            await ws.send_json({"id": msg_id, "type": "result", "success": True, "result": result})

        async def fail(code: str, message: str = ""):
            await ws.send_json(
                {
                    "id": msg_id,
                    "type": "result",
                    "success": False,
                    "error": {"code": code, "message": message},
                }
            )

        simple = {
            "config/floor_registry/list": self.floors,
            "config/area_registry/list": self.areas,
            "config/device_registry/list": self.devices,
            "config/entity_registry/list": self.entities,
        }
        if kind in simple:
            await ok(copy.deepcopy(simple[kind]))
        elif kind == "get_states":
            await ok(copy.deepcopy(list(self.states.values())))
        elif kind == "ping":
            await ws.send_json({"id": msg_id, "type": "pong"})
        elif kind == "subscribe_events":
            client["subs"][msg_id] = msg.get("event_type")
            await ok()
        elif kind in ("zwave_js/node_status", "zwave_js/node_capabilities"):
            node = self.zwave.get(msg.get("device_id"))
            if not node:
                await fail("not_found", "device not found")
            else:
                key = "status" if kind.endswith("status") else "capabilities"
                await ok(copy.deepcopy(node[key]))
        elif kind == "zwave_js/network_status":
            await ok({"client": {"ws_server_url": self.zwave_server_url, "connected": True}})
        elif kind == "call_service":
            await self._call_service(msg, ok, fail)
        else:
            await fail("unknown_command", f"Unknown command {kind}")

    async def _call_service(self, msg: dict, ok, fail) -> None:
        domain, service = msg["domain"], msg["service"]
        data = dict(msg.get("service_data") or {})
        targets = (msg.get("target") or {}).get("entity_id") or data.pop("entity_id", [])
        if isinstance(targets, str):
            targets = [targets]
        if domain not in ("light", "switch") or service not in ("turn_on", "turn_off"):
            await fail("service_not_found", f"{domain}.{service}")
            return
        for eid in targets:
            if eid not in self.states or not eid.startswith(domain + "."):
                await fail("not_found", f"{eid}")
                return
        context_id = uuid.uuid4().hex
        self.calls.append(Call(time.monotonic(), domain, service, list(targets), data, context_id))
        await ok({"context": {"id": context_id, "parent_id": None, "user_id": None}})
        for eid in targets:
            delay = self.latency.get(eid, self.default_latency)
            state = "on" if service == "turn_on" else "off"
            attrs = self._attributes_after(eid, service, data)
            if delay:
                asyncio.get_running_loop().call_later(
                    delay,
                    lambda e=eid, s=state, a=attrs: asyncio.ensure_future(
                        self._set_state(e, s, a, context_id)
                    ),
                )
            else:
                await self._set_state(eid, state, attrs, context_id)

    def _attributes_after(self, eid: str, service: str, data: dict) -> dict:
        current = self.states[eid]["attributes"]
        if service == "turn_off" or not eid.startswith("light."):
            return {"brightness": None} if eid.startswith("light.") else {}
        attrs: dict = {"brightness": data.get("brightness", current.get("brightness") or 255)}
        if "brightness_pct" in data:
            attrs["brightness"] = round(data["brightness_pct"] * 255 / 100)
        for key, mode in (
            ("xy_color", "xy"),
            ("hs_color", "hs"),
            ("rgb_color", "rgb"),
            ("rgbw_color", "rgbw"),
            ("rgbww_color", "rgbww"),
            ("color_temp_kelvin", "color_temp"),
        ):
            if key in data:
                attrs[key] = data[key]
                attrs["color_mode"] = mode
        if "effect" in data:
            attrs["effect"] = data["effect"]
        return attrs

    async def _set_state(self, eid: str, state: str, attrs: dict, context_id: str) -> None:
        old = copy.deepcopy(self.states[eid])
        new = copy.deepcopy(old)
        new["state"] = state
        new["attributes"].update(attrs)
        new["context"] = {"id": context_id, "parent_id": None, "user_id": None}
        self.states[eid] = new
        event = {
            "event_type": "state_changed",
            "data": {"entity_id": eid, "old_state": old, "new_state": new},
            "origin": "LOCAL",
            "context": new["context"],
        }
        for client in list(self._clients):
            for sub_id, event_type in client["subs"].items():
                if event_type in (None, "state_changed"):
                    try:
                        await client["ws"].send_json(
                            {"id": sub_id, "type": "event", "event": event}
                        )
                    except ConnectionError:
                        pass


async def _main(port: int) -> None:
    fake = FakeHA()
    url = await fake.start(port)
    print(f"Fake HA on {url} (token: {TOKEN})")
    await asyncio.Event().wait()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8124)
    asyncio.run(_main(parser.parse_args().port))
