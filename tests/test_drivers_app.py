"""The app with every direct driver against fakes: discovery, routing, override, Test."""

from __future__ import annotations

import asyncio

import httpx
import pytest
from tools.fake_ha import TOKEN
from tools.fake_lan import FakeWiZBulb, FakeWLED
from tools.fake_mqtt import FakeBroker, FakeZ2M
from tools.fake_supervisor import FakeSupervisor
from tools.fake_zwave import FakeZWaveServer

from luminorium.app import Luminorium
from luminorium.discovery import Supervisor, discover
from luminorium.drivers.base import LightState
from luminorium.settings import DriverSettings
from luminorium.web.server import create_app

from .conftest import make_settings, wait_for

PORCH = "light.front_porch_light"
ZEN77 = "light.kitchen_cabinet_light_switch"
GE = ["light.living_room_overhead_lights_switch", "light.dining_room_overhead_light_switch"]
WIZ = "light.wiz_rgbww_tunable_c3b549"
WLED_RGB = "light.front_pathway_rgb"


@pytest.fixture
async def fakes(fake_ha):
    broker = FakeBroker(username="addons", password="pw")
    await broker.start()
    z2m = FakeZ2M(broker)
    await z2m.start()
    zwave = FakeZWaveServer()
    await zwave.start()
    fake_ha.zwave_server_url = zwave.url
    bulb = FakeWiZBulb(mac="e3bc9ea23456")
    await bulb.start()
    wled = FakeWLED()
    await wled.start()
    for device in fake_ha.devices:
        if ["wled", "d48afca1d67c"] in device["identifiers"]:
            device["configuration_url"] = f"http://{wled.host}"
    supervisor = FakeSupervisor(
        token=TOKEN,
        mqtt={
            "host": "127.0.0.1",
            "port": broker.port,
            "ssl": False,
            "protocol": "3.1.1",
            "username": "addons",
            "password": "pw",
            "addon": "core_mosquitto",
        },
        addons={"core_zwave_js": {"state": "started", "ip_address": "127.0.0.1"}},
    )
    await supervisor.start()
    yield {
        "broker": broker,
        "z2m": z2m,
        "zwave": zwave,
        "bulb": bulb,
        "wled": wled,
        "supervisor": supervisor,
    }
    await supervisor.stop()
    await wled.stop()
    bulb.stop()
    await zwave.stop()
    await broker.stop()


@pytest.fixture
async def app(fake_ha, fakes, tmp_path):
    drivers = DriverSettings(
        enabled=frozenset({"z2m", "zwave_js", "wiz", "wled"}),
        wiz_subnets=(),
        wiz_hosts=(fakes["bulb"].addr,),
        wled_ddp_port=fakes["wled"].ddp_port,
    )
    settings = make_settings(
        fake_ha.url, tmp_path, supervisor_url=fakes["supervisor"].url, drivers=drivers
    )
    lum = Luminorium(settings, test_hold_s=0.05)
    await lum.start()
    await asyncio.wait_for(lum.inventory.loaded.wait(), 10)
    inv = lambda: lum.inventory.inventory  # noqa: E731
    for eid, name in ((PORCH, "z2m"), (ZEN77, "zwave_js"), (WIZ, "wiz"), (WLED_RGB, "wled")):
        await wait_for(lambda e=eid, n=name: inv().lights[e].profile.driver == n, timeout=10)
    yield lum
    await lum.stop()


@pytest.fixture
async def client(app):
    transport = httpx.ASGITransport(app=create_app(app, manage_lifecycle=False))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def test_supervisor_discovery(fake_ha, fakes, tmp_path):
    sup = Supervisor(fakes["supervisor"].url, TOKEN)
    endpoint = await sup.mqtt()
    assert endpoint and endpoint.port == fakes["broker"].port and endpoint.username == "addons"
    assert "pw" not in repr(endpoint)
    assert await Supervisor(fakes["supervisor"].url, "wrong").mqtt() is None
    settings = make_settings(
        fake_ha.url,
        tmp_path,
        supervisor_url=fakes["supervisor"].url,
        drivers=DriverSettings(enabled=frozenset({"z2m", "zwave_js"})),
    )
    lum = Luminorium(settings)
    await lum.ha.start()
    try:
        await lum.ha.wait_connected(5)
        found = await discover(settings, lum.ha, "any-zwave-device")
    finally:
        await lum.ha.close()
    assert found.mqtt == endpoint
    # what HA uses first, then the add-on hostname, then its IP from the Supervisor
    assert found.zwave_urls == [
        fakes["zwave"].url,
        "ws://core-zwave-js:3000",
        "ws://127.0.0.1:3000",
    ]


async def test_routes_and_status(client):
    status = (await client.get("/api/status")).json()
    drivers = status["drivers"]
    assert drivers["z2m"]["connected"] and drivers["z2m"]["devices"] > 10
    assert drivers["zwave_js"]["connected"] and drivers["wiz"]["bulbs"] == 1
    assert drivers["govee"] == {"enabled": False}
    lights = {lt["entity_id"]: lt for lt in (await client.get("/api/inventory")).json()["lights"]}
    porch = lights[PORCH]
    assert porch["profile"]["driver"] == "z2m"
    assert porch["profile"]["endpoint"] == "z2m 'Front Porch Light '"
    assert porch["driver_options"] == ["ha", "z2m"]
    assert lights["light.rgbic_path_lights"]["driver_options"] == ["ha"]  # Govee is off


async def test_test_button_goes_through_z2m_not_ha(client, app, fake_ha, fakes):
    assert (await client.post(f"/api/lights/{PORCH}/test")).status_code == 200
    await wait_for(lambda: not app.safety.sessions, timeout=10)
    sets = [p.json() for p in fakes["z2m"].sets("Front Porch Light ")]
    assert [s["state"] for s in sets] == ["ON", "OFF", "OFF"]  # on, off, restore (was off)
    assert not fake_ha.calls_for(PORCH)


async def test_override_to_ha(client, app, fake_ha, fakes):
    r = await client.put(f"/api/lights/{PORCH}/driver", json={"driver": "wiz"})
    assert r.status_code == 400
    r = await client.put(f"/api/lights/{PORCH}/driver", json={"driver": "ha"})
    assert r.status_code == 200 and r.json()["profile"]["driver"] == "ha"
    assert app.store.load("choices")["drivers"] == {PORCH: "ha"}
    await client.post(f"/api/lights/{PORCH}/test")
    await wait_for(lambda: not app.safety.sessions, timeout=10)
    assert len(fake_ha.calls_for(PORCH)) == 3
    assert not fakes["z2m"].sets()
    r = await client.put(f"/api/lights/{PORCH}/driver", json={"driver": None})
    assert r.json()["profile"]["driver"] == "z2m"


async def test_fixture_of_dimmers_tests_by_multicast(client, app, fakes):
    fixture = (await client.post("/api/fixtures", json={"members": GE})).json()
    for eid in GE:  # fast enough for a quick test
        app.inventory.inventory.lights[eid].profile.max_rate_hz = 50
    await wait_for(
        lambda: all(app.inventory.inventory.lights[e].profile.driver == "zwave_js" for e in GE)
    )
    assert (await client.post(f"/api/fixtures/{fixture['id']}/test")).status_code == 200
    await wait_for(lambda: not app.safety.sessions, timeout=15)
    multicasts = [
        c.payload for c in fakes["zwave"].commands if c.command == "multicast_group.set_value"
    ]
    # on and off as one frame each (restore goes light by light: states may differ)
    assert [m["value"] for m in multicasts[:2]] == [99, 0]
    assert sorted(multicasts[0]["nodeIDs"]) == [7, 12]


async def test_read_only_app_never_reaches_a_device(fake_ha, fakes, tmp_path):
    drivers = DriverSettings(
        enabled=frozenset({"z2m", "wiz"}), wiz_subnets=(), wiz_hosts=(fakes["bulb"].addr,)
    )
    settings = make_settings(
        fake_ha.url,
        tmp_path,
        read_only=True,
        supervisor_url=fakes["supervisor"].url,
        drivers=drivers,
    )
    lum = Luminorium(settings)
    await lum.start()
    try:
        await wait_for(
            lambda: (
                lum.inventory.loaded.is_set()
                and lum.inventory.inventory.lights[WIZ].profile.driver == "wiz"
            ),
            timeout=10,
        )
        light = lum.inventory.inventory.lights[WIZ]
        with pytest.raises(Exception, match="read-only"):
            await lum.governor.send(light, LightState(True))
        assert not fakes["bulb"].set_pilots()
    finally:
        await lum.stop()


async def test_test_with_fade_and_effect(client, app, fakes):
    r = await client.post(f"/api/lights/{PORCH}/test", json={"transition_ms": 20000})
    assert r.status_code == 409  # longer than 10 s
    r = await client.post(f"/api/lights/{PORCH}/test", json={"effect": "fire"})
    assert r.status_code == 409  # not one of the porch light's effects
    r = await client.post(
        f"/api/lights/{PORCH}/test", json={"transition_ms": 300, "effect": "candle", "hold_s": 0}
    )
    assert r.status_code == 200
    await wait_for(lambda: not app.safety.sessions, timeout=10)
    on, off, _ = (p.json() for p in fakes["z2m"].sets("Front Porch Light "))
    assert on == {"state": "ON", "brightness": 254, "effect": "candle", "transition": 0.3}
    assert off == {"state": "OFF", "transition": 0.3}
    assert any("via z2m, 300 ms fade, effect candle" in a["message"] for a in app.safety.activity)
