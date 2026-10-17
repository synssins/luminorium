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


def test_default_floors_never_go_deeper_than_one_storey(lum):
    # This house: 4 levels, 2 under "Main": a split level, half a storey apart
    floors = {f["name"]: f for f in lum.house.view()["floors"]}
    assert floors["Main Level"]["elevation"] == 0
    assert floors["Ground Level"]["elevation"] == pytest.approx(-1.2)
    assert floors["Basement"]["elevation"] == pytest.approx(-2.4)
    assert floors["Bedroom Level"]["elevation"] == pytest.approx(1.2)
    assert all(f["ceiling"] == 2.4 for f in floors.values())


def test_default_floors_plain_house():
    from luminorium.house import default_floors
    from luminorium.inventory.model import Floor, Inventory

    inv = Inventory(
        floors={
            "basement": Floor("basement", "Basement", -1),
            "main": Floor("main", "Main floor", 0),
            "upstairs": Floor("upstairs", "Upstairs", 1),
        }
    )
    f = default_floors(inv)
    assert (f["basement"]["elevation"], f["main"]["elevation"], f["upstairs"]["elevation"]) == (
        -2.4,
        0,
        2.7,
    )


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
        # As the front pathway is set up: white and RGB LEDs alternate, each segment skipping
        # every other LED
        segments=[
            {"id": 0, "name": "RGB", "start": 1, "stop": 8, "grp": 1, "spc": 1},
            {"id": 1, "name": "White", "start": 0, "stop": 7, "grp": 1, "spc": 1},
        ],
    )
    inv = lum.inventory.inventory
    master = inv.lights["light.front_pathway_master"]
    rgb = inv.lights["light.front_pathway_rgb"]
    wled.device_for = lambda light: (
        (device, None) if light is master else (device, 0) if light is rgb else None
    )
    lum.router.drivers["wled"] = wled
    parts = lum._parts_for(master)
    assert [p.label for p in parts] == [
        f"LED {i} · {'White' if i % 2 else 'RGB'}" for i in range(1, 9)
    ]
    # The RGB segment is LEDs 2, 4, 6, 8
    assert wled.leds(rgb) == [1, 3, 5, 7]
    assert [p.label for p in lum._parts_for(rgb)] == ["LED 2", "LED 4", "LED 6", "LED 8"]
    ids = {t["id"] for t in lum.house.targets()}
    assert "light.front_pathway_master" in ids
    assert "light.front_pathway_rgb" not in ids and "light.front_pathway_white" not in ids


def test_segment_leds_follow_grouping_and_spacing():
    from luminorium.drivers.wled import segment_leds

    assert segment_leds({"start": 0, "stop": 7, "grp": 1, "spc": 1}) == [0, 2, 4, 6]
    assert segment_leds({"start": 2, "stop": 12, "grp": 2, "spc": 3}) == [2, 3, 7, 8]
    assert segment_leds({"start": 3, "stop": 6}) == [3, 4, 5]


async def test_stream_to_an_interleaved_segment_leaves_the_others_dark():
    wled = WLEDDriver()
    device = WLEDDevice(
        host="192.0.2.5",
        mac="aabbccddeeff",
        leds=8,
        online=True,
        segments=[{"id": 0, "start": 1, "stop": 8, "grp": 1, "spc": 1}],
    )
    wled.device_for = lambda light: (device, 0)
    sent = []

    class Sock:
        def sendto(self, data, addr):
            sent.append(data)

    wled._ddp = Sock()
    await wled.stream(object(), [(255, 0, 0), (0, 255, 0), (0, 0, 255), (9, 9, 9)])
    (packet,) = sent
    offset = int.from_bytes(packet[4:8], "big")
    pixels = [tuple(packet[10 + i : 13 + i]) for i in range(0, len(packet) - 10, 3)]
    # LEDs 2..8: the segment's LEDs get the colours, the white LEDs between them stay dark
    assert offset == 3
    assert pixels == [
        (255, 0, 0),
        (0, 0, 0),
        (0, 255, 0),
        (0, 0, 0),
        (0, 0, 255),
        (0, 0, 0),
        (9, 9, 9),
    ]


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


JPEG = b"\xff\xd8\xff\xe0" + b"\0" * 64


async def test_front_photo_sets_width_floors_and_massing(client, lum):
    # A drawing needs a photo first
    assert (await client.put("/api/house/facade", json={})).status_code == 400
    bad = await client.put("/api/house/photo?w=800&h=600", content=b"not an image")
    assert bad.status_code == 400
    r = await client.put("/api/house/photo?w=800&h=600", content=JPEG)
    assert r.status_code == 200 and r.json()["photo"] == {"w": 800, "h": 600}
    photo = await client.get("/api/house/photo")
    assert photo.headers["content-type"] == "image/jpeg" and photo.content == JPEG

    # Facade metres from the door's bottom left corner. The sill is 0.6 m above the ground; the
    # house runs from 4 m left of the door to 10 m right of it, in two blocks
    door = {"pts": [[400, 300], [436, 300], [436, 380], [400, 380]], "w": 0.9144, "h": 2.032}
    body = {
        "door": door,
        "ground": {"z": -0.6},
        "blocks": [
            {
                "id": "a",
                "name": "Two storey",
                "x0": -4,
                "x1": 3,
                "z0": -0.6,
                "z1": 5,
                "roof": "gable",
                "peak_z": 7.5,
                "peak_x": -0.5,
            },
            {
                "id": "b",
                "name": "Side",
                "x0": 3,
                "x1": 10,
                "z0": -0.6,
                "z1": 2.8,
                "roof": "ridge",
                "peak_z": 4.6,
                "depth": 8,
            },
        ],
        "openings": [{"id": "w", "kind": "window", "x0": 5, "x1": 6.2, "z0": 0.4, "z1": 1.6}],
        "lines": [
            {"id": "m", "floor": "main_level", "x0": 3, "x1": 10, "z": 0},
            {"id": "u", "floor": "bedroom_level", "x0": -4, "x1": 10, "z": 2.4},
        ],
    }
    view = (await client.put("/api/house/facade", json=body)).json()
    assert view["size"]["width"] == 14
    floors = {f["id"]: f for f in view["floors"]}
    # Main: 0.6 m above the ground, over the right half only (x 7..14 in house metres)
    assert floors["main_level"]["elevation"] == pytest.approx(0.6)
    assert (floors["main_level"]["x0"], floors["main_level"]["x1"]) == (7, 14)
    # The bedroom line runs the whole width, so it covers the whole house
    assert floors["bedroom_level"]["elevation"] == pytest.approx(3.0)
    assert floors["bedroom_level"]["x0"] is None
    m = view["massing"]
    a, b = m["blocks"]
    assert (a["x0"], a["x1"], a["z0"], a["z1"]) == (0, 7, 0, 5.6)
    assert (a["peak_x"], a["peak_z"]) == (3.5, 8.1)
    assert b["depth"] == 8 and a["depth"] == view["size"]["depth"]
    assert m["openings"][0] == {"kind": "window", "x0": 9, "x1": 10.2, "z0": 1.0, "z1": 2.2}
    # Kept in house.json
    assert lum.house.store.load("house")["facade"]["blocks"][0]["name"] == "Two storey"

    # Bad drawings are refused
    for broken in (
        {**body, "door": {**door, "pts": door["pts"][:3]}},
        {**body, "blocks": [{**body["blocks"][0], "roof": "dome"}]},
        {**body, "lines": [{"floor": "attic", "x0": 0, "x1": 1, "z": 1}]},
        {**body, "openings": [{"kind": "window", "x0": 1, "x1": 1, "z0": 0, "z1": 1}]},
    ):
        assert (await client.put("/api/house/facade", json=broken)).status_code == 400

    # A new photo keeps the drawing but needs the door again; starting over removes it all
    r = await client.put("/api/house/photo?w=1000&h=700", content=JPEG)
    assert r.json()["door"] is None and len(r.json()["blocks"]) == 2
    assert (await client.get("/api/house")).json()["massing"] is None
    view = (await client.delete("/api/house/facade")).json()
    assert view["facade"] is None
    assert (await client.get("/api/house/photo")).status_code == 404
