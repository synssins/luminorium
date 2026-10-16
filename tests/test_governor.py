from __future__ import annotations

import asyncio
import time

import pytest

from luminorium.drivers.base import Driver, LightState
from luminorium.engine import governor as gov
from luminorium.engine.governor import Governor, Priority, Superseded
from luminorium.inventory.model import Capabilities, Kind, Light, Profile


class RecordingDriver(Driver):
    name = "fake"

    def __init__(self):
        self.sent: list[tuple[float, str, LightState]] = []

    async def set(self, light, state, transition_ms=None):
        self.sent.append((time.monotonic(), light.entity_id, state))
        return f"ctx-{len(self.sent)}"


def make_light(eid: str, network: str = "zigbee", rate: float = 10.0) -> Light:
    light = Light(eid, eid, "test", "test", Kind.LIGHT, "a", "f", state="off")
    light.profile = Profile(Capabilities(dimming=True), network=network, max_rate_hz=rate)
    return light


async def test_latest_value_wins():
    driver = RecordingDriver()
    g = Governor(lambda _: driver)
    light = make_light("light.a", rate=5.0)  # one command per 0.2 s
    first = asyncio.create_task(g.send(light, LightState(True, 10)))
    await asyncio.sleep(0)
    middle = [asyncio.create_task(g.send(light, LightState(True, b))) for b in (20, 30, 40)]
    await asyncio.sleep(0)
    last = asyncio.create_task(g.send(light, LightState(True, 50)))
    await first
    assert await last == "ctx-2"
    for task in middle:
        with pytest.raises(Superseded):
            await task
    assert [s.brightness for _, _, s in driver.sent] == [10, 50]
    gap = driver.sent[1][0] - driver.sent[0][0]
    assert gap >= 0.19


async def test_lower_priority_cannot_replace_higher():
    driver = RecordingDriver()
    g = Governor(lambda _: driver)
    light = make_light("light.a", rate=5.0)
    await g.send(light, LightState(True, 1))
    restore = asyncio.create_task(g.send(light, LightState(False), priority=Priority.RESTORE))
    await asyncio.sleep(0)
    with pytest.raises(Superseded):
        await g.send(light, LightState(True, 99), priority=Priority.SHOW)
    await restore
    assert driver.sent[-1][2] == LightState(False)


async def test_restore_skips_per_light_wait():
    driver = RecordingDriver()
    g = Governor(lambda _: driver)
    light = make_light("light.a", rate=0.5)  # 2 s between show commands
    await g.send(light, LightState(True, 1))
    start = time.monotonic()
    await g.send(light, LightState(False), priority=Priority.RESTORE)
    assert time.monotonic() - start < 0.2


async def test_network_budget_spreads_a_burst(monkeypatch):
    monkeypatch.setitem(gov.NETWORK_BUDGETS, "zwave", (20.0, 2))
    driver = RecordingDriver()
    g = Governor(lambda _: driver)
    lights = [make_light(f"light.z{i}", network="zwave", rate=10.0) for i in range(10)]
    start = time.monotonic()
    await asyncio.gather(*(g.send(lt, LightState(True, 100)) for lt in lights))
    # 2 at once, then 8 more at 20/s: at least 0.4 s
    assert time.monotonic() - start >= 0.38
    assert len(driver.sent) == 10


async def test_cancel_all_drops_waiting_show_commands():
    driver = RecordingDriver()
    g = Governor(lambda _: driver)
    light = make_light("light.a", rate=1.0)
    await g.send(light, LightState(True, 1))
    waiting = asyncio.create_task(g.send(light, LightState(True, 2)))
    await asyncio.sleep(0.01)
    g.cancel_all()
    with pytest.raises(Superseded):
        await waiting
    assert len(driver.sent) == 1
