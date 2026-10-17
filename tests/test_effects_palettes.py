"""Effect resolution, the palette cycler, and the YAML library."""

from __future__ import annotations

import pytest

from luminorium.engine.color import OFF
from luminorium.engine.effects import EffectLibrary
from luminorium.engine.layers import (
    LayerContext,
    LayerError,
    Palette,
    Span,
    build_layer,
)
from luminorium.inventory.builder import UserChoices, build
from luminorium.library import Library, LibraryError

HUE = "light.front_entryway_flood_01"  # Hue via z2m: candle, fireplace, sunset, ...
WIZ = "light.master_bedroom_arc_lamp_1"
WLED = "light.front_pathway_rgb"
GOVEE = "light.rgbic_path_lights"
DIMMER = "light.master_closet_light"  # no effects of note


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


@pytest.fixture
def effects():
    return EffectLibrary.load()


def test_fire_resolves_per_integration(inv, effects):
    expect = {HUE: "fireplace", WIZ: "Fireplace", WLED: "Fire 2012", GOVEE: "Fire"}
    for eid, name in expect.items():
        res = effects.resolve("fire", inv.get(eid))
        assert (res.method, res.native_name) == ("native", name), eid


def test_close_software_and_static_fallbacks(inv, effects):
    # WiZ has "Jungle" and "Forest"; exact first
    assert effects.resolve("forest", inv.get(WIZ)).native_name == "Forest"
    # Hue has no forest and forest has no software version: static key colour
    assert effects.resolve("forest", inv.get(HUE)).method == "static"
    # A dimmer runs fire as a software candle
    res = effects.resolve("fire", inv.get(DIMMER))
    assert (res.method, res.software) == ("software", "candle")
    # z2m's "breathe" is an identify blink: not used for the slow breathe
    assert effects.resolve("breathe", inv.get(HUE)).method == "software"
    # Close match when exact is missing: Hue aurora -> cosmos
    res = effects.resolve("aurora", inv.get(HUE))
    assert (res.method, res.native_name) == ("close", "cosmos")
    assert effects.resolve("aurora", inv.get(HUE), allow_close=False).method == "static"


def test_user_effect_files_extend_and_override(tmp_path, inv):
    (tmp_path / "mine.yaml").write_text(
        "fire:\n  name: My fire\n  color: red\n  native:\n    '*': {exact: [candle]}\n"
        "disco:\n  color: magenta\n  native:\n    '*': {exact: [colorloop]}\n",
        encoding="utf-8",
    )
    lib = EffectLibrary.load(tmp_path)
    assert lib.get("fire").name == "My fire"
    assert lib.native_name("fire", inv.get(HUE)) == "candle"
    assert lib.native_name("disco", inv.get(HUE)) == "colorloop"
    assert lib.get("ocean") is not None  # built-ins are kept


def _palette(**overrides) -> Palette:
    data = {
        "id": "test",
        "colors": [{"hex": "#ff0000", "weight": 2}, {"hex": "#00ff00"}, {"kelvin": 2700}],
        "brightness": [30, 60],
        "transition_s": [2, 4],
        "hold_s": [1, 3],
    }
    data.update(overrides)
    return Palette.from_dict(data)


def _walk(palette: Palette, seed: str, element: str, times: list[float]) -> list:
    layer = build_layer(
        {"type": "palette", "palette": "p", "fade_in_s": 0},
        LayerContext(EffectLibrary(), {"p": palette}, seed),
        0,
    )
    layer.bind(0.0)
    return [layer.span(element, t, Span(OFF, t)) for t in times]


def test_palette_is_deterministic_with_a_seed():
    palette = _palette()
    times = [i * 0.5 for i in range(200)]
    a = _walk(palette, "42", "light.a", times)
    assert a == _walk(palette, "42", "light.a", times)
    assert a != _walk(palette, "43", "light.a", times)
    assert a != _walk(palette, "42", "light.b", times)  # each element walks on its own
    together = _palette(spread="together")
    assert _walk(together, "42", "light.a", times) == _walk(together, "42", "light.b", times)


def test_palette_walk_stays_in_the_palette():
    palette = _palette()
    colours = {c for c, _ in palette.colors}
    spans = _walk(palette, "7", "light.a", [i * 0.25 for i in range(400)])
    holds = [s for s in spans if s.to is None]
    fades = [s for s in spans if s.to is not None]
    assert holds and fades
    for s in holds:
        assert s.look.color in colours
        assert 0.3 - 1e-9 <= s.look.brightness <= 0.6 + 1e-9
    for s in fades:
        assert s.to.color in colours
        assert 0 < s.until - s.start <= 4.0 + 1e-9  # a fade is never longer than transition_s
    # A long walk changes colour more than once
    assert len({s.look.color for s in holds}) >= 2


def test_palette_validation():
    with pytest.raises(LayerError):
        Palette.from_dict({"id": "x", "colors": []})
    with pytest.raises(LayerError):
        Palette.from_dict({"id": "x", "colors": ["red"], "brightness": [10, 200]})
    with pytest.raises(LayerError):
        Palette.from_dict({"id": "x", "colors": ["nope"]})
    with pytest.raises(LayerError):
        Palette.from_dict({"id": "x", "colors": ["red"], "spread": "sideways"})


def test_starter_palettes(tmp_path):
    lib = Library(tmp_path)
    palettes = lib.palettes()
    for pid in (
        "forest",
        "ocean",
        "fire",
        "aurora",
        "sunset",
        "team_colours",
        "warm_white",
        "halloween",
    ):
        assert pid in palettes
    assert len(palettes["team_colours"].colors) == 2
    assert all(c.kelvin for c, _ in palettes["warm_white"].colors)
    assert {p["source"] for p in lib.palette_list()} == {"builtin"}


def test_library_saves_overrides_and_deletes(tmp_path):
    lib = Library(tmp_path)
    lib.save_palette("forest", {"name": "My forest", "colors": ["green", "teal"]})
    assert (tmp_path / "palettes" / "forest.yaml").exists()
    listed = {p["id"]: p for p in lib.palette_list()}
    assert listed["forest"]["name"] == "My forest" and listed["forest"]["source"] == "user"
    lib.delete_palette("forest")
    assert lib.palettes()["forest"].name == "Forest"  # the built-in shows again
    with pytest.raises(KeyError):
        lib.delete_palette("ocean")  # built-ins can't be deleted
    with pytest.raises(LibraryError):
        lib.save_palette("../escape", {"colors": ["red"]})
    with pytest.raises(LibraryError):
        lib.save_palette("ok", {"colors": []})


def test_library_shows(tmp_path):
    lib = Library(tmp_path)
    show = {
        "name": "Porch fire",
        "targets": {"areas": ["porch"]},
        "layers": [{"type": "native_effect", "effect": "fire"}, {"type": "dip", "level": 10}],
    }
    lib.save_show("porch_fire", show)
    assert lib.show("porch_fire")["name"] == "Porch fire"
    with pytest.raises(LibraryError):
        lib.save_show("bad", {"layers": [{"type": "laser"}]})
    with pytest.raises(LibraryError):
        lib.save_show("bad", {"layers": []})
    lib.delete_show("porch_fire")
    with pytest.raises(KeyError):
        lib.show("porch_fire")
