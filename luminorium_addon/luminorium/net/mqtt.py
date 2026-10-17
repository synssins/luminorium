"""A small MQTT 3.1.1 client on asyncio streams: QoS 0 publish, subscribe, keepalive, reconnect.

Why not aiomqtt or paho: both need the selector event loop on Windows (paho uses
add_reader/add_writer), while uvicorn and the tests run on the default Proactor loop. The part
of MQTT Luminorium needs (talking to Zigbee2MQTT through Mosquitto) is small enough to carry.
"""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
import ssl as ssl_module
import struct
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

log = logging.getLogger(__name__)

CONNECT, CONNACK, PUBLISH, PUBACK = 1, 2, 3, 4
SUBSCRIBE, SUBACK, UNSUBSCRIBE, UNSUBACK = 8, 9, 10, 11
PINGREQ, PINGRESP, DISCONNECT = 12, 13, 14

CONNACK_ERRORS = {
    1: "unacceptable protocol version",
    2: "client id rejected",
    3: "server unavailable",
    4: "bad user name or password",
    5: "not authorised",
}

Handler = Callable[[str, bytes, bool], Awaitable[None] | None]


class MQTTError(Exception):
    pass


# ---- codec (shared with the fake broker in tools/fake_mqtt.py) --------------------------------


def encode_length(n: int) -> bytes:
    out = bytearray()
    while True:
        byte, n = n % 128, n // 128
        out.append(byte | (0x80 if n else 0))
        if not n:
            return bytes(out)


def encode_str(s: str) -> bytes:
    data = s.encode("utf-8")
    return struct.pack("!H", len(data)) + data


def packet(kind: int, flags: int, body: bytes) -> bytes:
    return bytes([kind << 4 | flags]) + encode_length(len(body)) + body


async def read_packet(reader: asyncio.StreamReader) -> tuple[int, int, bytes]:
    """One packet: (type, flags, body). Raises IncompleteReadError at end of stream."""
    first = (await reader.readexactly(1))[0]
    length, mult = 0, 1
    while True:
        byte = (await reader.readexactly(1))[0]
        length += (byte & 0x7F) * mult
        if not byte & 0x80:
            break
        mult *= 128
        if mult > 128**3:
            raise MQTTError("malformed remaining length")
    body = await reader.readexactly(length) if length else b""
    return first >> 4, first & 0x0F, body


def read_str(body: bytes, pos: int) -> tuple[str, int]:
    (n,) = struct.unpack_from("!H", body, pos)
    return body[pos + 2 : pos + 2 + n].decode("utf-8"), pos + 2 + n


def encode_publish(topic: str, payload: bytes, *, retain: bool = False) -> bytes:
    """A QoS 0 PUBLISH."""
    return packet(PUBLISH, 0x01 if retain else 0, encode_str(topic) + payload)


def decode_publish(flags: int, body: bytes) -> tuple[str, bytes, bool, int, int | None]:
    """(topic, payload, retain, qos, packet id)."""
    topic, pos = read_str(body, 0)
    qos = (flags >> 1) & 0x03
    packet_id = None
    if qos:
        (packet_id,) = struct.unpack_from("!H", body, pos)
        pos += 2
    return topic, body[pos:], bool(flags & 0x01), qos, packet_id


def topic_matches(pattern: str, topic: str) -> bool:
    """MQTT wildcards: + for one level, # for the rest."""
    p_parts, t_parts = pattern.split("/"), topic.split("/")
    for i, part in enumerate(p_parts):
        if part == "#":
            return True
        if i >= len(t_parts) or (part != "+" and part != t_parts[i]):
            return False
    return len(p_parts) == len(t_parts)


# ---- client -----------------------------------------------------------------------------------


@dataclass(frozen=True)
class MQTTEndpoint:
    host: str
    port: int = 1883
    username: str = ""
    password: str = ""
    ssl: bool = False

    def __repr__(self) -> str:  # never show the password
        return f"MQTTEndpoint({self.host}:{self.port}, user={self.username!r}, ssl={self.ssl})"


class MQTTClient:
    """One connection, re-established after a drop. Subscriptions are renewed on reconnect
    (so retained messages are delivered again); publishes while disconnected raise."""

    def __init__(self, endpoint: MQTTEndpoint, client_id: str, *, keepalive: int = 30):
        self.endpoint = endpoint
        self.client_id = client_id
        self.keepalive = keepalive
        self._subs: list[tuple[str, Handler]] = []
        self._writer: asyncio.StreamWriter | None = None
        self._runner: asyncio.Task | None = None
        self._ids = itertools.count(1)
        self._connected = asyncio.Event()
        self._closing = False
        self._on_connect: list[Callable[[], None]] = []
        self._on_disconnect: list[Callable[[], None]] = []
        self.error: str | None = None

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    def on_connect(self, cb: Callable[[], None]) -> None:
        self._on_connect.append(cb)

    def on_disconnect(self, cb: Callable[[], None]) -> None:
        self._on_disconnect.append(cb)

    def start(self) -> None:
        self._runner = asyncio.create_task(self._run(), name="mqtt")

    async def wait_connected(self, timeout: float | None = None) -> None:
        await asyncio.wait_for(self._connected.wait(), timeout)

    async def close(self) -> None:
        self._closing = True
        if self._writer and self.connected:
            with contextlib.suppress(Exception):
                self._writer.write(packet(DISCONNECT, 0, b""))
                await self._writer.drain()
        if self._runner:
            self._runner.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._runner
        if self._writer:
            self._writer.close()

    async def subscribe(self, pattern: str, handler: Handler) -> None:
        self._subs.append((pattern, handler))
        if self.connected:
            await self._send_subscribe(pattern)

    async def publish(self, topic: str, payload: bytes | str, *, retain: bool = False) -> None:
        if not self._writer or not self.connected:
            raise ConnectionError("MQTT not connected")
        data = payload.encode("utf-8") if isinstance(payload, str) else payload
        self._writer.write(encode_publish(topic, data, retain=retain))
        await self._writer.drain()

    async def _run(self) -> None:
        delay = 1.0
        while not self._closing:
            try:
                await self._connect_once()
                delay = 1.0
            except asyncio.CancelledError:
                raise
            except (OSError, MQTTError, asyncio.IncompleteReadError, TimeoutError) as err:
                self.error = str(err) or type(err).__name__
                log.warning("MQTT %s:%s: %s", self.endpoint.host, self.endpoint.port, self.error)
            if self._connected.is_set():
                self._connected.clear()
                for cb in self._on_disconnect:
                    cb()
            self._writer = None
            if self._closing:
                return
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    async def _connect_once(self) -> None:
        ep = self.endpoint
        ctx = ssl_module.create_default_context() if ep.ssl else None
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ep.host, ep.port, ssl=ctx), 10
        )
        self._writer = writer
        try:
            flags = 0x02  # clean session
            payload = encode_str(self.client_id)
            if ep.username:
                flags |= 0x80
                payload += encode_str(ep.username)
                if ep.password:
                    flags |= 0x40
                    payload += encode_str(ep.password)
            body = encode_str("MQTT") + bytes([4, flags]) + struct.pack("!H", self.keepalive)
            writer.write(packet(CONNECT, 0, body + payload))
            await writer.drain()
            kind, _, body = await asyncio.wait_for(read_packet(reader), 10)
            if kind != CONNACK or len(body) < 2:
                raise MQTTError("no CONNACK")
            if body[1]:
                raise MQTTError(CONNACK_ERRORS.get(body[1], f"refused ({body[1]})"))
            self.error = None
            self._connected.set()
            log.info("MQTT connected to %s:%s", ep.host, ep.port)
            for pattern, _ in self._subs:
                await self._send_subscribe(pattern)
            for cb in self._on_connect:
                cb()
            pinger = asyncio.create_task(self._ping(writer))
            try:
                await self._read(reader, writer)
            finally:
                pinger.cancel()
        finally:
            writer.close()

    async def _send_subscribe(self, pattern: str) -> None:
        assert self._writer is not None
        packet_id = next(self._ids) % 65535 + 1
        body = struct.pack("!H", packet_id) + encode_str(pattern) + b"\x00"
        self._writer.write(packet(SUBSCRIBE, 0x02, body))
        await self._writer.drain()

    async def _ping(self, writer: asyncio.StreamWriter) -> None:
        while True:
            await asyncio.sleep(self.keepalive * 0.75)
            writer.write(packet(PINGREQ, 0, b""))
            await writer.drain()

    async def _read(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while True:
            kind, flags, body = await asyncio.wait_for(read_packet(reader), self.keepalive * 2)
            if kind == PUBLISH:
                topic, payload, retain, qos, packet_id = decode_publish(flags, body)
                if qos == 1 and packet_id is not None:
                    writer.write(packet(PUBACK, 0, struct.pack("!H", packet_id)))
                await self._deliver(topic, payload, retain)
            # SUBACK, PINGRESP, PUBACK: nothing to do

    async def _deliver(self, topic: str, payload: bytes, retain: bool) -> None:
        for pattern, handler in list(self._subs):
            if topic_matches(pattern, topic):
                try:
                    result = handler(topic, payload, retain)
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    log.exception("MQTT handler for %s failed", topic)
