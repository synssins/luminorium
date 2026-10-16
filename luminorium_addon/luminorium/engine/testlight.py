"""The test button: turn a light (or every light of a fixture) on, then off, then put it back."""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass

from ..drivers.base import LightState
from ..inventory.model import Fixture, Kind, Light
from .safety import Safety

log = logging.getLogger(__name__)

HOLD_S = 2.0
MAX_HOLD_S = 30.0
MAX_TRANSITION_MS = 10_000


class LightTestError(Exception):
    pass


@dataclass(frozen=True)
class TestOptions:
    """Variations of the Test sequence for checking a driver: a fade (transition) on the way on
    and off, a native effect while on, a longer hold."""

    __test__ = False  # not a pytest class

    transition_ms: int = 0
    effect: str | None = None
    hold_s: float | None = None

    def __post_init__(self) -> None:
        if not 0 <= self.transition_ms <= MAX_TRANSITION_MS:
            raise LightTestError(f"transition must be 0-{MAX_TRANSITION_MS} ms")
        if self.hold_s is not None and not 0 <= self.hold_s <= MAX_HOLD_S:
            raise LightTestError(f"hold must be 0-{MAX_HOLD_S:.0f} s")


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

    def start(self, light: Light, options: TestOptions | None = None) -> None:
        problem = _testable(light)
        if problem:
            raise LightTestError(problem)
        options = options or TestOptions()
        caps = light.profile.capabilities if light.profile else None
        if options.effect and caps is not None and options.effect not in caps.effects:
            raise LightTestError(f"{light.name} has no effect {options.effect!r}")
        self._start(f"test:{light.entity_id}", light.name, [light], options)

    def start_fixture(self, fixture: Fixture, members: list[Light]) -> list[str]:
        """Test a fixture's lights together, as one. Returns the members that were skipped."""
        lights = [lt for lt in members if _testable(lt) is None]
        if not lights:
            raise LightTestError(f"no light in {fixture.name} can be tested now")
        self._start(f"test:{fixture.id}", fixture.name, lights)
        return [lt.entity_id for lt in members if lt not in lights]

    def _start(
        self, name: str, label: str, lights: list[Light], options: TestOptions | None = None
    ) -> None:
        if name in self.safety.sessions:
            raise LightTestError(f"{label} is already being tested")
        for light in lights:
            if light.entity_id in self.safety.snapshots:
                raise LightTestError(
                    f"{light.name} is in use by {self.safety.snapshots[light.entity_id].session}"
                )
        session = self.safety.session(name)
        session.run(self._run(session, label, lights, options or TestOptions()))

    async def _step(
        self, session, lights: list[Light], on: bool, options: TestOptions | None = None
    ) -> bool:
        """Send one state to every light at once (one multicast or z2m group message where the
        lights allow it). True if any light took it."""
        options = options or TestOptions()
        dimmable = [lt for lt in lights if lt.entity_id.startswith("light.")]
        relays = [lt for lt in lights if not lt.entity_id.startswith("light.")]
        sends = [
            self.safety.command_many(
                session,
                group,
                LightState(
                    on=on,
                    brightness=255 if on and bri else None,
                    effect=options.effect if on and bri else None,
                ),
                transition_ms=options.transition_ms,
            )
            for group, bri in ((dimmable, True), (relays, False))
            if group
        ]
        results = await asyncio.gather(*sends)
        return any(any(r) for r in results)

    async def _run(self, session, label: str, lights: list[Light], options: TestOptions) -> None:
        safety = self.safety
        ids = [lt.entity_id for lt in lights]
        drivers = sorted({lt.profile.driver for lt in lights if lt.profile})
        extra = "".join(
            [
                f", {options.transition_ms} ms fade" if options.transition_ms else "",
                f", effect {options.effect}" if options.effect else "",
            ]
        )
        safety.note(f"Testing {label} via {', '.join(drivers) or 'ha'}{extra}", entity_ids=ids)
        hold = (options.hold_s if options.hold_s is not None else self.hold_s) + (
            options.transition_ms / 1000
        )
        try:
            if await self._step(session, lights, on=True, options=options):
                await asyncio.sleep(hold)
            if await self._step(session, lights, on=False, options=options):
                await asyncio.sleep(hold)
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
