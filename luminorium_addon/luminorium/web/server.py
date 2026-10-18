"""Web UI and API, served through HA Ingress.

Ingress serves the app under a per-session path prefix, so every page uses relative URLs.
In the add-on, only the Supervisor's ingress proxy may connect.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import __version__
from ..app import Luminorium
from ..drivers.router import DriverChoiceError
from ..engine.engine import ShowError
from ..engine.testlight import LightTestError, TestOptions
from ..house import HouseError, photo_type
from ..inventory.model import Kind
from ..library import LibraryError
from . import mapping_api, spatial_api

STATIC = Path(__file__).parent / "static"


class IncludeBody(BaseModel):
    include: bool | None


class DriverBody(BaseModel):
    driver: str | None


class WhiteOnlyBody(BaseModel):
    white_only: bool


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


class PlayPaletteBody(BaseModel):
    targets: dict
    include_white: bool = False  # also play on lights marked white only
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

    # Pages built from the shared shell: (title, script). Views, capture and the camera check are
    # their own HTML files, which load the same shell.
    pages = {
        "": ("Overview", "overview"),
        "lights": ("Lights", "lights"),
        "light": ("Light", "light"),
        "palettes": ("Palettes & shows", "palettes"),
        "house": ("House map", "house"),
        "drivers": ("Drivers", "drivers"),
        "activity": ("Activity", "activity"),
        "settings": ("Settings", "settings"),
    }

    def page_html(key: str) -> HTMLResponse:
        title, script = pages[key]
        wide = ' data-wide="1"' if key == "house" else ""
        crumbs = ' data-crumbs="Lights@lights"' if key == "light" else ""
        extra_js = (
            f'<script src="static/pages/house3d.js?v={__version__}"></script>\n'
            f'<script src="static/pages/facade.js?v={__version__}"></script>\n'
            f'<script src="static/pages/site.js?v={__version__}"></script>\n'
            if key == "house"
            else ""
        )
        return HTMLResponse(
            f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>{title} · Luminorium</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&amp;family=IBM+Plex+Sans:wght@400;500;600;700&amp;display=swap">
<link rel="stylesheet" href="static/style.css?v={__version__}">
</head>
<body data-page="{script}" data-title="{title.replace("&", "&amp;")}"{wide}{crumbs}>
<script src="static/shell.js?v={__version__}"></script>
{extra_js}<script src="static/pages/{script}.js?v={__version__}"></script>
</body>
</html>
"""
        )

    @app.get("/")
    async def index():
        return page_html("")

    @app.get("/camera")
    async def camera():
        return FileResponse(STATIC / "camera.html")

    @app.get("/views")
    async def views_page():
        return FileResponse(STATIC / "views.html")

    @app.get("/capture")
    async def capture_page():
        return FileResponse(STATIC / "capture.html")

    for _key in [k for k in pages if k]:

        async def _page(key: str = _key) -> HTMLResponse:
            return page_html(key)

        app.add_api_route(f"/{_key}", _page, methods=["GET"], include_in_schema=False)

    app.include_router(spatial_api.router(lum))
    app.include_router(mapping_api.router(lum))

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
            "drivers": lum.driver_status(),
            "units": lum.units,
        }

    def light_dict(light) -> dict:
        data = light.to_dict()
        data["driver_options"] = lum.router.options(light)
        attrs = light.attributes or {}
        # What it looks like now, for the cards (the full attributes stay server-side)
        data["look"] = {
            k: attrs.get(k)
            for k in (
                "brightness",
                "color_mode",
                "rgb_color",
                "hs_color",
                "color_temp_kelvin",
                "effect",
            )
            if attrs.get(k) is not None
        }
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

    @app.put("/api/lights/{entity_id}/white_only")
    async def set_white_only(entity_id: str, body: WhiteOnlyBody):
        try:
            lum.inventory.set_white_only(entity_id, body.white_only)
        except KeyError as err:
            raise HTTPException(404, f"unknown light {entity_id}") from err
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
            "include_white": body.include_white,
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

    # ---- house map ------------------------------------------------------------------------

    def _house_errors(fn):
        try:
            return fn()
        except KeyError as err:
            raise HTTPException(404, f"unknown {err.args[0]}") from err
        except HouseError as err:
            raise HTTPException(400, str(err)) from err

    @app.get("/api/house")
    async def house():
        return lum.house.view()

    @app.put("/api/house/settings")
    async def house_settings(body: dict):
        _house_errors(lambda: lum.house.settings(body.get("size"), body.get("floors")))
        return lum.house.view()

    @app.put("/api/house/items/{target}")
    async def house_place(target: str, body: dict):
        return _house_errors(
            lambda: lum.house.place(
                target,
                str(body.get("floor", "")),
                body.get("x", 0),
                body.get("y", 0),
                body.get("h"),
                body.get("mount"),
            )
        )

    @app.post("/api/house/blocks")
    async def house_block_add(body: dict):
        """A new block from 3D: {x0, x1, y0, depth, z0, z1, name?, level?} in house metres."""
        _house_errors(lambda: lum.house.add_block(body))
        return lum.house.view()

    @app.delete("/api/house/blocks/{block}")
    async def house_block_remove(block: str):
        _house_errors(lambda: lum.house.remove_block(block))
        return lum.house.view()

    @app.put("/api/house/blocks/{block}")
    async def house_block(block: str, body: dict):
        """Move a house block's faces from 3D: {x0?, x1?, z0?, z1?, y0?, depth?} in house metres."""
        _house_errors(lambda: lum.house.set_block(block, body))
        return lum.house.view()

    @app.post("/api/house/blocks/{block}/split")
    async def house_block_split(block: str, body: dict):
        """Split a block front to back: {front_depth} stays, a new block behind takes the rest."""
        _house_errors(lambda: lum.house.split_block(block, body.get("front_depth", 0)))
        return lum.house.view()

    @app.put("/api/house/items/{target}/fixtures")
    async def house_fixtures(target: str, body: dict):
        """How many fixtures one switch runs: {count: 2-50}, or 0 for one."""
        return _house_errors(lambda: lum.house.set_fixtures(target, body.get("count", 0)))

    @app.put("/api/house/items/{target}/form")
    async def house_form(target: str, body: dict | None = None):
        """What a light looks like: {form: bar|strip, length, rot, face: down|up|side}, or
        null for a bulb."""
        return _house_errors(lambda: lum.house.set_form(target, body or None))

    @app.put("/api/house/items/{target}/aim")
    async def house_aim(target: str, body: dict | None = None):
        """Where a flood, spot or wall light points: {kind, beam, tilt, heading}, or null."""
        return _house_errors(lambda: lum.house.set_aim(target, body or None))

    @app.delete("/api/house/items/{target}")
    async def house_remove(target: str):
        _house_errors(lambda: lum.house.remove(target))
        return {"removed": target}

    @app.put("/api/house/items/{target}/parts/{index}")
    async def house_part(target: str, index: int, body: dict):
        _house_errors(
            lambda: lum.house.place_part(
                target, index, body.get("x", 0), body.get("y", 0), body.get("h")
            )
        )
        return {"placed": index}

    @app.delete("/api/house/items/{target}/parts/{index}")
    async def house_part_remove(target: str, index: int):
        _house_errors(lambda: lum.house.remove_part(target, index))
        return {"removed": index}

    @app.post("/api/house/items/{target}/line")
    async def house_line(target: str, body: dict):
        n = _house_errors(
            lambda: lum.house.line(
                target, body.get("start") or {}, body.get("end") or {}, body.get("parts")
            )
        )
        return {"placed": n}

    @app.put("/api/house/photo")
    async def house_photo_put(request: Request, w: int = 0, h: int = 0, which: str = "front"):
        """The front photo (or `which=top`, the top view), as image bytes (the page shrinks it to
        a JPEG first)."""
        if which not in ("front", "top"):
            raise HTTPException(400, "which is front or top")
        data = await request.body()
        return _house_errors(lambda: lum.house.set_photo(data, w, h, which))

    @app.get("/api/house/photo")
    async def house_photo_get(which: str = "front"):
        path = lum.house.photo_path("top" if which == "top" else "front")
        if not path.exists():
            raise HTTPException(404, "no photo")
        with path.open("rb") as f:
            kind = photo_type(f.read(16)) or "application/octet-stream"
        return FileResponse(path, media_type=kind, headers={"Cache-Control": "no-cache"})

    @app.put("/api/house/facade")
    async def house_facade(body: dict):
        _house_errors(lambda: lum.house.set_facade(body))
        return lum.house.view()

    @app.put("/api/house/site")
    async def house_site_put(body: dict):
        _house_errors(lambda: lum.house.set_site(body))
        return lum.house.view()

    @app.delete("/api/house/site")
    async def house_site_clear():
        lum.house.clear_site()
        return lum.house.view()

    @app.delete("/api/house/facade")
    async def house_facade_clear():
        lum.house.clear_facade()
        return lum.house.view()

    @app.post("/api/house/identify")
    async def house_identify(body: dict):
        """Flash a light, a fixture, or one part of a segmented light so it can be spotted."""
        if lum.settings.read_only:
            raise HTTPException(409, "Luminorium is read-only: nothing is sent to lights")
        inv = lum.inventory.inventory
        target, part = str(body.get("target", "")), body.get("part")
        try:
            if target in inv.fixtures:
                if part is not None:
                    raise HTTPException(400, "a fixture has no parts")
                lum.tester.start_fixture(
                    inv.fixtures[target], [inv.lights[e] for e in inv.fixtures[target].members]
                )
                return {"flashing": target}
            light = inv.get(target)
            if light is None:
                raise HTTPException(404, f"unknown light {target}")
            if part is None:
                lum.tester.identify(light)
                return {"flashing": target}
            parts = lum._parts_for(light)
            found = next((p for p in parts if p.index == int(part)), None)
            if found is None:
                raise HTTPException(404, f"{light.name} has no part {part}")
            if found.entity_id:
                segment = inv.get(found.entity_id)
                if segment is None:
                    raise HTTPException(404, f"unknown segment {found.entity_id}")
                lum.tester.identify(segment)
            else:
                lum.safety.note(
                    f"Flashing {found.label} of {light.name} to identify it",
                    entity_id=light.entity_id,
                )
                task = asyncio.create_task(lum.flash_pixel(light, found.index))
                task.add_done_callback(
                    lambda t: t.exception() and lum.safety.note(f"Identify failed: {t.exception()}")
                )
            return {"flashing": target, "part": found.index}
        except LightTestError as err:
            raise HTTPException(409, str(err)) from err

    @app.post("/api/stop_all")
    async def stop_all():
        restored = await lum.safety.stop_all()
        return {"restored": restored}

    return app
