"""Keeps the inventory current: loads it from HA and follows registry and state changes."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections.abc import Callable

from ..ha.client import HAClient, HAError
from ..store import JsonStore
from .builder import UserChoices, build, fixture_member_ok
from .model import Inventory, Kind

log = logging.getLogger(__name__)

REGISTRY_EVENTS = (
    "entity_registry_updated",
    "device_registry_updated",
    "area_registry_updated",
    "floor_registry_updated",
)
RELOAD_DEBOUNCE_S = 2.0

StateListener = Callable[[str, dict | None, dict | None, str | None], None]


class InventoryService:
    def __init__(self, ha: HAClient, store: JsonStore):
        self.ha = ha
        self.store = store
        self.inventory = Inventory()
        self.choices = UserChoices.from_dict(store.load("choices"))
        # Latencies measured by camera mapping: {entity_id: {"ms", "at", "session"}}
        self.measured: dict[str, dict] = store.load("latency", {}) or {}
        self.loaded = asyncio.Event()
        self._zwave_cache: dict[str, dict] = {}
        self._reload_task: asyncio.Task | None = None
        self._state_listeners: list[StateListener] = []
        self._raw: dict | None = None

    def on_state_change(self, listener: StateListener) -> None:
        """listener(entity_id, old_state, new_state, context_id)"""
        self._state_listeners.append(listener)

    async def start(self) -> None:
        for event in REGISTRY_EVENTS:
            await self.ha.subscribe_events(event, self._registry_changed)
        await self.ha.subscribe_events("state_changed", self._state_changed)
        self.ha.on_connect(self.reload)
        if self.ha.connected:
            await self.reload()

    async def reload(self) -> None:
        cmd = self.ha.command
        floors = await cmd({"type": "config/floor_registry/list"})
        areas = await cmd({"type": "config/area_registry/list"})
        devices = await cmd({"type": "config/device_registry/list"})
        entities = await cmd({"type": "config/entity_registry/list"})
        states = await cmd({"type": "get_states"})
        await self._load_zwave(devices, entities)
        self._raw = {
            "floors": floors,
            "areas": areas,
            "devices": devices,
            "entities": entities,
            "states": states,
        }
        self._rebuild()
        self.loaded.set()
        counts = self.counts()
        log.info(
            "Inventory: %d lights included, %d switches opted in, %d excluded",
            counts["lights"],
            counts["switches"],
            counts["excluded"],
        )

    def _rebuild(self) -> None:
        if self._raw is None:
            return
        self.inventory = build(
            self._raw["floors"],
            self._raw["areas"],
            self._raw["devices"],
            self._raw["entities"],
            self._raw["states"],
            self._zwave_cache,
            self.choices,
        )
        self._apply_measured()

    def _apply_measured(self) -> None:
        for eid, m in self.measured.items():
            light = self.inventory.get(eid)
            if light is not None and light.profile is not None:
                light.profile.latency_ms = int(m["ms"])
                light.profile.details["latency_measured"] = True
                light.profile.details["latency_measured_at"] = m.get("at")

    def set_measured_latency(self, latencies: dict[str, float], session: str | None = None) -> None:
        """Store latencies (ms) measured by a capture; they replace the profile defaults."""
        now = time.time()
        for eid, ms in latencies.items():
            self.measured[eid] = {"ms": round(float(ms)), "at": now, "session": session}
        self.store.save("latency", self.measured)
        self._apply_measured()

    async def _load_zwave(self, devices: list[dict], entities: list[dict]) -> None:
        """Node status and command classes for Z-Wave devices that have a light or switch."""
        wanted = {
            e["device_id"]
            for e in entities
            if e["platform"] == "zwave_js"
            and e.get("device_id")
            and e["entity_id"].split(".")[0] in ("light", "switch")
        }
        for device in devices:
            device_id = device["id"]
            if device_id not in wanted or device_id in self._zwave_cache:
                continue
            try:
                status = await self.ha.command(
                    {"type": "zwave_js/node_status", "device_id": device_id}
                )
                caps = await self.ha.command(
                    {"type": "zwave_js/node_capabilities", "device_id": device_id}
                )
                self._zwave_cache[device_id] = {"status": status, "capabilities": caps}
            except (HAError, TimeoutError) as err:
                log.debug("Z-Wave details for %s unavailable: %s", device_id, err)

    def set_choice(self, entity_id: str, include: bool | None) -> None:
        """Include or exclude a light (None: back to the default)."""
        light = self.inventory.get(entity_id)
        if light is None or light.kind in (Kind.SEGMENT, Kind.SETTING):
            raise KeyError(entity_id)
        if include is None:
            self.choices.include.pop(entity_id, None)
        else:
            self.choices.include[entity_id] = include
        self._save()

    # ---- fixtures -----------------------------------------------------------------------------

    def create_fixture(self, name: str, members: list[str]) -> str:
        """Group lights in one physical fixture. Returns the new fixture's id."""
        members = self._check_members(members, allow_fixture=None)
        fixture_id = "fx_" + uuid.uuid4().hex[:8]
        self.choices.fixtures.append(
            {"id": fixture_id, "name": _fixture_name(name, members, self), "members": members}
        )
        self._save()
        return fixture_id

    def update_fixture(
        self, fixture_id: str, name: str | None = None, members: list[str] | None = None
    ) -> None:
        stored = self._stored_fixture(fixture_id)
        if members is not None:
            stored["members"] = self._check_members(members, allow_fixture=fixture_id)
        if name is not None:
            stored["name"] = _fixture_name(name, stored["members"], self)
        self._save()

    def delete_fixture(self, fixture_id: str) -> None:
        stored = self._stored_fixture(fixture_id)
        self.choices.fixtures.remove(stored)
        self._save()

    def dismiss_suggestion(self, members: list[str]) -> None:
        key = sorted(set(members))
        if key not in self.choices.dismissed:
            self.choices.dismissed.append(key)
        self._save()

    def _stored_fixture(self, fixture_id: str) -> dict:
        for f in self.choices.fixtures:
            if f["id"] == fixture_id:
                return f
        raise KeyError(fixture_id)

    def _check_members(self, members: list[str], allow_fixture: str | None) -> list[str]:
        members = list(dict.fromkeys(members))  # unique, order kept
        if len(members) < 2:
            raise ValueError("a fixture needs at least two lights")
        for eid in members:
            light = self.inventory.get(eid)
            if not fixture_member_ok(light):
                raise ValueError(f"{eid} can't be part of a fixture")
            assert light is not None
            if light.fixture and light.fixture != allow_fixture:
                raise ValueError(f"{light.name} is already in another fixture")
        return members

    def _save(self) -> None:
        self.store.save("choices", self.choices.to_dict())
        self._rebuild()

    def counts(self) -> dict[str, int]:
        lights = self.inventory.lights.values()
        return {
            "lights": sum(1 for lt in lights if lt.kind == Kind.LIGHT and lt.included),
            "segments": sum(1 for lt in lights if lt.kind == Kind.SEGMENT and lt.included),
            "switches": sum(1 for lt in lights if lt.kind == Kind.SWITCH and lt.included),
            "excluded": sum(1 for lt in lights if not lt.included and lt.kind != Kind.SEGMENT),
        }

    async def _registry_changed(self, event: dict) -> None:
        # Bursts of registry events (a device re-interview) collapse into one reload
        if self._reload_task and not self._reload_task.done():
            self._reload_task.cancel()
        self._reload_task = asyncio.create_task(self._debounced_reload())

    async def _debounced_reload(self) -> None:
        with contextlib.suppress(asyncio.CancelledError):
            await asyncio.sleep(RELOAD_DEBOUNCE_S)
            try:
                await self.reload()
            except Exception:
                log.exception("Inventory reload failed")

    def _state_changed(self, event: dict) -> None:
        data = event.get("data") or {}
        entity_id = data.get("entity_id", "")
        new = data.get("new_state")
        light = self.inventory.get(entity_id)
        if light is not None:
            if new is None:
                light.state = "unavailable"
            else:
                light.state = new.get("state", "unknown")
                light.attributes = dict(new.get("attributes") or {})
            if self._raw is not None:
                self._update_raw_state(entity_id, new)
        context_id = ((new or {}).get("context") or {}).get("id")
        for listener in self._state_listeners:
            try:
                listener(entity_id, data.get("old_state"), new, context_id)
            except Exception:
                log.exception("state listener failed")

    def _update_raw_state(self, entity_id: str, new: dict | None) -> None:
        assert self._raw is not None
        states = self._raw["states"]
        for i, s in enumerate(states):
            if s["entity_id"] == entity_id:
                if new is None:
                    states.pop(i)
                else:
                    states[i] = new
                return
        if new is not None:
            states.append(new)


def _fixture_name(name: str, members: list[str], service: InventoryService) -> str:
    name = (name or "").strip()
    if name:
        return name[:80]
    first = service.inventory.get(members[0])
    return f"{first.name if first else members[0]} fixture"
