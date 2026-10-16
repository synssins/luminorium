# Changelog

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
