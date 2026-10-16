"""Test button, Stop all, outside changes and crash recovery, against the fake HA."""

from __future__ import annotations

import asyncio

import pytest

from luminorium.app import Luminorium
from luminorium.engine.testlight import LightTestError
from luminorium.ha.client import ReadOnlyError

from .conftest import make_settings, wait_for

PORCH = "light.front_porch_light"  # Hue, off in the fixtures
CLOSET = "light.master_closet_light"  # CREE, on in the fixtures


async def test_test_button_turns_on_off_and_restores(lum, fake_ha):
    before = fake_ha.states[CLOSET]
    assert before["state"] == "on"
    original_brightness = before["attributes"]["brightness"]
    lum.tester.start(lum.inventory.inventory.get(CLOSET))
    await wait_for(lambda: not lum.safety.sessions, timeout=10)
    calls = fake_ha.calls_for(CLOSET)
    assert [(c.service, c.data.get("brightness")) for c in calls] == [
        ("turn_on", 255),
        ("turn_off", None),
        ("turn_on", original_brightness),
    ]
    assert calls[0].data.get("transition") == 0
    after = fake_ha.states[CLOSET]
    assert after["state"] == "on" and after["attributes"]["brightness"] == original_brightness
    assert not lum.safety.snapshots
    assert not lum.store.load("snapshots")
    await wait_for(lambda: any("done; restored" in a["message"] for a in lum.safety.activity))


async def test_test_restores_an_off_light_to_off(lum, fake_ha):
    lum.tester.start(lum.inventory.inventory.get(PORCH))
    await wait_for(lambda: not lum.safety.sessions, timeout=10)
    assert [c.service for c in fake_ha.calls_for(PORCH)] == ["turn_on", "turn_off", "turn_off"]
    assert fake_ha.states[PORCH]["state"] == "off"


async def test_relay_switch_uses_switch_service(lum, fake_ha):
    lum.inventory.set_choice("switch.backyard_light_switch", True)
    light = lum.inventory.inventory.get("switch.backyard_light_switch")
    lum.tester.hold_s = 0.0
    light.profile.max_rate_hz = 50  # don't wait 5 s per toggle in a test
    lum.tester.start(light)
    await wait_for(lambda: not lum.safety.sessions, timeout=10)
    calls = fake_ha.calls_for("switch.backyard_light_switch")
    assert [(c.domain, c.service) for c in calls] == [
        ("switch", "turn_on"),
        ("switch", "turn_off"),
        ("switch", "turn_off"),
    ]


async def test_excluded_and_unavailable_lights_cannot_be_tested(lum):
    inv = lum.inventory.inventory
    with pytest.raises(LightTestError):
        lum.tester.start(inv.get("switch.backyard_light_switch"))  # not opted in
    with pytest.raises(LightTestError):
        lum.tester.start(inv.get("light.living_room_floor_lamp_switch"))  # unavailable


async def test_outside_change_drops_the_light(lum, fake_ha):
    lum.tester.hold_s = 1.0
    lum.tester.start(lum.inventory.inventory.get(PORCH))
    await wait_for(lambda: fake_ha.states[PORCH]["state"] == "on")
    # Someone turns it off at the wall switch, at a different brightness than we sent
    await fake_ha.external_change(PORCH, "on", brightness=40)
    await wait_for(lambda: not lum.safety.sessions, timeout=10)
    # Our turn_off and restore were skipped: their change stands
    assert [c.service for c in fake_ha.calls_for(PORCH)] == ["turn_on"]
    assert fake_ha.states[PORCH]["attributes"]["brightness"] == 40
    assert any("changed outside" in a["message"] for a in lum.safety.activity)


async def test_stop_all_restores(lum, fake_ha):
    lum.tester.hold_s = 5.0
    for eid in (PORCH, CLOSET):
        lum.tester.start(lum.inventory.inventory.get(eid))
    await wait_for(lambda: fake_ha.states[PORCH]["state"] == "on")
    await wait_for(lambda: len(lum.safety.snapshots) == 2)
    restored = await lum.safety.stop_all()
    assert restored == 2
    assert fake_ha.states[PORCH]["state"] == "off"
    assert fake_ha.states[CLOSET]["state"] == "on"
    assert not lum.safety.sessions and not lum.safety.snapshots


async def test_restore_leftovers_after_crash(fake_ha, tmp_path):
    settings = make_settings(fake_ha.url, tmp_path)
    crashed = Luminorium(settings, test_hold_s=10)
    await crashed.start()
    await crashed.inventory.loaded.wait()
    crashed.tester.start(crashed.inventory.inventory.get(PORCH))
    await wait_for(lambda: fake_ha.states[PORCH]["state"] == "on")
    # Simulate a crash: the process dies without restoring
    for session in crashed.safety.sessions.values():
        for task in session.tasks:
            task.cancel()
    crashed.safety.sessions.clear()
    crashed.safety.snapshots.clear()  # the in-memory copy is gone; the file stays
    await crashed.ha.close()
    assert crashed.store.load("snapshots")

    fresh = Luminorium(settings)
    await fresh.start()
    await wait_for(lambda: fake_ha.states[PORCH]["state"] == "off", timeout=10)
    await wait_for(lambda: not fresh.store.load("snapshots"))
    await fresh.stop()


async def test_read_only_blocks_service_calls(fake_ha, tmp_path):
    app = Luminorium(make_settings(fake_ha.url, tmp_path, read_only=True))
    await app.start()
    await app.inventory.loaded.wait()
    with pytest.raises(ReadOnlyError):
        await app.ha.call_service("light", "turn_on", entity_ids=[PORCH])
    assert not fake_ha.calls
    await app.stop()


async def test_reconnect_reloads_and_resubscribes(lum, fake_ha):
    await fake_ha.drop_clients()
    await wait_for(lambda: not lum.ha.connected, timeout=5)
    await wait_for(lambda: lum.ha.connected, timeout=10)
    await asyncio.sleep(0.2)
    await fake_ha.external_change(PORCH, "on", brightness=99)
    await wait_for(lambda: lum.inventory.inventory.get(PORCH).state == "on")
