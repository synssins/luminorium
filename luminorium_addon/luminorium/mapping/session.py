"""One guided capture: the phone's websocket, the passes at each station, the recording, and the
analysis afterwards (DESIGN.md section 8).

A station runs as its own Safety session (`mapping:<id>:<station>`), so Stop all cancels it and
restores its lights like any other session:

1. wait until the phone is steady, then record a still lead-in (the reference) and ask for a photo
2. the sync blink: the sync light toggles four times
3. the pass: one light (or fixture) inverted per step, left inverted; the next step goes out once
   the live detector has seen the change settle, or after a per-light timeout if nothing changed
4. retakes: a step jolted (motion sensor), unsteady, or not settled gets one revert at the end
5. restore everything together, hold still a little longer (the restore check), done

Then the station is analysed in a worker thread while the user walks to the next one.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import struct
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path

import cv2
import numpy as np

from ..drivers.base import LightState
from ..engine.safety import LightBusy, Safety
from ..inventory.model import Inventory, Kind, Light
from . import analysis, live, recording, results
from . import motion as motion_mod
from .clock import Clock

log = logging.getLogger(__name__)

FRAME_MAGIC = b"LMF1"  # + uint32 seq + float64 phone time (s) + JPEG/PNG/WebP
PHOTO_MAGIC = b"LMP1"  # + JPEG/PNG
MAX_FRAME_BYTES = 2_000_000
MAX_PHOTO_BYTES = 12_000_000

STATIONS = ("centre", "left", "right")
LEAD_S = 1.5  # still lead-in (the reference)
LEAD_FRAMES = 8
STEADY_S = 1.0  # motion this calm for this long before the lead-in starts
# Heavy hand tremor reaches ~30 deg/s smoothed; a jolt is 80+ (proto/mapping/README.md)
STEADY_ROT = 30.0  # deg/s
STEADY_ACC = 3.0  # m/s^2
STEADY_WAIT_S = 10.0  # then start anyway: the analysis copes with shake
SYNC_TOGGLES = 4
MIN_STEP_S = 0.45
HARD_EXTRA_S = 1.5  # a change seen but not settled: wait at most this much past the timeout
RESTORE_HOLD_S = 2.6
NO_FRAMES_S = 4.0
COUNTDOWN_S = 5.0  # record-and-upload: time to start recording before the blink
POLL_S = 1 / 30
SLOW_NETWORKS = {"zwave", "govee_cloud"}


class CaptureError(Exception):
    pass


@dataclass
class Unit:
    """What one step inverts: a light, or every light of a fixture together."""

    id: str
    name: str
    lights: list[Light]
    timeout: float  # adaptive: advance if nothing has changed by then
    fixed_step: float  # record-and-upload mode
    interval: float  # minimum time between two commands to it (its slowest light's rate)
    latency: float  # expected, s
    sync_ok: bool

    @property
    def slow(self) -> bool:
        return self.timeout > 1.0


def _expected_latency(light: Light) -> float:
    profile = light.profile
    if profile is None:
        return 0.25
    return profile.latency_ms / 1000


def make_unit(inv: Inventory, uid: str) -> Unit:
    if uid in inv.fixtures:
        fx = inv.fixtures[uid]
        lights = [inv.lights[e] for e in fx.members if e in inv.lights]
        name = fx.name
    else:
        light = inv.lights.get(uid)
        if light is None:
            raise CaptureError(f"unknown light {uid}")
        if light.fixture:
            raise CaptureError(f"{light.name} is part of a fixture: pick the fixture")
        lights, name = [light], light.name
    lights = [lt for lt in lights if lt.included and lt.kind in (Kind.LIGHT, Kind.SWITCH)]
    if not lights:
        raise CaptureError(f"{name} has no light that can be driven")
    lat = max(_expected_latency(lt) for lt in lights)
    networks = {lt.profile.network if lt.profile else "other" for lt in lights}
    measured = all(lt.profile and lt.profile.details.get("latency_measured") for lt in lights)
    relay = any(lt.profile and lt.profile.relay for lt in lights)
    if networks & SLOW_NETWORKS and not measured:
        timeout = 2.5
    else:
        timeout = min(3.0, max(0.8, 2 * lat + 0.3))
    fixed = 2.2 if (networks & SLOW_NETWORKS or lat > 0.5) else 0.8
    rates = [lt.profile.max_rate_hz for lt in lights if lt.profile and lt.profile.max_rate_hz]
    interval = 1 / min(rates) if rates else 0.5
    return Unit(
        id=uid,
        name=name,
        lights=lights,
        timeout=timeout,
        fixed_step=max(fixed, timeout if networks & SLOW_NETWORKS else fixed),
        interval=interval,
        latency=lat,
        sync_ok=not relay and not networks & SLOW_NETWORKS and interval <= 1.0,
    )


def pass_order(units: list[Unit], sync: Unit | None) -> list[Unit]:
    """Fast lights first, slow last; the sync light is not first (it just blinked)."""
    order = sorted(units, key=lambda u: (u.slow, u.timeout, u.name.lower()))
    if sync is not None and len(order) > 1 and order[0] is sync:
        fast = [u for u in order if not u.slow]
        order.remove(sync)
        order.insert(max(1, len(fast) - 1), sync)
    return order


def choose_sync(units: list[Unit], wanted: str | None = None) -> Unit | None:
    if wanted:
        for u in units:
            if u.id == wanted:
                return u
        raise CaptureError(f"the sync light {wanted} is not one of the lights to map")
    good = [u for u in units if u.sync_ok]
    pool = good or units
    return min(pool, key=lambda u: (len(u.lights) > 1, u.latency, u.interval)) if pool else None


@dataclass
class StationState:
    name: str
    state: str = "pending"  # pending | capturing | recorded | analysing | analysed | failed
    message: str = ""
    mode: str = "live"  # live | record
    frames: int = 0
    retakes: list[str] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)
    handshake: float | None = None

    def to_dict(self) -> dict:
        return dict(self.__dict__)


class CaptureSession:
    def __init__(
        self,
        session_id: str,
        folder: Path,
        *,
        view_id: str,
        targets: list[str],
        stations: list[str],
        sync: str | None,
        known_distance: dict | None,
        inventory: Callable[[], Inventory],
        safety: Safety,
        clock: Clock,
        analysis_lock: asyncio.Lock,
        on_done: Callable[[CaptureSession], Awaitable[None]] | None = None,
        params: analysis.Params | None = None,
        created: float | None = None,
        strict: bool = True,
    ):
        self.id = session_id
        self.folder = folder
        self.view_id = view_id
        self.targets = list(dict.fromkeys(targets))
        self.station_names = stations
        self.sync_id = sync
        self.known_distance = known_distance
        self._inventory = inventory
        self.safety = safety
        self.clock = clock
        self.params = params or analysis.Params()
        self._analysis_lock = analysis_lock
        self._on_done = on_done
        self.created = created or time.time()
        self.stations = {n: StationState(n) for n in stations}
        self.commands: list[dict] = []
        self.status = "waiting"  # waiting | capturing | analysing | done | stopped | error
        self.message = ""
        self.results: dict[str, analysis.StationResult] = {}
        self.summary: dict | None = None
        self.names: dict[str, str] = {}
        self._send: Callable[[dict], Awaitable[None]] | None = None
        self._ws_owner: object | None = None
        self._task: asyncio.Task | None = None
        self._station: str | None = None
        self._recorder: recording.StationRecorder | None = None
        self._recording = False
        self._detector = live.LiveDetector()
        self._motion: list = []
        self._pings: dict[float, float] = {}
        self._clock_samples: list = []  # (rtt, offset) this station
        self._clock_raw: list = []  # [sent, phone, received] this station
        self.solution: analysis.Solution | None = None
        self._photo_wanted = False
        self._last_frame: tuple[float, float] | None = None  # (app clock on arrival, phone time)
        self._analyses: set[asyncio.Task] = set()
        self._step = 0
        self.units: dict[str, Unit] = {}
        self.resolve_units(strict=strict)

    # ---- description ----------------------------------------------------------------------

    def resolve_units(self, strict: bool = True) -> list[Unit]:
        """The lights to flash, from the current inventory. Not strict (an old capture opened
        after a restart, or after a light was removed): skip what can't be resolved."""
        inv = self._inventory()
        units = {}
        for uid in self.targets:
            try:
                units[uid] = make_unit(inv, uid)
            except CaptureError:
                if strict:
                    raise
        self.units = units
        self.names = {uid: self.names.get(uid, uid) for uid in self.targets}
        self.names.update({uid: u.name for uid, u in units.items()})
        return list(units.values())

    def to_dict(self) -> dict:
        try:
            sync = choose_sync(list(self.units.values()), self.sync_id) if self.units else None
        except CaptureError:
            sync = None
        return {
            "id": self.id,
            "view_id": self.view_id,
            "created": self.created,
            "status": self.status,
            "message": self.message,
            "targets": [{"id": u, "name": self.names.get(u, u)} for u in self.targets],
            "sync": sync.id if sync else None,
            "known_distance": self.known_distance,
            "stations": [s.to_dict() for s in self.stations.values()],
            "connected": self._send is not None,
            "active_station": self._station,
            "summary": self.summary,
        }

    def save_meta(self) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        meta = self.to_dict()
        meta["station_names"] = self.station_names
        meta["target_ids"] = self.targets
        meta["sync_id"] = self.sync_id
        recording.write_json(self.folder / "session.json", meta)
        recording.write_json(self.folder / "commands.json", self.commands)

    # ---- the phone's websocket --------------------------------------------------------------

    def attach(self, owner: object, send: Callable[[dict], Awaitable[None]]) -> None:
        self._ws_owner, self._send = owner, send

    async def detach(self, owner: object) -> None:
        if self._ws_owner is not owner:
            return
        self._send, self._ws_owner = None, None
        if self._task and not self._task.done() and self._station:
            st = self.stations[self._station]
            if st.mode == "live":
                await self.stop("the phone disconnected")

    async def send(self, msg: dict) -> None:
        if self._send is None:
            return
        try:
            await self._send(msg)
        except Exception as err:  # a closed socket: the disconnect handler cleans up
            log.debug("send to phone failed: %s", err)

    async def phase(self, phase: str, message: str = "", **extra) -> None:
        if self._station:
            self.stations[self._station].message = message
        await self.send(
            {"type": "phase", "station": self._station, "phase": phase, "message": message, **extra}
        )

    async def on_text(self, msg: dict) -> None:
        kind = msg.get("type")
        if kind == "pong":
            self._pong(msg)
        elif kind == "motion":
            rows = [r for r in msg.get("samples") or [] if isinstance(r, list) and len(r) == 7]
            self._motion.extend(rows)
            if self._recording and self._recorder:
                self._recorder.motion.extend(rows)
            del self._motion[:-4000]
        elif kind == "orientation":
            if self._recording and self._recorder:
                self._recorder.orientation.extend(msg.get("samples") or [])
        elif kind == "hello":
            await self.send({"type": "state", "session": self.to_dict()})
            await self.ping()
        elif kind == "start":
            await self.start_station(str(msg.get("station") or ""), mode="live")
        elif kind == "stop":
            await self.stop("stopped on the phone")
        elif kind == "ping":  # the phone measuring for itself
            await self.send({"type": "pong", "phone": msg.get("phone"), "server": self.clock.now()})

    async def on_binary(self, data: bytes) -> None:
        if data[:4] == FRAME_MAGIC and len(data) > 16:
            if len(data) > MAX_FRAME_BYTES:
                return
            seq = struct.unpack("<I", data[4:8])[0]
            t_phone = struct.unpack("<d", data[8:16])[0]
            image = data[16:]
            self._frame(t_phone, image)
            await self.send({"type": "ack", "seq": seq})
        elif data[:4] == PHOTO_MAGIC and len(data) < MAX_PHOTO_BYTES:
            if self._recorder is not None and self._photo_wanted:
                self._recorder.photo(bytes(data[4:]))
                self._photo_wanted = False
                await self.send({"type": "photo_saved", "station": self._station})

    def _frame(self, t_phone: float, image: bytes) -> None:
        self._last_frame = (self.clock.now(), t_phone)
        if self._recording and self._recorder is not None:
            try:
                self._recorder.frame(t_phone, image)
            except ValueError:
                return
            self.stations[self._station or ""].frames = self._recorder.count
        if self._task is None or self._task.done():
            return
        gray = cv2.imdecode(np.frombuffer(image, np.uint8), cv2.IMREAD_REDUCED_GRAYSCALE_2)
        if gray is not None:
            self._detector.add(t_phone, gray)

    # ---- clock handshake --------------------------------------------------------------------

    async def ping(self) -> None:
        t = self.clock.now()
        self._pings[t] = t
        while len(self._pings) > 50:
            self._pings.pop(next(iter(self._pings)))
        await self.send({"type": "ping", "server": t})

    def _pong(self, msg: dict) -> None:
        try:
            sent = float(msg["server"])
            phone = float(msg["phone"])
        except (KeyError, TypeError, ValueError):
            return
        if sent not in self._pings:
            return
        received = self.clock.now()
        rtt = received - sent
        offset = phone - (sent + received) / 2  # phone = server + offset
        self._clock_samples.append((rtt, offset))
        self._clock_raw.append([sent, phone, received])
        if self._recording and self._recorder:
            self._recorder.clock.append([sent, phone, received])

    def offset(self) -> float | None:
        """phone = server + offset, from the fastest recent round trips (or, before any, from
        the latest frame's arrival)."""
        if not self._clock_samples:
            if self._last_frame is not None:
                arrived, t_phone = self._last_frame
                return t_phone - arrived
            return None
        best = sorted(self._clock_samples[-30:])[:3]
        return float(np.median([o for _, o in best]))

    # ---- motion -----------------------------------------------------------------------------

    def _motion_stream(self) -> dict:
        return motion_mod.from_rows(self._motion)

    def _steady(self, offset: float | None) -> bool:
        if not self._motion:
            return True
        m = self._motion_stream()
        t_now = m["t"][-1] if offset is None else self.clock.now() + offset
        rot, acc = motion_mod.jolt_score(m, t_now - STEADY_S, t_now + 1)
        return rot < STEADY_ROT and acc < STEADY_ACC

    # ---- stations ---------------------------------------------------------------------------

    async def start_station(self, name: str, mode: str = "live") -> None:
        if name not in self.stations:
            raise CaptureError(f"unknown station {name!r}")
        if self._task is not None and not self._task.done():
            raise CaptureError("a station is already running")
        if mode == "live" and self._send is None:
            raise CaptureError("the phone is not connected")
        units = self.resolve_units()
        for u in units:
            for lt in u.lights:
                snap = self.safety.snapshots.get(lt.entity_id)
                if snap is not None:
                    raise CaptureError(f"{lt.name} is in use by {snap.session}")
        st = self.stations[name]
        st.state, st.mode, st.message, st.frames = "capturing", mode, "", 0
        st.retakes, st.dropped = [], []
        self.commands = [c for c in self.commands if c["station"] != name]
        recording.remove(self.folder / name)
        self.results.pop(name, None)
        self.status = "capturing"
        self._station = name
        session = self.safety.session(f"mapping:{self.id}:{name}")
        self._task = session.run(self._run_station(session, name, units, mode))
        self._task.add_done_callback(lambda t, n=name: asyncio.ensure_future(self._finished(t, n)))
        self.save_meta()

    async def stop(self, reason: str) -> None:
        task = self._task
        if task is None or task.done():
            return
        name = self._station
        session = self.safety.sessions.get(f"mapping:{self.id}:{name}")
        if session is not None:
            await self.safety.end_session(session, restore=True)
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await task
        self.message = reason

    async def _finished(self, task: asyncio.Task, name: str) -> None:
        st = self.stations[name]
        self._recording = False
        if self._recorder is not None:
            self._recorder.close()
            self._recorder = None
        self._detector.end()
        if task.cancelled():
            st.state, st.message = "failed", "stopped; the lights were put back"
            self.status, self.message = "stopped", self.message or "stopped"
            await self.send({"type": "stopped", "station": name, "message": self.message})
        elif task.exception() is not None:
            err = task.exception()
            st.state, st.message = "failed", str(err)
            self.status, self.message = "error", str(err)
            log.warning("Capture %s station %s failed: %s", self.id, name, err)
            await self.send({"type": "stopped", "station": name, "message": str(err)})
        else:
            st.state = "recorded"
            if st.mode == "live":
                self.schedule_analysis(name)
            else:
                st.message = "pass done: stop recording and upload the video"
            self.status = "capturing"
            nxt = next((s for s in self.station_names if self.stations[s].state == "pending"), None)
            await self.send({"type": "station_done", "station": name, "next": nxt})
        self._station = None
        self.save_meta()

    async def _run_station(self, session, name: str, units: list[Unit], mode: str) -> None:
        clock = self.clock
        clock.register(asyncio.current_task())  # type: ignore[arg-type]
        st = self.stations[name]
        live_mode = mode == "live"
        sync = choose_sync(units, self.sync_id)
        order = pass_order(units, sync)
        original = {lt.entity_id: lt.is_on for u in units for lt in u.lights}
        self._step = 0
        self._clock_samples, self._clock_raw = [], []
        try:
            if live_mode:
                await self.phase("steady", "Hold the phone still with the anchor in the middle")
                for _ in range(5):
                    await self.ping()
                    await clock.sleep(0.05)
                t0 = clock.now()
                while not self._steady(self.offset()) or clock.now() - t0 < STEADY_S:
                    await clock.sleep(1 / 15)
                    if clock.now() - t0 > STEADY_WAIT_S:
                        await self.phase("steady", "Hold as still as you can")
                        break
            else:
                for k in range(int(COUNTDOWN_S), 0, -1):
                    await self.phase("countdown", f"Start recording now: {k}")
                    await clock.sleep(1.0)

            self._recorder = recording.StationRecorder(self.folder / name)
            self._recorder.clock.extend(self._clock_raw)
            self._recording = True
            if live_mode:
                self._photo_wanted = True
                await self.send({"type": "photo", "station": name})
                await self.phase("reference", "Hold still: taking the reference")
                t_ref = clock.now()
                while self._recorder.count < LEAD_FRAMES or clock.now() - t_ref < LEAD_S:
                    await clock.sleep(POLL_S)
                    if clock.now() - t_ref > NO_FRAMES_S + LEAD_S and self._recorder.count == 0:
                        raise CaptureError("no frames from the phone")
            else:
                await self.phase("reference", "Hold still")
                await clock.sleep(LEAD_S + 0.5)

            if sync is not None:
                await self.phase("sync", f"Sync blink: {sync.name}")
                period = max(0.4, sync.interval + 0.05)
                inverted = _inverted(sync, original)
                for k in range(SYNC_TOGGLES):
                    target = inverted if k % 2 == 0 else _restored(sync, original)
                    await self._command(session, sync, target, "sync")
                    if k < SYNC_TOGGLES - 1:
                        await clock.sleep(period)
                await clock.sleep(max(0.8, period + 0.4))

            retakes: list[Unit] = []
            for i, unit in enumerate(order):
                await self.phase(
                    "pass", f"{i + 1} of {len(order)}: {unit.name}", step=i, steps=len(order)
                )
                t_cmd = await self._command(session, unit, _inverted(unit, original), "invert")
                status = await self._wait_step(unit, t_cmd, live_mode)
                if live_mode:
                    await self.ping()  # follow any drift between the clocks
                if self._needs_retake(t_cmd, status, live_mode):
                    retakes.append(unit)
                    await self.phase("hold", "Hold still", light=unit.name)
            for unit in retakes:
                st.retakes.append(unit.id)
                await self.phase("retake", f"Again: {unit.name}")
                t_cmd = await self._command(session, unit, _restored(unit, original), "revert")
                await self._wait_step(unit, t_cmd, live_mode)

            await self.phase("restore", "Putting the lights back")
            self._log(name, None, "restore_all")
            session.tasks.discard(asyncio.current_task())  # type: ignore[arg-type]
            await asyncio.shield(self.safety.end_session(session, restore=True))
            st.dropped = sorted(session.dropped)
            await self.phase("hold", "Hold still a moment longer")
            await clock.sleep(RESTORE_HOLD_S)
            st.handshake = self.offset()
        except Exception:
            # an error (HA gone, the frames stopped): put the lights back now, not at Stop all
            if self.safety.sessions.get(session.name) is session:
                session.tasks.discard(asyncio.current_task())  # type: ignore[arg-type]
                await asyncio.shield(self.safety.end_session(session, restore=True))
            raise
        finally:
            self._recording = False
            if self._recorder is not None:
                self._recorder.flush()

    def _log(self, station: str, unit: str | None, action: str) -> float:
        t = self.clock.now()
        self.commands.append(
            {"t": t, "station": station, "light": unit, "action": action, "step": self._step}
        )
        self._step += 1
        return t

    async def _command(self, session, unit: Unit, target: dict[str, bool], action: str) -> float:
        assert self._station is not None
        t = self._log(self._station, unit.id, action)

        async def one(light: Light) -> None:
            on = target[light.entity_id]
            brightness = 255 if on and light.entity_id.startswith("light.") else None
            try:
                await self.safety.command(
                    session, light, LightState(on=on, brightness=brightness), transition_ms=0
                )
            except LightBusy as err:
                log.warning("Capture: %s", err)

        await asyncio.gather(*(one(lt) for lt in unit.lights))
        return t

    async def _wait_step(self, unit: Unit, t_cmd: float, live_mode: bool):
        clock = self.clock
        if not live_mode:
            await clock.sleep(unit.fixed_step - (clock.now() - t_cmd))
            return None
        offset = self.offset() or 0.0
        det = self._detector
        det.begin(t_cmd + offset, self.params.min_latency)
        hard = unit.timeout + HARD_EXTRA_S
        while True:
            await clock.sleep(POLL_S)
            status = det.status
            elapsed = clock.now() - t_cmd
            last = det.last_t
            seen = (last - offset - t_cmd) if last is not None else -1.0
            arrived = self._last_frame[0] if self._last_frame else -1e9
            if clock.now() - arrived > NO_FRAMES_S:
                raise CaptureError("the frames stopped coming")
            if elapsed < MIN_STEP_S:
                continue
            if status.settled and seen >= MIN_STEP_S:
                break
            if not status.changed and seen >= unit.timeout:
                break
            if elapsed >= hard:
                break
        status = det.end()
        if self._recorder is not None:
            mask = det._previous
            where = None
            if mask is not None:
                ys, xs = np.nonzero(mask)
                where = [
                    round(float(xs.mean()) / mask.shape[1], 3),
                    round(float(ys.mean()) / mask.shape[0], 3),
                ]
            self._recorder.live.append(
                {
                    "light": unit.id,
                    "t": t_cmd,
                    "duration": round(clock.now() - t_cmd, 3),
                    "changed": status.changed,
                    "settled": status.settled,
                    "unsteady": status.unsteady,
                    "first_change": None
                    if status.first_change is None
                    else round(status.first_change - offset - t_cmd, 3),
                    "where": where,
                }
            )
        return status

    def _needs_retake(self, t_cmd: float, status, live_mode: bool) -> bool:
        if not live_mode or status is None:
            return False
        offset = self.offset() or 0.0
        jolt = motion_mod.is_jolt(
            self._motion_stream(), t_cmd + offset - 0.1, self.clock.now() + offset + 0.1
        )
        return jolt or status.unsteady

    # ---- analysis ---------------------------------------------------------------------------

    def schedule_analysis(self, name: str, *, upload: bool = False) -> asyncio.Task:
        task = asyncio.create_task(self._analyse(name, upload=upload))
        self._analyses.add(task)
        task.add_done_callback(self._analyses.discard)
        return task

    async def wait_analyses(self) -> None:
        while self._analyses:
            await asyncio.gather(*list(self._analyses), return_exceptions=True)

    async def _analyse(self, name: str, *, upload: bool = False) -> None:
        st = self.stations[name]
        st.state = "analysing"
        await self.send({"type": "analysis", "station": name, "state": "analysing"})
        inventory = [{"id": uid} for uid in self.targets]
        p = analysis.Params(**self.params.__dict__)
        if upload:
            p.sync_search = 1e9
        try:
            async with self._analysis_lock:
                res = await asyncio.to_thread(
                    _analyse_station, self.folder / name, name, self.commands, inventory, p, upload
                )
        except Exception as err:
            log.exception("Analysis of %s/%s failed", self.id, name)
            st.state, st.message = "failed", f"analysis failed: {err}"
            await self.send({"type": "analysis", "station": name, "state": "failed"})
            self.save_meta()
            return
        self.results[name] = res
        st.state = "analysed"
        found = len(res.detected(p.min_conf))
        st.message = f"{found} of {len(self.targets)} found"
        await self.send({"type": "analysis", "station": name, "state": "analysed", "found": found})
        if all(
            self.stations[s].state in ("analysed", "failed") for s in self.station_names
        ) and any(self.stations[s].state == "analysed" for s in self.station_names):
            await self.solve()
        else:
            self.save_meta()

    async def solve(self) -> dict:
        """Combine the analysed stations: grouping, 3D, elements. Writes results.json."""
        names = [s for s in self.station_names if s in self.results]
        if not names:
            raise CaptureError("no station has been analysed")
        res = [self.results[s] for s in names]
        p = self.params
        known = None
        kd = self.known_distance
        if kd and kd.get("a") and kd.get("b") and kd.get("metres"):
            known = (kd["a"], kd["b"], float(kd["metres"]))
        sol = await asyncio.to_thread(
            analysis.solve_3d, res, tuple(res[0].size), p, known_distance=known
        )
        self.solution = sol
        els, missing = results.elements(res, sol, self.names, p)
        stations = results.stations(res, sol, self.id)
        photo = self.folder / names[0] / "photo.jpg"
        if not photo.exists():
            ok, buf = cv2.imencode(
                ".jpg",
                cv2.cvtColor(res[0].ref_image, cv2.COLOR_RGB2BGR),
                [cv2.IMWRITE_JPEG_QUALITY, 92],
            )
            if ok:
                (self.folder / "reference.jpg").write_bytes(buf.tobytes())
        out = {
            "session": self.id,
            "view_id": self.view_id,
            "stations": [results.station_summary(r, p) for r in res],
            "elements": [e.to_dict() for e in els],
            "missing": missing,
            "latency_ms": results.latencies(res, p),
            "sync": self.to_dict()["sync"],
            "solution": {
                "focal_px": round(float(sol.f), 2),
                "reproj_rms": None if np.isnan(sol.reproj_rms) else round(sol.reproj_rms, 3),
                "metric": sol.scale_known,
                "method": sol.method,
                "note": sol.note,
            },
            "station_poses": [s.to_dict() for s in stations],
            "photo": f"{names[0]}/photo.jpg" if photo.exists() else "reference.jpg",
        }
        recording.write_json(self.folder / "results.json", out)
        self.summary = {
            "elements": len(els),
            "missing": missing,
            "found": sum(len(e.parts) for e in els),
            "metric": sol.scale_known,
        }
        self.status = "done"
        self.save_meta()
        await self.send({"type": "results", "summary": self.summary})
        if self._on_done:
            await self._on_done(self)
        return out

    def load_results(self) -> dict | None:
        return recording.read_json(self.folder / "results.json")


def _inverted(unit: Unit, original: dict[str, bool]) -> dict[str, bool]:
    """A fixture changes as one: all off if any light was on, else all on."""
    any_on = any(original[lt.entity_id] for lt in unit.lights)
    return {lt.entity_id: not any_on for lt in unit.lights}


def _restored(unit: Unit, original: dict[str, bool]) -> dict[str, bool]:
    return {lt.entity_id: original[lt.entity_id] for lt in unit.lights}


def _analyse_station(
    folder: Path, name: str, commands: list, inventory: list, p: analysis.Params, upload: bool
) -> analysis.StationResult:
    data = recording.load_station(folder)
    handshake = None
    if not upload and data["clock"]:
        samples = sorted(
            ((r - s, ph - (s + r) / 2) for s, ph, r in data["clock"]), key=lambda x: x[0]
        )[:3]
        handshake = float(np.median([o for _, o in samples]))
    return analysis.analyze_station(
        name, data["frames"], data["t"], data["motion"], commands, inventory, p, handshake
    )


def reanalyse_station(folder: Path, name: str, p: analysis.Params | None = None):
    """Run the analysis again on a recorded station (offline), from the files alone."""
    commands = recording.read_json(folder.parent / "commands.json", [])
    meta = json.loads((folder.parent / "session.json").read_text(encoding="utf-8"))
    inventory = [{"id": uid} for uid in meta.get("target_ids") or []]
    st = next((s for s in meta.get("stations") or [] if s["name"] == name), {})
    return _analyse_station(
        folder, name, commands, inventory, p or analysis.Params(), st.get("mode") == "record"
    )
