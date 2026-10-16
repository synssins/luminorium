"""Home Assistant websocket client: commands, event subscriptions, reconnects."""

from __future__ import annotations

import asyncio
import contextlib
import itertools
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import aiohttp

log = logging.getLogger(__name__)

EventHandler = Callable[[dict], Awaitable[None] | None]


class HAError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code


class ReadOnlyError(Exception):
    """A service call was attempted while the app runs read-only."""


class HAClient:
    """One websocket connection to HA, re-established after a drop.

    Subscriptions are remembered and renewed on every reconnect. ``on_connect`` callbacks run after
    each (re)connect, so the inventory can reload whatever changed while the link was down.
    """

    def __init__(self, url: str, token: str, *, read_only: bool = False):
        self.url = url
        self._token = token
        self.read_only = read_only
        self._session: aiohttp.ClientSession | None = None
        self._ws: aiohttp.ClientWebSocketResponse | None = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._subscriptions: list[tuple[dict, EventHandler]] = []
        self._sub_ids: dict[int, EventHandler] = {}
        self._on_connect: list[Callable[[], Awaitable[None]]] = []
        self._connected = asyncio.Event()
        self._runner: asyncio.Task | None = None
        self._closing = False
        self.ha_version: str | None = None

    @property
    def connected(self) -> bool:
        return self._connected.is_set()

    def on_connect(self, callback: Callable[[], Awaitable[None]]) -> None:
        self._on_connect.append(callback)

    async def start(self) -> None:
        self._session = aiohttp.ClientSession()
        self._runner = asyncio.create_task(self._run(), name="ha-link")

    async def wait_connected(self, timeout: float | None = None) -> None:
        await asyncio.wait_for(self._connected.wait(), timeout)

    async def close(self) -> None:
        self._closing = True
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
        while not self._closing:
            try:
                await self._connect_once()
                delay = 1.0
            except asyncio.CancelledError:
                raise
            except HAError as err:
                if err.code == "auth_invalid":
                    log.error("HA rejected the token; not retrying")
                    return
                log.warning("HA link error: %s", err)
            except (aiohttp.ClientError, OSError, TimeoutError) as err:
                log.warning("HA link down: %s", err)
            self._drop_connection()
            if self._closing:
                return
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)

    def _drop_connection(self) -> None:
        self._connected.clear()
        self._ws = None
        self._sub_ids.clear()
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(ConnectionError("HA link lost"))
        self._pending.clear()

    async def _connect_once(self) -> None:
        assert self._session is not None
        async with self._session.ws_connect(self.url, heartbeat=30, max_msg_size=0) as ws:
            msg = await ws.receive_json()
            if msg.get("type") != "auth_required":
                raise HAError("protocol", f"unexpected first message {msg.get('type')}")
            await ws.send_json({"type": "auth", "access_token": self._token})
            msg = await ws.receive_json()
            if msg.get("type") != "auth_ok":
                raise HAError("auth_invalid", "authentication failed")
            self.ha_version = msg.get("ha_version")
            self._ws = ws
            reader = asyncio.create_task(self._read(ws), name="ha-reader")
            try:
                for sub, handler in self._subscriptions:
                    await self._subscribe_on_wire(sub, handler)
                self._connected.set()
                log.info("Connected to HA %s", self.ha_version)
                for callback in self._on_connect:
                    try:
                        await callback()
                    except Exception:
                        log.exception("on_connect callback failed")
                await reader
            finally:
                reader.cancel()

    async def _read(self, ws: aiohttp.ClientWebSocketResponse) -> None:
        async for raw in ws:
            if raw.type != aiohttp.WSMsgType.TEXT:
                break
            payload = raw.json()
            for msg in payload if isinstance(payload, list) else [payload]:
                await self._dispatch(msg)

    async def _dispatch(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "event":
            handler = self._sub_ids.get(msg.get("id"))
            if handler:
                try:
                    result = handler(msg["event"])
                    if asyncio.iscoroutine(result):
                        await result
                except Exception:
                    log.exception("event handler failed")
            return
        fut = self._pending.pop(msg.get("id"), None)
        if fut is None or fut.done():
            return
        if kind == "pong":
            fut.set_result(None)
        elif msg.get("success"):
            fut.set_result(msg.get("result"))
        else:
            err = msg.get("error") or {}
            fut.set_exception(HAError(err.get("code", "unknown"), err.get("message", "")))

    async def command(self, payload: dict, *, timeout: float = 30.0) -> Any:
        """Send one command and return its result."""
        if not self._ws:
            await self.wait_connected(timeout)
        assert self._ws is not None
        msg_id = next(self._ids)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        await self._ws.send_json({"id": msg_id, **payload})
        try:
            return await asyncio.wait_for(fut, timeout)
        finally:
            self._pending.pop(msg_id, None)

    async def subscribe(self, payload: dict, handler: EventHandler) -> None:
        """Subscribe now (if connected) and again after every reconnect."""
        self._subscriptions.append((payload, handler))
        if self._ws:
            await self._subscribe_on_wire(payload, handler)

    async def subscribe_events(self, event_type: str, handler: EventHandler) -> None:
        await self.subscribe({"type": "subscribe_events", "event_type": event_type}, handler)

    async def _subscribe_on_wire(self, payload: dict, handler: EventHandler) -> None:
        assert self._ws is not None
        msg_id = next(self._ids)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[msg_id] = fut
        self._sub_ids[msg_id] = handler
        await self._ws.send_json({"id": msg_id, **payload})
        await asyncio.wait_for(fut, 30)

    async def call_service(
        self,
        domain: str,
        service: str,
        data: dict | None = None,
        *,
        entity_ids: list[str] | None = None,
    ) -> str | None:
        """Call a service. Returns the context id HA gives the resulting state changes."""
        if self.read_only:
            raise ReadOnlyError(f"{domain}.{service} blocked: read-only mode")
        payload: dict = {"type": "call_service", "domain": domain, "service": service}
        if data:
            payload["service_data"] = data
        if entity_ids:
            payload["target"] = {"entity_id": entity_ids}
        result = await self.command(payload)
        return ((result or {}).get("context") or {}).get("id")
