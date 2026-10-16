"""Rate governor: every command to a light goes through here.

- Per light: no faster than the light's profile allows. Restores and safety commands skip the
  per-light wait (but not the network budgets).
- Latest value wins: a new command replaces one still waiting; nothing queues up behind a slow
  light. A lower-priority command never replaces a higher-priority one.
- Per network and for the HA driver as a whole: token buckets, so a burst across many Z-Wave
  lights can't flood the mesh.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from enum import IntEnum

from ..drivers.base import Driver, LightState
from ..inventory.model import Light

log = logging.getLogger(__name__)


class Priority(IntEnum):
    AMBIENT = 0
    SHOW = 1
    SAFETY = 2
    RESTORE = 3


# Commands per second for a whole network (DESIGN.md section 4); bursts up to `burst`.
NETWORK_BUDGETS: dict[str, tuple[float, int]] = {
    "zwave": (2.0, 2),
    "zigbee": (25.0, 10),
    "govee_cloud": (1.0, 2),
    "matter": (5.0, 5),
}
HA_DRIVER_BUDGET = (10.0, 10)


class Superseded(Exception):
    """A newer command for the same light replaced this one before it was sent."""


class TokenBucket:
    def __init__(self, rate: float, burst: int, clock: Callable[[], float] = time.monotonic):
        self.rate = rate
        self.capacity = float(burst)
        self.tokens = float(burst)
        self.clock = clock
        self.updated = clock()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            while True:
                now = self.clock()
                self.tokens = min(self.capacity, self.tokens + (now - self.updated) * self.rate)
                self.updated = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                await asyncio.sleep((1 - self.tokens) / self.rate)


@dataclass
class _Pending:
    state: LightState
    transition_ms: int | None
    priority: Priority
    future: asyncio.Future


@dataclass
class _Slot:
    pending: _Pending | None = None
    worker: asyncio.Task | None = None
    last_sent: float = field(default=-1e9)


class Governor:
    def __init__(self, driver_for: Callable[[Light], Driver]):
        self.driver_for = driver_for
        self._slots: dict[str, _Slot] = {}
        self._networks: dict[str, TokenBucket] = {
            name: TokenBucket(rate, burst) for name, (rate, burst) in NETWORK_BUDGETS.items()
        }
        self._ha = TokenBucket(*HA_DRIVER_BUDGET)
        self.sent = 0
        self.dropped = 0

    async def send(
        self,
        light: Light,
        state: LightState,
        *,
        transition_ms: int | None = None,
        priority: Priority = Priority.SHOW,
    ) -> str | None:
        """Send a state to a light, governed. Returns the context id, or raises Superseded."""
        slot = self._slots.setdefault(light.entity_id, _Slot())
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        new = _Pending(state, transition_ms, priority, future)
        old = slot.pending
        if old is not None:
            if priority < old.priority:
                self.dropped += 1
                raise Superseded(light.entity_id)
            if not old.future.done():
                old.future.set_exception(Superseded(light.entity_id))
            self.dropped += 1
        slot.pending = new
        if slot.worker is None or slot.worker.done():
            slot.worker = asyncio.create_task(self._work(light, slot))
        return await future

    def cancel_all(self, below: Priority = Priority.SAFETY) -> None:
        """Drop waiting commands below a priority (Stop all)."""
        for entity_id, slot in self._slots.items():
            pending = slot.pending
            if pending is not None and pending.priority < below:
                slot.pending = None
                if not pending.future.done():
                    pending.future.set_exception(Superseded(entity_id))

    async def _work(self, light: Light, slot: _Slot) -> None:
        while slot.pending is not None:
            profile = light.profile
            interval = 1.0 / profile.max_rate_hz if profile and profile.max_rate_hz else 0.0
            if slot.pending.priority < Priority.SAFETY:
                wait = slot.last_sent + interval - time.monotonic()
                if wait > 0:
                    await asyncio.sleep(wait)
                    continue  # the pending command may have changed while waiting
            network = self._networks.get(profile.network) if profile else None
            if network:
                await network.acquire()
            driver = self.driver_for(light)
            if driver.name == "ha":
                await self._ha.acquire()
            pending = slot.pending
            if pending is None:
                return
            slot.pending = None
            slot.last_sent = time.monotonic()
            try:
                result = await driver.set(light, pending.state, pending.transition_ms)
            except Exception as err:
                if not pending.future.done():
                    pending.future.set_exception(err)
            else:
                self.sent += 1
                if not pending.future.done():
                    pending.future.set_result(result)
