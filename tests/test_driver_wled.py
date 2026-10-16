from __future__ import annotations

import pytest
from tools.fake_lan import FakeWLED

from luminorium.drivers.base import LightState
from luminorium.drivers.wled import WLEDDriver, ddp_packets, host_of, wled_ids
from luminorium.ha.client import ReadOnlyError

from .conftest import wait_for

MASTER = "light.front_pathway_master"
RGB = "light.front_pathway_rgb"  # segment 0
WHITE = "light.front_pathway_white"  # segment 1


@pytest.fixture
async def wled():
    w = FakeWLED()
    await w.start()
    yield w
    await w.stop()


@pytest.fixture
def lights(house, wled):
    """The front pathway lights, pointed at the fake controller instead of 192.168.10.215."""
    out = {eid: house.lights[eid] for eid in (MASTER, RGB, WHITE)}
    for light in out.values():
        light.device_url = f"http://{wled.host}"
    return out


@pytest.fixture
async def driver(wled, lights):
    d = WLEDDriver(ddp_port=wled.ddp_port)
    d.watch(list(lights.values()))
    await d.start()
    await wait_for(lambda: d.handles(lights[RGB]))
    yield d
    await d.stop()


def test_ids_from_ha(house):
    assert wled_ids(house.lights[MASTER]) == ("d48afca1d67c", None)
    assert wled_ids(house.lights[WHITE]) == ("d48afca1d67c", 1)
    assert host_of(house.lights[MASTER]) == "192.168.10.215"


def test_ddp_packets():
    pkts = ddp_packets([(1, 2, 3)] * 500, offset_px=4, seq=3)
    assert len(pkts) == 2
    flags, seq, kind, dest = pkts[0][:4]
    assert flags == 0x40 and seq == 3 and kind == 0x0B and dest == 1  # no push yet
    assert int.from_bytes(pkts[0][4:8], "big") == 12  # 4 pixels in
    assert int.from_bytes(pkts[0][8:10], "big") == 1440
    assert pkts[1][0] == 0x41  # push on the last packet
    assert int.from_bytes(pkts[1][4:8], "big") == 12 + 1440
    assert len(pkts[1]) == 10 + 20 * 3


async def test_state_effects_and_palettes(driver, wled, lights):
    assert driver.endpoint(lights[WHITE]) == "WLED 127.0.0.1 segment 1"
    await driver.set(lights[RGB], LightState(True, 200, "rgb", [255, 0, 0]), transition_ms=700)
    assert wled.posts[-1].message == {
        "tt": 7,
        "seg": [{"id": 0, "on": True, "bri": 200, "col": [[255, 0, 0]]}],
    }
    await driver.set(lights[MASTER], LightState(False))
    assert wled.posts[-1].message == {"on": False}
    await driver.set(lights[WHITE], LightState(True, effect="Fire 2012"))
    assert wled.posts[-1].message["seg"][0]["fx"] == 3
    assert not driver.supports(lights[WHITE], LightState(True, effect="Rainbow"))
    await driver.effect(lights[WHITE], "Breathe", palette="Forest", speed=90)
    assert wled.posts[-1].message == {
        "on": True,
        "seg": [{"id": 1, "fx": 2, "pal": 1, "sx": 90}],
    }
    with pytest.raises(ValueError):
        await driver.effect(lights[WHITE], "Breathe", palette="Lava")


async def test_ddp_stream_to_a_segment(driver, wled, lights):
    assert driver.can_stream(lights[WHITE])
    assert driver.pixel_count(lights[WHITE]) == 4
    await driver.stream(lights[WHITE], [(0, 255, 0)] * 4)
    await wait_for(lambda: wled.ddp)
    flags, offset, data = wled.ddp_pixels()[0]
    assert flags & 0x01 and offset == 4 * 3  # segment 1 starts at LED 4
    assert data == bytes([0, 255, 0] * 4)


async def test_wrong_mac_is_not_used(wled, lights):
    wled.mac = "000000000000"  # another controller answers at that address
    d = WLEDDriver()
    d.watch(list(lights.values()))
    await d.start()
    try:
        await d.refresh()
        assert not d.handles(lights[RGB])
    finally:
        await d.stop()


async def test_read_only(wled, lights):
    d = WLEDDriver(read_only=True, ddp_port=wled.ddp_port)
    d.watch(list(lights.values()))
    await d.start()
    try:
        await wait_for(lambda: d.handles(lights[RGB]))
        with pytest.raises(ReadOnlyError):
            await d.set(lights[RGB], LightState(True))
        with pytest.raises(ReadOnlyError):
            await d.stream(lights[RGB], [(1, 1, 1)])
        assert not wled.posts and not wled.ddp
    finally:
        await d.stop()
