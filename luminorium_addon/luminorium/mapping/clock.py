"""The capture's clock. The command log, the phone handshake and step timing all use it, so tests
can drive a capture in simulated time (see tests/mapping_sim.py)."""

from __future__ import annotations

import asyncio
import time


class Clock:
    def now(self) -> float:
        return time.monotonic()

    async def sleep(self, seconds: float) -> None:
        await asyncio.sleep(max(0.0, seconds))

    def register(self, task: asyncio.Task) -> None:
        """A task whose timing depends on this clock (only simulated clocks care)."""
