"""The colour pipeline: conversions, OKLab blending, and rendering to each kind of light."""

from __future__ import annotations

import pytest

from luminorium.drivers.base import LightState
from luminorium.engine.color import (
    BLACK,
    Color,
    Look,
    kelvin_to_xy,
    look_from_state,
    parse_color,
    perceptible,
    render,
    xy_to_kelvin,
)
from luminorium.inventory.builder import UserChoices, build

RED = Color.from_hex("#ff0000")
GREEN = Color.from_hex("#00ff00")
BLUE = Color.from_hex("#0000ff")


@pytest.fixture
def inv(raw):
    choices = UserChoices(include={"switch.backyard_light_switch": True})
    return build(
        raw["floors"],
        raw["areas"],
        raw["devices"],
        raw["entities"],
        raw["states"],
        raw["zwave"],
        choices,
    )


def test_xy_of_primaries():
    assert RED.xy == pytest.approx((0.64, 0.33), abs=0.002)
    assert GREEN.xy == pytest.approx((0.30, 0.60), abs=0.002)
    assert Color.from_xy(*RED.xy).hex() == "#ff0000"


def test_kelvin_round_trip():
    for kelvin in (2000, 2700, 4000, 6500):
        assert xy_to_kelvin(*kelvin_to_xy(kelvin)) == pytest.approx(kelvin, rel=0.03)
    warm = Color.from_kelvin(2700)
    assert warm.r == 1.0 and warm.b < 0.6  # warm white is orange-ish
    assert warm.cct() == 2700


def test_parse_color_forms():
    assert parse_color("#f00") == RED
    assert parse_color("red") == RED
    assert parse_color({"rgb": [0, 0, 255]}) == BLUE
    assert parse_color("2700K").kelvin == 2700
    assert parse_color({"kelvin": 3000}).kelvin == 3000
    assert parse_color({"hs": [120, 100]}).hex() == "#00ff00"
    assert parse_color({"xy": [0.64, 0.33]}).hex() == "#ff0000"
    with pytest.raises(ValueError):
        parse_color("not a colour")


def test_oklab_blend_red_to_green_passes_through_yellow():
    mid = RED.mix(GREEN, 0.5)
    hue, sat = mid.hs
    assert 35 < hue < 80 and sat > 80
    assert mid.r > 0.8 and mid.g > 0.8 and mid.b < 0.2
    assert RED.mix(GREEN, 0) == RED and RED.mix(GREEN, 1) == GREEN


def test_whites_blend_along_the_locus():
    mid = Color.from_kelvin(2000).mix(Color.from_kelvin(6500), 0.5)
    assert mid.kelvin is not None and 2900 < mid.kelvin < 3200  # halfway in mireds


def test_look_fades_from_off_keep_colour():
    off = Look(BLACK, 0.0)
    half = off.mix(Look(BLUE, 0.8), 0.5)
    assert half.color == BLUE and half.brightness == pytest.approx(0.4)


def test_render_to_each_kind_of_light(inv):
    look = Look(RED, 0.5)
    hue = inv.get("light.front_porch_light")  # xy + white
    state = render(look, hue)
    assert state.color_mode == "xy" and state.color == pytest.approx([0.64, 0.33], abs=0.002)
    assert state.brightness == 128

    fan = inv.get("light.office_fan_rgb1")  # hs
    assert render(look, fan).color_mode == "hs"
    assert render(look, fan).color == [0.0, 100.0]

    wled = inv.get("light.front_pathway_rgb")  # rgb
    assert render(Look(Color.from_hex("#ff8040"), 1.0), wled).color == [255, 128, 64]

    wiz = inv.get("light.master_bedroom_arc_lamp_1")  # rgbww
    rgbww = render(Look(Color.rgb255(255, 200, 200), 1.0), wiz)
    assert rgbww.color_mode == "rgbww" and len(rgbww.color) == 5
    assert rgbww.color[:3] == [55, 0, 0] and sum(rgbww.color[3:]) == pytest.approx(200, abs=1)

    flood = inv.get("light.master_bedroom_ceiling_flood")  # rgbw
    assert render(Look(Color.rgb255(255, 200, 200), 1.0), flood).color == [55, 0, 0, 200]


def test_whites_use_the_white_channel_where_there_is_one(inv):
    hue = inv.get("light.front_porch_light")
    state = render(Look(Color.from_kelvin(2700), 0.6), hue)
    assert (state.color_mode, state.color) == ("color_temp", 2700)
    # Outside the light's range: the nearest kelvin it has
    assert render(Look(Color.from_kelvin(1500), 0.6), hue).color == 2000


def test_white_only_light_gets_nearest_temperature(inv):
    lamp = inv.get("light.office_desk_monitor_lamp")  # colour temperature 2000-6329 K only
    assert render(Look(Color.from_kelvin(3500), 1.0), lamp).color == 3500
    assert render(Look(RED, 1.0), lamp).color == 2000  # warm
    assert render(Look(BLUE, 1.0), lamp).color == 6329  # cool, clamped to the range
    hinted = render(Look(GREEN, 1.0, white_k=3000), lamp)
    assert hinted.color == 3000  # a palette's own white wins


def test_dimmers_and_relays(inv):
    closet = inv.get("light.master_closet_light")  # brightness only
    assert render(Look(BLUE, 0.4), closet) == LightState(True, 102)
    assert render(Look(BLACK, 1.0), closet) == LightState(False)
    assert render(Look(RED, 0.0), closet) == LightState(False)

    relay = inv.get("switch.backyard_light_switch")
    assert relay.profile.relay
    assert render(Look(RED, 0.8), relay) == LightState(True)
    assert render(Look(RED, 0.1), relay) == LightState(False)  # below the threshold


def test_perceptual_threshold():
    a = LightState(True, 200, "xy", [0.30, 0.30])
    assert not perceptible(a, LightState(True, 201, "xy", [0.30, 0.30]))
    assert not perceptible(a, LightState(True, 200, "xy", [0.3005, 0.3003]))
    assert perceptible(a, LightState(True, 150, "xy", [0.30, 0.30]))
    assert perceptible(a, LightState(True, 200, "xy", [0.40, 0.40]))
    assert perceptible(a, LightState(False))
    # Near dark, small steps show
    assert perceptible(LightState(True, 3), LightState(True, 6))
    assert not perceptible(LightState(False), LightState(False))


def test_look_from_state_round_trip(inv):
    hue = inv.get("light.front_porch_light")
    look = Look(Color.from_hex("#20c0ff"), 0.7)
    back = look_from_state(render(look, hue))
    assert back.brightness == pytest.approx(0.7, abs=0.01)
    assert back.color.distance(look.color) < 0.01
