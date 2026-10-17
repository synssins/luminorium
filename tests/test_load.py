"""Load test: a burst of commands to every Z-Wave dimmer through the governor, the real Z-Wave
driver and a fake Z-Wave JS server, with the real network budget (2 frames/s, burst 2).

- The budget is never exceeded, counting every frame the server sees: unicasts, multicasts
  (one frame each) and the driver's read-backs.
- Latest value wins: each dimmer ends at the last value asked of it, and most of the burst is
  dropped instead of queued.
"""

from __future__ import annotations

import asyncio
import random

from tools.fake_zwave import FakeZWaveServer

from luminorium.drivers.base import LightState
from luminorium.drivers.zwave import ZWaveDriver, target_value, value_of
from luminorium.engine.governor import NETWORK_BUDGETS, Governor, Superseded

from .conftest import wait_for

DIMMERS = [
    "light.living_room_overhead_lights_switch",  # GE 12724 ×5: v1, insecure
    "light.dining_room_overhead_light_switch",
    "light.lower_hallway_light_switch",
    "light.master_bedroom_overhead_light_switch",
    "light.basement_main_lights",
    "light.upstairs_hallway_light_switch",  # Honeywell: v4, insecure
    "light.kitchen_cabinet_light_switch",  # ZEN77: S2 Authenticated
    "light.living_room_scene_controller",  # ZEN35: S2 Authenticated
]


def max_excess(times: list[float], rate: float, burst: int) -> float:
    """The most any window of frames exceeds burst + rate × window length (≤ 0: within)."""
    worst = float("-inf")
    for i in range(len(times)):
        for j in range(i, len(times)):
            worst = max(worst, (j - i + 1) - (burst + rate * (times[j] - times[i])))
    return worst


async def test_zwave_budget_holds_under_a_burst_and_latest_value_wins(house):
    server = FakeZWaveServer()
    await server.start()
    driver = ZWaveDriver([server.url], verify_after_s=0.2)
    governor = Governor(lambda _: driver)
    driver.acquire = lambda: governor.network_token("zwave")
    await driver.start()
    try:
        await wait_for(lambda: driver.connected)
        lights = [house.lights[e] for e in DIMMERS]
        for light in lights:
            light.profile.max_rate_hz = 20.0  # let the network budget be the limit
        rng = random.Random(7)
        expected: dict[int, int | bool] = {}
        tasks = []
        start = asyncio.get_running_loop().time()
        sent = commands = 0
        # 1.5 s of a show hammering the dimmers: a command every ~20 ms, now and then a change
        # to all of them at once
        while asyncio.get_running_loop().time() - start < 1.5:
            commands += len(lights) if sent % 15 == 0 else 1
            if sent % 15 == 0:
                state = LightState(True, rng.randint(1, 255))
                tasks.append(asyncio.create_task(governor.send_many(lights, state)))
                for light in lights:
                    expected[value_of(light)[0]] = target_value(38, state)  # type: ignore[index]
            else:
                light = rng.choice(lights)
                state = LightState(True, rng.randint(1, 255))
                tasks.append(asyncio.create_task(governor.send(light, state)))
                expected[value_of(light)[0]] = target_value(38, state)  # type: ignore[index]
            sent += 1
            await asyncio.sleep(0.02)
        results = []
        for r in await asyncio.gather(*tasks, return_exceptions=True):
            results.extend(r if isinstance(r, list) else [r])
        assert len(results) == commands
        await asyncio.sleep(0.5)  # let the last read-backs finish
        await wait_for(lambda: not driver._verifiers, timeout=20)

        frames = server.frames()
        times = [f.at for f in frames]
        rate, burst = NETWORK_BUDGETS["zwave"]
        assert max_excess(times, rate, burst) <= 0.25, "Z-Wave budget exceeded"
        # nothing queued: far fewer frames than commands
        superseded = sum(isinstance(r, Superseded) for r in results)
        assert len(frames) < commands / 3 and superseded > commands / 2
        errors = [r for r in results if isinstance(r, Exception) and not isinstance(r, Superseded)]
        assert not errors
        # latest value wins: every dimmer ends at the last value asked of it
        final = {node: server.values.get((node, 38, 0)) for node in expected}
        assert final == expected
    finally:
        await driver.stop()
        await server.stop()


async def test_a_multicast_takes_one_token(house):
    server = FakeZWaveServer()
    await server.start()
    driver = ZWaveDriver([server.url], verify_multicast=False)
    governor = Governor(lambda _: driver)
    await driver.start()
    try:
        await wait_for(lambda: driver.connected)
        lights = [house.lights[e] for e in DIMMERS]
        # 8 dimmers in 3 groups: GE ×5 can't take a duration, the Honeywell can (alone), and
        # the two S2 dimmers multicast together: 3 frames, within the burst of 2 + 0.5 s
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        await governor.send_many(lights, LightState(True, 128))
        elapsed = loop.time() - t0
        assert len(server.frames()) == 3
        assert governor.batches_sent == 2
        assert 0.4 <= elapsed < 1.5
    finally:
        await driver.stop()
        await server.stop()
