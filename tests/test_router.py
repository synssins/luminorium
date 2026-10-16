from __future__ import annotations

import pytest

from luminorium.drivers.base import DirectDriver, LightState
from luminorium.drivers.router import DriverChoiceError, Router

PORCH = "light.front_porch_light"  # zigbee2mqtt
ZEN77 = "light.kitchen_cabinet_light_switch"  # zwave_js
RELAY = "switch.backyard_light_switch"  # zwave_js relay (included below)
WIZ = "light.wiz_rgbww_tunable_c3b549"


class Stub(DirectDriver):
    def __init__(self, name: str, network: str, reach: set[str]):
        super().__init__()
        self.name = name
        self.network_name = network
        self.reach = reach

    def handles(self, light):
        return light.entity_id in self.reach

    def endpoint(self, light):
        return f"{self.name} {light.entity_id}"

    async def set(self, light, state, transition_ms=None):
        return None


class FakeHADriver:
    name = "ha"

    class ha:  # noqa: N801
        connected = True

    def supports(self, light, state):
        return True


def router_with(**reach) -> tuple[Router, dict[str, Stub]]:
    nets = {"z2m": "zigbee", "zwave_js": "zwave", "wiz": "wiz"}
    stubs = {n: Stub(n, nets[n], set(r)) for n, r in reach.items()}
    return Router(FakeHADriver(), stubs), stubs  # type: ignore[arg-type]


def test_direct_driver_when_it_reaches_the_light(house):
    router, _ = router_with(z2m={PORCH}, zwave_js={ZEN77})
    router.apply(house)
    porch = house.lights[PORCH].profile
    assert (porch.driver, porch.network, porch.latency_ms, porch.max_rate_hz) == (
        "z2m",
        "zigbee",
        200,
        5.0,
    )
    assert porch.drivers == ["z2m", "ha"]
    assert porch.endpoint == f"z2m {PORCH}"
    zen = house.lights[ZEN77].profile
    assert (zen.driver, zen.latency_ms, zen.max_rate_hz) == ("zwave_js", 600, 0.5)
    # HA for everything else, with HA's overhead and 2 Hz cap
    wiz = house.lights[WIZ].profile
    assert (wiz.driver, wiz.network, wiz.latency_ms, wiz.max_rate_hz) == ("ha", "wiz", 170, 2.0)
    assert wiz.drivers == ["ha"]


def test_falls_back_to_ha_when_unreachable(house):
    router, stubs = router_with(z2m=set())
    house.lights[PORCH].profile.driver_override = "z2m"
    router.apply(house)
    porch = house.lights[PORCH].profile
    assert porch.driver == "ha" and porch.latency_ms == 250 and porch.max_rate_hz == 2.0
    assert porch.driver_note == "Zigbee2MQTT can't reach it now: using HA"
    stubs["z2m"].reach.add(PORCH)
    router.apply(house)
    assert porch.driver == "z2m" and porch.driver_note is None


def test_user_can_pin_ha(house):
    router, _ = router_with(z2m={PORCH})
    house.lights[PORCH].profile.driver_override = "ha"
    router.apply(house)
    porch = house.lights[PORCH].profile
    assert porch.driver == "ha" and porch.drivers == ["ha", "z2m"]
    assert router.driver_for(house.lights[PORCH]).name == "ha"


def test_switched_off_driver(house):
    router, _ = router_with(zwave_js={ZEN77})
    house.lights[PORCH].profile.driver_override = "z2m"
    router.apply(house)
    assert house.lights[PORCH].profile.driver_note == "Zigbee2MQTT is switched off: using HA"
    assert router.options(house.lights[PORCH]) == ["ha"]


def test_choices_are_checked(house):
    router, _ = router_with(z2m={PORCH})
    router.check_choice(house.lights[PORCH], "z2m")
    router.check_choice(house.lights[PORCH], None)
    with pytest.raises(DriverChoiceError):
        router.check_choice(house.lights[PORCH], "wiz")


def test_relays_keep_their_slow_rate(house):
    router, _ = router_with(zwave_js={RELAY})
    router.apply(house)
    relay = house.lights[RELAY].profile
    assert relay.driver == "zwave_js" and relay.relay and relay.max_rate_hz == 0.2


def test_driver_for_rechecks_reachability(house):
    router, stubs = router_with(z2m={PORCH})
    router.apply(house)
    light = house.lights[PORCH]
    assert router.driver_for(light).name == "z2m"
    stubs["z2m"].reach.clear()  # lost between apply() and the command
    assert router.driver_for(light).name == "ha"
    assert stubs["z2m"].supports(light, LightState(True))


def test_driver_changes_reroute(house):
    router, stubs = router_with(z2m=set())
    router.attach(lambda: house)
    router.refresh()
    assert house.lights[PORCH].profile.driver == "ha"
    stubs["z2m"].reach.add(PORCH)
    stubs["z2m"].changed()
    assert house.lights[PORCH].profile.driver == "z2m"
