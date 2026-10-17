"""Capture sessions: units, order, refusals, Stop all and disconnects mid-pass, the live detector,
the record-and-upload fallback."""

from __future__ import annotations

import asyncio
import struct

import cv2
import httpx
import numpy as np
import pytest

from luminorium.app import Luminorium
from luminorium.mapping import live
from luminorium.mapping.session import CaptureError, choose_sync, make_unit, pass_order
from luminorium.web.server import create_app

from .conftest import make_settings, wait_for
from .mapping_sim import ENTITY, House, ManualClock, synth

WLED = "light.front_pathway_master"
ZIG_ON = "light.master_closet_light"  # on in the fixtures
ZIG_OFF = "light.front_porch_light"
ZWAVE = "light.living_room_overhead_lights_switch"
TARGETS = [WLED, ZIG_ON, ZIG_OFF, ZWAVE]


@pytest.fixture
async def rig(fake_ha, tmp_path):
    clock = ManualClock()
    app = Luminorium(make_settings(fake_ha.url, tmp_path), mapping_clock=clock)
    await app.start()
    await asyncio.wait_for(app.inventory.loaded.wait(), 10)
    app.clock = clock  # type: ignore[attr-defined]
    yield app
    await app.stop()


def test_units_order_and_sync(lum):
    inv = lum.inventory.inventory
    units = [make_unit(inv, u) for u in TARGETS]
    by = {u.id: u for u in units}
    assert by[ZWAVE].timeout == 2.5 and by[ZWAVE].slow and not by[ZWAVE].sync_ok
    assert by[WLED].timeout == 0.8 and not by[WLED].slow
    sync = choose_sync(units)
    assert sync.id == WLED  # the fastest light blinks
    order = pass_order(units, sync)
    assert order[-1].id == ZWAVE  # slow lights last
    assert order[0].id != WLED  # the sync light is not the first step
    with pytest.raises(CaptureError):
        make_unit(inv, "light.nope")


async def test_fixture_is_one_unit(lum):
    fid = lum.inventory.create_fixture("Pair", [ZIG_ON, ZIG_OFF])
    inv = lum.inventory.inventory
    unit = make_unit(inv, fid)
    assert {lt.entity_id for lt in unit.lights} == {ZIG_ON, ZIG_OFF}
    with pytest.raises(CaptureError):
        make_unit(inv, ZIG_ON)  # pick the fixture, not one of its lights


async def test_sessions_refused_when_read_only(fake_ha, tmp_path):
    app = Luminorium(make_settings(fake_ha.url, tmp_path, read_only=True))
    await app.start()
    await app.inventory.loaded.wait()
    view = app.spatial.create("Front")
    transport = httpx.ASGITransport(app=create_app(app, manage_lifecycle=False))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.post("/api/mapping/sessions", json={"view_id": view.id, "targets": TARGETS})
        assert r.status_code == 409 and "read-only" in r.json()["detail"]
    assert not fake_ha.calls
    await app.stop()


async def test_session_api_errors(lum):
    transport = httpx.ASGITransport(app=create_app(lum, manage_lifecycle=False))
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        r = await c.post("/api/mapping/sessions", json={"view_id": "view_nope", "targets": TARGETS})
        assert r.status_code == 404
        view = lum.spatial.create("Front")
        r = await c.post("/api/mapping/sessions", json={"view_id": view.id, "targets": []})
        assert r.status_code == 409
        r = await c.post(
            "/api/mapping/sessions",
            json={"view_id": view.id, "targets": TARGETS, "sync": "light.nope"},
        )
        assert r.status_code == 409
        r = await c.post("/api/mapping/sessions", json={"view_id": view.id, "targets": TARGETS})
        sid = r.json()["id"]
        assert r.json()["sync"] == WLED
        assert (await c.get("/api/mapping/sessions")).json()[0]["id"] == sid
        assert (await c.post(f"/api/mapping/sessions/{sid}/apply")).status_code == 409
        assert (await c.get("/api/mapping/sessions/nope")).status_code == 404
        # reopened from disk (after a restart) even if a light has gone from HA since
        lum.mapping.sessions.clear()
        lum.inventory.inventory.lights.pop(ZWAVE)
        r = await c.get(f"/api/mapping/sessions/{sid}")
        assert r.status_code == 200 and len(r.json()["targets"]) == 4
        assert (await c.delete(f"/api/mapping/sessions/{sid}")).status_code == 200


async def _advance_until(clock: ManualClock, predicate, limit_s: float = 60.0, step: float = 0.1):
    end = clock.now() + limit_s
    while not predicate():
        if clock.now() > end:
            raise AssertionError("not reached in simulated time")
        await clock.advance(clock.now() + step)


async def test_stop_all_mid_pass_restores(rig, fake_ha):
    before = {e: fake_ha.states[e]["state"] for e in TARGETS}
    view = rig.spatial.create("Front")
    session = rig.mapping.create(view.id, TARGETS, stations=["centre"])
    await session.start_station("centre", mode="record")  # no phone needed
    await _advance_until(rig.clock, lambda: any(c["action"] == "invert" for c in session.commands))
    await wait_for(lambda: rig.safety.snapshots)
    assert any(fake_ha.states[e]["state"] != before[e] for e in TARGETS)
    await rig.safety.stop_all()
    await wait_for(lambda: session.stations["centre"].state == "failed")
    assert {e: fake_ha.states[e]["state"] for e in TARGETS} == before
    assert session.status == "stopped" and not rig.safety.sessions and not rig.safety.snapshots


async def test_phone_disconnect_mid_pass_restores(rig, fake_ha):
    before = {e: fake_ha.states[e]["state"] for e in TARGETS}
    view = rig.spatial.create("Front")
    session = rig.mapping.create(view.id, TARGETS, stations=["centre"])
    sent: list[dict] = []

    async def send(msg):
        sent.append(msg)

    owner = object()
    session.attach(owner, send)
    await session.on_text({"type": "start", "station": "centre"})
    frame = cv2.imencode(".jpg", np.full((360, 640, 3), 40, np.uint8))[1].tobytes()
    seq = 0

    async def feed():
        nonlocal seq
        t = rig.clock.now() + 500.0  # the phone's clock
        await session.on_binary(b"LMF1" + struct.pack("<I", seq) + struct.pack("<d", t) + frame)
        seq += 1

    while not any(c["action"] == "invert" for c in session.commands):
        await feed()
        await rig.clock.advance(rig.clock.now() + 1 / 15)
        assert rig.clock.now() < 1100
    assert any(m["type"] == "photo" for m in sent)  # the reference photo was asked for
    await wait_for(lambda: rig.safety.snapshots)
    await session.detach(owner)
    await wait_for(lambda: session.stations["centre"].state == "failed")
    assert {e: fake_ha.states[e]["state"] for e in TARGETS} == before
    assert not rig.safety.snapshots


async def test_frames_stopping_mid_pass_restores(rig, fake_ha):
    before = {e: fake_ha.states[e]["state"] for e in TARGETS}
    view = rig.spatial.create("Front")
    session = rig.mapping.create(view.id, TARGETS, stations=["centre"])

    async def send(msg):
        pass

    session.attach(object(), send)
    await session.on_text({"type": "start", "station": "centre"})
    frame = cv2.imencode(".jpg", np.full((360, 640, 3), 40, np.uint8))[1].tobytes()
    seq = 0
    while not any(c["action"] == "invert" for c in session.commands):
        t = rig.clock.now() + 500.0
        await session.on_binary(b"LMF1" + struct.pack("<I", seq) + struct.pack("<d", t) + frame)
        seq += 1
        await rig.clock.advance(rig.clock.now() + 1 / 15)
    # the phone stays connected but sends nothing more
    await _advance_until(rig.clock, lambda: session.stations["centre"].state == "failed", 30)
    await wait_for(lambda: not rig.safety.snapshots)
    assert "frames stopped" in session.stations["centre"].message
    assert {e: fake_ha.states[e]["state"] for e in TARGETS} == before


def test_live_detector_settles_on_a_light_and_ignores_shake():
    rng = np.random.default_rng(0)
    base = cv2.GaussianBlur((rng.random((180, 320)) * 120 + 20).astype(np.uint8), (0, 0), 1.5)
    det = live.LiveDetector()

    def frame(level: float, shift: float = 0.0):
        img = base.astype(np.float32)
        img[60:90, 100:140] += level
        M = np.float32([[1, 0, shift], [0, 1, 0]])
        img = cv2.warpAffine(img, M, (320, 180), borderMode=cv2.BORDER_REFLECT)
        img += rng.normal(0, 1.0, img.shape)
        return np.clip(img, 0, 255).astype(np.uint8)

    t = 0.0
    for _ in range(6):
        det.add(t, frame(0))
        t += 1 / 15
    det.begin(t)
    # shake only (a 0.6 px drift): no change
    for k in range(5):
        det.add(t + 0.07 * (k + 1), frame(0, shift=0.12 * k))
    assert not det.status.changed
    # the light ramps up over 0.2 s, then stays
    t0 = t + 0.4
    for k in range(12):
        level = min(1.0, k / 3) * 80
        det.add(t0 + k / 15, frame(level))
    st = det.end()
    assert st.changed and st.settled
    assert st.first_change == pytest.approx(t0 + 1 / 15, abs=0.01)


@pytest.mark.slow
async def test_record_and_upload_fallback(fake_ha, tmp_path):
    """No live stream: the pass runs on fixed timing, the video is uploaded afterwards and the
    blink alone gives the clock."""
    sc = synth.SCENARIOS["clean"]
    house = House(sc)
    clock = ManualClock()
    house.clock = clock
    for eid, on in house.initial_states().items():
        fake_ha.states[eid]["state"] = "on" if on else "off"
        fake_ha.states[eid]["attributes"]["brightness"] = 255 if on else None
    fake_ha.listeners.append(house.on_call)
    app = Luminorium(make_settings(fake_ha.url, tmp_path), mapping_clock=clock)
    await app.start()
    await app.inventory.loaded.wait()
    view = app.spatial.create("Front")
    session = app.mapping.create(view.id, list(ENTITY.values()), stations=["centre"])
    st = house.new_station("centre", clock.now())
    from .mapping_sim import Phone

    phone = Phone.__new__(Phone)  # only its renderer is needed here
    phone.house, phone.sc, phone.clock = house, sc, clock
    phone._gain, phone._frame_rng = None, np.random.default_rng(1)
    await session.start_station("centre", mode="record")
    video = tmp_path / "upload.avi"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 15.0, (640, 360))
    assert writer.isOpened()
    t_start = clock.now() + 1.0  # recording starts during the countdown
    while session.stations["centre"].state == "capturing":
        t = clock.now()
        if t >= t_start:
            writer.write(cv2.cvtColor(phone._render(st, t), cv2.COLOR_RGB2BGR))
        await clock.advance(t + 1 / 15)
        assert t < clock.now() + 200
    writer.release()
    transport = httpx.ASGITransport(app=create_app(app, manage_lifecycle=False))
    async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=120) as c:
        r = await c.put(
            f"/api/mapping/sessions/{session.id}/stations/centre/video", content=video.read_bytes()
        )
        assert r.status_code == 200, r.text
    await asyncio.wait_for(session.wait_analyses(), 120)
    res = session.results["centre"]
    assert res.clock_source == "blink"
    visible = {ENTITY[k] for k in ("porch", "w_den", "long1", "long2", "w_kitchen", "drive_l")}
    assert visible <= set(res.detected())
    assert ENTITY["post"] not in res.detected()  # behind the tree from the centre
    await app.stop()
