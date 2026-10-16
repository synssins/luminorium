"""A simulated house and phone for end-to-end capture tests.

The house is the mapping prototype's synthetic scene (proto/mapping/synth.py): 16 lights at night,
three guided stations with hand shake, auto-exposure, noise and an optional jolt. Each synthetic
light stands in for one entity in the fake HA; when the app sends that entity a service call, the
synthetic light changes after its own latency and ramp.

The phone renders the frames, timestamps them on its own clock (an unknown offset from the
app's), streams them with motion samples over the real websocket, answers the clock handshake,
and sends the reference photo when asked.

Time is simulated (`ManualClock`): the phone renders a frame, waits for the app to acknowledge it,
then advances the clock by one frame; the capture's own timing (steps, holds) runs on the same
clock. Rendering is slower than real time, so this keeps the capture's timing exact.
"""

from __future__ import annotations

import asyncio
import heapq
import itertools
import json
import math
import struct
import sys
from dataclasses import dataclass, field, replace
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "proto" / "mapping"))

import synth  # noqa: E402  (the prototype's renderer and scene)

from luminorium.mapping.clock import Clock  # noqa: E402

# Synthetic light → fake-HA entity standing in for it. The porch (the prototype's sync light) is a
# WLED, so the app picks it for the blink; the four slow lights are Z-Wave dimmers.
ENTITY = {
    "porch": "light.front_pathway_master",
    "w_den": "light.front_pathway_rgb",
    "w_bed2": "light.wiz_rgbww_tunable_c3b549",
    "long1": "light.master_bedroom_arc_lamp_1",
    "long3": "light.master_bedroom_arc_lamp_2",
    "path1": "light.front_entryway_flood_01",
    "path2": "light.front_entryway_flood_02",
    "path3": "light.front_driveway_light_01",
    "path4": "light.front_driveway_light_02",
    "drive_l": "light.garage_light_bulb_1",
    "drive_r": "light.garage_light_bulb_2",
    "post": "light.front_porch_light",
    "w_bed1": "light.living_room_overhead_lights_switch",
    "long2": "light.dining_room_overhead_light_switch",
    "w_kitchen": "light.lower_hallway_light_switch",
    "side": "light.kitchen_cabinet_light_switch",
}
LIGHT_OF = {v: k for k, v in ENTITY.items()}


class ManualClock(Clock):
    """Simulated time. `advance()` moves it and waits until every registered task is asleep again
    (or done), so everything due at a time has happened before the next frame is rendered."""

    def __init__(self, t0: float = 1000.0):
        self.t = t0
        self._heap: list = []
        self._seq = itertools.count()
        self._tasks: set[asyncio.Task] = set()
        self._sleeping: set[asyncio.Task] = set()

    def now(self) -> float:
        return self.t

    def register(self, task: asyncio.Task) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def sleep(self, seconds: float) -> None:
        task = asyncio.current_task()
        if seconds <= 0:
            await asyncio.sleep(0)
            return
        fut = asyncio.get_running_loop().create_future()
        heapq.heappush(self._heap, (self.t + seconds, next(self._seq), fut, task))
        self._sleeping.add(task)
        try:
            await fut
        finally:
            self._sleeping.discard(task)

    async def advance(self, t: float) -> None:
        self.t = max(self.t, t)
        while self._heap and self._heap[0][0] <= self.t + 1e-9:
            _, _, fut, task = heapq.heappop(self._heap)
            self._sleeping.discard(task)
            if not fut.done():
                fut.set_result(None)
        await self.settle()

    async def settle(self, timeout: float = 30.0) -> None:
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        await asyncio.sleep(0)
        while any(not t.done() and t not in self._sleeping for t in self._tasks):
            if loop.time() > end:
                raise TimeoutError("a capture task didn't go back to sleep")
            await asyncio.sleep(0.001)


@dataclass
class StationSim:
    name: str
    cam_nom: synth.Camera
    shake: synth.Shake
    t0: float
    transitions: dict = field(default_factory=dict)  # light → [(t_start, ramp, level)]
    plan_t0: float = 0.0  # the prototype plan's clock at this station's start
    drift: object = None  # exposure drift, a function of the plan's clock
    t_ref: float | None = None
    jolt_t: list = field(default_factory=list)

    def plan_t(self, t: float) -> float:
        return t - self.t0 + self.plan_t0

    frames_sent: int = 0


class House:
    """The synthetic scene, driven by the fake HA's service calls."""

    def __init__(self, sc: synth.Scenario):
        self.sc = sc
        self.lights = synth.default_lights()
        self.by_id = {lt.id: lt for lt in self.lights}
        self.ids = [lt.id for lt in self.lights]
        # the prototype's plan gives the stations; its jolt is injected live instead (the pass
        # timing here is adaptive, so the jolted step happens at a different time)
        self.sim = synth.Simulation(replace(sc, jolt=None))
        self.renderer = self.sim.renderer
        self.K = synth.intrinsics(sc.hfov_true)
        self.rng = np.random.default_rng(sc.seed + 500)
        self.level0 = {lt.id: 1.0 if lt.initial_on else 0.0 for lt in self.lights}
        self.state = dict(self.level0)  # target level after the latest command
        self.station: StationSim | None = None
        self.clock: ManualClock | None = None
        self.jolt_on: tuple | None = sc.jolt  # (station, light)

    def initial_states(self) -> dict[str, bool]:
        return {ENTITY[lt.id]: lt.initial_on for lt in self.lights}

    def new_station(self, name: str, t0: float) -> StationSim:
        """The prototype's station for this scenario: the same camera pose and hand-shake track,
        so the scores compare like for like with proto/mapping/README.md."""
        plan = next(p for p in self.sim.plans if p.name == name)
        shake = synth.Shake(plan.shake.t.copy(), plan.shake.ang.copy(), plan.shake.trans.copy())
        st = StationSim(name, plan.cam_nom, shake, t0, plan_t0=plan.t0)
        st.transitions = {lid: [] for lid in self.ids}
        self.station = st
        return st

    def on_call(self, call) -> None:
        """A service call reached the fake HA: the synthetic light follows after its latency."""
        st, clock = self.station, self.clock
        if st is None or clock is None:
            return
        t = clock.now()
        for eid in call.entity_ids:
            lid = LIGHT_OF.get(eid)
            if lid is None:
                continue
            light = self.by_id[lid]
            target = 1.0 if call.service == "turn_on" else 0.0
            if target == self.state[lid]:
                continue
            lat = light.latency + float(self.rng.normal(0, 0.01))
            st.transitions[lid].append((t + max(0.02, lat), light.ramp, target))
            self.state[lid] = target
            if self.jolt_on and self.jolt_on == (st.name, lid) and target != self.level0[lid]:
                self.inject_jolt(st, t + 0.25)
                self.jolt_on = None

    def inject_jolt(self, st: StationSim, tj: float) -> None:
        deg = math.pi / 180
        s = st.shake.t - st.plan_t(tj)
        rise = np.clip(s / 0.12, 0, 1)
        rise = rise * rise * (3 - 2 * rise)
        bump = np.where(s < 0, 0, rise * np.exp(-np.maximum(s - 0.12, 0) / 0.8))
        st.shake.ang += np.outer(bump, np.array([6.0, 4.0, 2.0]) * deg)
        st.shake.trans += np.outer(bump, [0.015, -0.03, 0.01])
        st.jolt_t.append(tj)

    def level(self, st: StationSim, lid: str, t: float) -> float:
        lvl = self.level0[lid]
        for ts, ramp, tgt in st.transitions[lid]:
            if t < ts:
                break
            if ramp <= 0 or t >= ts + ramp:
                lvl = tgt
            else:
                lvl = lvl + (tgt - lvl) * (t - ts) / ramp
                break
        return lvl

    def levels(self, st: StationSim, t0: float, t1: float) -> np.ndarray:
        ts = np.linspace(t0, t1, 5)
        return np.array(
            [np.mean([self.level(st, lid, t) for t in ts]) for lid in self.ids], np.float32
        )

    def camera_at(self, st: StationSim, t: float) -> synth.Camera:
        a, tr = st.shake.at(st.plan_t(t))
        return synth.Camera(self.K, synth.small_rotation(a) @ st.cam_nom.R, st.cam_nom.C + tr)

    # ---- ground truth (as synth.Simulation.gt_station, at this capture's reference time) -------

    def gt_station(self, st: StationSim) -> dict:
        sc = self.sc
        t_ref = (st.t_ref if st.t_ref is not None else st.t0) + sc.exposure_time / 2
        cam = self.camera_at(st, t_ref)
        base = np.array([self.level0[lid] for lid in self.ids], np.float32)
        rad0 = cv2.GaussianBlur(self.renderer.render(cam, base), (0, 0), 0.8)
        g = 0.09 / float((rad0 @ synth.LUMA).mean())
        masks, visible = {}, []
        for i, lt in enumerate(self.lights):
            on, off = base.copy(), base.copy()
            on[i], off[i] = 1.0, 0.0
            a = cv2.GaussianBlur(self.renderer.render(cam, on), (0, 0), 0.8) * g
            b = cv2.GaussianBlur(self.renderer.render(cam, off), (0, 0), 0.8) * g
            dimg = np.abs(np.clip(a, 0, 1) @ synth.LUMA - np.clip(b, 0, 1) @ synth.LUMA)
            m = dimg > max(0.2 * float(dimg.max()), 0.01)
            masks[ENTITY[lt.id]] = m
            if m.sum() >= 6:
                visible.append(ENTITY[lt.id])
        return {"R": cam.R, "C": cam.C, "masks": masks, "visible": visible}

    def ground_truth(self) -> dict:
        pos = {ENTITY[lt.id]: synth.light_position_gt(lt) for lt in self.lights}
        P = np.array(list(pos.values()))
        return {
            "lights": {
                ENTITY[lt.id]: {
                    "pos": pos[ENTITY[lt.id]],
                    "latency": lt.latency_half,
                    "rise": not lt.initial_on,
                }
                for lt in self.lights
            },
            "scene_size": float(np.linalg.norm(P.max(0) - P.min(0))),
            "f": float(self.K[0, 0]),
        }


class Phone:
    """Renders and streams one station after another over the capture's websocket."""

    def __init__(self, house: House, clock: ManualClock, ws, *, jpeg_quality: int = 95):
        """jpeg_quality 100 sends lossless PNG frames."""
        self.house = house
        self.clock = clock
        self.ws = ws
        self.sc = house.sc
        self.offset = 7321.25 + 3.7 * house.sc.seed  # phone clock = app clock + offset
        self.quality = jpeg_quality
        self.messages: list[dict] = []
        self._acks: dict[int, asyncio.Event] = {}
        self._seq = 0
        self._gain: float | None = None
        self._frame_rng = np.random.default_rng(house.sc.seed * 101)
        self._done: asyncio.Event = asyncio.Event()
        self._photo = False
        self._reader = asyncio.create_task(self._read())
        self.gt: dict[str, dict] = {}
        self.stations: dict[str, StationSim] = {}
        self._motion_i = 0

    def phone_t(self, t: float) -> float:
        return t + self.offset

    async def _read(self) -> None:
        async for msg in self.ws:
            if msg.type != 1:  # TEXT
                continue
            data = json.loads(msg.data)
            kind = data.get("type")
            if kind == "ack":
                ev = self._acks.pop(data["seq"], None)
                if ev:
                    ev.set()
                continue
            self.messages.append(data)
            if kind == "ping":
                await self.ws.send_str(
                    json.dumps(
                        {
                            "type": "pong",
                            "server": data["server"],
                            "phone": self.phone_t(self.clock.now()),
                        }
                    )
                )
            elif kind == "photo":
                self._photo = True
            elif kind in ("station_done", "stopped"):
                self._done.set()

    async def close(self) -> None:
        self._reader.cancel()
        await self.ws.close()

    def _render(self, st: StationSim, t: float) -> np.ndarray:
        sc, house = self.sc, self.house
        tm = t + sc.exposure_time / 2
        cam = house.camera_at(st, tm)
        lv = house.levels(st, t, t + sc.exposure_time)
        rad = house.renderer.render(cam, lv)
        rad = cv2.GaussianBlur(rad, (0, 0), 0.8)
        rad = _motion_blur(rad, st.shake.rate(st.plan_t(tm)), cam.K[0, 0], sc.exposure_time)
        m = float((rad @ synth.LUMA).mean())
        target = 0.09 / max(m, 1e-4)
        if self._gain is None:
            self._gain = target
        else:
            self._gain += (1 - math.exp(-(1 / sc.fps) / 0.6)) * (target - self._gain)
        g = self._gain * self._drift(st, t)
        lin = rad * g
        read, shot = 0.004 * sc.noise, 0.0015 * sc.noise
        sigma = np.sqrt(read**2 + shot * np.maximum(lin, 0))
        lin = lin + self._frame_rng.standard_normal(lin.shape, dtype=np.float32) * sigma
        out = np.power(np.clip(lin, 0, 1), 1 / 2.2) * 255.0
        return np.clip(out + 0.5, 0, 255).astype(np.uint8)  # RGB

    def _drift(self, st: StationSim, t: float) -> float:
        """The prototype's exposure drift for this station (slow oscillations and four ±20 %
        steps), on its clock."""
        return st.drift(st.plan_t(t)) if st.drift else 1.0

    def _motion_rows(self, st: StationSim, t_to: float) -> list:
        """DeviceMotion samples at 60 Hz since the last call (phone clock)."""
        sh = st.shake
        step = int(synth.MOTION_FS / 60)
        i1 = int(np.searchsorted(sh.t, st.plan_t(t_to)))
        idx = np.arange(self._motion_i, i1, step)
        self._motion_i = int(idx[-1] + step) if len(idx) else self._motion_i
        if not len(idx):
            return []
        dt = 1 / synth.MOTION_FS
        lo, hi = max(0, idx[0] - 20), min(len(sh.t), idx[-1] + 21)
        ang = sh.ang[lo:hi]
        tr = sh.trans[lo:hi]
        rate = np.gradient(ang, dt, axis=0) * 180 / math.pi
        acc_w = np.gradient(np.gradient(tr, dt, axis=0), dt, axis=0)
        acc_w = cv2.GaussianBlur(acc_w.astype(np.float64), (1, 9), 0)
        acc = acc_w @ st.cam_nom.R.T
        rng = self._frame_rng
        rows = []
        for i in idx:
            j = i - lo
            r = rate[j] + rng.normal(0, 0.3, 3)
            a = acc[j] + rng.normal(0, 0.08, 3)
            t_app = sh.t[i] - st.plan_t0 + st.t0
            rows.append([self.phone_t(t_app), *map(float, r), *map(float, a)])
        return rows

    async def _send_frame(self, img_rgb: np.ndarray, t: float) -> None:
        bgr = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR)
        if self.quality >= 100:
            ok, buf = cv2.imencode(".png", bgr, [cv2.IMWRITE_PNG_COMPRESSION, 1])
        else:
            ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, self.quality])
        assert ok
        seq = self._seq
        self._seq += 1
        ev = asyncio.Event()
        self._acks[seq] = ev
        header = b"LMF1" + struct.pack("<I", seq) + struct.pack("<d", self.phone_t(t))
        await self.ws.send_bytes(header + buf.tobytes())
        await asyncio.wait_for(ev.wait(), 30)

    async def run_station(self, name: str, max_s: float = 90.0) -> dict:
        clock = self.clock
        st = self.house.new_station(name, clock.now())
        self.stations[name] = st
        # as synth.Simulation.render_station: the same generator for the drift, then the noise
        idx = [p.name for p in self.house.sim.plans].index(name)
        self._frame_rng = np.random.default_rng(self.sc.seed * 101 + idx)
        plan = self.house.sim.plans[idx]
        if self.sc.exposure == "drift":
            st.drift = self.house.sim._exposure_drift(self._frame_rng, plan)
        self._motion_i = 0
        self._gain = None
        self._done.clear()
        await self.ws.send_str(json.dumps({"type": "start", "station": name}))
        await clock.settle()
        dt = 1 / self.sc.fps
        t_end = clock.now() + max_s
        jitter = np.random.default_rng(self.sc.seed + 77)
        while not self._done.is_set():
            t = clock.now()
            if t > t_end:
                raise TimeoutError(f"station {name} didn't finish")
            rows = self._motion_rows(st, t)
            if rows:
                await self.ws.send_str(json.dumps({"type": "motion", "samples": rows}))
            img = self._render(st, t)
            if self._photo:
                photo = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_LINEAR)
                ok, buf = cv2.imencode(".jpg", cv2.cvtColor(photo, cv2.COLOR_RGB2BGR))
                await self.ws.send_bytes(b"LMP1" + buf.tobytes())
                self._photo = False
            await self._send_frame(img, t)
            st.frames_sent += 1
            await clock.advance(t + dt + float(jitter.normal(0, 0.002)))

    def ground_truth(self, name: str, first_frame_phone_t: float) -> dict:
        """Per-station truth, at the camera pose of the first recorded frame (the reference)."""
        st = self.stations[name]
        st.t_ref = first_frame_phone_t - self.offset
        self.gt[name] = self.house.gt_station(st)
        self.gt[name]["video_offset"] = self.offset
        return self.gt[name]


def _motion_blur(img, rate, f, exposure):
    dx = rate[1] * f * exposure
    dy = rate[0] * f * exposure
    L = math.hypot(dx, dy)
    if L < 0.7:
        return img
    n = (int(math.ceil(L)) | 1) + 2
    k = np.zeros((n, n), np.float32)
    c = n // 2
    cv2.line(
        k,
        (int(round(c - dx / 2)), int(round(c - dy / 2))),
        (int(round(c + dx / 2)), int(round(c + dy / 2))),
        1.0,
        1,
    )
    k /= k.sum()
    return cv2.filter2D(img, -1, k)
