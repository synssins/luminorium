# Architecture (as built)

This describes the code as it is today (phase 1, plus phase 5's views and camera mapping). [DESIGN.md](../DESIGN.md) is the full target
design; [BRIEF.md](../BRIEF.md) has the phases.

## Process

One Python process (asyncio) in one add-on container:

```
                 ┌──────────────────── luminorium (python -m luminorium) ────────────────────┐
 HA core  ◄──ws──┤ ha/client.py      HAClient: auth, commands, subscriptions, reconnect      │
                 │      │                                                                    │
                 │ inventory/service.py  InventoryService: loads registries + states,        │
                 │      │                follows registry and state_changed events           │
                 │      ├─ inventory/builder.py   build(): pure function → Inventory          │
                 │      └─ inventory/profiles.py  capabilities, network, rate, latency       │
                 │                                                                           │
                 │ engine/safety.py     Safety: sessions, snapshots, Stop all, restore,      │
                 │      │               outside-change detection                             │
                 │ engine/governor.py   Governor: per-light and per-network rate limits      │
                 │      │                                                                    │
                 │ drivers/ha.py        HADriver: light.* / switch.* services                 │
                 │                                                                           │
                 │ engine/testlight.py  LightTester: the Test button                         │
                 │ spatial/service.py   SpatialService: views, planes, elements (/config)    │
                 │ mapping/service.py   MappingService: captures; session.py runs a station  │
                 │      ├─ mapping/live.py      live step detection (adaptive advance)      │
                 │      └─ mapping/analysis.py  offline analysis (OpenCV, worker thread)    │
                 │ web/server.py        FastAPI app (Ingress UI + JSON API)                  │
                 └───────────────────────────────────────────────────────────────────────────┘
```

`app.py` (`Luminorium`) builds these objects and owns start and stop. `__main__.py` reads the
settings and runs the FastAPI app under uvicorn; the app's lifespan starts and stops `Luminorium`.

## Modules

| Module | Responsibility |
|---|---|
| `settings.py` | `Settings`: HA URL and token, data folders, port, read-only. In the add-on: `SUPERVISOR_TOKEN`, `ws://supervisor/core/websocket`, `/data/options.json`. On a PC: environment variables. `repr` never shows the token. |
| `ha/client.py` | `HAClient`: one websocket to HA. `command()`, `subscribe_events()` (renewed on every reconnect), `on_connect()` callbacks, `call_service()` returning the context id. Reconnects with backoff (1 s → 30 s); stops retrying on `auth_invalid`. `ReadOnlyError` when read-only. |
| `store.py` | `JsonStore`: JSON documents in `/data`, written atomically (temp file + `fsync` + rename). A corrupt file is moved aside and the default used. |
| `inventory/model.py` | Dataclasses: `Floor`, `Area`, `Light`, `Fixture`, `FixtureSuggestion`, `Capabilities`, `Profile`, `Inventory`; `Kind` (light, segment, group, switch, setting). |
| `inventory/builder.py` | `build()`: registries + states + Z-Wave node details + user choices → `Inventory`. No I/O. Rules in [inventory.md](inventory.md). |
| `inventory/profiles.py` | Network defaults, Z-Wave command-class facts, `build_profile()`. |
| `inventory/service.py` | `InventoryService`: reload on connect and (debounced, 2 s) on registry events; keeps light states current from `state_changed`; stores include/exclude choices; notifies state listeners. |
| `drivers/base.py` | `Driver` interface; `LightState` (on, brightness, colour mode + value, effect) and `LightState.from_ha()` for snapshots. |
| `drivers/ha.py` | `HADriver`: `light.turn_on/turn_off`, `switch.turn_on/turn_off`; only sends attributes the light supports; `transition` only where it's native. |
| `engine/governor.py` | `Governor.send()`: per-light interval, latest value wins, priorities, network and HA token buckets. See [safety.md](safety.md). |
| `engine/safety.py` | `Safety`: sessions, snapshots, `command()`, `end_session()`, `stop_all()`, `restore_leftovers()`, outside-change detection. |
| `engine/testlight.py` | `LightTester`: on (full) → hold → off → hold → restore, as a session named `test:<entity_id>`; `start_fixture()` does the same for all of a fixture's lights at once (`test:<fixture id>`). |
| `spatial/model.py` | `View`, `Plane`, `Element`, `Part`, `World`, `Station`: normalised picture coordinates. See [mapping.md](mapping.md). |
| `spatial/geometry.py` | Plane homographies, polygons, mask outlines, photo registration (ORB + RANSAC), camera pose from a plane. |
| `spatial/service.py` | `SpatialService`: views on disk; photo, planes, elements; merge, split, reorder, segment lines; `apply_capture()`. |
| `mapping/session.py` | `CaptureSession`: the phone's websocket, the clock handshake, each station's pass as a Safety session, recording, analysis in a worker thread. |
| `mapping/live.py` | `LiveDetector`: is this step's change visible and settled yet (adaptive step advance). |
| `mapping/analysis.py` | The offline analysis, ported from `proto/mapping/analyze.py` (alignment, exposure, clock, differences, grouping, 3D). |
| `mapping/lm.py` | A small Levenberg–Marquardt solver (no SciPy). |
| `mapping/results.py` | Analysis results → per-light findings, suggested elements, stations, latencies. |
| `mapping/recording.py` | Raw captures on disk; decoding uploaded videos. |
| `mapping/service.py` | `MappingService`: create, list, delete, re-analyse, apply; latency write-back. |
| `mapping/clock.py` | The capture's clock (simulated in tests). |
| `web/server.py` | `create_app()`: pages, static files, JSON API ([api.md](api.md)), client allow-list. Includes `web/spatial_api.py` and `web/mapping_api.py`. |
| `web/static/` | `index.html` + `app.js` + `style.css` (lights page), `views.html` + `views.js` (views and review), `capture.html` + `capture.js` (camera mapping), `spatial.css`, `camera.html` (phone camera check). No build step. |

## Data in `/data`

| File | Contents |
|---|---|
| `options.json` | Written by the Supervisor from the add-on options. |
| `choices.json` | The user's decisions: `include` (`{entity_id: true/false}`), `fixtures` (`[{id, name, members}]`) and `dismissed` fixture suggestions (`[[entity_id, …]]`). |
| `snapshots.json` | Lights currently touched and their state before: `{entity_id: {state, session, taken_at}}`. Absent when nothing is touched. Used to restore after a crash. |
| `latency.json` | Latencies measured by camera mapping: `{entity_id: {ms, at, session}}`; they replace the profile defaults. |

`/config` (the add-on's `addon_config` folder) holds user content: `views/` (views and their
photos) and `mapping/sessions/` (raw captures), and later shows, palettes and plugins. Both are
included in HA backups; see [mapping.md](mapping.md#storage).

## Startup and shutdown

1. `HAClient.start()` connects in the background.
2. `InventoryService.start()` subscribes to registry events and `state_changed`, and registers
   `reload()` to run on every (re)connect.
3. Once the inventory is loaded, `Safety.restore_leftovers()` restores anything in
   `snapshots.json` (skipped in read-only mode, which keeps the file).
4. On shutdown, if anything is still touched and HA is reachable, `stop_all()` restores it
   (10 s limit), then the websocket closes.

## What's not here yet

Direct drivers (z2m, Z-Wave JS, WiZ, WLED, Govee LAN), effects and palettes, shows, triggers,
plugins, MQTT entities: phases 2–8 in [BRIEF.md](../BRIEF.md). The mapping analysis was
prototyped in `proto/mapping/`; the add-on's version is in `mapping/`.
