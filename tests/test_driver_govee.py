from __future__ import annotations

import base64
import socket

import pytest
from tools.fake_lan import FakeGovee

from luminorium.drivers.base import Driver, LightState
from luminorium.drivers.govee import GoveeDriver, commands_for, razer_frame
from luminorium.engine.governor import Governor
from luminorium.ha.client import ReadOnlyError

from .conftest import wait_for

PATH = "light.rgbic_path_lights"  # H7055, gv2mqtt-1BC8BC5470053FC2, 15 segments


@pytest.fixture
async def govee():
    g = FakeGovee()
    await g.start()
    yield g
    g.stop()


async def make_driver(govee: FakeGovee, **kw) -> GoveeDriver:
    options = dict(
        subnets=[],
        hosts=[f"127.0.0.1:{govee.scan_port}"],
        multicast=False,
        listen=("127.0.0.1", 0),
        control_port=govee.control_port,
        poll_every_s=0.05,
        timeout_s=0.2,
    )
    options.update(kw)
    d = GoveeDriver(**options)
    await d.start()
    assert d.sock is not None
    govee.reply_port = d.sock.port  # real devices answer on 4002; here, our port
    return d


@pytest.fixture
async def driver(govee):
    d = await make_driver(govee)
    yield d
    await d.stop()


def test_commands_for_states():
    assert commands_for(LightState(False)) == [{"cmd": "turn", "data": {"value": 0}}]
    assert commands_for(LightState(True, 128, "rgb", [255, 10, 0])) == [
        {"cmd": "turn", "data": {"value": 1}},
        {"cmd": "colorwc", "data": {"color": {"r": 255, "g": 10, "b": 0}, "colorTemInKelvin": 0}},
        {"cmd": "brightness", "data": {"value": 50}},
    ]
    white = commands_for(LightState(True, None, "color_temp", 3000))
    assert white[1]["data"]["colorTemInKelvin"] == 3000


def test_razer_frame_layout():
    raw = base64.b64decode(razer_frame([(255, 0, 0), (0, 0, 255)]))
    assert raw[:6] == bytes([0xBB, 0x00, 0x08, 0xB0, 0x01, 0x02])
    assert raw[6:12] == bytes([255, 0, 0, 0, 0, 255])
    check = 0
    for b in raw[:-1]:
        check ^= b
    assert raw[-1] == check


async def test_unicast_scan_finds_device_by_id(driver, govee, house):
    light = house.lights[PATH]
    await wait_for(lambda: driver.handles(light))
    assert driver.endpoint(light) == "Govee LAN 127.0.0.1"
    assert driver.devices["1BC8BC5470053FC2"].sku == "H7055"
    assert not driver.handles(house.lights["light.led_bulb_string_lights"])  # not on the LAN


async def test_multicast_scan(govee, house):
    # The multicast group stands in for 239.255.255.250 on loopback
    d = await make_driver(
        govee, hosts=[], multicast=True, multicast_group="127.0.0.1", scan_port=govee.scan_port
    )
    try:
        await wait_for(lambda: d.handles(house.lights[PATH]))
    finally:
        await d.stop()


async def test_set_and_dev_status(driver, govee, house):
    light = house.lights[PATH]
    await wait_for(lambda: driver.handles(light))
    await driver.set(light, LightState(True, 255, "rgb", [0, 0, 255]))
    sent = ("turn", "colorwc", "brightness")
    await wait_for(lambda: len([c for c in govee.commands() if c["cmd"] in sent]) == 3)
    assert [c["cmd"] for c in govee.commands() if c["cmd"] in sent] == list(sent)
    assert govee.status["onOff"] == 1 and govee.status["color"] == {"r": 0, "g": 0, "b": 255}
    status = await driver.dev_status(driver.device_for(light))  # type: ignore[arg-type]
    assert status and status["onOff"] == 1


async def test_scenes_go_through_ha(driver, govee, house):
    light = house.lights[PATH]
    await wait_for(lambda: driver.handles(light))
    assert not driver.supports(light, LightState(True, effect="Aurora"))

    class HA(Driver):
        name = "ha"
        calls: list = []

        async def set(self, light, state, transition_ms=None):
            self.calls.append(state.effect)
            return "ctx"

    ha = HA()
    g = Governor(lambda _: driver, fallback=ha)
    assert await g.send(light, LightState(True, effect="Aurora")) == "ctx"
    assert ha.calls == ["Aurora"]


async def test_unreachable_after_missed_polls(driver, govee, house):
    light = house.lights[PATH]
    await wait_for(lambda: driver.handles(light))
    govee.stop()
    await wait_for(lambda: not driver.handles(light), timeout=5)


async def test_razer_only_when_enabled_for_the_model(govee, house):
    light = house.lights[PATH]
    off = await make_driver(govee)
    try:
        await wait_for(lambda: off.handles(light))
        assert not off.can_stream(light)
        with pytest.raises(ConnectionError):
            await off.stream(light, [(1, 2, 3)] * 15)
    finally:
        await off.stop()
    on = await make_driver(govee, razer_models=["h7055"])
    try:
        await wait_for(lambda: on.handles(light))
        assert on.can_stream(light)
        await on.stream(light, [(255, 0, 0)] * 15)
        await wait_for(lambda: len(govee.commands("razer")) == 2)
        enable, frame = (base64.b64decode(c["data"]["pt"]) for c in govee.commands("razer"))
        assert enable[:5] == bytes([0xBB, 0x00, 0x01, 0xB1, 0x01])
        assert frame[5] == 15
        await on.set(light, LightState(True, 100))  # a normal command ends streaming first
        await wait_for(lambda: len(govee.commands("razer")) == 3)
        assert base64.b64decode(govee.commands("razer")[-1]["data"]["pt"])[4] == 0x00
    finally:
        await on.stop()


async def test_port_in_use_turns_the_driver_off():
    taken = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    taken.bind(("127.0.0.1", 0))
    try:
        d = GoveeDriver(subnets=[], listen=("127.0.0.1", taken.getsockname()[1]))
        await d.start()
        assert not d.connected and "can't listen" in (d.error or "")
        await d.stop()
    finally:
        taken.close()


async def test_read_only(govee, house):
    d = await make_driver(govee, read_only=True)
    try:
        await wait_for(lambda: d.handles(house.lights[PATH]))
        with pytest.raises(ReadOnlyError):
            await d.set(house.lights[PATH], LightState(True))
        assert not govee.commands("turn")
    finally:
        await d.stop()
