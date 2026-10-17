"""End to end: the simulated phone streams a synthetic house over the real websocket, the app
drives the fake HA through Safety and the governor, records, analyses, and builds the view.

The simulated stations are the prototype's own (same camera poses and hand shake), and frames go
over the websocket losslessly as the prototype analysed them, so the scores compare like for like
with the table in proto/mapping/README.md. Each scenario renders ~1,000 frames and takes about two
minutes; the clean one always runs, the others with `--slow`.
"""

from __future__ import annotations

import asyncio
import json
import socket

import aiohttp
import numpy as np
import pytest
import uvicorn
from tools.fake_ha import FakeHA

from luminorium.app import Luminorium
from luminorium.mapping.recording import Frames
from luminorium.mapping.session import reanalyse_station
from luminorium.web.server import create_app

from . import mapping_score
from .conftest import make_settings, wait_for
from .mapping_sim import ENTITY, House, ManualClock, Phone, synth

DRIVE = (ENTITY["drive_l"], ENTITY["drive_r"])


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Rig:
    """Fake HA + the app on a real port + a simulated house and phone."""

    def __init__(self, tmp_path, scenario: synth.Scenario, jpeg_quality: int = 100):
        self.quality = jpeg_quality
        self.tmp_path = tmp_path
        self.house = House(scenario)
        self.clock = ManualClock()
        self.house.clock = self.clock

    async def __aenter__(self):
        self.fake = FakeHA()
        for eid, on in self.house.initial_states().items():
            st = self.fake.states[eid]
            st["state"] = "on" if on else "off"
            st["attributes"]["brightness"] = 255 if on else None
        self.fake.listeners.append(self.house.on_call)
        url = await self.fake.start()
        self.lum = Luminorium(make_settings(url, self.tmp_path), mapping_clock=self.clock)
        await self.lum.start()
        await asyncio.wait_for(self.lum.inventory.loaded.wait(), 10)
        self.port = _free_port()
        app = create_app(self.lum, manage_lifecycle=False)
        self.server = uvicorn.Server(
            uvicorn.Config(app, host="127.0.0.1", port=self.port, log_config=None, ws="auto")
        )
        self.server_task = asyncio.create_task(self.server.serve())
        await wait_for(lambda: self.server.started, timeout=10)
        self.http = aiohttp.ClientSession(f"http://127.0.0.1:{self.port}")
        return self

    async def __aexit__(self, *exc):
        await self.http.close()
        await asyncio.sleep(0.2)  # let the websocket handler see the phone hang up
        self.server.should_exit = True
        await self.server_task
        await self.lum.stop()
        await self.fake.stop()

    async def post(self, path: str, body=None):
        async with self.http.post(path, json=body) as r:
            return r.status, await r.json()

    async def get(self, path: str):
        async with self.http.get(path) as r:
            return r.status, await r.json()

    async def capture(self, stations=("centre", "left", "right")):
        _, view = await self.post("/api/views", {"name": "Front of house"})
        self.view_id = view["id"]
        status, sess = await self.post(
            "/api/mapping/sessions",
            {
                "view_id": self.view_id,
                "targets": list(ENTITY.values()),
                "stations": list(stations),
                "known_distance": {"a": DRIVE[0], "b": DRIVE[1], "metres": 3.0},
            },
        )
        assert status == 200, sess
        self.session_id = sess["id"]
        ws = await self.http.ws_connect(f"/api/mapping/sessions/{self.session_id}/ws")
        self.phone = Phone(self.house, self.clock, ws, jpeg_quality=self.quality)
        await ws.send_str(json.dumps({"type": "hello"}))
        for name in stations:
            await self.phone.run_station(name)
        session = self.lum.mapping.get(self.session_id)
        await asyncio.wait_for(session.wait_analyses(), 300)
        await self.phone.close()
        for name in stations:
            first = Frames(session.folder / name).times[0]
            self.phone.ground_truth(name, first)
        return session


async def _run(tmp_path, name: str) -> dict:
    async with Rig(tmp_path, synth.SCENARIOS[name]) as rig:
        session = await rig.capture()
        results = [session.results[s] for s in session.station_names]
        gt = rig.house.ground_truth()
        s = mapping_score.score(gt, rig.phone.gt, results, session.solution)
        print("\n" + name, mapping_score.row(name, s), f"focal {s['focal_err_pct']:+.3f} %")
        print(
            {
                k: (v["missed"], v["false"], round(1000 * v["clock_error"]))
                for k, v in s["stations"].items()
            }
        )
        status, applied = await rig.post(f"/api/mapping/sessions/{rig.session_id}/apply")
        _, view = await rig.get(f"/api/views/{rig.view_id}")
        return {
            "scores": s,
            "session": session,
            "rig": rig,
            "view": view,
            "applied": (status, applied),
            "calls": list(rig.fake.calls),
            "states": {eid: rig.fake.states[eid]["state"] for eid in ENTITY.values()},
            "initial": rig.house.initial_states(),
            "profiles": {
                eid: rig.lum.inventory.inventory.get(eid).profile for eid in ENTITY.values()
            },
        }


def _common(s, det=0.95, iou=0.8, lat_mean=0.1, pos_mean=1.0, pos_max=5.0, rot=3.0):
    """The prototype's thresholds (proto/mapping/tests/test_mapping.py)."""
    assert s["detection_rate"] >= det, s["stations"]
    assert s["iou_mean"] >= iou
    assert s["latency_err_mean"] <= lat_mean
    assert s["rise_fall_acc"] == 1.0
    assert s["n_triangulated"] >= 14
    assert s["pos_err_pct_mean"] < pos_mean
    assert s["pos_err_pct_max"] < pos_max
    assert s["pose_rot_err_max"] < rot
    assert s["pose_centre_err_pct_max"] < 5.0
    assert abs(s["focal_err_pct"]) < 8.0
    for st in s["stations"].values():
        assert abs(st["clock_error"]) < 0.1
        assert st["clock_source"] == "handshake"


async def test_clean_capture_end_to_end(tmp_path):
    r = await _run(tmp_path, "clean")
    s = r["scores"]
    _common(s)
    # at least as good as the prototype's README row for this scenario: 100 %, 0 false, IoU 0.90,
    # latency 54 / 106 ms, 3D 0.25 % (0.52 %), 4.9 cm, rotation 1.3°, position 1.8 %, focal +2.1 %
    assert s["detection_rate"] == 1.0
    assert s["false_detections"] == 0
    assert s["iou_mean"] >= 0.895  # the README's 0.90, at its precision
    assert s["latency_err_mean"] <= 0.054 and s["latency_err_max"] <= 0.106
    assert s["pos_err_pct_mean"] <= 0.25 and s["pos_err_pct_max"] <= 0.52
    assert s["pos_err_metric_mean"] <= 0.049
    assert s["pose_rot_err_max"] <= 1.3 and s["pose_centre_err_pct_max"] <= 1.8
    assert abs(s["focal_err_pct"]) <= 2.15  # the README's +2.1 %, at its precision

    # the occluded post light: not from the centre, triangulated from the sides
    post = ENTITY["post"]
    by = {x.name: x for x in r["session"].results.values()}
    assert post not in by["centre"].detected()
    assert post in by["left"].detected() and post in by["right"].detected()
    assert r["session"].solution.method[post] == "triangulated"
    # the side-wall sconce: right station only, a ray
    assert r["session"].solution.method[ENTITY["side"]] == "single-station"

    # grouping: the long window as segments in order, the bedroom window as one
    els = s["elements"]
    seg = [e for e in els if e["mode"] == "segments"]
    assert seg and seg[0]["segments"] == [[ENTITY["long1"]], [ENTITY["long2"]], [ENTITY["long3"]]]
    beds = sorted([ENTITY["w_bed1"], ENTITY["w_bed2"]])
    assert any(e["mode"] == "single" and sorted(e["lights"]) == beds for e in els)

    # safety: every light is back as it was, and nothing outside the targets was touched
    assert r["states"] == {eid: "on" if on else "off" for eid, on in r["initial"].items()}
    touched = {e for c in r["calls"] for e in c.entity_ids}
    assert touched <= set(ENTITY.values())
    assert not r["rig"].lum.safety.snapshots

    # latencies written back to the profiles
    prof = r["profiles"][ENTITY["w_kitchen"]]
    assert prof.details.get("latency_measured")
    assert abs(prof.latency_ms - 1000 * (1.30 + 0.25 / 2)) < 150

    # applied to the view: photo, elements, stations
    assert r["applied"][0] == 200, r["applied"]
    view = r["view"]
    assert view["photo"] and len(view["stations"]) == 3
    modes = sorted(e["mode"] for e in view["elements"])
    assert modes.count("segments") == 1
    members = {p["member"] for e in view["elements"] for p in e["parts"]}
    assert members == set(ENTITY.values())
    worlds = [e["world"] for e in view["elements"] if e["world"]]
    assert sum(1 for w in worlds if w["method"] == "triangulated" and w["metric"]) >= 12

    # every raw station was saved and analyses the same offline
    session = r["session"]
    for name in session.station_names:
        folder = session.folder / name
        assert (folder / "frames.csv").exists() and (folder / "motion.json").exists()
        assert (folder / "photo.jpg").exists()
    assert (session.folder / "commands.json").exists()
    offline = await asyncio.to_thread(reanalyse_station, session.folder / "centre", "centre")
    live = session.results["centre"]
    assert offline.detected() == live.detected()
    for k in live.detected():
        assert np.allclose(offline.lights[k].centroid, live.lights[k].centroid, atol=0.01)


# The prototype's README row per scenario: detection, false, IoU, latency mean / max (s), 3D mean /
# max (% of scene), metric (m), rotation (deg), camera position (%), |focal| (%). The add-on must
# do at least as well, except where noted.
README = {
    "heavy_shake": (1.0, 0, 0.80, 0.047, 0.087, 0.52, 0.76, 0.10, 2.5, 3.7, 2.6),
    "exposure_drift": (1.0, 0, 0.89, 0.042, 0.092, 0.16, 0.50, 0.053, 0.2, 1.7, 1.6),
    "jolt": (1.0, 0, 0.90, 0.049, 0.099, 0.14, 0.26, 0.038, 0.5, 0.7, 0.0),
}
# Measured differences (docs/mapping.md): region IoU 0.78 under heavy shake and 0.86 with
# exposure drift; jolt 3D max 0.28 % and focal +0.2 %; drift rotation 0.3 deg.
SLACK = {
    "heavy_shake": {"iou": 0.03},
    "exposure_drift": {"iou": 0.04, "rot": 0.2},
    "jolt": {"max": 0.03, "focal": 0.3},
}


@pytest.mark.slow
@pytest.mark.parametrize("name", ["heavy_shake", "exposure_drift", "jolt"])
async def test_scenarios_end_to_end(tmp_path, name):
    r = await _run(tmp_path, name)
    s = r["scores"]
    det, false, iou, lat, lat_max, mean, mx, metric, rot, pos, focal = README[name]
    slack = SLACK[name]
    # the README rounds: half a unit of its last digit
    iou -= 0.005
    lat, lat_max, mean, mx = lat + 0.0005, lat_max + 0.0005, mean + 0.005, mx + 0.005
    metric, rot, pos, focal = metric + 0.0005, rot + 0.05, pos + 0.05, focal + 0.05
    if name == "heavy_shake":  # the prototype's own test thresholds for this scenario
        _common(s, det=0.9, iou=0.7, lat_mean=0.15, pos_mean=2.0)
    else:
        _common(s)
    assert s["detection_rate"] >= det
    assert s["false_detections"] <= false
    assert s["iou_mean"] >= iou - slack.get("iou", 0)
    assert s["latency_err_mean"] <= lat and s["latency_err_max"] <= lat_max
    assert s["pos_err_pct_mean"] <= mean
    assert s["pos_err_pct_max"] <= mx + slack.get("max", 0)
    assert s["pos_err_metric_mean"] <= metric
    assert s["pose_rot_err_max"] <= rot + slack.get("rot", 0)
    assert s["pose_centre_err_pct_max"] <= pos
    assert abs(s["focal_err_pct"]) <= focal + slack.get("focal", 0)
    if name == "exposure_drift":
        gains = [res.gains for res in r["session"].results.values()]
        assert max(np.ptp(np.log(g)) for g in gains) > np.log(1.25)
    if name == "jolt":
        session = r["session"]
        assert session.stations["centre"].retakes == [ENTITY["long1"]]
        assert session.stations["left"].retakes == [] and session.stations["right"].retakes == []
        lr = session.results["centre"].lights[ENTITY["long1"]]
        assert lr.retake and lr.source == "retake" and lr.detected and lr.rise is True
