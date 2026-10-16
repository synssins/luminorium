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
from ..engine.engine import ShowError
from ..engine.testlight import LightTestError
from ..inventory.model import Kind
from ..library import LibraryError

STATIC = Path(__file__).parent / "static"


class IncludeBody(BaseModel):
    include: bool | None


class FixtureBody(BaseModel):
    name: str = ""
    members: list[str]


class FixtureUpdate(BaseModel):
    name: str | None = None
    members: list[str] | None = None


class MembersBody(BaseModel):
    members: list[str]


class PlayPaletteBody(BaseModel):
    targets: dict
    priority: int = 0
    on_end: str = "restore"
    fade_s: float = 2.0
    brightness: float = 100  # percent of the palette's own range
    duration_s: float | None = None
    seed: str | int | None = None


class PlayShowBody(BaseModel):
    targets: dict | None = None
    seed: str | int | None = None


class StopBody(BaseModel):
    on_end: str | None = None


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
            "shows": [{"id": r["id"], "name": r["name"]} for r in lum.engine.running()],
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
        return light.to_dict() if light else {}

    @app.post("/api/lights/{entity_id}/test")
    async def test_light(entity_id: str):
        if lum.settings.read_only:
            raise HTTPException(409, "Luminorium is read-only: nothing is sent to lights")
        light = lum.inventory.inventory.get(entity_id)
        if light is None:
            raise HTTPException(404, f"unknown light {entity_id}")
        if light.fixture:
            raise HTTPException(409, f"{light.name} is part of a fixture: test the fixture")
        try:
            lum.tester.start(light)
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

    # ---- palettes, shows, running ----------------------------------------------------------

    def _writable() -> None:
        if lum.settings.read_only:
            raise HTTPException(409, "Luminorium is read-only: nothing is sent to lights")
        if not lum.inventory.loaded.is_set():
            raise HTTPException(409, "the inventory isn't loaded yet")

    async def _play(spec: dict, kind: str, source: str | None, targets: dict | None = None):
        _writable()
        try:
            show = await lum.engine.play(spec, kind=kind, source=source, targets=targets)
        except ShowError as err:
            raise HTTPException(400, str(err)) from err
        return show.to_dict(lum.engine.clock())

    @app.get("/api/palettes")
    async def palettes():
        return lum.library.palette_list()

    @app.put("/api/palettes/{palette_id}")
    async def save_palette(palette_id: str, body: dict):
        try:
            palette = lum.library.save_palette(palette_id, body)
        except LibraryError as err:
            raise HTTPException(400, str(err)) from err
        return palette.to_dict()

    @app.delete("/api/palettes/{palette_id}")
    async def delete_palette(palette_id: str):
        try:
            lum.library.delete_palette(palette_id)
        except LibraryError as err:
            raise HTTPException(400, str(err)) from err
        except KeyError as err:
            raise HTTPException(404, f"no user palette {palette_id}") from err
        return {"deleted": palette_id}

    @app.post("/api/palettes/{palette_id}/play")
    async def play_palette(palette_id: str, body: PlayPaletteBody):
        palettes = lum.library.palettes()
        if palette_id not in palettes:
            raise HTTPException(404, f"unknown palette {palette_id}")
        spec = {
            "name": palettes[palette_id].name,
            "priority": body.priority,
            "on_end": body.on_end,
            "fade_s": body.fade_s,
            "duration_s": body.duration_s,
            "seed": body.seed,
            "layers": [{"type": "palette", "palette": palette_id, "brightness": body.brightness}],
        }
        return await _play(spec, "palette", palette_id, body.targets)

    @app.get("/api/effects")
    async def effects():
        return lum.effects.to_list()

    @app.get("/api/lights/{entity_id}/effects")
    async def light_effects(entity_id: str):
        light = lum.inventory.inventory.get(entity_id)
        if light is None:
            raise HTTPException(404, f"unknown light {entity_id}")
        out = {}
        for key in lum.effects.effects:
            res = lum.effects.resolve(key, light)
            out[key] = {"method": res.method, "name": res.native_name or res.software}
        return out

    @app.get("/api/shows")
    async def shows():
        return list(lum.library.shows().values())

    @app.put("/api/shows/{show_id}")
    async def save_show(show_id: str, body: dict):
        try:
            return lum.library.save_show(show_id, body)
        except LibraryError as err:
            raise HTTPException(400, str(err)) from err

    @app.delete("/api/shows/{show_id}")
    async def delete_show(show_id: str):
        try:
            lum.library.delete_show(show_id)
        except LibraryError as err:
            raise HTTPException(400, str(err)) from err
        except KeyError as err:
            raise HTTPException(404, f"unknown show {show_id}") from err
        return {"deleted": show_id}

    @app.post("/api/shows/{show_id}/play")
    async def play_show(show_id: str, body: PlayShowBody | None = None):
        try:
            spec = lum.library.show(show_id)
        except LibraryError as err:
            raise HTTPException(400, str(err)) from err
        except KeyError as err:
            raise HTTPException(404, f"unknown show {show_id}") from err
        if body and body.seed is not None:
            spec = {**spec, "seed": body.seed}
        return await _play(spec, "show", show_id, body.targets if body else None)

    @app.post("/api/play")
    async def play(body: dict):
        """Play a show given inline (not saved)."""
        return await _play(body, "show", None)

    @app.get("/api/running")
    async def running():
        return lum.engine.running()

    @app.post("/api/running/{run_id}/stop")
    async def stop_running(run_id: str, body: StopBody | None = None):
        try:
            stopped = await lum.engine.stop(run_id, body.on_end if body else None)
        except ShowError as err:
            raise HTTPException(400, str(err)) from err
        if not stopped:
            raise HTTPException(404, f"nothing running as {run_id}")
        return {"stopped": run_id}

    @app.post("/api/stop")
    async def stop_shows():
        """End every running show, each as its on_end says (Stop all restores everything)."""
        return {"stopped": await lum.engine.stop_shows()}

    @app.post("/api/stop_all")
    async def stop_all():
        restored = await lum.safety.stop_all()
        return {"restored": restored}

    return app
