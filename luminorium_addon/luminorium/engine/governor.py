"""Rate governor: every command to a light goes through here.

- Per light: no faster than the light's profile allows. Restores and safety commands skip the
  per-light wait (but not the network budgets).
- Latest value wins: a new command replaces one still waiting; nothing queues up behind a slow
  light. A lower-priority command never replaces a higher-priority one.
- Per network and for the HA driver as a whole: token buckets, so a burst across many Z-Wave
  lights can't flood the mesh. The network is the one the driver actually uses (a Govee light
  over LAN doesn't draw from the Govee cloud budget).
- Batches: `send_many()` gives several lights one state. Lights of a batch whose turn has come
  together, and that one driver can reach with one message (Z-Wave multicast, a z2m group), go
  out as that one message, which takes one token from the network budget.
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
    batch: object | None = None  # the same object for every light of one send_many()
    claimed: bool = False  # another light's worker is sending it as part of a batch


@dataclass
class _Slot:
    pending: _Pending | None = None
    worker: asyncio.Task | None = None
    last_sent: float = field(default=-1e9)


class Governor:
    def __init__(self, driver_for: Callable[[Light], Driver], *, fallback: Driver | None = None):
        """driver_for(light): the driver to use for a light. fallback: the driver for a state
        the chosen one can't carry (HA)."""
        self.driver_for = driver_for
        self.fallback = fallback
        self._slots: dict[str, _Slot] = {}
        self._lights: dict[str, Light] = {}
        self._networks: dict[str, TokenBucket] = {
            name: TokenBucket(rate, burst) for name, (rate, burst) in NETWORK_BUDGETS.items()
        }
        self._ha = TokenBucket(*HA_DRIVER_BUDGET)
        self.sent = 0
        self.dropped = 0
        self.batches_sent = 0

    async def send(
        self,
        light: Light,
        state: LightState,
        *,
        transition_ms: int | None = None,
        priority: Priority = Priority.SHOW,
    ) -> str | None:
        """Send a state to a light, governed. Returns the context id, or raises Superseded."""
        future = self._queue(light, _Pending(state, transition_ms, priority, _future()))
        self._start_worker(light)
        return await future

    async def send_many(
        self,
        lights: list[Light],
        state: LightState,
        *,
        transition_ms: int | None = None,
        priority: Priority = Priority.SHOW,
    ) -> list[str | None | BaseException]:
        """One state to several lights, sent together where a driver can (see the module doc).
        Returns, per light, the context id or the exception (Superseded, a driver error)."""
        batch = object()
        futures = [
            self._queue(lt, _Pending(state, transition_ms, priority, _future(), batch))
            for lt in lights
        ]
        for light in lights:
            self._start_worker(light)
        return list(await asyncio.gather(*futures, return_exceptions=True))

    async def network_token(self, network: str) -> None:
        """Take a token from a network's budget, for a frame a driver sends on its own (a
        Z-Wave read-back)."""
        bucket = self._networks.get(network)
        if bucket:
            await bucket.acquire()

    def cancel_all(self, below: Priority = Priority.SAFETY) -> None:
        """Drop waiting commands below a priority (Stop all)."""
        for entity_id, slot in self._slots.items():
            pending = slot.pending
            if pending is not None and pending.priority < below:
                slot.pending = None
                if not pending.future.done():
                    pending.future.set_exception(Superseded(entity_id))

    # ---- internals ----------------------------------------------------------------------------

    def _queue(self, light: Light, new: _Pending) -> asyncio.Future:
        """Make `new` the light's pending command (latest wins); returns its future."""
        slot = self._slots.setdefault(light.entity_id, _Slot())
        old = slot.pending
        if old is not None:
            if new.priority < old.priority:
                self.dropped += 1
                new.future.set_exception(Superseded(light.entity_id))
                return new.future
            if not old.future.done():
                old.future.set_exception(Superseded(light.entity_id))
            self.dropped += 1
        slot.pending = new
        self._lights[light.entity_id] = light
        return new.future

    def _start_worker(self, light: Light) -> None:
        slot = self._slots[light.entity_id]
        if slot.pending is not None and (slot.worker is None or slot.worker.done()):
            slot.worker = asyncio.create_task(self._work(light.entity_id, slot))

    def _wait(self, light: Light, slot: _Slot, pending: _Pending) -> float:
        """Seconds until the light may be sent its pending command (<= 0: now)."""
        if pending.priority >= Priority.SAFETY:
            return 0.0
        profile = light.profile
        interval = 1.0 / profile.max_rate_hz if profile and profile.max_rate_hz else 0.0
        return slot.last_sent + interval - time.monotonic()

    def _driver(self, light: Light, state: LightState) -> Driver:
        driver = self.driver_for(light)
        if self.fallback is not None and not driver.supports(light, state):
            return self.fallback
        return driver

    async def _work(self, entity_id: str, slot: _Slot) -> None:
        while slot.pending is not None:
            light = self._lights[entity_id]
            wait = self._wait(light, slot, slot.pending)
            if wait > 0:
                await asyncio.sleep(wait)
                continue  # the pending command may have changed while waiting
            pending = slot.pending
            if pending.claimed:
                # Being sent with its batch by another light's worker: wait for that (or for a
                # newer command, which supersedes it)
                await asyncio.wait([pending.future])
                continue
            driver = self._driver(light, pending.state)
            if pending.batch is not None:
                members = self._claim_batch(light, slot, pending, driver)
                if members:
                    await self._send_batch(driver, members)
                    continue
            await self._acquire(driver, light)
            pending = slot.pending  # latest value wins, also while waiting for a token
            if pending is None or pending.claimed:
                continue
            slot.pending = None
            slot.last_sent = time.monotonic()
            await self._deliver(driver, [light], [pending])

    async def _acquire(self, driver: Driver, light: Light) -> None:
        network = self._networks.get(driver.network(light))
        if network:
            await network.acquire()
        if driver.name == "ha":
            await self._ha.acquire()

    def _claim_batch(
        self, light: Light, slot: _Slot, pending: _Pending, driver: Driver
    ) -> list[tuple[Light, _Slot, _Pending]]:
        """This light and the other lights of its batch that are due now, on the same driver,
        with the same command, claimed for sending together. Empty if the light is alone (it
        then goes the normal way)."""
        members = [(light, slot, pending)]
        for eid, other in self._slots.items():
            p = other.pending
            if eid == light.entity_id or p is None or p.batch is not pending.batch or p.claimed:
                continue
            other_light = self._lights[eid]
            if self._wait(other_light, other, p) > 0:
                continue
            if self._driver(other_light, p.state) is not driver:
                continue
            members.append((other_light, other, p))
        if len(members) < 2:
            return []
        for _, _, p in members:
            p.claimed = True
        return members

    async def _send_batch(
        self, driver: Driver, members: list[tuple[Light, _Slot, _Pending]]
    ) -> None:
        """Send claimed members, one message (and one token) per group the driver forms.
        After each token wait, members that got a newer command meanwhile are left out:
        their newer command is theirs to send (latest value wins)."""
        by_id = {lt.entity_id: (s, p) for lt, s, p in members}
        state = members[0][2].state

        def current(group: list[Light]) -> list[Light]:
            return [lt for lt in group if by_id[lt.entity_id][0].pending is by_id[lt.entity_id][1]]

        queue = driver.batches([lt for lt, _, _ in members], state)
        while queue:
            group = queue.pop(0)
            await self._acquire(driver, group[0])  # one message, one token
            still = current(group)
            if not still:
                continue
            if len(still) < len(group):
                parts = driver.batches(still, state)
                still, queue = parts[0], parts[1:] + queue
            now = time.monotonic()
            for lt in still:
                slot = by_id[lt.entity_id][0]
                slot.pending = None
                slot.last_sent = now
            if len(still) > 1:
                self.batches_sent += 1
            await self._deliver(driver, still, [by_id[lt.entity_id][1] for lt in still])

    async def _deliver(self, driver: Driver, lights: list[Light], pendings: list[_Pending]) -> None:
        first = pendings[0]
        try:
            if len(lights) == 1:
                result = await driver.set(lights[0], first.state, first.transition_ms)
            else:
                result = await driver.set_batch(lights, first.state, first.transition_ms)
        except Exception as err:
            for p in pendings:
                if not p.future.done():
                    p.future.set_exception(err)
        else:
            self.sent += 1
            for p in pendings:
                if not p.future.done():
                    p.future.set_result(result)


def _future() -> asyncio.Future:
    return asyncio.get_running_loop().create_future()
