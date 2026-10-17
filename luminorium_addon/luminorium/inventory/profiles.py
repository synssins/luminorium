"""Profiles: what a light can do and how fast it may be driven.

Defaults per network come from DESIGN.md section 4, corrected by the 2026-10-16 spikes (WiZ
latency, Govee via the cloud). Mapping measures real latencies later.
"""

from __future__ import annotations

from dataclasses import dataclass

from .model import Capabilities, Light, Profile


@dataclass(frozen=True)
class NetworkDefaults:
    latency_ms: int
    max_rate_hz: float  # safe sustained rate for one light


NETWORKS: dict[str, NetworkDefaults] = {
    "zwave": NetworkDefaults(600, 0.5),
    "zigbee": NetworkDefaults(200, 5.0),
    "wiz": NetworkDefaults(120, 15.0),
    "wled": NetworkDefaults(30, 40.0),
    # govee2mqtt reaches every Govee device here through the cloud (no LAN path yet)
    "govee_cloud": NetworkDefaults(1000, 0.5),
    # Luminorium's own Govee LAN driver (UDP 4003)
    "govee_lan": NetworkDefaults(100, 10.0),
    "esphome": NetworkDefaults(100, 10.0),
    "matter": NetworkDefaults(300, 2.0),
    "mqtt": NetworkDefaults(200, 5.0),
    "other": NetworkDefaults(250, 2.0),
}

# The HA fallback driver: one service call per change, ~2 per second per light.
HA_DRIVER_MAX_RATE_HZ = 2.0
HA_DRIVER_OVERHEAD_MS = 50
# Relays: on/off only, and no faster than one toggle per 5 s (wear, and the click).
RELAY_MAX_RATE_HZ = 0.2

INTEGRATION_NETWORK = {
    "zwave_js": "zwave",
    "zigbee2mqtt": "zigbee",
    "wiz": "wiz",
    "wled": "wled",
    "govee2mqtt": "govee_cloud",
    "esphome": "esphome",
    "matter": "matter",
    "mqtt": "mqtt",
}

# Direct drivers: the integration each one serves, and the network its commands travel on.
# Latency and rate come from that network's defaults (no HA hop, so no HA overhead or 2 Hz cap).
INTEGRATION_DRIVER = {
    "zigbee2mqtt": "z2m",
    "zwave_js": "zwave_js",
    "wiz": "wiz",
    "wled": "wled",
    "govee2mqtt": "govee",
}
DRIVER_NETWORK = {
    "z2m": "zigbee",
    "zwave_js": "zwave",
    "wiz": "wiz",
    "wled": "wled",
    "govee": "govee_lan",
}

# Z-Wave security classes as zwave-js numbers them
ZWAVE_SECURITY = {
    -1: "none",
    0: "S2 Unauthenticated",
    1: "S2 Authenticated",
    2: "S2 Access Control",
    7: "S0 Legacy",
}
ZWAVE_NODE_STATUS = {0: "unknown", 1: "asleep", 2: "awake", 3: "dead", 4: "alive"}
CC_MULTILEVEL_SWITCH = 38
CC_BINARY_SWITCH = 37


def capabilities_from_attributes(light: Light) -> Capabilities:
    attrs = light.attributes
    if light.entity_id.startswith("switch."):
        return Capabilities(on_off=True)
    modes = [m for m in (attrs.get("supported_color_modes") or []) if m != "onoff"]
    color_modes = [m for m in modes if m in ("xy", "hs", "rgb", "rgbw", "rgbww")]
    white = None
    if "color_temp" in modes or any(m in ("rgbww",) for m in modes):
        lo = attrs.get("min_color_temp_kelvin")
        hi = attrs.get("max_color_temp_kelvin")
        if lo and hi:
            white = (int(lo), int(hi))
    effects = [
        e
        for e in (attrs.get("effect_list") or [])
        if e and e.lower() not in ("none", "stop_effect", "finish_effect", "stop_hue_effect")
    ]
    return Capabilities(
        on_off=True,
        dimming=bool(modes),
        white=white,
        color_modes=color_modes,
        effects=effects,
        transition="native",
        segments=len(light.segments),
    )


def zwave_details(node: dict | None) -> dict:
    """Facts from zwave_js/node_status and node_capabilities."""
    if not node:
        return {}
    status = node.get("status") or {}
    details: dict = {
        "node_id": status.get("node_id"),
        "node_status": ZWAVE_NODE_STATUS.get(status.get("status"), "unknown"),
        "security": ZWAVE_SECURITY.get(status.get("highest_security_class"), "unknown"),
        "zwave_plus": status.get("zwave_plus_version"),
    }
    for endpoint_ccs in (node.get("capabilities") or {}).values():
        for cc in endpoint_ccs:
            if cc.get("id") == CC_MULTILEVEL_SWITCH:
                details["multilevel_switch_version"] = cc.get("version")
            elif cc.get("id") == CC_BINARY_SWITCH:
                details["binary_switch_version"] = cc.get("version")
            elif cc.get("id") == 108:
                details["supervision"] = True
    return details


def build_profile(light: Light, zwave_node: dict | None = None, relay: bool = False) -> Profile:
    caps = capabilities_from_attributes(light)
    details: dict = {}

    if light.integration == "zwave_js":
        details = zwave_details(zwave_node)
        version = details.get("multilevel_switch_version")
        # Multilevel Switch v1 has no duration: the dimmer uses its own ramp rate
        caps.transition = "native" if version and version >= 2 else "none"
    elif light.integration in ("wiz", "govee2mqtt"):
        # Neither HA's WiZ integration nor govee2mqtt passes a transition on
        caps.transition = "none"

    if relay or light.entity_id.startswith("switch."):
        caps = Capabilities(on_off=True)
        relay = True

    profile = Profile(capabilities=caps, network="other", relay=relay, details=details)
    apply_driver(profile, "ha", light.integration)
    return profile


def apply_driver(profile: Profile, driver: str, integration: str) -> None:
    """Set a profile's driver, and the network, latency and rate that come with it."""
    if driver == "ha":
        network = INTEGRATION_NETWORK.get(integration, "other")
        defaults = NETWORKS[network]
        latency = defaults.latency_ms + HA_DRIVER_OVERHEAD_MS
        rate = min(defaults.max_rate_hz, HA_DRIVER_MAX_RATE_HZ)
    else:
        network = DRIVER_NETWORK[driver]
        defaults = NETWORKS[network]
        latency, rate = defaults.latency_ms, defaults.max_rate_hz
    # A latency measured by camera mapping through this driver beats the default
    if profile.details.get("latency_measured_driver") == driver:
        latency = int(profile.details["latency_measured_ms"])
    profile.driver = driver
    profile.network = network
    profile.latency_ms = latency
    profile.max_rate_hz = RELAY_MAX_RATE_HZ if profile.relay else rate
