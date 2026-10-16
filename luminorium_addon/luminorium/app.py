"""Wires the parts together and owns their lifecycle."""

from __future__ import annotations

import asyncio
import contextlib
import logging

from .drivers.base import Driver
from .drivers.ha import HADriver
from .engine.engine import Engine
from .engine.governor import Governor
from .engine.safety import Safety
from .engine.testlight import LightTester
from .ha.client import HAClient
from .inventory.model import Light
from .inventory.service import InventoryService
from .library import Library
from .settings import Settings
from .store import JsonStore

log = logging.getLogger(__name__)


class Luminorium:
    def __init__(self, settings: Settings, *, test_hold_s: float | None = None):
        self.settings = settings
        self.store = JsonStore(settings.data_dir)
        self.ha = HAClient(settings.ha_url, settings.ha_token, read_only=settings.read_only)
        self.ha_driver = HADriver(self.ha)
        self.inventory = InventoryService(self.ha, self.store)
        self.governor = Governor(self.driver_for)
        self.safety = Safety(self.inventory, self.governor, self.store)
        self.tester = LightTester(self.safety, **({"hold_s": test_hold_s} if test_hold_s else {}))
        self.library = Library(settings.config_dir)
        self.effects = self.library.effects()
        self.engine = Engine(self.inventory, self.safety, self.effects, self.library.palettes)
        self._startup: asyncio.Task | None = None

    def driver_for(self, light: Light) -> Driver:
        # Phase 1: HA for everything. Direct drivers arrive in phase 2.
        return self.ha_driver

    async def start(self) -> None:
        if self.settings.read_only:
            log.warning("Read-only mode: nothing will be sent to any light")
        await self.ha.start()
        await self.inventory.start()
        self._startup = asyncio.create_task(self._restore_after_connect())

    async def _restore_after_connect(self) -> None:
        await self.inventory.loaded.wait()
        if self.settings.read_only:
            if self.store.load("snapshots"):
                log.warning("Snapshots from a previous run are kept: read-only mode can't restore")
            return
        try:
            await self.safety.restore_leftovers()
        except Exception:
            log.exception("Restoring leftovers failed")

    async def stop(self) -> None:
        if self._startup:
            self._startup.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._startup
        await self.engine.close()  # Stop all below restores what the shows touched
        if self.safety.snapshots and self.ha.connected and not self.settings.read_only:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self.safety.stop_all(), 10)
        await self.ha.close()
