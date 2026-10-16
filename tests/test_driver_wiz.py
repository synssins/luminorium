from __future__ import annotations

import pytest
from tools.fake_lan import FakeWiZBulb

from luminorium.drivers.base import LightState
from luminorium.drivers.wiz import WiZDriver, pilot_params, scene_id
from luminorium.ha.client import ReadOnlyError
from luminorium.net.udp import parse_hostport, sweep_hosts

from .conftest import wait_for

WIZ = "light.wiz_rgbww_tunable_c3b549"  # HA's MAC for it: e3:bc:9e:a2:34:56


@pytest.fixture
async def bulb():
    b = FakeWiZBulb(mac="e3bc9ea23456")
    await b.start()
    yield b
    b.stop()


@pytest.fixture
async def driver(bulb):
    # A /32 "subnet" sweep on the bulb's port: the same path as 192.168.10.0/24 on 38899
    d = WiZDriver(subnets=["127.0.0.1/32"], port=bulb.port, poll_every_s=0.05, timeout_s=0.2)
    await d.start()
    yield d
    await d.stop()


def test_sweep_hosts_and_hostport():
    assert len(sweep_hosts(["192.168.10.0/24"])) == 254
    assert sweep_hosts(["10.0.0.5/32", "10.0.0.5/32"]) == ["10.0.0.5"]
    assert sweep_hosts(["10.0.0.0/8", "nonsense"]) == []  # too big; not a network
    assert parse_hostport("192.168.10.64", 38899) == ("192.168.10.64", 38899)
    assert parse_hostport("127.0.0.1:5000", 38899) == ("127.0.0.1", 5000)


def test_pilot_params():
    assert pilot_params(LightState(False)) == {"state": False}
    assert pilot_params(LightState(True, 20)) == {"state": True, "dimming": 10}  # WiZ minimum
    assert pilot_params(LightState(True, 255, "rgb", [255, 0, 0])) == {
        "state": True,
        "dimming": 100,
        "r": 255,
        "g": 0,
        "b": 0,
    }
    assert pilot_params(LightState(True, None, "color_temp", 9000), (2200, 6500)) == {
        "state": True,
        "temp": 6500,
    }
    assert pilot_params(LightState(True, 128, effect="Fireplace")) == {
        "state": True,
        "dimming": 50,
        "sceneId": 5,
    }
    assert scene_id("Wake-up") == 9 and scene_id("Rhythm") is None


async def test_found_by_mac_and_driven(driver, bulb, house):
    light = house.lights[WIZ]
    await wait_for(lambda: driver.handles(light))
    assert driver.endpoint(light) == "WiZ 127.0.0.1"
    # another WiZ light in HA whose bulb didn't answer the sweep
    assert not driver.handles(house.lights["light.master_bedroom_arc_lamp_1"])
    await driver.set(light, LightState(True, 255, "xy", [0.675, 0.322]))
    params = bulb.set_pilots()[-1]
    assert params["r"] == 255 and params["g"] < 80 and params["b"] < 20  # red, as HA converts it
    assert bulb.state["state"] is True
    await driver.effect(light, "Ocean", speed=150)
    assert bulb.set_pilots()[-1] == {"state": True, "sceneId": 1, "speed": 150}
    assert driver.supports(light, LightState(True, effect="Forest"))
    assert not driver.supports(light, LightState(True, effect="Rhythm"))


async def test_polling_tracks_reachability(driver, bulb, house):
    light = house.lights[WIZ]
    await wait_for(lambda: driver.handles(light))
    await wait_for(lambda: any(r.message["method"] == "getPilot" for r in bulb.received))
    bulb.answer = False  # switched off at the wall
    await wait_for(lambda: not driver.handles(light), timeout=5)
    bulb.answer = True
    driver.rescan()
    await wait_for(lambda: driver.handles(light), timeout=5)


async def test_read_only(bulb, house):
    d = WiZDriver(subnets=[], hosts=[bulb.addr], read_only=True, timeout_s=0.2)
    await d.start()
    try:
        await wait_for(lambda: d.handles(house.lights[WIZ]))  # finding bulbs is a read
        with pytest.raises(ReadOnlyError):
            await d.set(house.lights[WIZ], LightState(True))
        assert not bulb.set_pilots()
    finally:
        await d.stop()
