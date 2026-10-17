"""The house map: floors, placing lights in 3D, segmented lights' parts, identify."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from luminorium.drivers.wled import WLEDDevice, WLEDDriver
from luminorium.house import OUTSIDE, HouseError
from luminorium.web.server import create_app

from .conftest import wait_for

PORCH = "light.front_porch_light"
STRING = "light.led_bulb_string_lights"  # Govee, 30 segments


def test_default_floors_stack_from_the_main_level(lum):
    floors = {f["name"]: f for f in lum.house.view()["floors"]}
    assert floors["Main Level"]["elevation"] == 0
    assert floors["Bedroom Level"]["elevation"] == pytest.approx(2.7)
    assert floors["Ground Level"]["elevation"] == pytest.approx(-2.7)
    assert all(f["ceiling"] == 2.4 for f in floors.values())


def test_split_levels_and_heights(lum):
    house = lum.house
    house.settings(
        {"width": 16, "depth": 9},
        {"ground_level": {"elevation": -1.3, "ceiling": 2.4, "x0": 0, "x1": 8}},
    )
    assert house.view()["size"] == {"width": 16, "depth": 9}
    # A ceiling light on the half-sunk Ground Level: 2.35 m above its floor, 1.05 m above ground
    office = "light.office_wall_wash"
    item = house.place(office, "ground_level", 3, 7, None, "ceiling")
    assert item["h"] == pytest.approx(2.35)
    assert house.world(office) == {"x": 3, "y": 7, "z": pytest.approx(1.05)}
    # Outside, heights are above the ground
    house.place(PORCH, OUTSIDE, 9, -0.6, None, "wall")
    assert house.world(PORCH)["z"] == pytest.approx(1.8)
    # Saved to the config folder
    saved = house.store.load("house")
    assert saved["items"][office]["mount"] == "ceiling"
    assert saved["floors"]["ground_level"]["x1"] == 8


def test_validation(lum):
    house = lum.house
    with pytest.raises(HouseError):
        house.place(PORCH, "the_moon", 0, 0, 1, None)
    with pytest.raises(HouseError):
        house.place(PORCH, OUTSIDE, "abc", 0, 1, None)
    with pytest.raises(HouseError):
        house.place(PORCH, OUTSIDE, 0, 0, 1, "chandelier-ish")
    with pytest.raises(HouseError):
        house.settings({"width": 0, "depth": 5}, None)
    with pytest.raises(KeyError):
        house.place("light.nope", OUTSIDE, 0, 0, 1, None)


def test_fixture_is_one_target_and_its_lights_are_not(lum):
    fid = lum.inventory.create_fixture(
        "Office fan", ["light.office_fan_rgb1", "light.office_fan_rgb2"]
    )
    ids = {t["id"] for t in lum.house.targets()}
    assert fid in ids and "light.office_fan_rgb1" not in ids


def test_govee_segments_are_parts_and_spread_along_a_line(lum):
    house = lum.house
    target = next(t for t in house.targets() if t["id"] == STRING)
    assert len(target["parts"]) == 30
    assert target["parts"][0]["entity_id"].startswith(f"{STRING}_segment_")
    with pytest.raises(HouseError):
        house.place_part(STRING, 0, 1, 1, None)  # the light itself first
    n = house.line(STRING, {"x": 0, "y": 12, "h": 2.2}, {"x": 29, "y": 12, "h": 2.2})
    assert n == 30
    assert house.part_world(STRING, 0) == {"x": 0, "y": 12, "z": pytest.approx(2.2)}
    assert house.part_world(STRING, 29)["x"] == pytest.approx(29)
    assert house.part_world(STRING, 10)["x"] == pytest.approx(10)
    assert house.world(STRING)["x"] == pytest.approx(14.5)  # the middle of its parts


def test_wled_leds_are_parts_and_segment_lights_fold_in(lum):
    wled = WLEDDriver()
    device = WLEDDevice(
        host="192.0.2.5",
        mac="aabbccddeeff",
        leds=8,
        online=True,
        segments=[{"id": 0, "start": 0, "stop": 4}, {"id": 1, "start": 4, "stop": 8}],
    )
    inv = lum.inventory.inventory
    master = inv.lights["light.front_pathway_master"]
    rgb = inv.lights["light.front_pathway_rgb"]
    wled.device_for = lambda light: (
        (device, None) if light is master else (device, 0) if light is rgb else None
    )
    lum.router.drivers["wled"] = wled
    parts = lum._parts_for(master)
    assert [p.label for p in parts][:5] == [
        "LED 1 · segment 0",
        "LED 2 · segment 0",
        "LED 3 · segment 0",
        "LED 4 · segment 0",
        "LED 5 · segment 1",
    ]
    ids = {t["id"] for t in lum.house.targets()}
    assert "light.front_pathway_master" in ids
    assert "light.front_pathway_rgb" not in ids and "light.front_pathway_white" not in ids


async def test_flash_pixel_lights_one_led(lum):
    sent = []
    wled = WLEDDriver()
    device = WLEDDevice(
        host="192.0.2.5",
        mac="aabbccddeeff",
        leds=8,
        online=True,
        segments=[{"id": 0, "start": 0, "stop": 8}],
    )
    wled.device_for = lambda light: (device, None)

    async def stream(light, pixels):
        sent.append(list(pixels))

    wled.stream = stream
    lum.router.drivers["wled"] = wled
    await lum.flash_pixel(
        lum.inventory.inventory.lights["light.front_pathway_master"], 2, seconds=0.4
    )
    assert sent and all(p[2] == (255, 255, 255) and sum(map(sum, p)) == 765 for p in sent)
    with pytest.raises(ValueError):
        await lum.flash_pixel(lum.inventory.inventory.lights["light.front_pathway_master"], 8)


@pytest.fixture
async def client(lum):
    app = create_app(lum, manage_lifecycle=False)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def test_house_api(client, lum):
    view = (await client.get("/api/house")).json()
    assert view["outside"] == OUTSIDE and {m["id"] for m in view["mounts"]} >= {
        "ceiling",
        "wall",
        "table",
        "post",
    }
    r = await client.put(
        f"/api/house/items/{PORCH}", json={"floor": OUTSIDE, "x": 9, "y": -0.5, "mount": "wall"}
    )
    assert r.status_code == 200 and r.json()["h"] == 1.8
    assert (
        await client.put(f"/api/house/items/{PORCH}", json={"floor": "nowhere", "x": 1, "y": 1})
    ).status_code == 400
    assert (
        await client.put("/api/house/items/light.nope", json={"floor": OUTSIDE})
    ).status_code == 404
    r = await client.post(
        f"/api/house/items/{STRING}/line",
        json={"start": {"x": 0, "y": 11, "h": 2}, "end": {"x": 6, "y": 11, "h": 2}},
    )
    assert r.json() == {"placed": 30}
    assert (await client.delete(f"/api/house/items/{STRING}/parts/3")).status_code == 200
    assert (await client.delete(f"/api/house/items/{PORCH}")).status_code == 200
    assert (await client.delete(f"/api/house/items/{PORCH}")).status_code == 404
    r = await client.put("/api/house/settings", json={"floors": {"main_level": {"ceiling": 2.7}}})
    assert next(f for f in r.json()["floors"] if f["id"] == "main_level")["ceiling"] == 2.7


async def test_identify_light_and_govee_segment(client, lum, fake_ha):
    assert (await client.post("/api/house/identify", json={"target": PORCH})).status_code == 200
    await wait_for(lambda: not lum.safety.sessions, timeout=10)
    calls = fake_ha.calls_for(PORCH)
    assert [c.service for c in calls] == ["turn_on", "turn_off"]  # flash, then back off
    assert calls[0].data.get("brightness") == 255
    assert fake_ha.states[PORCH]["state"] == "off"  # back as it was
    seg = f"{STRING}_segment_005"
    r = await client.post("/api/house/identify", json={"target": STRING, "part": 4})
    assert r.json() == {"flashing": STRING, "part": 4}
    await wait_for(lambda: not lum.safety.sessions, timeout=10)
    seg_calls = fake_ha.calls_for(seg)
    assert seg_calls[0].service == "turn_on" and seg_calls[0].data.get("rgb_color") == [
        255,
        255,
        255,
    ]
    assert (
        await client.post("/api/house/identify", json={"target": STRING, "part": 99})
    ).status_code == 404
    assert any("Flashing" in a["message"] for a in lum.safety.activity)
    await asyncio.sleep(0)


async def test_identify_refused_when_read_only(fake_ha, tmp_path):
    from luminorium.app import Luminorium

    from .conftest import make_settings

    app = Luminorium(make_settings(fake_ha.url, tmp_path, read_only=True))
    await app.start()
    await app.inventory.loaded.wait()
    web = create_app(app, manage_lifecycle=False)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=web), base_url="http://test"
    ) as c:
        assert (await c.post("/api/house/identify", json={"target": PORCH})).status_code == 409
    assert not fake_ha.calls
    await app.stop()
