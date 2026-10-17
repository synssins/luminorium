"""The planner on simulated time: budgets per network, fades for slow lights, the threshold, and
latency compensation. No HA, no real time: the planner is driven tick by tick."""

from __future__ import annotations

import pytest

from luminorium.drivers.base import LightState
from luminorium.engine.color import OFF
from luminorium.engine.effects import EffectLibrary
from luminorium.engine.layers import LayerContext, Palette, Span, build_layer
from luminorium.engine.planner import Planner
from luminorium.inventory.builder import UserChoices, build

TICK = 0.05
ZWAVE_V1 = "light.living_room_overhead_lights_switch"  # Multilevel Switch v1: no transition
ZWAVE_V2 = "light.kitchen_cabinet_light_switch"  # transitions
GOVEE = "light.rgbic_path_lights"  # cloud, 0.5 Hz, no transition
HUE = "light.front_porch_light"


@pytest.fixture
def inv(raw):
    return build(
        raw["floors"],
        raw["areas"],
        raw["devices"],
        raw["entities"],
        raw["states"],
        raw["zwave"],
        UserChoices(),
    )


def _layer(spec: dict, palettes: dict | None = None):
    effects = EffectLibrary.load()
    layer = build_layer(spec, LayerContext(effects, palettes or {}, "seed"), 0)
    layer.bind(0.0)
    return layer, effects


def simulate(lights, layer, seconds: float, effects=None, planner=None):
    """Run the planner for `seconds` of simulated time; returns the commands."""
    planner = planner or Planner(effects.native_name if effects else None)
    for light in lights:
        layer.setup(light.entity_id, [light])
        planner.seed(light.entity_id, LightState(on=False))

    def span_fn(eid):
        def at(t):
            base = Span(OFF, t)
            if layer.active(t):
                return layer.span(eid, t, base)
            if layer.start > t:
                return base.clip(layer.start)
            return base

        return at

    commands = []
    t = 0.0
    while t < seconds:
        commands += planner.plan(t, [(lt, span_fn(lt.entity_id)) for lt in lights])
        t = round(t + TICK, 6)
    return commands


def zwave_lights(inv):
    return [lt for lt in inv.drivable() if lt.profile.network == "zwave" and lt.available]


def test_zwave_never_exceeds_its_network_budget(inv):
    lights = zwave_lights(inv)
    assert len(lights) >= 6
    palette = Palette.from_dict(
        {
            "id": "fast",
            "colors": ["red", "blue"],
            "brightness": [5, 100],
            "transition_s": [0.2, 0.5],
            "hold_s": [0, 0.3],
        }
    )
    layer, effects = _layer(
        {"type": "palette", "palette": "fast", "fade_in_s": 0}, {"fast": palette}
    )
    commands = simulate(lights, layer, 60, effects)
    times = sorted(c.at for c in commands)
    assert len(times) > 30  # it did keep the lights busy
    # Z-Wave: 2 commands/s for the whole mesh, burst 2
    for window in (1.0, 2.0, 5.0, 20.0):
        for i, start in enumerate(times):
            count = sum(1 for t in times[i:] if t < start + window)
            assert count <= 2 + 2.0 * window, (window, start, count)
    # And per light, never faster than its own rate (0.5 Hz)
    for light in lights:
        own = [c.at for c in commands if c.entity_id == light.entity_id]
        assert all(b - a >= 2.0 - 1e-6 for a, b in zip(own, own[1:], strict=False))


def test_slow_dimmer_gets_one_fade_per_palette_change(inv):
    light = inv.get(ZWAVE_V2)
    assert light.profile.capabilities.transition == "native"
    palette = Palette.from_dict(
        {
            "id": "slow",
            "colors": ["red", "white"],
            "brightness": [20, 90],
            "transition_s": [10, 10],
            "hold_s": [5, 5],
        }
    )
    layer, effects = _layer(
        {"type": "palette", "palette": "slow", "fade_in_s": 0}, {"slow": palette}
    )
    commands = simulate([light], layer, 61, effects)
    fades = [c for c in commands if c.reason == "fade"]
    # About four 10 s fades in a minute: one command each, with the fade's length
    assert 3 <= len(fades) <= 5
    assert all(c.transition_ms >= 8000 for c in fades)
    assert len(commands) <= len(fades) + 2


def test_fast_content_on_a_slow_light_is_a_fade_not_a_flood(inv):
    flicker = {"type": "software_effect", "effect": "flicker", "speed_hz": 8}
    govee = inv.get(GOVEE)
    layer, effects = _layer(flicker)
    commands = simulate([govee], layer, 30, effects)
    assert len(commands) <= 30 * 0.5 + 1  # never above the light's 0.5 Hz
    assert {c.reason for c in commands} <= {"lowpass"}

    dimmer = inv.get(ZWAVE_V2)
    layer, effects = _layer(flicker)
    commands = simulate([dimmer], layer, 30, effects)
    assert len(commands) <= 30 / 2 + 1
    assert all(c.reason == "lowpass" and c.transition_ms == 2000 for c in commands)
    # The 8 Hz flicker is averaged away: the level hardly moves from send to send
    levels = [c.state.brightness for c in commands]
    assert max(levels) - min(levels) < 60


def test_fast_light_follows_software_effect(inv):
    hue = inv.get(HUE)
    layer, effects = _layer({"type": "software_effect", "effect": "flicker", "speed_hz": 2})
    commands = simulate([hue], layer, 10, effects)
    assert len(commands) >= 10  # sampled at the light's 2 Hz
    assert all(c.reason == "sample" and c.transition_ms == 0 for c in commands)  # crisp


def test_nothing_sent_when_nothing_changes(inv):
    hue = inv.get(HUE)
    layer, effects = _layer({"type": "static", "color": "red", "brightness": 60, "fade_in_s": 0})
    commands = simulate([hue], layer, 20, effects)
    assert len(commands) == 1


def test_light_without_transition_steps_through_a_fade(inv):
    light = inv.get(ZWAVE_V1)
    layer, effects = _layer(
        {"type": "static", "color": "white", "brightness": 100, "fade_in_s": 10}
    )
    commands = simulate([light], layer, 12, effects)
    assert all(c.transition_ms is None for c in commands)
    levels = [c.state.brightness for c in commands]
    assert levels == sorted(levels) and len(levels) >= 4  # steps up at its 0.5 Hz
    assert levels[-1] == 255


def test_latency_compensation_lands_together(inv):
    """A flash at t=3: each light is sent it early by its own latency."""
    hue, dimmer = inv.get(HUE), inv.get(ZWAVE_V2)
    layer, effects = _layer({"type": "flash", "color": "white", "at_s": 3, "on_s": 1})
    commands = simulate([hue, dimmer], layer, 5, effects)
    first_on = {}
    for c in commands:
        if c.state.on and c.entity_id not in first_on:
            first_on[c.entity_id] = c.at
    for light in (hue, dimmer):
        latency = light.profile.latency_ms / 1000
        assert first_on[light.entity_id] == pytest.approx(3 - latency, abs=TICK + 1e-9)
    assert first_on[HUE] > first_on[ZWAVE_V2]


def test_native_effect_is_sent_once(inv):
    hue = inv.get(HUE)
    layer, effects = _layer({"type": "native_effect", "effect": "fire", "fade_in_s": 0})
    commands = simulate([hue], layer, 10, effects)
    assert len(commands) == 1
    assert commands[0].state.effect == "fireplace"
