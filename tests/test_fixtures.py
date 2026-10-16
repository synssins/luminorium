"""Fixtures: lights in one physical fixture, grouped, tested and (later) mapped as one."""

from __future__ import annotations

import httpx
import pytest

from luminorium.inventory.builder import UserChoices, build
from luminorium.web.server import create_app

from .conftest import wait_for

RGB1, RGB2 = "light.office_fan_rgb1", "light.office_fan_rgb2"


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


def test_suggests_numbered_lights_of_one_model_in_one_room(raw):
    inv = inv_from(raw)
    office = [s for s in inv.suggestions if s.members == [RGB1, RGB2]]
    assert len(office) == 1
    assert office[0].name == "Office Fan RGB" and office[0].area_id == "office"


def test_stored_fixture_applies_and_hides_its_suggestion(raw):
    choices = UserChoices(fixtures=[{"id": "fx_1", "name": "Office fan", "members": [RGB1, RGB2]}])
    inv = inv_from(raw, choices)
    fixture = inv.fixtures["fx_1"]
    assert fixture.members == [RGB1, RGB2] and fixture.area_id == "office"
    assert fixture.floor_id == "ground_level"
    assert inv.get(RGB1).fixture == "fx_1"
    assert not any(RGB1 in s.members for s in inv.suggestions)


def test_dismissed_suggestion_stays_away(raw):
    inv = inv_from(raw, UserChoices(dismissed=[[RGB2, RGB1]]))
    assert not any(s.members == [RGB1, RGB2] for s in inv.suggestions)


def test_fixture_with_missing_members_is_not_applied(raw):
    choices = UserChoices(
        fixtures=[{"id": "fx_1", "name": "x", "members": [RGB1, "light.gone_from_ha"]}]
    )
    inv = inv_from(raw, choices)
    assert "fx_1" not in inv.fixtures and inv.get(RGB1).fixture is None


def test_service_validation(lum):
    inv = lum.inventory
    with pytest.raises(ValueError):
        inv.create_fixture("one", [RGB1])
    with pytest.raises(ValueError):
        inv.create_fixture("seg", [RGB1, "light.led_bulb_string_lights_segment_001"])
    fid = inv.create_fixture("", [RGB1, RGB2])
    assert inv.inventory.fixtures[fid].name == "Office Fan RGB1 fixture"
    with pytest.raises(ValueError):
        inv.create_fixture("again", [RGB1, "light.office_wall_wash"])
    inv.update_fixture(fid, name="Office fan")
    assert lum.store.load("choices")["fixtures"][0]["name"] == "Office fan"
    inv.delete_fixture(fid)
    assert not inv.inventory.fixtures and inv.inventory.get(RGB1).fixture is None


@pytest.fixture
async def client(lum):
    app = create_app(lum, manage_lifecycle=False)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test"
    ) as c:
        yield c


async def test_fixture_tests_its_lights_together(client, lum, fake_ha):
    r = await client.post("/api/fixtures", json={"name": "Office fan", "members": [RGB1, RGB2]})
    assert r.status_code == 200
    fid = r.json()["id"]
    inv = (await client.get("/api/inventory")).json()
    assert [f["id"] for f in inv["fixtures"]] == [fid]
    # A member can't be tested on its own
    assert (await client.post(f"/api/lights/{RGB1}/test")).status_code == 409

    before = {e: fake_ha.states[e]["state"] for e in (RGB1, RGB2)}
    r = await client.post(f"/api/fixtures/{fid}/test")
    assert r.status_code == 200 and r.json()["skipped"] == []
    await wait_for(lambda: not lum.safety.sessions, timeout=10)
    for eid in (RGB1, RGB2):
        assert [c.service for c in fake_ha.calls_for(eid)][:2] == ["turn_on", "turn_off"]
        assert fake_ha.states[eid]["state"] == before[eid]
    # Both lights switched together: their 'on' calls are close in time
    on_times = [fake_ha.calls_for(e)[0].at for e in (RGB1, RGB2)]
    assert abs(on_times[0] - on_times[1]) < 0.2


async def test_fixture_api_errors_and_dismiss(client):
    r = await client.post("/api/fixtures", json={"name": "x", "members": [RGB1]})
    assert r.status_code == 400
    assert (await client.put("/api/fixtures/fx_nope", json={"name": "y"})).status_code == 404
    assert (await client.delete("/api/fixtures/fx_nope")).status_code == 404
    assert (await client.post("/api/fixtures/fx_nope/test")).status_code == 404
    r = await client.post("/api/fixture_suggestions/dismiss", json={"members": [RGB2, RGB1]})
    assert r.json() == {"dismissed": [RGB1, RGB2]}
    inv = (await client.get("/api/inventory")).json()
    assert not any(s["members"] == [RGB1, RGB2] for s in inv["suggestions"])
