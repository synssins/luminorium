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
| `tests/test_driver_z2m.py` | MQTT client and z2m driver against the fake broker: names by IEEE (trailing space), payloads, groups, bridge offline, reconnect, bad credentials, read-only |
| `tests/test_driver_zwave.py` | Z-Wave JS driver against the fake server: URL fallback, durations only on v2+, multicast by security class, read-back and resend, latest value wins over a read-back, read-only |
| `tests/test_driver_wiz.py` | Sweep and MAC match, `setPilot` params, scenes, polling and reachability, read-only |
| `tests/test_driver_wled.py` | Ids from HA, state bodies, effects and palettes, DDP packets and streaming to a segment, wrong MAC, read-only |
| `tests/test_driver_govee.py` | Unicast and multicast scan, commands, `devStatus`, scenes through HA, missed polls, razer only when enabled, port in use, read-only |
| `tests/test_router.py` | Automatic choice, fallback, pins, notes, relays, re-routing on driver changes |
| `tests/test_drivers_app.py` | The whole app with fake HA, Supervisor, broker, Z-Wave server, WiZ bulb and WLED: discovery, status, Test via z2m, pin to HA, fixture test by multicast, Test with fade and effect, read-only |
| `tests/test_load.py` | A burst on eight Z-Wave dimmers with the real budget: never exceeded, latest value wins; a multicast takes one token |

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

It also answers `zwave_js/network_status` with `zwave_server_url` (where the Z-Wave driver
looks first).

## Fake devices for the direct drivers

`tools/fake_mqtt.py` (broker + fake Zigbee2MQTT), `tools/fake_zwave.py` (Z-Wave JS server),
`tools/fake_lan.py` (WiZ bulb, WLED, Govee), `tools/fake_supervisor.py`. All run on loopback and
record what they receive with timestamps. Details in [drivers.md](drivers.md#testing-without-the-house).

**Tests never reach the LAN.** `DriverSettings()` enables no direct driver; a test that wants
one points it at a fake (`wiz_hosts=("127.0.0.1:<port>",)`, `wiz_subnets=()`, …).

## Running the app

```bash
.venv/Scripts/python tools/dev.py              # fake HA, UI on http://127.0.0.1:8199/
.venv/Scripts/python tools/dev.py --real --port 8198
```

The fake run also starts fake devices (broker + z2m, Z-Wave JS server, a WiZ bulb, the WLED
front pathway), so the UI shows lights going "via Zigbee2MQTT", "via Z-Wave JS" and so on, and
Test goes through them.

`--real` connects to the house HA **read-only** (forced; there is no switch to turn it off in
`dev.py`) with the token from `LUMINORIUM_HA_TOKEN_FILE`. `.claude/launch.json` has both as
`luminorium-fake` and `luminorium-real-readonly`. Dev data goes to `.dev-data/`.

`python -m luminorium` (from `luminorium_addon/`) also works with environment variables:
`LUMINORIUM_HA_URL`, `LUMINORIUM_HA_TOKEN` or `LUMINORIUM_HA_TOKEN_FILE`, `LUMINORIUM_DATA_DIR`,
`LUMINORIUM_PORT`, `LUMINORIUM_HOST`, `LUMINORIUM_LOG_LEVEL`, and `LUMINORIUM_DRIVERS` (a comma
list of direct drivers to switch on; none by default, since they reach the real LAN). Against anything but `127.0.0.1` it
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
