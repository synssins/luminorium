"""Where the direct drivers' hubs are: Mosquitto (for Zigbee2MQTT) and the Z-Wave JS server.

- Mosquitto: the Supervisor's `services/mqtt` gives this add-on its own credentials (the
  add-on declares `services: [mqtt:need]`).
- Z-Wave JS: the server URL HA itself uses (`zwave_js/network_status`), then the add-on's
  hostname `core-zwave-js`, then the add-on's IP from the Supervisor. With host networking the
  hostname may not resolve, so the IP is the fallback.
Nothing here is printed with its password.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import aiohttp

from .ha.client import HAClient, HAError
from .net.mqtt import MQTTEndpoint
from .settings import Settings

log = logging.getLogger(__name__)

ZWAVE_ADDON = "core_zwave_js"
ZWAVE_HOST_URL = "ws://core-zwave-js:3000"
ZWAVE_PORT = 3000


class Supervisor:
    """The few Supervisor API calls the drivers need. Every call returns None on failure."""

    def __init__(self, url: str, token: str):
        self.url = url.rstrip("/")
        self._token = token

    async def _get(self, path: str) -> dict | None:
        headers = {"Authorization": f"Bearer {self._token}"}
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as s:
                async with s.get(f"{self.url}{path}", headers=headers) as resp:
                    if resp.status != 200:
                        log.info("Supervisor %s: HTTP %s", path, resp.status)
                        return None
                    body = await resp.json(content_type=None)
        except (aiohttp.ClientError, TimeoutError, ValueError) as err:
            log.info("Supervisor %s: %s", path, err)
            return None
        return body.get("data") if isinstance(body, dict) else None

    async def mqtt(self) -> MQTTEndpoint | None:
        data = await self._get("/services/mqtt")
        if not data or not data.get("host"):
            return None
        return MQTTEndpoint(
            host=str(data["host"]),
            port=int(data.get("port") or 1883),
            username=str(data.get("username") or ""),
            password=str(data.get("password") or ""),
            ssl=bool(data.get("ssl")),
        )

    async def addon_ip(self, slug: str) -> str | None:
        data = await self._get(f"/addons/{slug}/info")
        if not data or data.get("state") not in (None, "started"):
            return None
        return data.get("ip_address") or None


@dataclass
class Endpoints:
    mqtt: MQTTEndpoint | None = None
    zwave_urls: list[str] = field(default_factory=list)


async def zwave_url_from_ha(ha: HAClient, zwave_device_id: str | None) -> str | None:
    if not zwave_device_id:
        return None
    try:
        status = await ha.command({"type": "zwave_js/network_status", "device_id": zwave_device_id})
    except (HAError, TimeoutError, ConnectionError) as err:
        log.info("zwave_js/network_status: %s", err)
        return None
    return ((status or {}).get("client") or {}).get("ws_server_url")


async def discover(
    settings: Settings, ha: HAClient, zwave_device_id: str | None = None
) -> Endpoints:
    cfg = settings.drivers
    supervisor = (
        Supervisor(settings.supervisor_url, settings.ha_token) if settings.supervisor_url else None
    )
    out = Endpoints()
    if cfg.on("z2m"):
        out.mqtt = cfg.mqtt or (await supervisor.mqtt() if supervisor else None)
        log.info("MQTT broker: %r", out.mqtt)
    if cfg.on("zwave_js"):
        urls = [cfg.zwave_url] if cfg.zwave_url else []
        from_ha = await zwave_url_from_ha(ha, zwave_device_id)
        if from_ha:
            urls.append(from_ha)
        if supervisor:
            urls.append(ZWAVE_HOST_URL)
            ip = await supervisor.addon_ip(ZWAVE_ADDON)
            if ip:
                urls.append(f"ws://{ip}:{ZWAVE_PORT}")
        out.zwave_urls = list(dict.fromkeys(urls))
        log.info("Z-Wave JS server candidates: %s", out.zwave_urls)
    return out
