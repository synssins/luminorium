from __future__ import annotations

import httpx
import pytest

from luminorium.app import Luminorium
from luminorium.web.server import create_app

from .conftest import make_settings, wait_for


@pytest.fixture
async def client(lum):
    app = create_app(lum, manage_lifecycle=False)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


async def test_status_and_inventory(client):
    status = (await client.get("/api/status")).json()
    assert status["connected"] and status["loaded"]
    assert status["counts"]["lights"] > 40
    inv = (await client.get("/api/inventory")).json()
    names = {lt["entity_id"] for lt in inv["lights"]}
    assert "light.front_porch_light" in names
    # Govee segments ride on their parent light
    assert "light.led_bulb_string_lights" in names
    assert not any(n.startswith("light.led_bulb_string_lights_segment_") for n in names)
    assert inv["floors"][0]["id"] == "bedroom_level"


async def test_include_switch_and_test_it(client, lum, fake_ha):
    eid = "switch.backyard_light_switch"
    r = await client.put(f"/api/lights/{eid}/include", json={"include": True})
    assert r.status_code == 200 and r.json()["included"]
    assert lum.store.load("choices") == {"include": {eid: True}}
    lum.inventory.inventory.get(eid).profile.max_rate_hz = 50
    lum.tester.hold_s = 0
    assert (await client.post(f"/api/lights/{eid}/test")).status_code == 200
    await wait_for(lambda: not lum.safety.sessions, timeout=10)
    assert len(fake_ha.calls_for(eid)) == 3
    r = await client.put(f"/api/lights/{eid}/include", json={"include": None})
    assert not r.json()["included"]


async def test_test_errors(client):
    r = await client.post("/api/lights/switch.backyard_light_switch/test")
    assert r.status_code == 409
    assert (await client.post("/api/lights/light.nope/test")).status_code == 404


async def test_stop_all_endpoint(client):
    assert (await client.post("/api/stop_all")).json() == {"restored": 0}


async def test_pages_served(client):
    assert "Luminorium" in (await client.get("/")).text
    assert "Camera check" in (await client.get("/camera")).text
    assert (await client.get("/static/app.js")).status_code == 200


async def test_only_ingress_clients_allowed(fake_ha, tmp_path):
    lum = Luminorium(make_settings(fake_ha.url, tmp_path, allowed_clients=("172.30.32.2",)))
    app = create_app(lum, manage_lifecycle=False)
    transport = httpx.ASGITransport(app=app, client=("192.168.1.50", 5000))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        assert (await c.get("/api/status")).status_code == 403
