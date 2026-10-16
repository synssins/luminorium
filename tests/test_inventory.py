"""The inventory built from the scrubbed real-house fixtures."""

from __future__ import annotations

from luminorium.inventory.builder import UserChoices, build
from luminorium.inventory.model import NO_AREA, NO_FLOOR, Kind


def inv_from(raw, choices=None):
    return build(
        raw["floors"],
        raw["areas"],
        raw["devices"],
        raw["entities"],
        raw["states"],
        raw["zwave"],
        choices,
    )


def test_floors_include_outside_bucket(raw):
    inv = inv_from(raw)
    assert list(inv.floors)[:4] == ["bedroom_level", "main_level", "ground_level", "basement"]
    assert inv.floors[NO_FLOOR].name == "Outside / no floor"
    assert inv.get("light.front_porch_light").floor_id == NO_FLOOR
    assert inv.get("light.living_room_cabinets_01").floor_id == "main_level"


def test_area_falls_back_to_device_area(raw):
    inv = inv_from(raw)
    light = inv.get("light.kitchen_cabinet_light_switch")
    assert light.area_id == "kitchen"


def test_lights_without_area(raw):
    inv = inv_from(raw)
    assert inv.get("light.wiz_rgbww_tunable_c3b549").area_id == NO_AREA


def test_default_exclusions(raw):
    inv = inv_from(raw)
    reasons = {lt.entity_id: lt.exclude_reason for lt in inv.lights.values() if not lt.included}
    by_platform = {}
    for lt in inv.lights.values():
        by_platform.setdefault(lt.platform, set()).add(lt.exclude_reason)
    # Some browser_mod entities are also stale; either way they're out
    assert "browser screen" in by_platform["browser_mod"]
    assert not any(lt.included for lt in inv.lights.values() if lt.platform == "browser_mod")
    assert by_platform["signalrgb"] == {"PC lighting"}
    assert reasons["light.back_patio_light_switch_basic"] == "Z-Wave Basic mirror"
    assert reasons["light.back_patio_light_switch"].startswith("stale")
    assert reasons["light.satellite1_90eff0_led_ring"] == "voice assistant LEDs"
    assert inv.get("light.main_level").kind == Kind.GROUP
    assert inv.get("light.main_level").exclude_reason == "Zigbee2MQTT group"


def test_switches_excluded_by_default_with_hints(raw):
    inv = inv_from(raw)
    backyard = inv.get("switch.backyard_light_switch")
    assert backyard.kind == Kind.SWITCH and not backyard.included
    assert backyard.hint == "looks like a light relay"
    # Switches on a light's own device are settings of that light, never relays
    setting = inv.get("switch.rgbic_path_lights_power_switch")
    assert setting.kind == Kind.SETTING and setting.hint is None and not setting.included
    assert inv.get("switch.wled_sync_send_2").kind == Kind.SETTING
    # A stale switch gets no hint
    assert inv.get("switch.master_bedroom_headboard_light_switch").hint is None
    assert inv.get("switch.living_room_ceiling_fan").hint is None
    assert inv.get("switch.kitchen_overhead_light_switch_button_1_indication_binary").hint is None


def test_user_choices_apply(raw):
    choices = UserChoices(
        include={"switch.backyard_light_switch": True, "light.office_wall_wash": False}
    )
    inv = inv_from(raw, choices)
    relay = inv.get("switch.backyard_light_switch")
    assert relay.included and relay.profile.relay
    assert relay.profile.max_rate_hz == 0.2
    assert relay.profile.capabilities.dimming is False
    wash = inv.get("light.office_wall_wash")
    assert not wash.included and wash.exclude_reason == "excluded by you"


def test_govee_segments_fold_under_parent(raw):
    inv = inv_from(raw)
    parent = inv.get("light.led_bulb_string_lights")
    assert len(parent.segments) == 30
    seg = inv.get(parent.segments[0])
    assert seg.kind == Kind.SEGMENT and seg.parent == parent.entity_id and seg.segment_index == 1
    assert parent.profile.capabilities.segments == 30
    assert parent.profile.network == "govee_cloud"


def test_duplicate_across_integrations(raw):
    inv = inv_from(raw)
    assert inv.get("light.h60b0").duplicates == ["light.uplighter_floor_lamp"]


def test_zwave_profiles(raw):
    inv = inv_from(raw)
    ge = inv.get("light.living_room_overhead_lights_switch").profile
    assert ge.network == "zwave"
    assert ge.details["multilevel_switch_version"] == 1
    assert ge.capabilities.transition == "none"
    zen77 = inv.get("light.kitchen_cabinet_light_switch").profile
    assert zen77.details["multilevel_switch_version"] == 4
    assert zen77.details["security"] == "S2 Authenticated"
    assert zen77.capabilities.transition == "native"
    dead = inv.get("light.living_room_floor_lamp_switch").profile
    assert dead.details["node_status"] == "dead"


def test_hue_profile(raw):
    inv = inv_from(raw)
    porch = inv.get("light.front_porch_light").profile
    assert porch.network == "zigbee"
    assert porch.capabilities.color_modes == ["xy"]
    assert porch.capabilities.white == (2000, 6535)
    assert "candle" in porch.capabilities.effects
    assert "stop_hue_effect" not in porch.capabilities.effects
