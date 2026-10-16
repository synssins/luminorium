"""A fake zwave-js-server: the websocket protocol subset Luminorium uses.

`version` on connect, `set_api_schema`, `start_listening` (nodes from the HA fixtures, or given),
`node.set_value`, `multicast_group.set_value`, `node.poll_value`. Every command is recorded with a
timestamp (`commands`), and `frames()` lists the ones that reach the mesh. Values change as a
real node's would; `multicast_misses` makes chosen nodes ignore multicasts (unacknowledged frames
get lost), so the driver's read-back can be tested.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from pathlib import Path

from aiohttp import WSMsgType, web

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "ha"
UNIQUE_RE = re.compile(r"^\d+\.(\d+)-(\d+)-(\d+)-currentValue$")
MESH_COMMANDS = {"node.set_value", "multicast_group.set_value", "node.poll_value"}


@dataclass
class Command:
    at: float
    command: str
    payload: dict


def nodes_from_fixtures() -> dict[int, dict]:
    """Node id -> {"status"} from the HA fixtures (dead nodes stay dead)."""
    zwave = json.loads((FIXTURES / "zwave.json").read_text(encoding="utf-8"))
    out = {}
    for node in zwave.values():
        status = node.get("status") or {}
        if status.get("node_id") is not None:
            out[status["node_id"]] = {
                "nodeId": status["node_id"],
                "status": status.get("status", 4),
            }
    return out


@dataclass
class FakeZWaveServer:
    nodes: dict[int, dict] = field(default_factory=nodes_from_fixtures)
    values: dict[tuple[int, int, int], object] = field(default_factory=dict)  # (node, cc, ep)
    commands: list[Command] = field(default_factory=list)
    multicast_misses: set[int] = field(default_factory=set)
    max_schema: int = 40
    port: int = 0
    _runner: web.AppRunner | None = None
    _clients: list = field(default_factory=list)

    @property
    def url(self) -> str:
        return f"ws://127.0.0.1:{self.port}"

    async def start(self, port: int = 0) -> str:
        app = web.Application()
        app.router.add_get("/", self._handle)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", port)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        return self.url

    async def stop(self) -> None:
        for ws in list(self._clients):
            await ws.close()
        if self._runner:
            await self._runner.cleanup()

    def frames(self) -> list[Command]:
        """Commands that put a frame on the mesh (a multicast is one frame)."""
        return [c for c in self.commands if c.command in MESH_COMMANDS]

    async def _handle(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(max_msg_size=0)
        await ws.prepare(request)
        self._clients.append(ws)
        await ws.send_json(
            {
                "type": "version",
                "driverVersion": "15.29.0",
                "serverVersion": "3.10.2",
                "homeId": 1,
                "minSchemaVersion": 0,
                "maxSchemaVersion": self.max_schema,
            }
        )
        try:
            async for raw in ws:
                if raw.type != WSMsgType.TEXT:
                    break
                await self._command(ws, json.loads(raw.data))
        finally:
            self._clients.remove(ws)
        return ws

    async def _command(self, ws: web.WebSocketResponse, msg: dict) -> None:
        cmd, message_id = msg.get("command"), msg.get("messageId")
        self.commands.append(Command(time.monotonic(), cmd, msg))

        async def ok(result: dict | None = None) -> None:
            await ws.send_json(
                {"type": "result", "messageId": message_id, "success": True, "result": result or {}}
            )

        async def fail(code: str) -> None:
            await ws.send_json(
                {"type": "result", "messageId": message_id, "success": False, "errorCode": code}
            )

        if cmd == "set_api_schema":
            await ok()
        elif cmd == "start_listening":
            await ok({"state": {"controller": {}, "nodes": list(self.nodes.values())}})
        elif cmd == "node.set_value":
            node = msg["nodeId"]
            if node not in self.nodes or self.nodes[node].get("status") == 3:
                await fail("node_dead")
                return
            self._apply(node, msg["valueId"], msg["value"])
            await ok({"result": {"status": 255}})
        elif cmd == "multicast_group.set_value":
            for node in msg["nodeIDs"]:
                if node not in self.multicast_misses:
                    self._apply(node, msg["valueId"], msg["value"])
            await ok({"success": True})
        elif cmd == "node.poll_value":
            vid = msg["valueId"]
            await ok(
                {"value": self.values.get((msg["nodeId"], vid["commandClass"], vid["endpoint"]))}
            )
        else:
            await fail("unknown_command")

    def _apply(self, node: int, value_id: dict, value: object) -> None:
        key = (node, value_id["commandClass"], value_id.get("endpoint", 0))
        if value == 255:
            value = self.values.get(key) or 99  # "previous level"
        self.values[key] = value
