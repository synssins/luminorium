# Changelog

## 0.2.0-dev.1

Phase 2: direct drivers. Not yet tried on real lights (see docs/driver-tests.md).

- **Drivers:** Zigbee2MQTT over MQTT (device names from z2m, groups for simultaneous changes),
  Z-Wave JS server (fade durations where the dimmer supports them, multicast by security class
  with read-back), WiZ over UDP (subnet sweep, MAC match, scenes), WLED (JSON API, effects and
  palettes, DDP streaming), Govee LAN (unicast and multicast scan, `devStatus`; segment streaming
  off until tested per model). Home Assistant stays the fallback for every light.
- Each light uses the best driver that can reach it, shown as a **via …** badge; pin a light to
  Home Assistant or its direct driver from the **Driver** select. A driver status line under the
  counts.
- Rate governor: budgets follow the network a command really uses; a Z-Wave multicast or a z2m
  group message counts as one; latest value still wins for every light of a batch.
- Fixtures are tested with one multicast or group message where their lights allow it.
- The Test API takes a fade, an effect and a hold time, for checking drivers.
- Add-on: `host_network: true`, `services: [mqtt:need]`, options `drivers`, `wiz_subnets`,
  `govee_subnets`, `govee_razer_models`, `z2m_base_topic`, `zwave_url`.

## 0.1.0-dev.3

- Levels and rooms fold (tap a heading), with Collapse all / Expand all, remembered per device.
- **Fixtures:** group lights that share one physical fixture (the two office fan bulbs). A fixture
  is tested as one (all its lights on, off, restored together) and will be mapped as one.
  Suggestions for numbered lights of one model in one room; Group lights, Rename, Ungroup.
- Messages show in the page instead of browser pop-ups (which the HA app may not show).

## 0.1.0-dev.2

- Fix: the add-on couldn't find `SUPERVISOR_TOKEN` under s6-overlay's init and stopped.
  `run.sh` now runs under `with-contenv`, and the token is also read from s6's container
  environment. Running as an add-on without a token now stops with a clear error instead of
  falling back to development settings.

## 0.1.0-dev.1

Phase 1, first build.

- Inventory from HA: floors (plus "Outside / no floor"), areas, lights; default exclusions with
  reasons; switches opt-in; Govee segments folded under their light; light-device settings
  recognised; duplicates across integrations suggested.
- Profiles from HA attributes and Z-Wave node details (command class versions, security,
  dead nodes); per-network defaults for rate and latency.
- HA driver with a rate governor (per light, per network, latest value wins).
- Snapshots before every change, restore on finish, Stop all, restore after a crash; lights
  changed outside Luminorium are dropped, not overwritten.
- Ingress web UI: lights by floor and area, include/exclude, Test button, activity; phone
  camera check page.
