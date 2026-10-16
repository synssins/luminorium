from __future__ import annotations

import asyncio

import pytest
from tools.fake_mqtt import FakeBroker, FakeZ2M

from luminorium.drivers.base import LightState
from luminorium.drivers.z2m import Z2MDriver, set_payload
from luminorium.engine.governor import Governor
from luminorium.ha.client import ReadOnlyError
from luminorium.net.mqtt import MQTTEndpoint, topic_matches

from .conftest import wait_for

PORCH = "light.front_porch_light"
DRIVEWAY = ("light.front_driveway_light_01", "light.front_driveway_light_02")


@pytest.fixture
async def broker():
    b = FakeBroker(username="addons", password="secret")
    await b.start()
    z2m = FakeZ2M(b)
    b.z2m = z2m  # type: ignore[attr-defined]
    yield b
    await b.stop()


def make_driver(broker: FakeBroker, password: str = "secret", **kw) -> Z2MDriver:
    endpoint = MQTTEndpoint("127.0.0.1", broker.port, "addons", password)
    return Z2MDriver(endpoint, **kw)


async def started(broker: FakeBroker, house, **kw) -> Z2MDriver:
    await broker.z2m.start()  # type: ignore[attr-defined]
    driver = make_driver(broker, **kw)
    await driver.start()
    await wait_for(lambda: driver.handles(house.lights[PORCH]))
    return driver


def test_topic_wildcards():
    assert topic_matches("zigbee2mqtt/bridge/#", "zigbee2mqtt/bridge/devices")
    assert topic_matches("a/+/c", "a/b/c")
    assert not topic_matches("a/+/c", "a/b/d")
    assert not topic_matches("a/b", "a/b/c")


async def test_names_from_bridge_devices_with_trailing_space(broker, house):
    driver = await started(broker, house)
    try:
        porch = house.lights[PORCH]
        # z2m's name, not HA's: the real one ends in a space
        assert driver.endpoint(porch) == "z2m 'Front Porch Light '"
        await driver.set(porch, LightState(True, 255, "xy", [0.6, 0.3]), transition_ms=1500)
        await wait_for(lambda: broker.z2m.sets())  # type: ignore[attr-defined]
        sent = broker.z2m.sets()[0]  # type: ignore[attr-defined]
        assert sent.topic == "zigbee2mqtt/Front Porch Light /set"
        assert sent.json() == {
            "state": "ON",
            "brightness": 254,
            "color": {"x": 0.6, "y": 0.3},
            "transition": 1.5,
        }
        # Lights z2m doesn't know (Z-Wave, Govee via govee2mqtt) are not handled
        assert not driver.handles(house.lights["light.basement_main_lights"])
        assert not driver.handles(house.lights["light.rgbic_path_lights"])
    finally:
        await driver.stop()


def test_payloads(house):
    porch = house.lights[PORCH]
    assert set_payload(porch, LightState(False), None) == {"state": "OFF"}
    p = set_payload(porch, LightState(True, 100, "color_temp", 2700), None)
    assert p == {"state": "ON", "brightness": 100, "color_temp": 370}
    p = set_payload(porch, LightState(True, None, "hs", [30, 80], effect="candle"), 0)
    assert p == {
        "state": "ON",
        "color": {"hue": 30.0, "saturation": 80.0},
        "effect": "candle",
        "transition": 0.0,
    }
    # an effect the light doesn't list is not sent
    assert "effect" not in set_payload(porch, LightState(True, effect="fire"), None)


async def test_group_carries_simultaneous_change(broker, house):
    a, b = (house.lights[e] for e in DRIVEWAY)
    broker.z2m.add_group(  # type: ignore[attr-defined]
        "Front Driveway", ["0x001788010c7daeb5", "0x001788010c84e400"]
    )
    driver = await started(broker, house)
    try:
        await wait_for(lambda: driver.groups)
        porch = house.lights[PORCH]
        assert driver.batches([a, porch, b], LightState(True)) == [[a, b], [porch]]
        g = Governor(lambda _: driver)
        await g.send_many([a, b, porch], LightState(True, 200))
        await wait_for(lambda: len(broker.z2m.sets()) == 2)  # type: ignore[attr-defined]
        topics = sorted(p.topic for p in broker.z2m.sets())  # type: ignore[attr-defined]
        assert topics == ["zigbee2mqtt/Front Driveway/set", "zigbee2mqtt/Front Porch Light /set"]
        assert g.batches_sent == 1
    finally:
        await driver.stop()


async def test_bridge_offline_hands_lights_back(broker, house):
    driver = await started(broker, house)
    try:
        changes = []
        driver.on_change(lambda: changes.append(1))
        await broker.publish("zigbee2mqtt/bridge/state", '{"state":"offline"}', retain=True)
        await wait_for(lambda: not driver.handles(house.lights[PORCH]))
        assert changes
    finally:
        await driver.stop()


async def test_reconnect_renews_subscriptions(broker, house):
    driver = await started(broker, house)
    try:
        await broker.drop_clients()
        await wait_for(lambda: not driver.connected)
        await wait_for(lambda: driver.connected, timeout=5)
        await wait_for(lambda: driver.handles(house.lights[PORCH]))
        await driver.set(house.lights[PORCH], LightState(False))
        await wait_for(lambda: broker.z2m.sets())  # type: ignore[attr-defined]
    finally:
        await driver.stop()


async def test_bad_credentials_and_read_only(broker, house):
    await broker.z2m.start()  # type: ignore[attr-defined]
    bad = make_driver(broker, password="wrong")
    await bad.start()
    try:
        await wait_for(lambda: bad.mqtt.error is not None)  # type: ignore[union-attr]
        assert "user name or password" in bad.mqtt.error  # type: ignore[union-attr]
        assert not bad.handles(house.lights[PORCH])
    finally:
        await bad.stop()
    ro = await started(broker, house, read_only=True)
    try:
        with pytest.raises(ReadOnlyError):
            await ro.set(house.lights[PORCH], LightState(True))
        await asyncio.sleep(0.05)
        assert not broker.z2m.sets()  # type: ignore[attr-defined]
    finally:
        await ro.stop()


def test_no_broker_found():
    driver = Z2MDriver(None)
    assert driver.error and "Mosquitto" in driver.error
