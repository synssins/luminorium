"""Camera mapping API: capture sessions, the phone's websocket, uploads, results."""

from __future__ import annotations

import contextlib
import json
import logging
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..app import Luminorium
from ..mapping.session import CaptureError
from ..spatial.service import SpatialError

log = logging.getLogger(__name__)

MAX_VIDEO_BYTES = 600_000_000


class SessionBody(BaseModel):
    view_id: str
    targets: list[str]
    stations: list[str] | None = None
    sync: str | None = None
    known_distance: dict | None = None  # {"a": unit, "b": unit, "metres": 3.0}


class SolveBody(BaseModel):
    known_distance: dict | None = None


def router(lum: Luminorium) -> APIRouter:
    api = APIRouter()
    mapping = lum.mapping
    allowed = set(lum.settings.allowed_clients)

    def session(session_id: str):
        try:
            return mapping.get(session_id)
        except (KeyError, ValueError) as err:
            raise HTTPException(404, f"unknown capture {session_id}") from err

    def details(s) -> dict:
        out = s.to_dict()
        out["results"] = s.load_results()
        return out

    @api.get("/api/mapping/sessions")
    async def sessions():
        return mapping.list()

    @api.post("/api/mapping/sessions")
    async def create(body: SessionBody):
        try:
            s = mapping.create(
                body.view_id,
                body.targets,
                stations=body.stations,
                sync=body.sync,
                known_distance=body.known_distance,
            )
        except KeyError as err:
            raise HTTPException(404, f"unknown view {body.view_id}") from err
        except (CaptureError, ValueError) as err:
            raise HTTPException(409, str(err)) from err
        return s.to_dict()

    @api.get("/api/mapping/sessions/{session_id}")
    async def get(session_id: str):
        return details(session(session_id))

    @api.delete("/api/mapping/sessions/{session_id}")
    async def delete(session_id: str):
        session(session_id)
        try:
            mapping.delete(session_id)
        except CaptureError as err:
            raise HTTPException(409, str(err)) from err
        return {"deleted": session_id}

    @api.post("/api/mapping/sessions/{session_id}/stop")
    async def stop(session_id: str):
        await session(session_id).stop("stopped")
        return {"stopped": session_id}

    @api.post("/api/mapping/sessions/{session_id}/stations/{station}/record")
    async def record(session_id: str, station: str):
        if lum.settings.read_only:
            raise HTTPException(409, "Luminorium is read-only: nothing is sent to lights")
        s = session(session_id)
        try:
            await s.start_station(station, mode="record")
        except CaptureError as err:
            raise HTTPException(409, str(err)) from err
        return s.to_dict()

    @api.put("/api/mapping/sessions/{session_id}/stations/{station}/video")
    async def video(session_id: str, station: str, request: Request):
        session(session_id)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "upload.video"
            size = 0
            with path.open("wb") as f:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_VIDEO_BYTES:
                        raise HTTPException(413, "the video is too large")
                    f.write(chunk)
            try:
                await mapping.upload_video(session_id, station, path)
            except (CaptureError, ValueError) as err:
                raise HTTPException(409, str(err)) from err
        return {"uploaded": station}

    @api.post("/api/mapping/sessions/{session_id}/solve")
    async def solve(session_id: str, body: SolveBody):
        s = session(session_id)
        if body.known_distance is not None:
            kd = body.known_distance
            if kd and not {kd.get("a"), kd.get("b")} <= set(s.units):
                raise HTTPException(400, "the known distance must be between two mapped lights")
            s.known_distance = kd or None
        try:
            if not s.results:
                return details(s) | {"results": await mapping.reanalyse(session_id)}
            await s.solve()
        except CaptureError as err:
            raise HTTPException(409, str(err)) from err
        return details(s)

    @api.post("/api/mapping/sessions/{session_id}/reanalyse")
    async def reanalyse(session_id: str):
        session(session_id)
        try:
            await mapping.reanalyse(session_id)
        except CaptureError as err:
            raise HTTPException(409, str(err)) from err
        return details(session(session_id))

    @api.post("/api/mapping/sessions/{session_id}/apply")
    async def apply(session_id: str):
        session(session_id)
        try:
            out = mapping.apply(session_id)
        except KeyError as err:
            raise HTTPException(404, "the capture's view no longer exists") from err
        except (CaptureError, SpatialError) as err:
            raise HTTPException(409, str(err)) from err
        return out

    @api.get("/api/mapping/sessions/{session_id}/photo")
    async def photo(session_id: str):
        s = session(session_id)
        out = s.load_results()
        if not out:
            raise HTTPException(404, "no results yet")
        path = (s.folder / out["photo"]).resolve()
        if not path.is_relative_to(s.folder.resolve()) or not path.exists():
            raise HTTPException(404, "no photo")
        return FileResponse(path, media_type="image/jpeg")

    @api.websocket("/api/mapping/sessions/{session_id}/ws")
    async def ws(websocket: WebSocket, session_id: str):
        # The http middleware doesn't see websockets: check the client here too
        client = websocket.client.host if websocket.client else ""
        if allowed and client not in allowed:
            await websocket.close(code=1008)
            return
        try:
            s = mapping.get(session_id)
        except (KeyError, ValueError):
            await websocket.close(code=1008)
            return
        await websocket.accept()
        owner = object()

        async def send(msg: dict) -> None:
            await websocket.send_text(json.dumps(msg))

        s.attach(owner, send)
        try:
            while True:
                msg = await websocket.receive()
                if msg["type"] == "websocket.disconnect":
                    break
                if msg.get("bytes") is not None:
                    await s.on_binary(msg["bytes"])
                elif msg.get("text") is not None:
                    try:
                        data = json.loads(msg["text"])
                    except json.JSONDecodeError:
                        continue
                    try:
                        if data.get("type") == "start" and lum.settings.read_only:
                            raise CaptureError("Luminorium is read-only")
                        await s.on_text(data)
                    except CaptureError as err:
                        await send({"type": "error", "message": str(err)})
        except WebSocketDisconnect:
            pass
        finally:
            with contextlib.suppress(Exception):
                await s.detach(owner)

    return api
