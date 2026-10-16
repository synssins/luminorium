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
from ..drivers.router import DriverChoiceError
from ..engine.testlight import LightTestError, TestOptions
from ..inventory.model import Kind

STATIC = Path(__file__).parent / "static"


class IncludeBody(BaseModel):
    include: bool | None


class DriverBody(BaseModel):
    driver: str | None


class TestBody(BaseModel):
    transition_ms: int = 0
    effect: str | None = None
    hold_s: float | None = None


class FixtureBody(BaseModel):
    name: str = ""
    members: list[str]


class FixtureUpdate(BaseModel):
    name: str | None = None
    members: list[str] | None = None


class MembersBody(BaseModel):
    members: list[str]


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
            "drivers": lum.driver_status(),
        }

    def light_dict(light) -> dict:
        data = light.to_dict()
        data["driver_options"] = lum.router.options(light)
        return data

    @app.get("/api/inventory")
    async def inventory():
        inv = lum.inventory.inventory
        return {
            "floors": [vars(f) for f in inv.floors.values()],
            "areas": [vars(a) for a in inv.areas.values()],
            "lights": [
                light_dict(light) for light in inv.lights.values() if light.kind != Kind.SEGMENT
            ],
            "fixtures": [f.to_dict() for f in inv.fixtures.values()],
            "suggestions": [s.to_dict() for s in inv.suggestions],
        }

    @app.put("/api/lights/{entity_id}/include")
    async def set_include(entity_id: str, body: IncludeBody):
        try:
            lum.inventory.set_choice(entity_id, body.include)
        except KeyError as err:
            raise HTTPException(404, f"unknown light {entity_id}") from err
        light = lum.inventory.inventory.get(entity_id)
        return light_dict(light) if light else {}

    @app.put("/api/lights/{entity_id}/driver")
    async def set_driver(entity_id: str, body: DriverBody):
        light = lum.inventory.inventory.get(entity_id)
        if light is None or light.kind not in (Kind.LIGHT, Kind.SWITCH):
            raise HTTPException(404, f"unknown light {entity_id}")
        try:
            lum.router.check_choice(light, body.driver)
        except DriverChoiceError as err:
            raise HTTPException(400, str(err)) from err
        lum.inventory.set_driver(entity_id, body.driver)
        light = lum.inventory.inventory.get(entity_id)
        return light_dict(light) if light else {}

    @app.post("/api/lights/{entity_id}/test")
    async def test_light(entity_id: str, body: TestBody | None = None):
        if lum.settings.read_only:
            raise HTTPException(409, "Luminorium is read-only: nothing is sent to lights")
        light = lum.inventory.inventory.get(entity_id)
        if light is None:
            raise HTTPException(404, f"unknown light {entity_id}")
        if light.fixture:
            raise HTTPException(409, f"{light.name} is part of a fixture: test the fixture")
        try:
            options = TestOptions(**body.model_dump()) if body else None
            lum.tester.start(light, options)
        except LightTestError as err:
            raise HTTPException(409, str(err)) from err
        return {"started": entity_id}

    @app.post("/api/fixtures")
    async def create_fixture(body: FixtureBody):
        try:
            fixture_id = lum.inventory.create_fixture(body.name, body.members)
        except ValueError as err:
            raise HTTPException(400, str(err)) from err
        return lum.inventory.inventory.fixtures[fixture_id].to_dict()

    @app.put("/api/fixtures/{fixture_id}")
    async def update_fixture(fixture_id: str, body: FixtureUpdate):
        try:
            lum.inventory.update_fixture(fixture_id, body.name, body.members)
        except KeyError as err:
            raise HTTPException(404, f"unknown fixture {fixture_id}") from err
        except ValueError as err:
            raise HTTPException(400, str(err)) from err
        fixture = lum.inventory.inventory.fixtures.get(fixture_id)
        return fixture.to_dict() if fixture else {}

    @app.delete("/api/fixtures/{fixture_id}")
    async def delete_fixture(fixture_id: str):
        try:
            lum.inventory.delete_fixture(fixture_id)
        except KeyError as err:
            raise HTTPException(404, f"unknown fixture {fixture_id}") from err
        return {"deleted": fixture_id}

    @app.post("/api/fixtures/{fixture_id}/test")
    async def test_fixture(fixture_id: str):
        if lum.settings.read_only:
            raise HTTPException(409, "Luminorium is read-only: nothing is sent to lights")
        inv = lum.inventory.inventory
        fixture = inv.fixtures.get(fixture_id)
        if fixture is None:
            raise HTTPException(404, f"unknown fixture {fixture_id}")
        try:
            skipped = lum.tester.start_fixture(fixture, [inv.lights[e] for e in fixture.members])
        except LightTestError as err:
            raise HTTPException(409, str(err)) from err
        return {"started": fixture_id, "skipped": skipped}

    @app.post("/api/fixture_suggestions/dismiss")
    async def dismiss_suggestion(body: MembersBody):
        lum.inventory.dismiss_suggestion(body.members)
        return {"dismissed": sorted(set(body.members))}

    @app.post("/api/stop_all")
    async def stop_all():
        restored = await lum.safety.stop_all()
        return {"restored": restored}

    return app
