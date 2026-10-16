"""Web UI and API, served through HA Ingress.

Ingress serves the app under a per-session path prefix, so every page uses relative URLs.
In the add-on, only the Supervisor's ingress proxy may connect.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import __version__
from ..app import Luminorium
from ..engine.testlight import LightTestError
from ..inventory.model import Kind

STATIC = Path(__file__).parent / "static"


class IncludeBody(BaseModel):
    include: bool | None


def create_app(lum: Luminorium, *, manage_lifecycle: bool = True) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if manage_lifecycle:
            await lum.start()
        try:
            yield
        finally:
            if manage_lifecycle:
                await lum.stop()

    app = FastAPI(title="Luminorium", version=__version__, lifespan=lifespan, docs_url=None)
    allowed = set(lum.settings.allowed_clients)

    @app.middleware("http")
    async def only_ingress(request: Request, call_next):
        if allowed:
            client = request.client.host if request.client else ""
            if client not in allowed:
                return JSONResponse({"detail": "Use Luminorium through Home Assistant"}, 403)
        response = await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html")

    @app.get("/camera")
    async def camera():
        return FileResponse(STATIC / "camera.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    @app.get("/api/status")
    async def status():
        return {
            "version": __version__,
            "connected": lum.ha.connected,
            "ha_version": lum.ha.ha_version,
            "read_only": lum.settings.read_only,
            "loaded": lum.inventory.loaded.is_set(),
            "counts": lum.inventory.counts(),
            "sessions": sorted(lum.safety.sessions),
            "touched": sorted(lum.safety.snapshots),
            "activity": list(lum.safety.activity)[:30],
        }

    @app.get("/api/inventory")
    async def inventory():
        inv = lum.inventory.inventory
        return {
            "floors": [vars(f) for f in inv.floors.values()],
            "areas": [vars(a) for a in inv.areas.values()],
            "lights": [
                light.to_dict() for light in inv.lights.values() if light.kind != Kind.SEGMENT
            ],
        }

    @app.put("/api/lights/{entity_id}/include")
    async def set_include(entity_id: str, body: IncludeBody):
        try:
            lum.inventory.set_choice(entity_id, body.include)
        except KeyError as err:
            raise HTTPException(404, f"unknown light {entity_id}") from err
        light = lum.inventory.inventory.get(entity_id)
        return light.to_dict() if light else {}

    @app.post("/api/lights/{entity_id}/test")
    async def test_light(entity_id: str):
        if lum.settings.read_only:
            raise HTTPException(409, "Luminorium is read-only: nothing is sent to lights")
        light = lum.inventory.inventory.get(entity_id)
        if light is None:
            raise HTTPException(404, f"unknown light {entity_id}")
        try:
            lum.tester.start(light)
        except LightTestError as err:
            raise HTTPException(409, str(err)) from err
        return {"started": entity_id}

    @app.post("/api/stop_all")
    async def stop_all():
        restored = await lum.safety.stop_all()
        return {"restored": restored}

    return app
