# Luminorium

A Home Assistant add-on for light effects, shows and sequences across every light in the house:
Zigbee (Zigbee2MQTT), Z-Wave dimmers and relays, WiZ, WLED, Govee, ESPHome and Matter. Home
Assistant stays the source of truth for lights, areas and floors; Luminorium adds effects,
palettes, spatial shows mapped with a phone camera, and automations on top.

**Status:** phase 1 of 8 (skeleton add-on) is done: it reads the house's lights from HA, shows
them by floor and area with what each can do, and has a safe Test button, Stop all, and crash
recovery. The phase 3 show engine core is in: palettes, native and software effects, dip and
flash, shows as YAML, and an API to play them ([docs/engine.md](docs/engine.md)).

## Documentation

| Document | What |
|---|---|
| [BRIEF.md](BRIEF.md) | Goals, environment, decisions, the 8 phases |
| [DESIGN.md](DESIGN.md) | The full target design: drivers, rate governor, effects, colour-field designer, phone mapping, plugins |
| [SPIKES.md](SPIKES.md) | Research results (2026-10-16): the real inventory, Z-Wave, z2m, Govee, WiZ, phone camera, image size; open questions |
| [docs/architecture.md](docs/architecture.md) | How the code is organised today |
| [docs/inventory.md](docs/inventory.md) | How HA entities become lights: kinds, exclusions, segments, duplicates, profiles |
| [docs/engine.md](docs/engine.md) | The show engine: colour, layers, palettes, effect resolution, the planner, shows, storage |
| [docs/safety.md](docs/safety.md) | Rate governor, snapshots, Stop all, crash restore, outside changes, read-only |
| [docs/api.md](docs/api.md) | The HTTP API |
| [docs/development.md](docs/development.md) | Setup, tests, the fake HA, running on a PC, fixtures |
| [docs/deployment.md](docs/deployment.md) | Add-on packaging, versioning rules, installing on HA |
| [luminorium_addon/DOCS.md](luminorium_addon/DOCS.md) | User guide shown in HA |
| [luminorium_addon/CHANGELOG.md](luminorium_addon/CHANGELOG.md) | Changes per version |

## Layout

| Path | What |
|---|---|
| `repository.yaml` | HA add-on repository |
| `luminorium_addon/` | The add-on: `config.yaml`, `build.yaml`, `Dockerfile`, `run.sh`, and the `luminorium` Python package |
| `tests/` | pytest suite; `tests/fixtures/ha/` is scrubbed data captured from the real HA |
| `tools/` | `fake_ha.py` (fake HA server), `dev.py` (run on a PC), `capture_ha.mjs` + `make_fixtures.py` (refresh fixtures) |
| `docs/` | Documentation |
| `proto/mapping/` | Offline prototype of the phone-mapping analysis on synthetic data (added separately) |

## Quick start (development)

```bash
py -3.13 -m venv .venv
.venv/Scripts/python -m pip install aiohttp fastapi uvicorn pyyaml pytest pytest-asyncio httpx ruff
.venv/Scripts/python -m pytest
.venv/Scripts/python tools/dev.py
```

Then open http://127.0.0.1:8199/. That runs against a fake HA; see
[docs/development.md](docs/development.md) for a read-only run against the real one.
