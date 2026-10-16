"""Which driver drives each light.

Automatic: the direct driver for the light's integration when it can reach the light now,
else HA. The user can pin a light to HA or to its direct driver; a pinned direct driver that
can't reach the light falls back to HA (with a note) rather than leaving the light dead.
Per command, a state the chosen driver can't carry (a Govee scene over LAN) goes through HA.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from ..inventory.model import Inventory, Kind, Light
from ..inventory.profiles import INTEGRATION_DRIVER, apply_driver
from .base import DirectDriver, Driver
from .ha import HADriver

log = logging.getLogger(__name__)

DRIVER_LABELS = {
    "ha": "Home Assistant",
    "z2m": "Zigbee2MQTT",
    "zwave_js": "Z-Wave JS",
    "wiz": "WiZ LAN",
    "wled": "WLED",
    "govee": "Govee LAN",
}


class DriverChoiceError(ValueError):
    pass


class Router:
    def __init__(
        self,
        ha: HADriver,
        drivers: dict[str, DirectDriver] | None = None,
        *,
        enabled: set[str] | frozenset[str] | None = None,
    ):
        """enabled: the direct drivers switched on in the options (they may still be starting).
        Default: the ones given."""
        self.ha = ha
        self.drivers: dict[str, DirectDriver] = dict(drivers or {})
        self.enabled = set(enabled if enabled is not None else self.drivers)
        self._inventory: Callable[[], Inventory] | None = None
        for driver in self.drivers.values():
            driver.on_change(self.refresh)

    def add(self, driver: DirectDriver) -> None:
        self.drivers[driver.name] = driver
        self.enabled.add(driver.name)
        driver.on_change(self.refresh)
        self.refresh()

    def attach(self, inventory: Callable[[], Inventory]) -> None:
        """Re-route whenever a driver finds or loses something (called by drivers)."""
        self._inventory = inventory

    def refresh(self) -> None:
        if self._inventory is not None:
            self.apply(self._inventory())

    # ---- choice ---------------------------------------------------------------------------

    def options(self, light: Light) -> list[str]:
        """Drivers the user may pick for a light: HA, and its integration's direct driver."""
        direct = INTEGRATION_DRIVER.get(light.integration)
        return ["ha", direct] if direct and direct in self.enabled else ["ha"]

    def check_choice(self, light: Light, driver: str | None) -> None:
        if driver is not None and driver not in self.options(light):
            raise DriverChoiceError(
                f"{light.name} can use {', '.join(self.options(light))}, not {driver}"
            )

    def apply(self, inventory: Inventory) -> None:
        """Set every drivable light's profile to the driver it will use now."""
        for light in inventory.lights.values():
            if light.profile is None or light.kind not in (Kind.LIGHT, Kind.SWITCH):
                continue
            profile = light.profile
            direct_name = INTEGRATION_DRIVER.get(light.integration)
            direct = self.drivers.get(direct_name) if direct_name else None
            reachable = bool(direct and direct.handles(light))
            override = profile.driver_override
            note = None
            if override == "ha":
                chosen = "ha"
            elif reachable:
                chosen = direct_name
            else:
                chosen = "ha"
                if override and direct_name not in self.enabled:
                    note = f"{DRIVER_LABELS.get(override, override)} is switched off: using HA"
                elif override:
                    note = f"{DRIVER_LABELS.get(override, override)} can't reach it now: using HA"
            assert chosen is not None
            apply_driver(profile, chosen, light.integration)
            profile.drivers = [chosen] + [d for d in ("ha", direct_name) if d and d != chosen]
            if not reachable and direct_name in profile.drivers:
                profile.drivers.remove(direct_name)
            profile.driver_note = note
            profile.endpoint = direct.endpoint(light) if chosen != "ha" and direct else None

    # ---- per command ----------------------------------------------------------------------

    def driver_for(self, light: Light) -> Driver:
        name = light.profile.driver if light.profile else "ha"
        driver = self.drivers.get(name)
        if driver is None or not driver.handles(light):
            return self.ha
        return driver

    def status(self) -> dict[str, dict]:
        out: dict[str, dict] = {"ha": {"enabled": True, "connected": self.ha.ha.connected}}
        for name, driver in self.drivers.items():
            out[name] = {"enabled": True, **driver.status()}
        for name in self.enabled - set(self.drivers):
            out[name] = {"enabled": True, "connected": False, "error": "starting"}
        return out
