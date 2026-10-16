"""The test button: turn one light on, then off, then put it back as it was."""

from __future__ import annotations

import asyncio
import logging

from ..drivers.base import LightState
from ..inventory.model import Kind, Light
from .safety import Safety

log = logging.getLogger(__name__)

HOLD_S = 2.0


class LightTestError(Exception):
    pass


class LightTester:
    def __init__(self, safety: Safety, hold_s: float = HOLD_S):
        self.safety = safety
        self.hold_s = hold_s

    def start(self, light: Light) -> None:
        if light.kind not in (Kind.LIGHT, Kind.SWITCH) or not light.included:
            raise LightTestError("only included lights and opted-in switches can be tested")
        if not light.available:
            raise LightTestError(f"{light.name} is {light.state}")
        name = f"test:{light.entity_id}"
        if name in self.safety.sessions:
            raise LightTestError(f"{light.name} is already being tested")
        if light.entity_id in self.safety.snapshots:
            raise LightTestError(
                f"{light.name} is in use by {self.safety.snapshots[light.entity_id].session}"
            )
        session = self.safety.session(name)
        session.run(self._run(session, light))

    async def _run(self, session, light: Light) -> None:
        safety = self.safety
        safety.note(f"Testing {light.name}", entity_id=light.entity_id)
        try:
            on = LightState(
                on=True, brightness=255 if light.entity_id.startswith("light.") else None
            )
            if await safety.command(session, light, on, transition_ms=0):
                await asyncio.sleep(self.hold_s)
            if await safety.command(session, light, LightState(on=False), transition_ms=0):
                await asyncio.sleep(self.hold_s)
        except asyncio.CancelledError:
            raise
        except Exception as err:
            safety.note(f"Test of {light.name} failed: {err}", entity_id=light.entity_id)
        finally:
            if light.entity_id in session.dropped:
                safety.note(f"Test of {light.name} stopped: changed outside Luminorium")
            if safety.sessions.get(session.name) is session:
                # This task is finishing on its own: end_session must not cancel it
                session.tasks.discard(asyncio.current_task())  # type: ignore[arg-type]
                await asyncio.shield(safety.end_session(session, restore=True))
                safety.note(f"Test of {light.name} done; restored", entity_id=light.entity_id)
