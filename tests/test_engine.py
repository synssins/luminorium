"""The show engine against the fake HA: palettes, dips, effects, overlap, fixtures, Stop all,
outside changes, and the API."""

from __future__ import annotations

import asyncio

import httpx
import pytest

from luminorium.app import Luminorium
from luminorium.engine.engine import ShowError
from luminorium.web.server import create_app

from .conftest import make_settings, wait_for

CLOSET = "light.master_closet_light"  # zigbee dimmer, on in the fixtures
PORCH = "light.front_porch_light"  # Hue, off
KITCHEN = "light.kitchen_cabinet_light_switch"  # Z-Wave dimmer with transitions, off
OFFICE = ["light.office_fan_rgb1", "light.office_fan_rgb2"]


def snapshot_of(fake_ha, eids):
    return {
        e: (fake_ha.states[e]["state"], fake_ha.states[e]["attributes"].get("brightness"))
        for e in eids
    }


async def _idle(lum, timeout=10):
    await wait_for(lambda: not lum.engine.shows and not lum.engine._releasing, timeout=timeout)
    await wait_for(lambda: not lum.safety.snapshots, timeout=timeout)


async def test_palette_on_an_area_and_stop_restores(lum, fake_ha):
    show = await lum.engine.play(
        {"seed": 5, "layers": [{"type": "palette", "palette": "forest"}]},
        kind="palette",
        source="forest",
        targets={"areas": ["master_bedroom"]},
    )
    lights = sorted(show.lights)
    assert CLOSET in lights and len(lights) >= 8
    before = snapshot_of(fake_ha, lights)
    await wait_for(lambda: all(fake_ha.calls_for(e) for e in lights if e != CLOSET), timeout=5)
    assert all(fake_ha.states[e]["state"] == "on" for e in lights)
    assert lum.engine.running()[0]["source"] == "forest"

    assert await lum.engine.stop(show.id)
    await _idle(lum)
    assert snapshot_of(fake_ha, lights) == before


async def test_same_seed_same_show(lum, fake_ha):
    spec = {"seed": 11, "layers": [{"type": "palette", "palette": "ocean", "fade_in_s": 0}]}
    targets = {"lights": [PORCH]}
    await lum.engine.play(spec, targets=targets)
    await wait_for(lambda: fake_ha.calls_for(PORCH))
    first = fake_ha.calls_for(PORCH)[0].data
    await lum.engine.stop_shows()
    await _idle(lum)
    fake_ha.calls.clear()
    await lum.engine.play(spec, targets=targets)
    await wait_for(lambda: fake_ha.calls_for(PORCH))
    assert fake_ha.calls_for(PORCH)[0].data == first
    await lum.engine.stop_shows()


async def test_dip_restores_each_lights_own_level(lum, fake_ha):
    # The Z-Wave dimmer is on at 200 before the show (someone turned it on)
    await fake_ha.external_change(KITCHEN, "on", brightness=200)
    await wait_for(lambda: lum.inventory.inventory.get(KITCHEN).state == "on")
    closet_level = fake_ha.states[CLOSET]["attributes"]["brightness"]
    await lum.engine.play(
        {"layers": [{"type": "dip", "level": 20, "fade_s": 0.3, "hold_s": 2.5, "restore_s": 0.5}]},
        targets={"lights": [CLOSET, KITCHEN]},
    )
    await wait_for(lambda: fake_ha.calls_for(KITCHEN) and fake_ha.calls_for(CLOSET))
    # Dimmed to about a fifth of each light's own level
    assert fake_ha.states[KITCHEN]["attributes"]["brightness"] == pytest.approx(40, abs=8)
    low = min(c.data["brightness"] for c in fake_ha.calls_for(CLOSET))
    assert low == pytest.approx(closet_level * 0.2, abs=10)
    await _idle(lum)
    assert fake_ha.states[KITCHEN]["attributes"]["brightness"] == 200
    assert fake_ha.states[CLOSET]["attributes"]["brightness"] == closet_level
    # Z-Wave's budget held: one command down, one back
    assert len(fake_ha.calls_for(KITCHEN)) <= 3


async def test_dip_leaves_off_lights_alone(lum, fake_ha):
    await lum.engine.play(
        {"layers": [{"type": "dip", "level": 10, "fade_s": 0.1, "hold_s": 0.3, "restore_s": 0.1}]},
        targets={"lights": [PORCH]},
    )
    await _idle(lum)
    assert not fake_ha.calls_for(PORCH)


async def test_native_effect_and_software_fallback(lum, fake_ha):
    show = await lum.engine.play(
        {"layers": [{"type": "native_effect", "effect": "fire"}]},
        targets={"lights": [PORCH, CLOSET]},
    )
    await asyncio.sleep(2.5)
    assert {c.data.get("effect") for c in fake_ha.calls_for(PORCH)} == {"fireplace"}
    # The dimmer has no fire: a software candle, so its level moves
    levels = {c.data.get("brightness") for c in fake_ha.calls_for(CLOSET)}
    assert len(levels) >= 2
    layer = lum.engine.running()[0]["layers"][0]
    assert layer["resolution"][PORCH][PORCH]["method"] == "native"
    assert layer["resolution"][CLOSET][CLOSET]["method"] == "software"
    await lum.engine.stop(show.id)
    await _idle(lum)
    assert fake_ha.states[PORCH]["state"] == "off"


async def test_higher_priority_wins_and_lower_resumes(lum, fake_ha):
    await lum.engine.play(
        {"layers": [{"type": "static", "color": "red", "brightness": 50, "fade_in_s": 0}]},
        targets={"lights": [PORCH]},
    )
    await wait_for(lambda: fake_ha.states[PORCH]["state"] == "on")
    red = fake_ha.states[PORCH]["attributes"]["xy_color"]
    await lum.engine.play(
        {"layers": [{"type": "flash", "color": "blue", "on_s": 1.0}]},
        targets={"lights": [PORCH]},
    )
    await wait_for(lambda: fake_ha.states[PORCH]["attributes"]["xy_color"] != red)
    # The flash ends; the red show is still running and comes back
    await wait_for(lambda: fake_ha.states[PORCH]["attributes"]["xy_color"] == red, timeout=5)
    # (sent early by the light's latency, so the flash show may still be ending)
    await wait_for(lambda: len(lum.engine.shows) == 1)
    assert PORCH in lum.safety.snapshots
    await lum.engine.stop_shows()
    await _idle(lum)
    assert fake_ha.states[PORCH]["state"] == "off"


async def test_fixture_lights_get_the_same_look(lum, fake_ha):
    fixture_id = lum.inventory.create_fixture("Office fan", OFFICE)
    show = await lum.engine.play(
        {"layers": [{"type": "palette", "palette": "sunset", "fade_in_s": 0}]},
        targets={"lights": [OFFICE[0]]},  # one light brings its whole fixture
    )
    assert sorted(show.lights) == OFFICE
    assert list(show.elements[0]) == [fixture_id]
    await wait_for(lambda: all(fake_ha.calls_for(e) for e in OFFICE))
    a, b = (fake_ha.calls_for(e)[0].data for e in OFFICE)
    # The same command for both, whichever palette colour came up (sunset includes a warm white,
    # sent as a colour temperature rather than hs)
    assert a == b and "brightness" in a
    await lum.engine.stop_shows()


async def test_stop_all_ends_shows_and_restores(lum, fake_ha):
    show = await lum.engine.play(
        {"layers": [{"type": "palette", "palette": "fire", "fade_in_s": 0}]},
        targets={"areas": ["master_bedroom", "porch"]},
    )
    lights = sorted(show.lights)
    before = snapshot_of(fake_ha, lights)
    await wait_for(lambda: len(lum.safety.snapshots) >= 5, timeout=5)
    await lum.safety.stop_all()
    assert not lum.engine.shows
    assert not lum.safety.snapshots and not lum.store.load("snapshots")
    await asyncio.sleep(0.3)
    assert snapshot_of(fake_ha, lights) == before
    # The engine plays again after a Stop all
    await lum.engine.play(
        {"layers": [{"type": "static", "color": "red", "fade_in_s": 0}]},
        targets={"lights": [PORCH]},
    )
    await wait_for(lambda: fake_ha.states[PORCH]["state"] == "on")
    await lum.safety.stop_all()


async def test_outside_change_drops_the_light(lum, fake_ha, monkeypatch):
    from luminorium.engine import safety as safety_mod

    monkeypatch.setattr(safety_mod, "SETTLE_MARGIN_S", 0.2)
    show = await lum.engine.play(
        {"layers": [{"type": "palette", "palette": "team_colours", "fade_in_s": 0}]},
        targets={"lights": [PORCH, CLOSET]},
    )
    await wait_for(lambda: fake_ha.calls_for(PORCH) and fake_ha.calls_for(CLOSET))
    # Once the command has settled (latency + margin), someone switches the porch off at the
    # wall, in the middle of the palette's fade: an on/off flip counts even while fading
    await asyncio.sleep(lum.inventory.inventory.get(PORCH).profile.latency_ms / 1000 + 0.4)
    await fake_ha.external_change(PORCH, "off")
    await wait_for(lambda: PORCH not in show.lights)
    sent = len(fake_ha.calls_for(PORCH))
    await asyncio.sleep(1.0)
    assert len(fake_ha.calls_for(PORCH)) == sent
    assert CLOSET in show.lights
    await lum.engine.stop(show.id)
    await _idle(lum)
    assert fake_ha.states[PORCH]["state"] == "off"  # their change stands


async def test_on_end_hold_leaves_lights(lum, fake_ha):
    show = await lum.engine.play(
        {"on_end": "hold", "layers": [{"type": "static", "color": "green", "fade_in_s": 0}]},
        targets={"lights": [PORCH]},
    )
    await wait_for(lambda: fake_ha.states[PORCH]["state"] == "on")
    await lum.engine.stop(show.id)
    await _idle(lum)
    assert fake_ha.states[PORCH]["state"] == "on"
    assert [c.service for c in fake_ha.calls_for(PORCH)] == ["turn_on"]


async def test_on_end_fade_restores_with_a_transition(lum, fake_ha):
    show = await lum.engine.play(
        {"on_end": "fade", "fade_s": 3, "layers": [{"type": "static", "fade_in_s": 0}]},
        targets={"lights": [PORCH]},
    )
    await wait_for(lambda: fake_ha.states[PORCH]["state"] == "on")
    await lum.engine.stop(show.id)
    await _idle(lum)
    last = fake_ha.calls_for(PORCH)[-1]
    assert (last.service, last.data.get("transition")) == ("turn_off", 3.0)


async def test_shows_end_on_their_own(lum, fake_ha):
    await lum.engine.play(
        {"duration_s": 0.6, "layers": [{"type": "static", "color": "red", "fade_in_s": 0}]},
        targets={"lights": [PORCH]},
    )
    await _idle(lum)
    assert fake_ha.states[PORCH]["state"] == "off"


async def test_bad_shows_are_refused(lum):
    with pytest.raises(ShowError):
        await lum.engine.play(
            {"layers": [{"type": "palette", "palette": "nope"}]}, targets={"all": True}
        )
    with pytest.raises(ShowError):
        await lum.engine.play({"layers": [{"type": "static"}]}, targets={"areas": ["mars"]})
    with pytest.raises(ShowError):
        await lum.engine.play({"layers": [{"type": "static"}]})  # no targets
    with pytest.raises(ShowError):
        await lum.engine.play(
            {"on_end": "explode", "layers": [{"type": "static"}]}, targets={"all": True}
        )


async def test_lights_in_a_test_are_left_out(lum, fake_ha):
    lum.tester.hold_s = 2.0
    lum.tester.start(lum.inventory.inventory.get(PORCH))
    await wait_for(lambda: PORCH in lum.safety.snapshots)
    show = await lum.engine.play(
        {"layers": [{"type": "static", "fade_in_s": 0}]}, targets={"lights": [PORCH, CLOSET]}
    )
    assert show.lights == {CLOSET}
    await lum.safety.stop_all()


# ---- API --------------------------------------------------------------------------------------


@pytest.fixture
async def api(lum):
    transport = httpx.ASGITransport(app=create_app(lum, manage_lifecycle=False))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


async def test_api_palettes_play_and_stop(api, fake_ha):
    palettes = {p["id"]: p for p in (await api.get("/api/palettes")).json()}
    assert {"forest", "ocean", "fire", "aurora", "sunset", "team_colours", "warm_white"} <= set(
        palettes
    )
    r = await api.post(
        "/api/palettes/forest/play", json={"targets": {"areas": ["porch"]}, "seed": 3}
    )
    assert r.status_code == 200, r.text
    run = r.json()
    assert run["source"] == "forest" and run["seed"] == "3" and PORCH in run["lights"]
    assert [s["id"] for s in (await api.get("/api/running")).json()] == [run["id"]]
    assert (await api.get("/api/status")).json()["shows"][0]["id"] == run["id"]
    r = await api.post(f"/api/running/{run['id']}/stop", json={})
    assert r.json() == {"stopped": run["id"]}
    assert (await api.get("/api/running")).json() == []
    assert (await api.post("/api/running/nope/stop")).status_code == 404
    r = await api.post("/api/palettes/nope/play", json={"targets": {"all": True}})
    assert r.status_code == 404
    r = await api.post("/api/palettes/forest/play", json={"targets": {"areas": ["mars"]}})
    assert r.status_code == 400


async def test_api_user_palettes(api):
    r = await api.put("/api/palettes/my_blue", json={"name": "My blue", "colors": ["blue", "cyan"]})
    assert r.status_code == 200, r.text
    listed = {p["id"]: p for p in (await api.get("/api/palettes")).json()}
    assert listed["my_blue"]["source"] == "user"
    assert (await api.put("/api/palettes/Bad Id", json={"colors": ["red"]})).status_code == 400
    assert (await api.put("/api/palettes/x", json={"colors": []})).status_code == 400
    assert (await api.delete("/api/palettes/my_blue")).status_code == 200
    assert (await api.delete("/api/palettes/forest")).status_code == 404


async def test_api_shows(api, lum, fake_ha):
    show = {
        "name": "Porch candle",
        "targets": {"lights": [PORCH]},
        "duration_s": 30,
        "layers": [{"type": "native_effect", "effect": "candle"}],
    }
    assert (await api.put("/api/shows/porch_candle", json=show)).status_code == 200
    assert [s["id"] for s in (await api.get("/api/shows")).json()] == ["porch_candle"]
    run = (await api.post("/api/shows/porch_candle/play")).json()
    assert run["kind"] == "show" and run["lights"] == [PORCH]
    assert (await api.post("/api/stop")).json() == {"stopped": 1}
    inline = await api.post(
        "/api/play", json={"layers": [{"type": "flash"}], "targets": {"lights": [PORCH]}}
    )
    assert inline.status_code == 200, inline.text
    r = await api.put("/api/shows/bad", json={"layers": [{"type": "laser"}]})
    assert r.status_code == 400
    assert (await api.delete("/api/shows/porch_candle")).status_code == 200
    assert (await api.post("/api/shows/porch_candle/play")).status_code == 404
    effects = {e["id"] for e in (await api.get("/api/effects")).json()}
    assert {"fire", "candle", "ocean", "lightning"} <= effects
    resolved = (await api.get(f"/api/lights/{PORCH}/effects")).json()
    assert resolved["fire"] == {"method": "native", "name": "fireplace"}
    await api.post("/api/stop_all")


async def test_api_read_only_refuses_play(fake_ha, tmp_path):
    app = Luminorium(make_settings(fake_ha.url, tmp_path, read_only=True))
    await app.start()
    await asyncio.wait_for(app.inventory.loaded.wait(), 10)
    transport = httpx.ASGITransport(app=create_app(app, manage_lifecycle=False))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
        r = await client.post("/api/palettes/forest/play", json={"targets": {"all": True}})
        assert r.status_code == 409
        assert (await client.get("/api/palettes")).status_code == 200
    await app.stop()


async def test_palettes_leave_white_only_lights_alone(api, lum):
    rgb, white = "light.front_pathway_rgb", "light.front_pathway_white"
    r = await api.put(f"/api/lights/{white}/white_only", json={"white_only": True})
    assert r.status_code == 200 and r.json()["white_only"] is True
    assert lum.inventory.store.load("choices")["white_only"] == [white]
    assert (
        await api.put("/api/lights/light.nope/white_only", json={"white_only": True})
    ).status_code == 404

    targets = {"lights": [rgb, white]}
    run = (await api.post("/api/palettes/fire/play", json={"targets": targets})).json()
    assert run["lights"] == [rgb]
    await api.post(f"/api/running/{run['id']}/stop", json={})
    # Unless the play asks for them
    run = (
        await api.post("/api/palettes/fire/play", json={"targets": targets, "include_white": True})
    ).json()
    assert sorted(run["lights"]) == [rgb, white]
    await api.post(f"/api/running/{run['id']}/stop", json={})
    # Only white-only lights: nothing left to play on
    r = await api.post("/api/palettes/fire/play", json={"targets": {"lights": [white]}})
    assert r.status_code == 400
    r = await api.put(f"/api/lights/{white}/white_only", json={"white_only": False})
    assert r.json()["white_only"] is False
