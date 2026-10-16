from __future__ import annotations

import pytest
from tools.fake_zwave import FakeZWaveServer

from luminorium.drivers.base import LightState
from luminorium.drivers.zwave import ZWaveDriver, duration, target_value, value_of
from luminorium.engine.governor import Governor
from luminorium.ha.client import ReadOnlyError

from .conftest import wait_for

GE = [  # GE 12724, Multilevel Switch v1, no security
    "light.living_room_overhead_lights_switch",
    "light.dining_room_overhead_light_switch",
    "light.lower_hallway_light_switch",
]
ZEN77 = "light.kitchen_cabinet_light_switch"  # v4, S2 Authenticated
ZEN35 = "light.living_room_scene_controller"  # v4, S2 Authenticated
HONEYWELL = "light.upstairs_hallway_light_switch"  # v4, no security
DEAD = "light.living_room_floor_lamp_switch"  # node 8, dead
RELAY = "switch.backyard_light_switch"  # Binary Switch


@pytest.fixture
async def server():
    s = FakeZWaveServer()
    await s.start()
    yield s
    await s.stop()


@pytest.fixture
async def driver(server):
    d = ZWaveDriver([server.url], verify_after_s=0.05)
    await d.start()
    await wait_for(lambda: d.connected, timeout=10)
    yield d
    await d.stop()


def test_values_and_durations(house):
    assert value_of(house.lights[ZEN77]) == (26, 38, 0)
    assert value_of(house.lights[RELAY]) == (15, 37, 0)
    assert value_of(house.lights["light.living_room_ceiling_fan_basic"]) is None  # Basic CC
    assert target_value(38, LightState(True, 255)) == 99
    assert target_value(38, LightState(True, 1)) == 1
    assert target_value(38, LightState(True)) == 255  # previous level
    assert target_value(38, LightState(False)) == 0
    assert target_value(37, LightState(True)) is True
    assert duration(3000) == "3s" and duration(400) == "0s"


async def test_falls_back_to_the_next_url(server):
    # the hostname first (may not resolve with host networking), then the add-on's IP
    d = ZWaveDriver(["ws://127.0.0.1:1/unreachable", server.url])
    await d.start()
    try:
        await wait_for(lambda: d.connected, timeout=15)
        assert d.url == server.url
    finally:
        await d.stop()


async def test_tracks_nodes(driver, server, house):
    assert driver.handles(house.lights[ZEN77])
    assert driver.handles(house.lights[RELAY])
    assert not driver.handles(house.lights[DEAD])
    assert driver.endpoint(house.lights[ZEN77]) == "Z-Wave node 26"


async def test_set_value_with_duration_only_where_supported(driver, server, house):
    await driver.set(house.lights[ZEN77], LightState(True, 128), transition_ms=3000)
    await driver.set(house.lights[GE[0]], LightState(True, 128), transition_ms=3000)
    await driver.set(house.lights[RELAY], LightState(False))
    sets = [c.payload for c in server.commands if c.command == "node.set_value"]
    assert sets[0]["nodeId"] == 26 and sets[0]["value"] == 50
    assert sets[0]["valueId"] == {"commandClass": 38, "endpoint": 0, "property": "targetValue"}
    assert sets[0]["options"] == {"transitionDuration": "3s"}
    assert sets[1]["nodeId"] == 7 and "options" not in sets[1]  # GE 12724: v1, no duration
    assert sets[2]["valueId"]["commandClass"] == 37 and sets[2]["value"] is False
    assert server.values[(26, 38, 0)] == 50


def test_batches_split_by_security_class(house):
    d = ZWaveDriver([])
    lights = [house.lights[e] for e in [*GE, ZEN77, ZEN35, HONEYWELL]]
    groups = d.batches(lights, LightState(True, 100))
    as_ids = sorted(sorted(lt.entity_id for lt in g) for g in groups)
    assert as_ids == sorted([sorted(GE), sorted([ZEN77, ZEN35]), [HONEYWELL]])


async def test_multicast_is_one_frame_and_read_back_fixes_misses(driver, server, house):
    server.multicast_misses = {12}  # the dining room dimmer misses the unacknowledged frame
    lights = [house.lights[e] for e in GE]
    g = Governor(lambda _: driver)
    driver.acquire = lambda: g.network_token("zwave")
    results = await g.send_many(lights, LightState(True, 77))
    assert results == [None, None, None]
    multicasts = [c.payload for c in server.commands if c.command == "multicast_group.set_value"]
    assert len(multicasts) == 1
    assert sorted(multicasts[0]["nodeIDs"]) == [7, 12, 22]
    assert multicasts[0]["value"] == 30
    assert driver.multicasts == 1
    # read back: three polls, one unicast resend to the node that missed it
    await wait_for(lambda: server.values.get((12, 38, 0)) == 30, timeout=10)
    await wait_for(lambda: len([c for c in server.commands if c.command == "node.poll_value"]) == 3)
    polls = [c.payload["nodeId"] for c in server.commands if c.command == "node.poll_value"]
    assert sorted(polls) == [7, 12, 22]
    resend = [c.payload for c in server.commands if c.command == "node.set_value"]
    assert [r["nodeId"] for r in resend] == [12]
    assert driver.read_back_misses == 1


async def test_read_back_skips_nodes_with_newer_commands(driver, server, house):
    server.multicast_misses = {7}
    lights = [house.lights[e] for e in GE[:2]]
    driver.verify_after_s = 0.3
    await driver.set_batch(lights, LightState(True, 255))
    await driver.set(lights[0], LightState(False))  # newer value for node 7: latest wins
    await wait_for(lambda: len([c for c in server.commands if c.command == "node.poll_value"]) == 1)
    sets = [c.payload for c in server.commands if c.command == "node.set_value"]
    assert [(s["nodeId"], s["value"]) for s in sets] == [(7, 0)]


async def test_read_only_sends_nothing(server, house):
    d = ZWaveDriver([server.url], read_only=True)
    await d.start()
    try:
        await wait_for(lambda: d.connected)
        with pytest.raises(ReadOnlyError):
            await d.set(house.lights[ZEN77], LightState(True))
        with pytest.raises(ReadOnlyError):
            await d.set_batch([house.lights[e] for e in GE], LightState(True))
        assert not server.frames()
    finally:
        await d.stop()
