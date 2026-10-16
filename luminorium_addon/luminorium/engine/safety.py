"""Leave things as they were.

Every light a session touches is snapshotted first. Snapshots are persisted, so after a crash
or restart the app restores whatever it left in a show state. "Stop all" cancels every session and
restores every touched light. If someone changes a light during a session (a wall switch, an
automation), the light is dropped from the session and is NOT restored over their change.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections import deque
from dataclasses import dataclass, field

from ..drivers.base import LightState
from ..inventory.model import Light
from ..inventory.service import InventoryService
from ..store import JsonStore
from .governor import Governor, Priority, Superseded

log = logging.getLogger(__name__)

SNAPSHOTS = "snapshots"
# Brightness difference (0-255) that counts as someone else's change
BRIGHTNESS_TOLERANCE = 51
OUR_CONTEXTS_KEPT = 2000


class LightBusy(Exception):
    pass


@dataclass
class Snapshot:
    state: LightState
    session: str
    taken_at: float
    expected: LightState | None = None

    def to_dict(self) -> dict:
        return {
            "state": self.state.to_dict(),
            "session": self.session,
            "taken_at": self.taken_at,
        }


@dataclass
class Session:
    name: str
    tasks: set[asyncio.Task] = field(default_factory=set)
    dropped: set[str] = field(default_factory=set)

    def run(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro, name=f"session:{self.name}")
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task


class Safety:
    def __init__(self, inventory: InventoryService, governor: Governor, store: JsonStore):
        self.inventory = inventory
        self.governor = governor
        self.store = store
        self.snapshots: dict[str, Snapshot] = {}
        self.sessions: dict[str, Session] = {}
        self._ours: deque[str] = deque(maxlen=OUR_CONTEXTS_KEPT)
        self._ours_set: set[str] = set()
        self.activity: deque[dict] = deque(maxlen=100)
        self._lock = asyncio.Lock()
        inventory.on_state_change(self._state_changed)

    # ---- sessions -----------------------------------------------------------------------------

    def session(self, name: str) -> Session:
        if name not in self.sessions:
            self.sessions[name] = Session(name)
        return self.sessions[name]

    def note(self, message: str, **extra) -> None:
        entry = {"at": time.time(), "message": message, **extra}
        self.activity.appendleft(entry)
        log.info(message)

    async def command(
        self,
        session: Session,
        light: Light,
        state: LightState,
        *,
        transition_ms: int | None = None,
        priority: Priority = Priority.SHOW,
    ) -> bool:
        """Send a state as part of a session. False if the light was dropped or superseded."""
        if light.entity_id in session.dropped:
            return False
        snap = self.snapshots.get(light.entity_id)
        if snap is None:
            snap = Snapshot(
                LightState.from_ha(light.state, light.attributes), session.name, time.time()
            )
            self.snapshots[light.entity_id] = snap
            self._persist()
        elif snap.session != session.name:
            raise LightBusy(f"{light.entity_id} is in use by {snap.session}")
        snap.expected = state
        try:
            context = await self.governor.send(
                light, state, transition_ms=transition_ms, priority=priority
            )
        except Superseded:
            return False
        self._remember(context)
        return True

    async def end_session(self, session: Session, *, restore: bool = True) -> None:
        current = asyncio.current_task()
        for task in list(session.tasks):
            if task is not current:
                task.cancel()
        owned = [eid for eid, s in self.snapshots.items() if s.session == session.name]
        if restore:
            await self._restore(owned)
        else:
            for eid in owned:
                self.snapshots.pop(eid, None)
            self._persist()
        self.sessions.pop(session.name, None)

    # ---- stop all and restore -----------------------------------------------------------------

    async def stop_all(self) -> int:
        """Cancel every session and restore every touched light. Returns how many were restored."""
        async with self._lock:
            # Count first: cancelled sessions restore their own lights as they end
            count = len(self.snapshots)
            self.governor.cancel_all(below=Priority.RESTORE)
            for session in list(self.sessions.values()):
                for task in list(session.tasks):
                    task.cancel()
                    with contextlib.suppress(asyncio.CancelledError, Exception):
                        await task
            self.sessions.clear()
            await self._restore(list(self.snapshots))
            self.note(f"Stop all: restored {count} light(s)")
            return count

    async def restore_leftovers(self) -> int:
        """At startup: restore lights a previous run left in a show state."""
        saved = self.store.load(SNAPSHOTS, {}) or {}
        if not saved:
            return 0
        await self.inventory.loaded.wait()
        for eid, data in saved.items():
            self.snapshots[eid] = Snapshot(
                LightState.from_dict(data["state"]),
                data.get("session", "previous run"),
                data.get("taken_at", 0.0),
            )
        count = len(saved)
        await self._restore(list(saved))
        self.note(f"Restored {count} light(s) left over from the previous run")
        return count

    async def _restore(self, entity_ids: list[str]) -> None:
        async def one(eid: str) -> None:
            snap = self.snapshots.get(eid)
            light = self.inventory.inventory.get(eid)
            if snap is None:
                return
            if light is None:
                log.warning("Can't restore %s: no longer in HA", eid)
                return
            snap.expected = snap.state
            try:
                context = await self.governor.send(light, snap.state, priority=Priority.RESTORE)
                self._remember(context)
            except Superseded:
                pass
            except Exception as err:
                log.warning("Restore of %s failed: %s", eid, err)

        await asyncio.gather(*(one(eid) for eid in entity_ids))
        for eid in entity_ids:
            self.snapshots.pop(eid, None)
        self._persist()

    # ---- outside changes ----------------------------------------------------------------------

    def _remember(self, context: str | None) -> None:
        if not context:
            return
        if len(self._ours) == self._ours.maxlen:
            self._ours_set.discard(self._ours[0])
        self._ours.append(context)
        self._ours_set.add(context)

    def _state_changed(
        self, entity_id: str, old: dict | None, new: dict | None, context_id: str | None
    ) -> None:
        snap = self.snapshots.get(entity_id)
        if snap is None or new is None or context_id in self._ours_set:
            return
        if new.get("state") in ("unavailable", "unknown"):
            return
        if snap.expected is not None and _matches(snap.expected, new):
            return  # a late report of our own change (HA gives reports after ~5 s a new context)
        # Someone else changed it: keep their change, forget ours
        self.snapshots.pop(entity_id, None)
        self._persist()
        session = self.sessions.get(snap.session)
        if session:
            session.dropped.add(entity_id)
        self.note(
            f"{entity_id} was changed outside Luminorium; dropped from {snap.session}",
            entity_id=entity_id,
        )

    def _persist(self) -> None:
        if self.snapshots:
            self.store.save(SNAPSHOTS, {eid: s.to_dict() for eid, s in self.snapshots.items()})
        else:
            self.store.delete(SNAPSHOTS)


def _matches(expected: LightState, new: dict) -> bool:
    on = new.get("state") == "on"
    if on != expected.on:
        return False
    brightness = (new.get("attributes") or {}).get("brightness")
    if on and expected.brightness is not None and brightness is not None:
        return abs(int(brightness) - int(expected.brightness)) <= BRIGHTNESS_TOLERANCE
    return True
