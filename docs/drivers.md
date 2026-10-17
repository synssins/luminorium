# Drivers

Every command to a light goes through one driver. **HA** (`drivers/ha.py`) reaches every light
through `light.*` / `switch.*` services and is always there. The **direct drivers** talk to a
light's hub or the light itself, which is faster, carries more (Z-Wave multicast, exact durations,
z2m groups, WLED pixels) and takes no HA service calls. All of them implement `Driver`
(`drivers/base.py`); the direct ones extend `DirectDriver`.

| Driver | Integration | Path | Network (budget) | Latency, rate per light |
|---|---|---|---|---|
| `ha` | any | HA websocket `call_service` | the integration's (`zwave`, `zigbee`, `govee_cloud`, …) + HA's 10 calls/s | network + 50 ms, ≤ 2 Hz |
| `z2m` | zigbee2mqtt | MQTT `zigbee2mqtt/<name>/set` on Mosquitto | `zigbee` 25/s, a group message counts 1 | 200 ms, 5 Hz |
| `zwave_js` | zwave_js | Z-Wave JS server websocket | `zwave` 2/s, a multicast counts 1 | 600 ms, 0.5 Hz |
| `wiz` | wiz | UDP 38899 | – | 120 ms, 15 Hz |
| `wled` | wled | HTTP JSON API; DDP on UDP 4048 | – | 30 ms, 40 Hz |
| `govee` | govee2mqtt | UDP 4001 / 4002 / 4003 (LAN API) | `govee_lan` (no shared budget) | 100 ms, 10 Hz |

Relays (included switches) keep their 0.2 Hz limit whichever driver they use.

## Which driver a light uses (`drivers/router.py`)

- **Automatic** (default): the direct driver for the light's integration if it is switched on
  and can reach the light now (`handles(light)`), else HA.
- **Pinned** by the user (UI select, `PUT /api/lights/{id}/driver`, stored in `choices.json`
  under `drivers`): `ha`, or the integration's direct driver. A pinned direct driver that can't
  reach the light falls back to HA and the light shows a note ("WiZ LAN can't reach it now:
  using HA"). Nothing else can be picked (`400`).
- **Per command**: a state the chosen driver can't carry goes through HA instead (a Govee scene
  over LAN, a WiZ effect name that isn't a firmware scene, a WLED effect the controller doesn't
  have). The governor asks `driver.supports(light, state)`.
- The router re-runs after every inventory rebuild and whenever a driver finds or loses a
  device (`DirectDriver.changed()`), and sets each profile's `driver`, `drivers` (what can reach
  it, chosen first), `driver_note`, `endpoint` ("z2m 'Front Porch Light '"), `network`,
  `latency_ms` and `max_rate_hz` (`profiles.apply_driver()`).
- `driver_for()` checks reachability again at send time, so a device lost between two router
  runs goes through HA.

## Finding the hubs and devices (`discovery.py`)

| What | How |
|---|---|
| Mosquitto | Supervisor `GET /services/mqtt` (the add-on declares `services: [mqtt:need]`, so the Supervisor gives it its own user). Never logged with the password. |
| Z-Wave JS server | In order, each tried until one connects: the `zwave_url` option; the URL HA itself uses (`zwave_js/network_status` → `client.ws_server_url`); `ws://core-zwave-js:3000`; `ws://<ip>:3000` with the add-on's IP from `GET /addons/core_zwave_js/info`. With host networking the hostname may not resolve, hence the IP. |
| Zigbee2MQTT devices | The retained `zigbee2mqtt/bridge/devices`: IEEE address → friendly name. HA's device identifier is `zigbee2mqtt_<ieee>`. Never HA's device name (one real z2m name ends in a space). Groups from `bridge/groups`, bridge online/offline from `bridge/state`. |
| WiZ bulbs | `getSystemConfig` to every address of `wiz_subnets` (default `192.168.10.0/24`), matched to HA's device `connections` MAC. Every 10 minutes, and again when a bulb stops answering. |
| WLED | The HA device's `configuration_url` is its address; `/json/info` must report the MAC in HA's `wled` identifier. Effects, palettes and segments read from `/json/eff`, `/json/pal`, `/json/state`. Every 5 minutes. |
| Govee | `scan` to `239.255.255.250:4001` and unicast to every address of `govee_subnets`; devices answer on UDP 4002. Matched by device id: govee2mqtt's identifier `gv2mqtt-<id>` = the reply's `device` without colons. |

All discovery is reading: nothing found is changed. In `read_only` mode drivers still discover
(so the UI shows what they would use), but every `set`, `set_batch` and `stream` raises
`ReadOnlyError`.

## The drivers

### z2m (`drivers/z2m.py`)

- `set` payload: `state` (`ON`/`OFF`), `brightness` 0–254, `color` (`{x, y}`, `{hue,
  saturation}` or `{r, g, b}`), `color_temp` in mired, `effect` (only names the light lists),
  `transition` in seconds (only where transitions are native). Multi-endpoint devices get
  `state_l1`, `brightness_l1`, ….
- **Groups:** `batches()` covers the requested lights with z2m groups whose members are all
  among them (largest first); one message to `zigbee2mqtt/<group>/set` each. Lights not covered
  go one by one. Groups are used only when they match exactly: a z2m group can't address a
  subset.
- MQTT: `net/mqtt.py`, a small MQTT 3.1.1 client (QoS 0, keepalive, reconnect with backoff,
  subscriptions renewed on reconnect so retained topics arrive again). Not aiomqtt or paho:
  both need the selector event loop on Windows, and uvicorn and the tests run on the default one.

### zwave_js (`drivers/zwave.py`)

- The value behind a light comes from HA's unique id `<home>.<node>-<cc>-<endpoint>-currentValue`:
  Multilevel Switch (38) for dimmers, Binary Switch (37) for relays.
- `node.set_value` on `targetValue`: 0–99 (brightness × 99 / 255, at least 1 when on), 255 for
  "on at the previous level", `true`/`false` for relays. `transitionDuration` (`"3s"`) only for
  Multilevel Switch v2+: the five GE 12724s (v1) get no duration and use their own ramp.
- **Multicast:** `batches()` groups by security class, command class, endpoint and duration
  support; S0 and unknown-security nodes go one by one (zwave-js can't multicast S0, and S2
  multicast is per class). This house: the insecure GE dimmers together, the Honeywell alone
  (it takes a duration, the GEs don't), the two S2 Authenticated Zooz dimmers together.
  `multicast_group.set_value` is one frame and takes one token from the Z-Wave budget.
- **Read-back:** multicast is unacknowledged. After it (1.5 s plus the transition), the driver
  polls each node's `currentValue` and resends by unicast to any node that missed it. Nodes that
  got a newer command meanwhile are skipped (latest value wins). Polls and resends take tokens
  from the same budget (`driver.acquire` = `Governor.network_token("zwave")`).
- **Unicast after a miss:** multicast frames aren't routed, so a node outside the stick's direct
  radio range never hears them (on the house, the lower hallway GE dimmer, node 22). A node that
  misses a multicast is added to `unicast_only` (shown in the driver status) and gets its own
  unicast from then on; the others keep sharing a multicast. The list is relearned after a
  restart, at the cost of one more miss and correction.
- Dead nodes (`start_listening` status, then `dead`/`alive` events) go to HA (which will fail
  too, but visibly).

### wiz (`drivers/wiz.py`)

- `setPilot`: `state`; `dimming` 10–100 (WiZ's minimum is 10 %); `r`, `g`, `b` for colour or
  `temp` clamped to the bulb's range; `sceneId` for an effect named like a firmware scene (HA's
  WiZ effect names: "Fireplace" → 5); `speed` 10–200 % through `effect(light, name, speed)`.
  No transitions (the firmware has none).
- Each `setPilot` waits for the bulb's reply (two tries within 1 s); no reply raises.
- `getPilot` every 30 s; three misses in a row and the bulb goes back to HA (and a sweep runs,
  in case its address changed).

### wled (`drivers/wled.py`)

- HA's lights map to a controller as: unique id `<mac>` = the master light (global `on`/`bri`),
  `<mac>_<n>` = segment n (`seg[n]`: `on`, `bri`, `col`, `fx`). With a single segment HA shows
  no master light, so that light's on/off and brightness go to the whole device.
- `tt` (this call's transition, in 100 ms) carries `transition_ms`.
- `effect(light, name, palette=, speed=, intensity=)`: by name, looked up in the controller's
  own lists.
- **DDP** (`stream(light, pixels)`): RGB frames to UDP 4048, 480 pixels per packet, the push flag
  on the last one, offset at the segment's first LED. WLED shows them in realtime mode and goes
  back to its own state a few seconds after frames stop. The caller paces frames; nothing is
  rate-limited here.

### govee (`drivers/govee.py`)

- `turn`, `colorwc` (RGB, or kelvin with RGB zero), `brightness` 1–100, sent in that order to
  UDP 4003. Govee doesn't answer these; `devStatus` (answered on 4002) is polled every 60 s and
  three misses send the device back to HA.
- Scenes aren't in the LAN API: a state with an effect goes through HA (govee2mqtt, the cloud).
- **Segments (`razer`)**: one frame with an RGB value per segment (`BB, length, B0, 01, n,
  RGB × n, XOR`, base64 in `{"cmd": "razer", "data": {"pt": …}}`), after an enable frame. The
  layout is reverse-engineered (OpenRGB) and not verified on Chris's models, so `can_stream()`
  is false unless the device's model is in the `govee_razer_models` option. A normal command
  ends streaming first.
- The driver listens on UDP 4002. If govee2mqtt (host networking) already holds it, the Govee
  driver reports "can't listen on UDP 4002" and stays off; every Govee light keeps going through
  HA.

## Simultaneous changes (the governor)

`Governor.send_many(lights, state)` (used by the Test button for fixtures, and by shows later):
each light gets the command in its own slot (latest value wins, priorities as usual). When a
light's turn comes, its worker claims the other lights of the same batch that are due now and on
the same driver, and asks the driver to split them into messages (`batches()`). Each message
takes **one** token from the network budget; after the token wait, lights that got a newer
command meanwhile are left out (their newer command is theirs). See [safety.md](safety.md).

## Streaming

`can_stream(light)` / `stream(light, pixels)` send one frame of per-LED (WLED) or per-segment
(Govee razer) colours. Frames bypass the governor: the effects engine (phase 3+) paces them.

## Testing without the house

| Fake | File | What it does |
|---|---|---|
| MQTT broker + Zigbee2MQTT | `tools/fake_mqtt.py` | Broker with retained messages and credentials; `FakeZ2M` publishes `bridge/devices` from the HA fixtures (including the trailing-space name), `bridge/groups`, `bridge/state`, echoes `<name>/set` as state |
| Z-Wave JS server | `tools/fake_zwave.py` | `version`, schema, `start_listening` (nodes from the fixtures, dead ones dead), `node.set_value`, `multicast_group.set_value`, `node.poll_value`; `multicast_misses` drops multicasts for chosen nodes |
| WiZ bulb | `tools/fake_lan.py` `FakeWiZBulb` | UDP on loopback, after Bifrost's `tests/wiz.rs`; `answer=False` = unplugged |
| WLED | `tools/fake_lan.py` `FakeWLED` | `/json/info`, `/eff`, `/pal`, `/state` (GET, POST) and a DDP receiver |
| Govee | `tools/fake_lan.py` `FakeGovee` | scan and control ports on loopback, replies to the driver's port |
| Supervisor | `tools/fake_supervisor.py` | `services/mqtt`, `addons/<slug>/info`, bearer token |

Real-light checks that need Chris's OK are listed in [driver-tests.md](driver-tests.md); none
has been run.

## Known limits

- **Outside-change detection** relies on HA's state reports. A direct driver returns no HA
  context id, so a light's next report is recognised as ours only by matching what was asked
  (on/off, brightness within 51/255). A report mid-transition that doesn't match yet could be
  taken for someone else's change and drop the light from its session (it is then not restored).
  Watch for this in the first real tests.
- The Z-Wave duration split puts the Honeywell (v4) apart from the GEs (v1) even when no
  transition is asked for; one extra frame.
- WiZ push updates (`syncPilot` on UDP 38900) aren't used: cross-VLAN push is unconfirmed;
  polling does the job.
- Govee razer and WLED DDP have no user of their own yet; the effects engine will drive them.
