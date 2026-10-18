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


async def test_floor_thickness_basements_and_roofs(client, lum):
    await client.put("/api/house/photo?w=800&h=600", content=JPEG)
    door = {"pts": [[400, 300], [436, 300], [436, 380], [400, 380]], "w": 0.9144, "h": 2.032}
    body = {
        "door": door,
        "ground": {"z": 0},
        "floor_depth": 0.3,
        "blocks": [
            # the lower level, its ceiling at 2.4 m; the basement under the main side, 2.1 m in
            {"id": "g", "name": "Ground", "x0": 0, "x1": 6, "z0": 0, "z1": 2.4},
            {
                "id": "b",
                "name": "Basement",
                "x0": 6,
                "x1": 12,
                "z0": 0,
                "z1": 1.0,
                "below": 2.1,
                "floor": "basement",
            },
        ],
        "roofs": [
            {
                "id": "r",
                "name": "Main",
                "pts": [[6, 3.5], [12, 3.5], [12, 5], [6, 5]],
                "back": "ridge",
                "ridge_y": 3,
            },
            {
                "id": "p",
                "name": "Porch",
                "pts": [[5, 2.4], [7, 2.4], [6, 3]],
                "back": "extrude",
                "depth": 1.5,
                "y0": -1.5,
            },
        ],
        "lines": [
            # drawn where the siding changes: the ceiling of the level below
            {"id": "u", "floor": "bedroom_level", "x0": 0, "x1": 6, "z": 2.4, "at": "below"},
            {"id": "g", "floor": "ground_level", "x0": 0, "x1": 6, "z": 0},
        ],
    }
    view = (await client.put("/api/house/facade", json=body)).json()
    floors = {f["id"]: f for f in view["floors"]}
    assert floors["bedroom_level"]["elevation"] == pytest.approx(2.7)  # 2.4 + the floor's 0.3
    assert floors["ground_level"]["ceiling"] == pytest.approx(2.4)  # up to the floor's underside
    assert floors["basement"]["elevation"] == pytest.approx(-2.1)  # the block's bottom
    m = view["massing"]
    assert m["blocks"][1]["z0"] == pytest.approx(-2.1) and m["blocks"][1]["below"] == 2.1
    main, porch = m["roofs"]
    assert main["ridge_y"] == 3 and main["depth"] == view["size"]["depth"]
    assert porch["y0"] == -1.5 and porch["depth"] == 1.5
    bad = {**body, "blocks": [{**body["blocks"][1], "floor": "attic"}]}
    assert (await client.put("/api/house/facade", json=bad)).status_code == 400


def test_unset_floors_fit_the_set_ones(lum):
    # Chris's house as drawn on the photo: Main +1.12 m, Bedroom +2.82 m (half a storey apart)
    lum.house.settings(
        None, {"main_level": {"elevation": 1.12}, "bedroom_level": {"elevation": 2.82}}
    )
    floors = {f["id"]: f["elevation"] for f in lum.house.view()["floors"]}
    assert floors["ground_level"] == pytest.approx(-0.58)
    assert floors["basement"] == pytest.approx(-2.28)
    # With one set, the others are a storey apart from it
    lum.house.data["floors"] = {}
    lum.house.settings(None, {"ground_level": {"elevation": 0}})
    floors = {f["id"]: f["elevation"] for f in lum.house.view()["floors"]}
    assert floors["main_level"] == pytest.approx(2.7) and floors["basement"] == pytest.approx(-2.7)


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
    # The levels without a line follow the step between the drawn ones (2.4 m here), instead of
    # staying where the first guess (Main at 0) put them
    assert floors["ground_level"]["elevation"] == pytest.approx(-1.8)
    assert floors["basement"]["elevation"] == pytest.approx(-4.2)
    m = view["massing"]
    a, b = m["blocks"]
    assert (a["x0"], a["x1"], a["z0"], a["z1"]) == (0, 7, 0, 5.6)
    # A page from before roofs were their own shapes: each block's roof becomes an outline
    gable, ridge = m["roofs"]
    assert gable["pts"] == [[0, 5.6], [3.5, 8.1], [7, 5.6]] and gable["back"] == "extrude"
    assert ridge["back"] == "ridge" and ridge["depth"] == 8 and ridge["ridge_y"] == 4
    assert "roof" not in lum.house.store.load("house")["facade"]["blocks"][0]
    assert b["depth"] == 8 and a["depth"] == view["size"]["depth"]
    # Main's ceiling is the underside of the Bedroom floor drawn above it: 12" of floor less
    assert floors["main_level"]["ceiling"] == pytest.approx(3.0 - 0.3048 - 0.6, abs=0.001)
    assert m["openings"][0] == {
        "id": "w",
        "kind": "window",
        "x0": 9,
        "x1": 10.2,
        "z0": 1.0,
        "z1": 2.2,
        "y": 0.0,
    }
    # A window sits on the front wall of the block it's in: pushed back, it goes with it
    inside = next(
        bl for bl in body["blocks"] if bl["x0"] <= 5.6 <= bl["x1"] and bl["z0"] <= 1.0 <= bl["z1"]
    )
    inside["y0"] = 1.2
    view = (await client.put("/api/house/facade", json=body)).json()
    assert view["massing"]["openings"][0]["y"] == 1.2
    inside.pop("y0")
    # Kept in house.json
    assert lum.house.store.load("house")["facade"]["blocks"][0]["name"] == "Two storey"

    # Bad drawings are refused
    for broken in (
        {**body, "door": {**door, "pts": door["pts"][:3]}},
        {**body, "roofs": [{"pts": [[0, 5], [1, 6], [2, 5]], "back": "dome"}]},
        {**body, "roofs": [{"pts": [[0, 5], [1, 6]], "back": "ridge"}]},
        {**body, "lines": [{"floor": "main_level", "x0": 0, "x1": 1, "z": 1, "at": "wall"}]},
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


async def test_recess_ground_line_roof_edges_and_spaces(client, lum):
    await client.put("/api/house/photo?w=800&h=600", content=JPEG)
    door = {
        "pts": [[400, 300], [436, 300], [436, 380], [400, 380]],
        "w": 0.9144,
        "h": 2.032,
        "recess": 0.9,
    }
    body = {
        "door": door,
        "eave": 0.6,
        # traced in the photo; the page works out where each point is on the ground
        "ground": {
            "z": -0.6,
            "pts": [[100, 500], [300, 502], [700, 505]],
            "footprint": [[-4, 0], [1, 1.2], [10, 0]],
        },
        "edges": [
            {"id": "a", "pts": [[-4.5, 5.2], [3.4, 5.2]]},
            {"id": "b", "pts": [[2.8, 3.0], [10.5, 3.0]]},  # overlaps the first by 0.6 m
        ],
        "blocks": [
            {"id": "m", "name": "Main", "x0": -4, "x1": 10, "z0": -0.6, "z1": 2.8},
            {
                "id": "e",
                "name": "Entry",
                "x0": 1,
                "x1": 3,
                "z0": -0.6,
                "z1": 2.4,
                "face": "back",
                "y0": 0.9,
                "level": "main_level",
                "offset": -0.6,
            },
        ],
    }
    view = (await client.put("/api/house/facade", json=body)).json()
    m = view["massing"]
    assert view["facade"]["door"]["recess"] == 0.9
    assert m["roofline"] == pytest.approx(15.0)  # -4.5 to 10.5, the overlap counted once
    assert m["footprint"] == [[0, 0], [5, 1.2], [14, 0]]
    entry = m["blocks"][1]
    assert entry["y0"] == 0.9 and entry["level"] == "main_level" and entry["offset"] == -0.6
    for broken in (
        {**body, "door": {**door, "recess": 9}},
        {**body, "eave": 3},
        {**body, "edges": [{"pts": [[0, 1]]}]},
        {**body, "blocks": [{**body["blocks"][1], "face": "sideways"}]},
        {**body, "blocks": [{**body["blocks"][1], "level": "attic"}]},
        {**body, "ground": {**body["ground"], "footprint": [[0, 0]]}},
    ):
        assert (await client.put("/api/house/facade", json=broken)).status_code == 400
    # A light under the eaves
    assert any(mt["id"] == "soffit" for mt in view["mounts"])


async def test_top_view_walls_yard_and_plans(client, lum):
    r = await client.put("/api/house/photo?which=top&w=1600&h=1200", content=JPEG)
    assert r.json()["photo"] == {"w": 1600, "h": 1200}
    assert (await client.get("/api/house/photo?which=top")).content == JPEG
    body = {
        "xf": {"s": 0.05, "theta": 0.35, "tx": -20, "ty": 30},
        "square": {"a": [500, 800], "b": [782, 903], "runs": "across"},
        "ref": {"pts": [[500, 800], [782, 903]]},
        "check": {"pts": [[782, 903], [853, 707]], "length": 10.4},
        # the roof: 15 m across, 10.4 m deep, its front edge 24" out from the wall
        "outline": [[0, -0.6096], [15, -0.6096], [15, 9.7904], [0, 9.7904]],
        "ext_wall": "2x6",
        "yard": [
            {"id": "d", "kind": "driveway", "pts": [[9, -1], [14, -1], [14, -9]]},
            {"id": "t", "kind": "tree", "c": [-4, -5], "r": 2.5, "h": 7},
            {"id": "p", "kind": "path", "pts": [[4, -0.3], [4, -9]], "smooth": True, "width": 1},
        ],
        "walls": [
            {
                "id": "w",
                "level": "main_level",
                "a": [5, 0.5],
                "b": [5, 8],
                "studs": "2x8",
                "finish": "plaster",
            }
        ],
        "doors": [{"id": "dr", "wall": "w", "at": 3, "width": 0.8128}],
        "rooms": [
            {"id": "r", "level": "main_level", "at": [2.5, 4], "area": "kitchen", "name": "Kitchen"}
        ],
    }
    view = (await client.put("/api/house/site", json=body)).json()
    top = view["top"]
    # the walls are the eaves' depth (24") inside the roof outline
    assert top["plan"][0] == pytest.approx([0.6096, 0], abs=1e-3)
    assert top["plan"][2] == pytest.approx([14.3904, 9.1808], abs=1e-3)
    assert view["size"]["depth"] == pytest.approx(9.181, abs=1e-3)
    assert top["walls"][0]["thick"] == pytest.approx(0.1842 + 2 * 0.01905, abs=1e-4)
    assert top["ext_thick"] == pytest.approx(0.1397 + 0.0127 + 0.0111 + 0.019, abs=1e-4)
    assert [y["kind"] for y in top["yard"]] == ["driveway", "tree", "path"]
    # two shapes merged into one: the second is a part of the first
    merged = {"kind": "patio", "pts": [[0, 0], [3, 0], [3, 3], [0, 3]]}
    merged["parts"] = [[[3, 0], [6, 0], [6, 1], [3, 1]]]
    view = (await client.put("/api/house/site", json={**body, "yard": [merged]})).json()
    assert view["top"]["yard"][0]["parts"] == [[[3, 0], [6, 0], [6, 1], [3, 1]]]
    for broken in (
        {**body, "yard": [{"kind": "volcano", "pts": [[0, 0], [1, 0], [1, 1]]}]},
        {**body, "yard": [{**merged, "parts": [[[0, 0], [1, 1]]]}]},  # an area part needs 3
        {**body, "walls": [{**body["walls"][0], "level": "attic"}]},
        {**body, "walls": [{**body["walls"][0], "studs": "2x12"}]},
        {**body, "doors": [{"wall": "nowhere", "at": 1}]},
        {**body, "rooms": [{**body["rooms"][0], "area": "mars"}]},
        {**body, "square": {**body["square"], "runs": "diagonal"}},
    ):
        assert (await client.put("/api/house/site", json=broken)).status_code == 400
    # A new top photo keeps the drawing but needs placing again
    r = await client.put("/api/house/photo?which=top&w=800&h=600", content=JPEG)
    assert "xf" not in r.json() and r.json()["outline"]
    assert (await client.delete("/api/house/site")).json()["site"] is None


async def test_a_light_as_a_bar_or_strip(client, lum):
    url = f"/api/house/items/{PORCH}/form"
    assert (await client.put(url, json={"form": "bar"})).status_code == 400  # not placed yet
    await client.put(f"/api/house/items/{PORCH}", json={"floor": OUTSIDE, "x": 3, "y": -2})
    body = {"form": "bar", "length": 1.2, "rot": 450, "face": "up"}
    view = (await client.put(url, json=body)).json()
    item = next(t for t in view["targets"] if t["id"] == PORCH)["item"]
    assert item["form"] == {"form": "bar", "length": 1.2, "rot": 90, "face": "up"}
    for bad in ({"form": "blob"}, {"form": "strip", "length": 99}, {"form": "bar", "face": "in"}):
        assert (await client.put(url, json=bad)).status_code == 400
    await client.put(url, json=None)
    assert "form" not in lum.house.data["items"][PORCH]


async def test_aiming_a_light(client, lum):
    r = await client.put(f"/api/house/items/{PORCH}/aim", json={"kind": "flood"})
    assert r.status_code == 400  # not placed yet
    await client.put(f"/api/house/items/{PORCH}", json={"floor": OUTSIDE, "x": 3, "y": -2})
    r = await client.put(
        f"/api/house/items/{PORCH}/aim", json={"kind": "spot", "tilt": 80, "heading": -45}
    )
    assert r.json()["aim"] == {"kind": "spot", "beam": 25, "tilt": 80, "heading": 315}
    # Moving it keeps where it points
    await client.put(f"/api/house/items/{PORCH}", json={"floor": OUTSIDE, "x": 4, "y": -2})
    assert lum.house.data["items"][PORCH]["aim"]["kind"] == "spot"
    for bad in ({"kind": "laser"}, {"kind": "flood", "beam": 300}, {"kind": "flood", "tilt": 120}):
        assert (await client.put(f"/api/house/items/{PORCH}/aim", json=bad)).status_code == 400
    r = await client.put(f"/api/house/items/{PORCH}/aim", json=None)
    assert "aim" not in r.json()


async def test_checks_point_out_numbers_that_disagree(client, lum):
    assert (await client.get("/api/house")).json()["checks"] == []
    await client.put("/api/house/photo?w=800&h=600", content=JPEG)
    texts = lambda v: [c["text"] for c in v["checks"]]  # noqa: E731
    assert any("Mark the front door" in t for t in texts((await client.get("/api/house")).json()))
    door = {"pts": [[400, 300], [436, 300], [436, 380], [400, 380]], "w": 0.9144, "h": 2.032}
    body = {
        "door": door,
        "edges": [{"id": "e", "pts": [[-2, 5], [13, 5]]}],  # 15 m across from the front
        "blocks": [{"id": "b", "x0": -1.4, "x1": 12.4, "z0": 0, "z1": 5}],
        "lines": [{"id": "l", "floor": "main_level", "x0": -1.4, "x1": 12.4, "z": 0.6}],
    }
    view = (await client.put("/api/house/facade", json=body)).json()
    assert any(c["text"].startswith("No ground line") for c in view["checks"])
    assert any("Guessed from the others" in t for t in texts(view))
    await client.put("/api/house/photo?which=top&w=1600&h=1200", content=JPEG)
    site = {
        "xf": {"s": 0.05, "theta": 0, "tx": 0, "ty": 0},
        # 16 m across from above: 7% more than the front photo's 15 m
        "outline": [[0, -0.6], [16, -0.6], [16, 9.8], [0, 9.8]],
        # front to back: 300 px = 15 m measured, against 10.4 m given
        "check": {"pts": [[100, 0], [100, -300]], "length": 10.4},
    }
    view = (await client.put("/api/house/site", json=site)).json()
    warns = [c["text"] for c in view["checks"] if c["level"] == "warn"]
    assert any("from above but" in t and "front photo" in t for t in warns)
    assert any(t.startswith("Front to back") for t in warns)
    # An inside light outside the walls
    await client.put(
        "/api/house/items/light.master_closet_light",
        json={"floor": "main_level", "x": 30, "y": 4},
    )
    view = (await client.get("/api/house")).json()
    assert any("outside the walls" in c["text"] for c in view["checks"])


async def test_aiming_at_a_spot_and_keeping_it(client, lum):
    # a flood on the porch post, 1.5 m up, aimed at a wall 4 m behind it and 2.5 m up
    await client.put(
        f"/api/house/items/{PORCH}",
        json={"floor": OUTSIDE, "x": 5, "y": -4, "h": 1.5, "mount": "post"},
    )
    r = await client.put(
        f"/api/house/items/{PORCH}/aim",
        json={"kind": "flood", "at": {"x": 5, "y": 0, "z": 2.5}, "what": "the Main wall"},
    )
    aim = r.json()["aim"]
    assert aim["heading"] == 180  # straight back, toward the house
    assert aim["tilt"] == pytest.approx(14.0, abs=0.1)  # atan(1 / 4)
    assert aim["what"] == "the Main wall" and aim["beam"] == 90
    # moved 4 m to the right: it still points at the same spot, now back and to the left
    await client.put(f"/api/house/items/{PORCH}", json={"floor": OUTSIDE, "x": 9, "y": -4})
    aim = lum.house.data["items"][PORCH]["aim"]
    assert aim["heading"] == pytest.approx(135, abs=0.1)
    # an uplight on a tree: straight up when it's right underneath
    r = await client.put(
        f"/api/house/items/{PORCH}/aim", json={"kind": "spot", "at": {"x": 9, "y": -4, "z": 6}}
    )
    assert r.json()["aim"]["tilt"] == 90
    # turned by hand: no longer tied to a spot
    r = await client.put(
        f"/api/house/items/{PORCH}/aim", json={"kind": "spot", "tilt": 30, "heading": 90}
    )
    assert "at" not in r.json()["aim"]
    bad = {"kind": "flood", "at": lum.house.world(PORCH)}  # where the light is
    assert (await client.put(f"/api/house/items/{PORCH}/aim", json=bad)).status_code == 400


async def test_a_group_of_lights_can_be_several_fixtures(client, lum):
    members = ["light.office_fan_rgb1", "light.office_fan_rgb2"]
    r = await client.post("/api/fixtures", json={"name": "Cabinets", "members": members})
    gid = r.json()["id"]
    await client.put(f"/api/house/items/{gid}", json={"floor": "main_level", "x": 4, "y": 3})

    async def group():
        targets = (await client.get("/api/house")).json()["targets"]
        return next(t for t in targets if t["id"] == gid)

    # placed, it's one fixture per light by itself, in a row from where it was put
    t = await group()
    assert t["kind"] == "fixture" and t["fixtures"] == 2
    assert [p["label"] for p in t["parts"]] == ["Fixture 1", "Fixture 2"]
    assert all(p["placed"] for p in t["parts"])
    # made one fixture, it stays one
    await client.put(f"/api/house/items/{gid}/fixtures", json={"count": 0})
    assert (await group())["fixtures"] == 0
    r = await client.put(f"/api/house/items/{gid}/fixtures", json={"count": 3})
    assert r.status_code == 200 and (await group())["fixtures"] == 3


async def test_one_switch_several_fixtures(client, lum):
    kitchen = "light.kitchen_cabinet_light_switch"
    r = await client.put(f"/api/house/items/{kitchen}/fixtures", json={"count": 3})
    assert r.status_code == 400  # place it first
    await client.put(f"/api/house/items/{kitchen}", json={"floor": "main_level", "x": 4, "y": 3})
    r = await client.put(f"/api/house/items/{kitchen}/fixtures", json={"count": 3})
    assert r.json()["fixtures"] == 3
    t = next(t for t in (await client.get("/api/house")).json()["targets"] if t["id"] == kitchen)
    assert t["fixtures"] == 3
    assert [p["label"] for p in t["parts"]] == ["Fixture 1", "Fixture 2", "Fixture 3"]
    assert all(p["placed"] for p in t["parts"])  # a row of three, 4 ft apart
    assert [round(p["world"]["x"], 2) for p in t["parts"]] == [4, 5.22, 6.44]
    # placing one moves the light to the middle of them
    await client.put(f"/api/house/items/{kitchen}/parts/2", json={"x": 10, "y": 3})
    assert lum.house.data["items"][kitchen]["x"] == pytest.approx((4 + 5.219 + 10) / 3, abs=0.01)
    # fewer: the extra one goes; none: one fixture again
    r = await client.put(f"/api/house/items/{kitchen}/fixtures", json={"count": 2})
    assert sorted(r.json()["parts"]) == ["0", "1"]
    r = await client.put(f"/api/house/items/{kitchen}/fixtures", json={"count": 0})
    assert "parts" not in r.json() and "fixtures" not in r.json()
    assert (
        await client.put(f"/api/house/items/{kitchen}/fixtures", json={"count": 1})
    ).status_code == 400
    # a Govee strip's parts are its own segments
    await client.put(f"/api/house/items/{STRING}", json={"floor": OUTSIDE, "x": 1, "y": 1})
    assert (
        await client.put(f"/api/house/items/{STRING}/fixtures", json={"count": 2})
    ).status_code == 400


async def test_blocks_moved_and_split_from_3d(client, lum):
    await client.put("/api/house/photo?w=800&h=600", content=JPEG)
    door = {"pts": [[400, 300], [436, 300], [436, 380], [400, 380]], "w": 0.9144, "h": 2.032}
    body = {
        "door": door,
        "ground": {"z": 0},
        "blocks": [
            {"id": "a", "name": "Bedrooms", "x0": -2, "x1": 6, "z0": 0, "z1": 5},
            {"id": "e", "name": "Entry", "x0": 6, "x1": 9, "z0": 0, "z1": 3, "y0": 0.9},
        ],
    }
    await client.put("/api/house/facade", json=body)
    view = (await client.get("/api/house")).json()
    entry = next(b for b in view["massing"]["blocks"] if b["id"] == "e")
    assert (entry["x0"], entry["x1"]) == (
        8,
        11,
    )  # house x: from the left edge, 2 m left of the door
    # drag the entry's back in to 3 m deep, and its right side out 0.5 m
    view = (await client.put("/api/house/blocks/e", json={"depth": 3, "x1": 11.5})).json()
    entry = next(b for b in view["massing"]["blocks"] if b["id"] == "e")
    assert (entry["depth"], entry["x1"]) == (3, 11.5)
    # moving the leftmost block's left face doesn't shift the house
    view = (await client.put("/api/house/blocks/a", json={"x0": -1})).json()
    assert next(b for b in view["massing"]["blocks"] if b["id"] == "e")["x0"] == 8
    # split the entry: 1.5 m in front; the back part is lower and on its own level
    view = (await client.post("/api/house/blocks/e/split", json={"front_depth": 1.5})).json()
    front, back = [b for b in view["massing"]["blocks"] if b["id"].startswith("e")]
    assert front["depth"] == 1.5 and back["depth"] == 1.5
    assert back["y0"] == pytest.approx(2.4) and back["behind"] is True
    view = (
        await client.put(
            f"/api/house/blocks/{back['id']}",
            json={"z1": 2.2, "level": "main_level", "offset": -0.6},
        )
    ).json()
    back = next(b for b in view["massing"]["blocks"] if b["id"] == back["id"])
    assert back["z1"] == 2.2 and back["level"] == "main_level" and back["offset"] == -0.6
    # its front can be moved (it isn't on the photo); a photo block's front can't
    assert (await client.put(f"/api/house/blocks/{back['id']}", json={"y0": 2})).status_code == 200
    # a photo block's front too: it's then set back (or sticks out)
    view = (await client.put("/api/house/blocks/e", json={"y0": 1.2, "depth": 1.2})).json()
    assert lum.house.data["facade"]["blocks"][1]["face"] == "back"
    for bad in ({"depth": 0.1}, {"x1": 6.1}, {"level": "attic"}):
        assert (await client.put("/api/house/blocks/e", json=bad)).status_code == 400
    assert (
        await client.post("/api/house/blocks/e/split", json={"front_depth": 1.4})
    ).status_code == 400
    assert (await client.put("/api/house/blocks/nope", json={"depth": 2})).status_code == 404


async def test_stairs_and_angled_walls_on_the_plan(client, lum):
    await client.put("/api/house/photo?which=top&w=1600&h=1200", content=JPEG)
    site = {
        "xf": {"s": 0.05, "theta": 0, "tx": 0, "ty": 0},
        "outline": [[0, -0.6], [15, -0.6], [15, 9.8], [0, 9.8]],
        "walls": [
            {"id": "w1", "level": "main_level", "a": [5, 0.5], "b": [5, 8]},
            {"id": "w2", "level": "main_level", "a": [5, 8], "b": [8, 6], "angled": True},
        ],
        "stairs": [
            {
                "id": "s",
                "level": "main_level",
                "to": "bedroom_level",
                "dir": "y+",
                "x0": 6,
                "x1": 7,
                "y0": 1,
                "y1": 4,
            }
        ],
    }
    view = (await client.put("/api/house/site", json=site)).json()
    assert view["site"]["walls"][1]["angled"] is True and "angled" not in view["site"]["walls"][0]
    assert view["top"]["stairs"][0]["to"] == "bedroom_level"
    assert "steps" not in view["site"]["stairs"][0]  # not typed: they follow the levels
    # typed steps and step height are kept
    typed = {**site, "stairs": [{**site["stairs"][0], "steps": 12, "riser": 0.19}]}
    st = (await client.put("/api/house/site", json=typed)).json()["site"]["stairs"][0]
    assert (st["steps"], st["riser"]) == (12, 0.19)
    # between two blocks' floors (a landing a few steps down): their heights and the blocks
    landing = {**site["stairs"][0], "z0": 0.6, "z1": -0.15, "from_block": "a", "to_block": "b"}
    st = (await client.put("/api/house/site", json={**site, "stairs": [landing]})).json()
    st = st["top"]["stairs"][0]
    assert (st["z0"], st["z1"], st["from_block"], st["to_block"]) == (0.6, -0.15, "a", "b")
    for bad in (
        {**site, "stairs": [{**site["stairs"][0], "steps": 0}]},
        {**site, "stairs": [{**site["stairs"][0], "riser": 0.9}]},
        {**site, "stairs": [{**site["stairs"][0], "to": "attic"}]},
        {**site, "stairs": [{**site["stairs"][0], "dir": "z+"}]},
        {**site, "stairs": [{**site["stairs"][0], "x1": 6.1}]},
    ):
        assert (await client.put("/api/house/site", json=bad)).status_code == 400


async def test_blocks_added_and_deleted_in_3d(client, lum):
    assert (await client.post("/api/house/blocks", json={})).status_code == 400  # no front photo
    await client.put("/api/house/photo?w=800&h=600", content=JPEG)
    door = {"pts": [[400, 300], [436, 300], [436, 380], [400, 380]], "w": 0.9144, "h": 2.032}
    await client.put(
        "/api/house/facade",
        json={
            "door": door,
            "ground": {"z": 0},
            "blocks": [{"id": "a", "x0": 0, "x1": 8, "z0": 0, "z1": 5}],
        },
    )
    body = {"x0": 8, "x1": 11, "y0": 0, "depth": 4, "z0": 0, "z1": 2.7, "level": "main_level"}
    view = (await client.post("/api/house/blocks", json=body)).json()
    new = view["massing"]["blocks"][-1]
    assert (new["x0"], new["x1"], new["depth"], new["z1"]) == (8, 11, 4, 2.7)
    assert new["behind"] is True and new["level"] == "main_level"
    # joined to another block, and apart again
    joined = (await client.put(f"/api/house/blocks/{new['id']}", json={"group": "g1"})).json()
    assert joined["massing"]["blocks"][-1]["group"] == "g1"
    apart = (await client.put(f"/api/house/blocks/{new['id']}", json={"group": None})).json()
    assert "group" not in apart["massing"]["blocks"][-1]
    assert view["size"]["width"] == 11  # the house is wider now
    # it moves freely
    view = (
        await client.put(f"/api/house/blocks/{new['id']}", json={"x0": 9, "x1": 12, "y0": 2})
    ).json()
    assert next(b for b in view["massing"]["blocks"] if b["id"] == new["id"])["y0"] == 2
    view = (await client.delete(f"/api/house/blocks/{new['id']}")).json()
    assert [b["id"] for b in view["massing"]["blocks"]] == ["a"]
    assert (await client.post("/api/house/blocks", json={**body, "x1": 8.1})).status_code == 400
