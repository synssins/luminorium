"""Wires the parts together and owns their lifecycle."""

from __future__ import annotations

import asyncio
import contextlib
import logging

from .discovery import discover
from .drivers.base import DirectDriver, Driver
from .drivers.govee import GoveeDriver
from .drivers.ha import HADriver
from .drivers.router import Router
from .drivers.wiz import WiZDriver
from .drivers.wled import WLEDDriver, segment_leds
from .drivers.z2m import Z2MDriver
from .drivers.zwave import ZWaveDriver
from .engine.engine import Engine
from .engine.governor import Governor
from .engine.safety import Safety
from .engine.testlight import LightTester
from .ha.client import HAClient
from .house import HouseService, Part
from .inventory.model import Inventory, Light
from .inventory.service import InventoryService
from .library import Library
from .mapping.clock import Clock
from .mapping.service import MappingService
from .settings import DRIVER_NAMES, Settings
from .spatial.service import SpatialService
from .store import JsonStore

log = logging.getLogger(__name__)


class Luminorium:
    def __init__(
        self,
        settings: Settings,
        *,
        test_hold_s: float | None = None,
        mapping_clock: Clock | None = None,
    ):
        self.settings = settings
        self.store = JsonStore(settings.data_dir)
        self.ha = HAClient(settings.ha_url, settings.ha_token, read_only=settings.read_only)
        self.ha_driver = HADriver(self.ha)
        self.router = Router(self.ha_driver, enabled=settings.drivers.enabled)
        self.inventory = InventoryService(self.ha, self.store)
        self.governor = Governor(self.driver_for, fallback=self.ha_driver)
        self.safety = Safety(self.inventory, self.governor, self.store)
        self.tester = LightTester(self.safety, **({"hold_s": test_hold_s} if test_hold_s else {}))
        self.library = Library(settings.config_dir)
        self.effects = self.library.effects()
        self.engine = Engine(self.inventory, self.safety, self.effects, self.library.palettes)
        self.spatial = SpatialService(settings.config_dir, lambda: self.inventory.inventory)
        self.mapping = MappingService(
            settings.config_dir,
            self.inventory,
            self.safety,
            self.spatial,
            read_only=settings.read_only,
            clock=mapping_clock,
        )
        self.house = HouseService(JsonStore(settings.config_dir), self.inventory, self._parts_for)
        self._startup: asyncio.Task | None = None
        # HA's own settings (unit system, time zone), read on every (re)connect
        self.ha_config: dict = {}
        self.ha.on_connect(self._read_ha_config)
        self.router.attach(lambda: self.inventory.inventory)
        self.inventory.on_rebuild(self._rebuilt)

    def _parts_for(self, light: Light) -> list[Part]:
        """A segmented light's parts for the house map: a WLED light's LEDs (labelled with the
        WLED segment each is in), or a Govee strip's segment entities."""
        if light.integration == "wled":
            wled = self.router.drivers.get("wled")
            found = wled.device_for(light) if isinstance(wled, WLEDDriver) else None
            if not found:
                return []
            device, seg = found
            # Which segment each LED is in, so interleaved segments (white and RGB LEDs
            # alternating along a path) label each LED right
            owner = {}
            for s in device.segments:
                for led in segment_leds(s):
                    owner.setdefault(led, s.get("name") or f"segment {s['id']}")
            parts = []
            for i, led in enumerate(wled.leds(light)):
                label = f"LED {led + 1}"
                if seg is None and len(device.segments) > 1 and led in owner:
                    label += f" · {owner[led]}"
                parts.append(Part(i, label))
            return parts
        if light.segments:
            return [Part(i, f"Segment {i + 1}", eid) for i, eid in enumerate(light.segments)]
        return []

    async def flash_pixel(self, light: Light, index: int, seconds: float = 2.0) -> None:
        """Light one LED of a WLED light white for a moment (realtime frames); WLED goes back to
        its own state by itself a few seconds after the frames stop."""
        wled = self.router.drivers.get("wled")
        if not isinstance(wled, WLEDDriver):
            raise ConnectionError("the WLED driver isn't running")
        count = wled.pixel_count(light)
        if not 0 <= index < count:
            raise ValueError(f"{light.name} has no LED {index + 1}")
        frame = [(0, 0, 0)] * count
        frame[index] = (255, 255, 255)
        for _ in range(max(1, int(seconds / 0.2))):
            await wled.stream(light, frame)
            await asyncio.sleep(0.2)

    async def _read_ha_config(self) -> None:
        try:
            self.ha_config = await self.ha.command({"type": "get_config"}) or {}
        except Exception as err:
            log.debug("HA config not read: %s", err)

    @property
    def units(self) -> str:
        """'imperial' or 'metric', as Home Assistant is set up."""
        length = ((self.ha_config or {}).get("unit_system") or {}).get("length")
        return "imperial" if length in ("mi", "ft", "in", "yd") else "metric"

    def driver_for(self, light: Light) -> Driver:
        return self.router.driver_for(light)

    def _rebuilt(self, inventory: Inventory) -> None:
        wled = self.router.drivers.get("wled")
        if isinstance(wled, WLEDDriver):
            wled.watch(list(inventory.lights.values()))
        self.router.apply(inventory)

    async def start(self) -> None:
        if self.settings.read_only:
            log.warning("Read-only mode: nothing will be sent to any light")
        await self.ha.start()
        await self.inventory.start()
        self._startup = asyncio.create_task(self._after_connect())

    async def _after_connect(self) -> None:
        await self.inventory.loaded.wait()
        # Restores go through HA until the direct drivers have found their devices
        if self.settings.read_only:
            if self.store.load("snapshots"):
                log.warning("Snapshots from a previous run are kept: read-only mode can't restore")
        else:
            try:
                await self.safety.restore_leftovers()
            except Exception:
                log.exception("Restoring leftovers failed")
        try:
            await self.start_drivers()
        except Exception:
            log.exception("Starting the direct drivers failed; everything stays on HA")

    async def start_drivers(self) -> None:
        cfg = self.settings.drivers
        if not cfg.enabled:
            return
        zwave_device = next(
            (
                lt.device_id
                for lt in self.inventory.inventory.lights.values()
                if lt.integration == "zwave_js" and lt.device_id
            ),
            None,
        )
        endpoints = await discover(self.settings, self.ha, zwave_device)
        read_only = self.settings.read_only
        drivers: list[DirectDriver] = []
        if cfg.on("z2m"):
            drivers.append(
                Z2MDriver(endpoints.mqtt, base_topic=cfg.z2m_base_topic, read_only=read_only)
            )
        if cfg.on("zwave_js"):
            zwave = ZWaveDriver(endpoints.zwave_urls, read_only=read_only)
            zwave.acquire = lambda: self.governor.network_token("zwave")
            drivers.append(zwave)
        if cfg.on("wiz"):
            drivers.append(
                WiZDriver(
                    subnets=list(cfg.wiz_subnets),
                    hosts=list(cfg.wiz_hosts),
                    port=cfg.wiz_port,
                    read_only=read_only,
                )
            )
        if cfg.on("wled"):
            wled = WLEDDriver(read_only=read_only, ddp_port=cfg.wled_ddp_port)
            wled.watch(list(self.inventory.inventory.lights.values()))
            drivers.append(wled)
        if cfg.on("govee"):
            drivers.append(
                GoveeDriver(
                    subnets=list(cfg.govee_subnets),
                    hosts=list(cfg.govee_hosts),
                    multicast=cfg.govee_multicast,
                    razer_models=list(cfg.govee_razer_models),
                    read_only=read_only,
                    listen=("0.0.0.0", cfg.govee_listen_port),
                    scan_port=cfg.govee_scan_port,
                    control_port=cfg.govee_control_port,
                )
            )
        for driver in drivers:
            self.router.add(driver)
            await driver.start()
        self.router.refresh()

    def driver_status(self) -> dict[str, dict]:
        status = self.router.status()
        for name in DRIVER_NAMES:
            status.setdefault(name, {"enabled": False})
        return status

    async def stop(self) -> None:
        if self._startup:
            self._startup.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._startup
        await self.engine.close()  # Stop all below restores what the shows touched
        if self.safety.snapshots and self.ha.connected and not self.settings.read_only:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.safety.stop_all(), 10)
        for driver in list(self.router.drivers.values()):
            with contextlib.suppress(Exception):
                await driver.stop()
        await self.ha.close()
