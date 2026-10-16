"""A fake Supervisor API: `services/mqtt` and `addons/<slug>/info`, behind a bearer token."""

from __future__ import annotations

from dataclasses import dataclass, field

from aiohttp import web


@dataclass
class FakeSupervisor:
    token: str = "fake-supervisor-token"
    mqtt: dict | None = None  # the services/mqtt data, or None for "no MQTT service"
    addons: dict[str, dict] = field(default_factory=dict)  # slug -> info data
    requests: list[str] = field(default_factory=list)
    port: int = 0
    _runner: web.AppRunner | None = None

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self) -> str:
        app = web.Application()
        app.router.add_get("/services/mqtt", self._mqtt)
        app.router.add_get("/addons/{slug}/info", self._addon)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        site = web.TCPSite(self._runner, "127.0.0.1", 0)
        await site.start()
        self.port = site._server.sockets[0].getsockname()[1]  # type: ignore[union-attr]
        return self.url

    async def stop(self) -> None:
        if self._runner:
            await self._runner.cleanup()

    def _authorised(self, request: web.Request) -> bool:
        self.requests.append(request.path)
        return request.headers.get("Authorization") == f"Bearer {self.token}"

    async def _mqtt(self, request: web.Request) -> web.Response:
        if not self._authorised(request):
            return web.json_response({"result": "error", "message": "Unauthorized"}, status=401)
        if self.mqtt is None:
            return web.json_response({"result": "error", "message": "No service"}, status=400)
        return web.json_response({"result": "ok", "data": self.mqtt})

    async def _addon(self, request: web.Request) -> web.Response:
        if not self._authorised(request):
            return web.json_response({"result": "error"}, status=401)
        info = self.addons.get(request.match_info["slug"])
        if info is None:
            return web.json_response({"result": "error", "message": "Addon does not exist"}, 400)
        return web.json_response({"result": "ok", "data": info})
