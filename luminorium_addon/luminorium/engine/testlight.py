"""The test button: turn a light (or every light of a fixture) on, then off, then put it back."""

from __future__ import annotations

import asyncio
import logging

from ..drivers.base import LightState
from ..inventory.model import Fixture, Kind, Light
from .safety import Safety

log = logging.getLogger(__name__)

HOLD_S = 2.0


class LightTestError(Exception):
    pass


def _testable(light: Light) -> str | None:
    """Why a light can't be tested, or None."""
    if light.kind not in (Kind.LIGHT, Kind.SWITCH) or not light.included:
        return "only included lights and opted-in switches can be tested"
    if not light.available:
        return f"{light.name} is {light.state}"
    return None


class LightTester:
    def __init__(self, safety: Safety, hold_s: float = HOLD_S):
        self.safety = safety
        self.hold_s = hold_s

    def start(self, light: Light) -> None:
        problem = _testable(light)
        if problem:
            raise LightTestError(problem)
        self._start(f"test:{light.entity_id}", light.name, [light])

    def start_fixture(self, fixture: Fixture, members: list[Light]) -> list[str]:
        """Test a fixture's lights together, as one. Returns the members that were skipped."""
        lights = [lt for lt in members if _testable(lt) is None]
        if not lights:
            raise LightTestError(f"no light in {fixture.name} can be tested now")
        self._start(f"test:{fixture.id}", fixture.name, lights)
        return [lt.entity_id for lt in members if lt not in lights]

    def _start(self, name: str, label: str, lights: list[Light]) -> None:
        if name in self.safety.sessions:
            raise LightTestError(f"{label} is already being tested")
        for light in lights:
            if light.entity_id in self.safety.snapshots:
                raise LightTestError(
                    f"{light.name} is in use by {self.safety.snapshots[light.entity_id].session}"
                )
        session = self.safety.session(name)
        session.run(self._run(session, label, lights))

    async def _step(self, session, lights: list[Light], on: bool) -> bool:
        """Send one state to every light at once. True if any light took it."""

        async def one(light: Light) -> bool:
            brightness = 255 if on and light.entity_id.startswith("light.") else None
            state = LightState(on=on, brightness=brightness)
            return await self.safety.command(session, light, state, transition_ms=0)

        results = await asyncio.gather(*(one(lt) for lt in lights))
        return any(results)

    async def _run(self, session, label: str, lights: list[Light]) -> None:
        safety = self.safety
        ids = [lt.entity_id for lt in lights]
        safety.note(f"Testing {label}", entity_ids=ids)
        try:
            if await self._step(session, lights, on=True):
                await asyncio.sleep(self.hold_s)
            if await self._step(session, lights, on=False):
                await asyncio.sleep(self.hold_s)
        except asyncio.CancelledError:
            raise
        except Exception as err:
            safety.note(f"Test of {label} failed: {err}", entity_ids=ids)
        finally:
            dropped = [lt.name for lt in lights if lt.entity_id in session.dropped]
            if dropped:
                safety.note(f"Test of {label}: {', '.join(dropped)} changed outside Luminorium")
            if safety.sessions.get(session.name) is session:
                # This task is finishing on its own: end_session must not cancel it
                session.tasks.discard(asyncio.current_task())  # type: ignore[arg-type]
                await asyncio.shield(safety.end_session(session, restore=True))
                safety.note(f"Test of {label} done; restored", entity_ids=ids)
