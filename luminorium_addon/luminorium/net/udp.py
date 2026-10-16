"""UDP helpers for the WiZ and Govee drivers: one socket, JSON datagrams, replies matched to
requests, and subnet sweeps."""

from __future__ import annotations

import asyncio
import contextlib
import ipaddress
import json
import logging
from collections.abc import Callable, Iterable
from typing import Any

log = logging.getLogger(__name__)

Addr = tuple[str, int]
# Largest sweep accepted: a /22. Wider ranges are almost certainly a typo.
MAX_SWEEP_HOSTS = 1024


def parse_hostport(text: str, default_port: int) -> Addr:
    """'192.168.10.5' or '192.168.10.5:38899' (or '127.0.0.1:5000' for a fake device)."""
    host, sep, port = text.strip().rpartition(":")
    if sep and port.isdigit() and host:
        return host, int(port)
    return text.strip(), default_port


def sweep_hosts(subnets: Iterable[str]) -> list[str]:
    """Every host address in the subnets ('192.168.10.0/24'), in order, without duplicates."""
    out: dict[str, None] = {}
    for subnet in subnets:
        try:
            net = ipaddress.ip_network(subnet.strip(), strict=False)
        except ValueError:
            log.warning("Ignoring subnet %r: not a network", subnet)
            continue
        if net.num_addresses > MAX_SWEEP_HOSTS + 2:
            log.warning("Ignoring subnet %s: larger than /22", net)
            continue
        hosts = list(net.hosts()) or [net.network_address]
        for host in hosts:
            out[str(host)] = None
    return list(out)


class JsonDatagrams(asyncio.DatagramProtocol):
    """A UDP socket exchanging JSON objects. Every datagram received goes to `on_message`;
    `request()` waits for the first reply that `match` accepts."""

    def __init__(self, on_message: Callable[[dict, Addr], None] | None = None):
        self.transport: asyncio.DatagramTransport | None = None
        self.on_message = on_message
        self._waiters: list[tuple[Callable[[dict, Addr], bool], asyncio.Future]] = []

    @classmethod
    async def open(
        cls,
        local: Addr = ("0.0.0.0", 0),
        on_message: Callable[[dict, Addr], None] | None = None,
        *,
        broadcast: bool = False,
    ) -> JsonDatagrams:
        loop = asyncio.get_running_loop()
        _, proto = await loop.create_datagram_endpoint(
            lambda: cls(on_message), local_addr=local, allow_broadcast=broadcast
        )
        return proto

    @property
    def port(self) -> int:
        assert self.transport is not None
        return self.transport.get_extra_info("sockname")[1]

    def connection_made(self, transport) -> None:  # type: ignore[override]
        self.transport = transport

    def datagram_received(self, data: bytes, addr) -> None:  # type: ignore[override]
        try:
            msg = json.loads(data)
        except ValueError:
            return
        if not isinstance(msg, dict):
            return
        addr = (addr[0], addr[1])
        for item in list(self._waiters):
            match, fut = item
            if not fut.done() and match(msg, addr):
                fut.set_result((msg, addr))
                self._waiters.remove(item)
                break
        if self.on_message:
            try:
                self.on_message(msg, addr)
            except Exception:
                log.exception("UDP message handler failed")

    def error_received(self, exc: Exception) -> None:
        log.debug("UDP error: %s", exc)

    def send(self, msg: dict[str, Any], addr: Addr) -> None:
        if self.transport is None or self.transport.is_closing():
            raise ConnectionError("UDP socket closed")
        self.transport.sendto(json.dumps(msg, separators=(",", ":")).encode(), addr)

    async def request(
        self,
        msg: dict[str, Any],
        addr: Addr,
        match: Callable[[dict, Addr], bool],
        *,
        timeout: float = 1.0,
        attempts: int = 2,
    ) -> dict:
        """Send and wait for a matching reply, resending up to `attempts` times in all."""
        per_try = timeout / attempts
        for attempt in range(attempts):
            fut: asyncio.Future = asyncio.get_running_loop().create_future()
            item = (match, fut)
            self._waiters.append(item)
            try:
                self.send(msg, addr)
                reply, _ = await asyncio.wait_for(fut, per_try)
                return reply
            except TimeoutError:
                if attempt == attempts - 1:
                    raise
            finally:
                with contextlib.suppress(ValueError):
                    self._waiters.remove(item)
        raise TimeoutError  # pragma: no cover

    def close(self) -> None:
        if self.transport:
            self.transport.close()
