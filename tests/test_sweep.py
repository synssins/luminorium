"""Sweeps: colour travelling across the house by where each light is on the house map; WLED LEDs
streamed one by one; a new play replacing the one before on the same lights."""

from __future__ import annotations

import pytest

from luminorium.drivers.wled import WLEDDevice, WLEDDriver
from luminorium.engine.color import Color, parse_color
from luminorium.engine.layers import LayerContext, LayerError, Span, build_layer
from luminorium.house import OUTSIDE

from .test_engine import _idle

RED, BLUE = parse_color("red"), parse_color("blue")
PORCH = "light.front_porch_light"
CLOSET = "light.master_closet_light"


def sweep(positions: dict, **spec):
    ctx = LayerContext(None, {}, "1", lambda el: positions.get(el))
    layer = build_layer({"type": "sweep", "colors": ["red", "blue"], **spec}, ctx, 0)
    layer.bind(100.0)
    for el in positions:
        layer.setup(el, [])
    return layer


def color_of(layer, el, t) -> Color:
    return layer.content(el, t, Span(None, t)).at(t).color


def test_wipe_paints_each_pass_from_one_end_to_the_other():
    at = {
        "a": {"x": 0, "y": 0, "z": 0},
        "b": {"x": 5, "y": 0, "z": 0},
        "c": {"x": 10, "y": 0, "z": 0},
    }
    layer = sweep(at, period_s=10, soft_s=1)
    # Pass 0 paints red from x=0 to x=10 over 10 s: halfway through, a and b are red, c not yet
    assert color_of(layer, "a", 105.5) == RED and color_of(layer, "b", 105.5) == RED
    assert color_of(layer, "c", 105.5) == BLUE  # still the colour of the pass before
    # c fades into red over the second before the front reaches it
    span = layer.content("c", 109.2, None)
    assert span.until == pytest.approx(110) and span.to.color == RED
    # Pass 1 paints blue, starting at a
    assert color_of(layer, "a", 110.5) == BLUE and color_of(layer, "c", 110.5) == RED
    # Reverse starts at the other end
    back = sweep(at, period_s=10, soft_s=1, direction="reverse")
    assert color_of(back, "c", 101) == RED and color_of(back, "a", 101) == BLUE
    # Bounce goes there and back
    bounce = sweep(at, period_s=10, soft_s=1, direction="bounce")
    assert color_of(bounce, "c", 111) == BLUE and color_of(bounce, "a", 111) == RED


def test_band_moves_across():
    at = {"a": {"x": 0, "y": 0, "z": 0}, "c": {"x": 10, "y": 0, "z": 0}}
    layer = sweep(at, mode="band", period_s=10, width=0.2, glow=10, colors=["red"])
    # The band's centre runs from -0.2 to 1.2 of the way across: at 1/7 of the pass it's on a
    t_on_a = 100 + 10 * (0.2 / 1.4)
    assert layer.content("a", t_on_a, None).at(t_on_a).brightness == pytest.approx(1)
    assert layer.content("c", t_on_a, None).at(t_on_a).brightness == pytest.approx(0.1)
    assert layer.content("a", t_on_a, None).busy


def test_bad_sweeps_are_refused():
    for bad in ({"mode": "zigzag"}, {"axis": "w"}, {"direction": "sideways"}, {"colors": []}):
        with pytest.raises(LayerError):
            sweep({}, **bad)


async def test_sweep_plays_only_on_lights_on_the_house_map(lum, fake_ha):
    lum.house.place(PORCH, OUTSIDE, 2, -0.5, None, "wall")
    lum.house.place(CLOSET, "main_level", 9, 4, None, "ceiling")
    spec = {"name": "Sweep", "layers": [{"type": "sweep", "colors": ["purple", "orange"]}]}
    show = await lum.engine.play(
        spec, targets={"lights": [PORCH, CLOSET, "light.kitchen_cabinet_light_switch"]}
    )
    assert show.lights == {PORCH, CLOSET}  # the kitchen light isn't placed
    await lum.engine.stop(show.id)
    await _idle(lum)


async def test_placed_wled_leds_are_streamed_one_by_one(lum, fake_ha):
    rgb = "light.front_pathway_rgb"
    wled = WLEDDriver()
    device = WLEDDevice(
        host="192.0.2.5",
        mac="aabbccddeeff",
        leds=8,
        online=True,
        segments=[
            {"id": 0, "name": "RGB", "start": 1, "stop": 8, "grp": 1, "spc": 1},
            {"id": 1, "name": "White", "start": 0, "stop": 7, "grp": 1, "spc": 1},
        ],
    )
    inv = lum.inventory.inventory
    master = "light.front_pathway_master"
    seg = {master: None, rgb: 0, "light.front_pathway_white": 1}
    wled.device_for = lambda light: (
        (device, seg[light.entity_id]) if light.entity_id in seg else None
    )
    lum.router.drivers["wled"] = wled
    frames = []

    async def streamer(light, frame):
        frames.append((light.entity_id, frame))

    lum.engine.streamer = streamer
    # The pathway: 8 LEDs about 3 ft apart along the front
    lum.house.place(master, OUTSIDE, 0, -3, None, "post")
    lum.house.line(master, {"x": 0, "y": -3, "h": 0.5}, {"x": 6.4, "y": -3, "h": 0.5})
    assert lum._is_carrier(master) and not lum._is_carrier(rgb)
    assert [round(p["x"], 1) for p in lum._pixel_positions(rgb)] == [0.9, 2.7, 4.6, 6.4]

    spec = {
        "name": "Sweep",
        "layers": [
            {"type": "sweep", "colors": ["red"], "fade_in_s": 0, "mode": "band", "period_s": 4}
        ],
    }
    show = await lum.engine.play(spec, targets={"lights": [master, rgb]})
    assert show.streamed == {rgb}
    await __import__("asyncio").sleep(0.4)
    assert frames and all(eid == rgb and len(f) == 4 for eid, f in frames)
    # The streamed light gets frames, not commands; the main light is held on
    assert not fake_ha.calls_for(rgb)
    await lum.engine.stop(show.id)
    await _idle(lum)
    inv.lights.get(master)  # still there


async def test_a_new_palette_replaces_the_one_before(lum, fake_ha):
    first = await lum.engine.play(
        {"layers": [{"type": "palette", "palette": "forest"}]}, targets={"areas": ["porch"]}
    )
    second = await lum.engine.play(
        {"layers": [{"type": "palette", "palette": "fire"}]}, targets={"areas": ["porch"]}
    )
    assert [s["id"] for s in lum.engine.running()] == [second.id]
    assert first.id not in lum.engine.shows
    # A dip plays on top instead
    dip = await lum.engine.play(
        {"layers": [{"type": "dip", "level": 30, "duration_s": 5}]}, targets={"areas": ["porch"]}
    )
    assert {s["id"] for s in lum.engine.running()} == {second.id, dip.id}
    await lum.engine.stop_shows()
    await _idle(lum)
