# Development

Everything runs on Windows (or any OS with Python 3.12+). No Home Assistant, Docker or real lights
are needed.

## Setup

```bash
py -3.13 -m venv .venv
.venv/Scripts/python -m pip install aiohttp fastapi uvicorn pytest pytest-asyncio httpx ruff
```

The add-on's own pinned dependencies are in `luminorium_addon/requirements.txt`.

## Tests

```bash
.venv/Scripts/python -m pytest
```

| File | Covers |
|---|---|
| `tests/test_inventory.py` | The builder on the real-house fixtures: floors, exclusions, switches, settings, segments, duplicates, Z-Wave and Hue profiles, user choices |
| `tests/test_governor.py` | Latest value wins, priorities, restore skips the per-light wait, network budget, cancel |
| `tests/test_safety.py` | Test button sequence and restore, relays, refusals, outside changes, Stop all, crash recovery, read-only, reconnect |
| `tests/test_web.py` | API endpoints, include/exclude, pages, the ingress-only allow-list |

`pytest-asyncio` runs in auto mode. `tests/conftest.py` gives a `fake_ha` server and a started
`lum` app (data in a temp folder, test hold time 0.05 s).

## The fake HA (`tools/fake_ha.py`)

A websocket server speaking HA's protocol from the fixtures:
- auth (token `fake-token`), the four registry lists, `get_states`, `subscribe_events`, `ping`
- `zwave_js/node_status` and `zwave_js/node_capabilities`
- `call_service` for `light.turn_on/turn_off` and `switch.turn_on/turn_off`: updates its states,
  emits `state_changed` with the call's context, records each call (`fake.calls`,
  `fake.calls_for(entity_id)`)
- `latency` per entity and `default_latency` to delay state changes
- `external_change(entity_id, state, **attrs)` to simulate a wall switch, `drop_clients()` to
  simulate an HA restart

Run it alone: `.venv/Scripts/python tools/fake_ha.py --port 8124`.

## Running the app

```bash
.venv/Scripts/python tools/dev.py              # fake HA, UI on http://127.0.0.1:8199/
.venv/Scripts/python tools/dev.py --real --port 8198
```

`--real` connects to the house HA **read-only** (forced; there is no switch to turn it off in
`dev.py`) with the token from `LUMINORIUM_HA_TOKEN_FILE`. `.claude/launch.json` has both as
`luminorium-fake` and `luminorium-real-readonly`. Dev data goes to `.dev-data/`.

`python -m luminorium` (from `luminorium_addon/`) also works with environment variables:
`LUMINORIUM_HA_URL`, `LUMINORIUM_HA_TOKEN` or `LUMINORIUM_HA_TOKEN_FILE`, `LUMINORIUM_DATA_DIR`,
`LUMINORIUM_PORT`, `LUMINORIUM_HOST`, `LUMINORIUM_LOG_LEVEL`. Against anything but `127.0.0.1` it
is read-only unless `LUMINORIUM_ALLOW_WRITES=1`.

## Fixtures

`tests/fixtures/ha/` holds data captured read-only from the real HA and scrubbed:

```bash
node tools/capture_ha.mjs <scratch dir>        # registries, states, Z-Wave node details
.venv/Scripts/python tools/make_fixtures.py <scratch dir>
```

`make_fixtures.py` keeps lights, switches (from lighting-related integrations only) and assist
satellites plus their devices. It replaces MAC addresses, Govee ids, the Z-Wave home id, emails
and personal names consistently across files, and drops serial numbers. Keep the raw capture out
of the repository. After refreshing, expect some test values (counts, specific entities) to need
updating.

## Lint and format

```bash
.venv/Scripts/ruff check .
.venv/Scripts/ruff format .
```

Settings are in `pyproject.toml` (line length 100; `proto/` excluded).

## Ground rules

- Never print, log or commit the HA token. `Settings.__repr__` hides it; the capture tools read it
  from the file and never echo it.
- Reading HA's registries and states is fine. Anything that changes a real light, touches a
  `switch.*`, or installs or changes anything in HA needs the owner's OK first.
- Plugins (later phases) are Python only.
