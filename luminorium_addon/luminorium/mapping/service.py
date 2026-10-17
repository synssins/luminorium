"""Capture sessions: create, run (one at a time), list, analyse again, apply to a view."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from pathlib import Path

from ..engine.safety import Safety
from ..inventory.service import InventoryService
from ..spatial.model import Element, Station
from ..spatial.service import SpatialService, encode_photo
from . import analysis, recording
from .clock import Clock
from .session import STATIONS, CaptureError, CaptureSession, choose_sync, reanalyse_station

log = logging.getLogger(__name__)

KEEP_SESSIONS = 10


class MappingService:
    def __init__(
        self,
        config_dir: Path,
        inventory: InventoryService,
        safety: Safety,
        spatial: SpatialService,
        *,
        read_only: bool,
        clock: Clock | None = None,
        params: analysis.Params | None = None,
    ):
        self.root = config_dir / "mapping" / "sessions"
        self.root.mkdir(parents=True, exist_ok=True)
        self.inventory = inventory
        self.safety = safety
        self.spatial = spatial
        self.read_only = read_only
        self.clock = clock or Clock()
        self.params = params
        self.sessions: dict[str, CaptureSession] = {}
        self._analysis_lock = asyncio.Lock()

    # ---- sessions -------------------------------------------------------------------------

    def create(
        self,
        view_id: str,
        targets: list[str],
        *,
        stations: list[str] | None = None,
        sync: str | None = None,
        known_distance: dict | None = None,
    ) -> CaptureSession:
        if self.read_only:
            raise CaptureError("Luminorium is read-only: nothing is sent to lights")
        self.spatial.get(view_id)
        if not targets:
            raise CaptureError("pick the lights that are visible from here")
        stations = stations or list(STATIONS)
        for s in stations:
            recording.check_name(s)
        if len(set(stations)) != len(stations):
            raise CaptureError("station names must be different")
        for s in self.sessions.values():
            if s.status == "capturing" and s._task is not None and not s._task.done():
                raise CaptureError("another capture is running")
        sid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:4]
        session = CaptureSession(
            sid,
            self.root / sid,
            view_id=view_id,
            targets=targets,
            stations=stations,
            sync=sync,
            known_distance=known_distance,
            inventory=lambda: self.inventory.inventory,
            safety=self.safety,
            clock=self.clock,
            analysis_lock=self._analysis_lock,
            on_done=self._session_done,
            params=self.params,
        )
        choose_sync(list(session.units.values()), sync)  # validates an explicit sync light
        if known_distance:
            for key in ("a", "b"):
                if known_distance.get(key) not in session.units:
                    raise CaptureError("the known distance must be between two mapped lights")
        session.save_meta()
        self.sessions[sid] = session
        self._prune()
        return session

    def get(self, session_id: str) -> CaptureSession:
        if session_id in self.sessions:
            return self.sessions[session_id]
        recording.check_name(session_id)
        folder = self.root / session_id
        meta = recording.read_json(folder / "session.json")
        if not meta:
            raise KeyError(session_id)
        if not meta.get("target_ids"):
            raise KeyError(session_id)
        session = CaptureSession(
            session_id,
            folder,
            view_id=meta["view_id"],
            targets=meta["target_ids"],
            stations=meta.get("station_names") or list(STATIONS),
            sync=meta.get("sync_id"),
            known_distance=meta.get("known_distance"),
            inventory=lambda: self.inventory.inventory,
            safety=self.safety,
            clock=self.clock,
            analysis_lock=self._analysis_lock,
            on_done=self._session_done,
            params=self.params,
            created=meta.get("created"),
            strict=False,
        )
        session.commands = recording.read_json(folder / "commands.json", [])
        for st in meta.get("stations") or []:
            if st["name"] in session.stations:
                state = session.stations[st["name"]]
                state.__dict__.update({k: v for k, v in st.items() if k in state.__dict__})
                if state.state in ("capturing", "analysing"):
                    state.state = "failed" if state.state == "capturing" else "recorded"
        session.status = meta.get("status", "done")
        if session.status in ("capturing", "analysing"):
            session.status = "stopped"
        session.summary = meta.get("summary")
        self.sessions[session_id] = session
        return session

    def list(self) -> list[dict]:
        out = []
        for d in sorted(self.root.iterdir(), reverse=True):
            meta = recording.read_json(d / "session.json") if d.is_dir() else None
            if meta:
                live = self.sessions.get(d.name)
                out.append(live.to_dict() if live else meta)
        return out

    def delete(self, session_id: str) -> None:
        session = self.get(session_id)
        if session._task is not None and not session._task.done():
            raise CaptureError("the capture is running: stop it first")
        self.sessions.pop(session_id, None)
        recording.remove(session.folder)

    def _prune(self) -> None:
        """Keep the newest KEEP_SESSIONS recordings (each is tens of megabytes)."""
        dirs = sorted(d for d in self.root.iterdir() if d.is_dir())
        for d in dirs[:-KEEP_SESSIONS]:
            if d.name in self.sessions and self.sessions[d.name].status == "capturing":
                continue
            self.sessions.pop(d.name, None)
            recording.remove(d)

    async def stop_all(self) -> None:
        for s in list(self.sessions.values()):
            await s.stop("stopped")

    # ---- record-and-upload fallback -----------------------------------------------------------

    async def upload_video(self, session_id: str, station: str, video: Path) -> None:
        session = self.get(session_id)
        if station not in session.stations:
            raise CaptureError(f"unknown station {station!r}")
        st = session.stations[station]
        if st.mode != "record" or st.state not in ("recorded", "failed", "analysed"):
            raise CaptureError("run the pass for this station in record mode first")
        if not any(c["station"] == station for c in session.commands):
            raise CaptureError("this station has no pass to match the video to")
        folder = session.folder / station
        n = await asyncio.to_thread(recording.video_to_frames, video, folder)
        st.frames, st.state = n, "recorded"
        session.save_meta()
        session.schedule_analysis(station, upload=True)

    # ---- offline -------------------------------------------------------------------------

    async def reanalyse(self, session_id: str) -> dict:
        """Analyse every recorded station again from the files, then combine."""
        session = self.get(session_id)
        if session._task is not None and not session._task.done():
            raise CaptureError("the capture is running")
        p = self.params or analysis.Params()
        for name in session.station_names:
            folder = session.folder / name
            if not (folder / "frames.csv").exists():
                continue
            async with self._analysis_lock:
                res = await asyncio.to_thread(reanalyse_station, folder, name, p)
            session.results[name] = res
            session.stations[name].state = "analysed"
        return await session.solve()

    # ---- results into the view and the profiles ---------------------------------------------

    async def _session_done(self, session: CaptureSession) -> None:
        out = session.load_results() or {}
        lat = out.get("latency_ms") or {}
        inv = self.inventory.inventory
        per_light = {}
        for uid, ms in lat.items():
            members = inv.fixtures[uid].members if uid in inv.fixtures else [uid]
            for eid in members:
                per_light[eid] = ms
        if per_light:
            self.inventory.set_measured_latency(per_light, session=session.id)

    def apply(self, session_id: str) -> dict:
        session = self.get(session_id)
        out = session.load_results()
        if not out:
            raise CaptureError("the capture has no results yet")
        photo_file = session.folder / out["photo"]
        photo = None
        if photo_file.exists():
            photo, _ = encode_photo(photo_file.read_bytes())
        elements = [Element.from_dict(e) for e in out["elements"]]
        stations = [Station.from_dict(s) for s in out["station_poses"]]
        station_photos = {}
        for st in stations:
            f = session.folder / st.name / "photo.jpg"
            if f.exists():
                station_photos[st.name] = encode_photo(f.read_bytes())[0]
        mapping = {
            "session": session.id,
            "focal_px": out["solution"]["focal_px"],
            "metric": out["solution"]["metric"],
            "missing": out["missing"],
            "applied": time.time(),
        }
        return self.spatial.apply_capture(
            session.view_id,
            photo_jpeg=photo,
            elements=elements,
            stations=stations,
            station_photos=station_photos,
            mapping=mapping,
        )
