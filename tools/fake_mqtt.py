"""A fake MQTT broker (3.1.1, QoS 0) with a fake Zigbee2MQTT on it, for tests and dev runs.

The broker keeps retained messages, routes publishes to matching subscriptions and records
every publish with a timestamp (`published`). `FakeZ2M` publishes `bridge/devices`,
`bridge/groups` and `bridge/state` (retained) from the HA fixtures, and answers `<name>/set` by
publishing the new state on `<name>`, as z2m does.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import struct
import time
from dataclasses import dataclass, field
from pathlib import Path

from luminorium.net.mqtt import (
    CONNACK,
    CONNECT,
    DISCONNECT,
    PINGREQ,
    PINGRESP,
    PUBLISH,
    SUBACK,
    SUBSCRIBE,
    decode_publish,
    encode_publish,
    packet,
    read_packet,
    read_str,
    topic_matches,
)

FIXTURES = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "ha"


@dataclass
class Published:
    at: float
    client: str
    topic: str
    payload: bytes

    def json(self):
        return json.loads(self.payload)


@dataclass
class _Client:
    client_id: str
    writer: asyncio.StreamWriter
    subs: list[str] = field(default_factory=list)


class FakeBroker:
    def __init__(self, username: str = "", password: str = ""):
        self.username, self.password = username, password
        self.retained: dict[str, bytes] = {}
        self.published: list[Published] = []
        self.clients: list[_Client] = []
        self.port = 0
        self._server: asyncio.base_events.Server | None = None
        self._listeners: list = []  # callbacks(topic, payload) inside the broker (fake z2m)

    async def start(self, port: int = 0, host: str = "127.0.0.1") -> int:
        self._server = await asyncio.start_server(self._handle, host, port)
        self.port = self._server.sockets[0].getsockname()[1]
        return self.port

    async def stop(self) -> None:
        await self.drop_clients()
        if self._server:
            self._server.close()
            with contextlib.suppress(Exception):
                await self._server.wait_closed()

    async def drop_clients(self) -> None:
        for c in list(self.clients):
            c.writer.close()

    def topics(self, prefix: str = "") -> list[Published]:
        return [p for p in self.published if p.topic.startswith(prefix)]

    async def publish(self, topic: str, payload: bytes | str, retain: bool = False) -> None:
        data = payload.encode() if isinstance(payload, str) else payload
        if retain:
            self.retained[topic] = data
        for c in list(self.clients):
            if any(topic_matches(s, topic) for s in c.subs):
                with contextlib.suppress(ConnectionError):
                    c.writer.write(encode_publish(topic, data))
                    await c.writer.drain()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        client: _Client | None = None
        try:
            kind, _, body = await read_packet(reader)
            if kind != CONNECT:
                return
            _, pos = read_str(body, 0)
            flags = body[pos + 1]
            pos += 4
            client_id, pos = read_str(body, pos)
            user = password = ""
            if flags & 0x80:
                user, pos = read_str(body, pos)
            if flags & 0x40:
                password, pos = read_str(body, pos)
            if self.username and (user, password) != (self.username, self.password):
                writer.write(packet(CONNACK, 0, b"\x00\x04"))
                await writer.drain()
                return
            writer.write(packet(CONNACK, 0, b"\x00\x00"))
            await writer.drain()
            client = _Client(client_id, writer)
            self.clients.append(client)
            while True:
                kind, flags, body = await read_packet(reader)
                if kind == SUBSCRIBE:
                    (packet_id,) = struct.unpack_from("!H", body, 0)
                    pattern, _ = read_str(body, 2)
                    client.subs.append(pattern)
                    writer.write(packet(SUBACK, 0, struct.pack("!HB", packet_id, 0)))
                    for topic, data in list(self.retained.items()):
                        if topic_matches(pattern, topic):
                            writer.write(encode_publish(topic, data, retain=True))
                    await writer.drain()
                elif kind == PUBLISH:
                    topic, payload, retain, _, _ = decode_publish(flags, body)
                    self.published.append(Published(time.monotonic(), client_id, topic, payload))
                    await self.publish(topic, payload, retain)
                    for listener in self._listeners:
                        await listener(topic, payload)
                elif kind == PINGREQ:
                    writer.write(packet(PINGRESP, 0, b""))
                    await writer.drain()
                elif kind == DISCONNECT:
                    return
        except (asyncio.IncompleteReadError, ConnectionError):
            return
        finally:
            if client in self.clients:
                self.clients.remove(client)
            writer.close()


def z2m_devices_from_fixtures() -> tuple[list[dict], list[dict]]:
    """bridge/devices and bridge/groups payloads made from the HA device registry fixture."""
    devices = json.loads((FIXTURES / "devices.json").read_text(encoding="utf-8"))
    out = [
        {
            "ieee_address": "0x00124b0000000000",
            "type": "Coordinator",
            "friendly_name": "Coordinator",
        }
    ]
    for d in devices:
        for domain, ident in d.get("identifiers") or []:
            if domain == "mqtt" and ident.startswith("zigbee2mqtt_0x"):
                out.append(
                    {
                        "ieee_address": ident.removeprefix("zigbee2mqtt_"),
                        "type": "Router",
                        # z2m's own name; HA's may differ (one real one has a trailing space)
                        "friendly_name": d.get("name") or ident,
                    }
                )
    return out, []


class FakeZ2M:
    """Plays Zigbee2MQTT on a FakeBroker."""

    def __init__(self, broker: FakeBroker, base: str = "zigbee2mqtt"):
        self.broker = broker
        self.base = base
        self.devices, self.groups = z2m_devices_from_fixtures()
        self.state: dict[str, dict] = {}
        broker._listeners.append(self._on_publish)

    async def start(self, online: bool = True) -> None:
        await self.broker.publish(f"{self.base}/bridge/devices", json.dumps(self.devices), True)
        await self.broker.publish(f"{self.base}/bridge/groups", json.dumps(self.groups), True)
        state = json.dumps({"state": "online" if online else "offline"})
        await self.broker.publish(f"{self.base}/bridge/state", state, True)

    def add_group(self, name: str, ieees: list[str], group_id: int = 1) -> None:
        self.groups.append(
            {
                "id": group_id,
                "friendly_name": name,
                "members": [{"ieee_address": i, "endpoint": 11} for i in ieees],
            }
        )

    def sets(self, name: str | None = None) -> list[Published]:
        """`<name>/set` publishes (all of them when name is None)."""
        return [
            p
            for p in self.broker.published
            if p.topic.endswith("/set") and (name is None or p.topic == f"{self.base}/{name}/set")
        ]

    async def _on_publish(self, topic: str, payload: bytes) -> None:
        prefix = f"{self.base}/"
        if not topic.startswith(prefix) or not topic.endswith("/set"):
            return
        name = topic[len(prefix) : -len("/set")]
        try:
            change = json.loads(payload)
        except ValueError:
            return
        self.state.setdefault(name, {}).update(change)
        await self.broker.publish(f"{self.base}/{name}", json.dumps(self.state[name]))
