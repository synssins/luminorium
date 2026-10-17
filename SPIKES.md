# Luminorium: research spike results

2026-10-16. Read-only: HA websocket (registries, states, `zwave_js/*` and `mqtt/device/debug_info`
queries), Supervisor add-on info (secrets redacted), the govee2mqtt web API, WLED `/json/info`, and
WiZ `getSystemConfig` / `getPilot` queries over UDP from the PC (192.168.1.25). Nothing was set,
toggled or installed. Raw dumps are kept outside the repo.

## 0. The inventory is not what DESIGN.md §2 says

| Kind | Light entities | Real, alive | Notes |
|---|---|---|---|
| Govee (govee2mqtt) | 99 | 5 devices | H7021 ×2 (back patio strings, 30 segments each), H7055 (front path lights, 15), H7066 (back patio flood), H60B0 (NW bedroom uplighter). Segment entities are `<device>_segment_NNN`, command topic `gv2mqtt/light/<id>/command/<n>`. |
| z2m | 20 + 4 groups | 20 | Hue ×7 (porch, front entry ×2, driveway ×2, two bedrooms), Gledopto ×7, CREE ×3, LEDEPLY ×2, Sunricher ×1 |
| Z-Wave `light.*` | 15 | **8 dimmers** | 5 are `_basic` mirror entities (Basic CC, all unavailable), 2 are dead nodes (floor lamp, master-bedroom **fan** controller) |
| Z-Wave `switch.*` | 29 | 11 light relays | Backyard (ZEN76), back patio (Honeywell), garage, kitchen, laundry and others. Front porch, front entryway and front driveway are **locked-on relays that only send commands** (Hue bulbs behind them). The rest are ZEN32 LED indicators, garage doors, a ceiling fan. |
| WiZ | 4 | 2 answer | `192.168.10.64` (C3B549, no area), `192.168.10.195` (F1E0A7, "master bedroom ceiling flood" but in area Office). The two master-bedroom arc lamps did not answer (likely off at the wall). |
| WLED | 9 | 1 controller | Only "Front pathway lights" (`192.168.10.215`, 8 LEDs, WLED 17.0.0-dev) is reachable. The other 3 controllers are unavailable in HA too. |
| ESPHome / Matter | 3 / 1 | 0 | Voice-satellite LED rings (exclude by default). The Matter light is the **same Govee H60B0** lamp as the gv2mqtt one: a duplicate to de-duplicate. |

- Outdoor areas (Porch, Driveway, Front Yard, Back Yard, Back Patio) have **no floor**. The UI
  needs an "Outside" bucket.
- 12 lights have no area at all.
- The **front of the house**, the first mapping target, is: Hue porch flood, 2 Hue entry floods,
  2 Hue driveway bulbs, WLED pathway (8 px), Govee H7055 path lights (15 segments), plus front
  windows (Z-Wave dimmers, Hue, Gledopto). All of it is fast or medium-speed except the windows.
  The porch, entryway and driveway Z-Wave switches are locked-on relays that only send commands,
  so they are not lights.

## 1. Z-Wave JS

- **Reachable as `ws://core-zwave-js:3000`.** That is the URL HA core itself uses (from
  `zwave_js/network_status`). Server 3.10.2, driver 15.29.0, Zooz ZST39 LR controller (SDK 7.24.2).
  Port 3000 is **not** published on the host, so the PC can't reach it; another add-on can.
  zwave-js-server accepts several clients at once.
- **Hostname gotcha:** Luminorium wants `host_network: true` for UDP. A host-network container may
  not resolve `core-zwave-js` through the Supervisor DNS. Plan: try the hostname, then fall back to
  the add-on's `ip_address` from the Supervisor API (`/addons/core_zwave_js/info`, currently
  `172.30.33.13`, reachable from the host through the hassio bridge). Same pattern for Mosquitto.
- **The dimmers (8 alive):**

  | Node | Device | Multilevel Switch CC | Security | Duration? |
  |---|---|---|---|---|
  | 7, 12, 22, 31, 38 | GE 12724 (living, dining, lower hall, master bed, basement) | **v1** | none | **No.** v1 has no duration; the switch uses its own ramp-rate parameters |
  | 30 | Honeywell 39351 (upstairs hall) | v4 | none | Yes |
  | 26 | Zooz ZEN77 (kitchen cabinets) | v4 | S2 Authenticated | Yes |
  | 51 | Zooz ZEN35 (living room scene controller) | v4 | S2 Authenticated | Yes |

  Dead nodes: 2, 8, 16, 17, 32, 33 (office overhead, floor lamp, wood shop, back driveway, master
  fan, headboard).
- **Multicast:** zwave-js multicasts only within one security class (S0 can't multicast at all;
  S2 multicast is per class). This house has two usable groups: **insecure** (the five GE 12724s
  plus the Honeywell dimmer, and the insecure relays) and **S2 Authenticated** (ZEN77, ZEN35, and
  the ZEN71/ZEN76/Eaton relays). Multicast is unacknowledged, so the driver must read state back
  afterwards. Whether it actually works on these models **can't be tested read-only**: it needs
  one test on two lights you choose (see "Tests I'd like to run").
- **Consequence for `dip`:** on the GE 12724s a dip is a snap down and a snap (or ramp-rate) back
  up, not a timed 3–4 s fade. The ZEN77/ZEN35/Honeywell can fade with exact durations.

## 2. z2m over MQTT

- Base topic is the default **`zigbee2mqtt`** (confirmed from HA's MQTT discovery data: state topic
  `zigbee2mqtt/<friendly name>`, command `…/set`, JSON schema).
- HA identifiers are `zigbee2mqtt_<ieee>`. Map IEEE → friendly name from the retained
  `zigbee2mqtt/bridge/devices`, **never from the HA device name**: one friendly name has a trailing
  space (`"Front Porch Light "`).
- z2m groups appear in HA as `zigbee2mqtt_<long id>_<group id>`; members come from
  `zigbee2mqtt/bridge/groups`, not from an `entity_id` attribute.
- Hue bulbs expose 20 native effects through z2m (`candle`, `fireplace`, `colorloop`, `sunrise`,
  `sunset`, `sparkle`, `opal`, `glisten`, `underwater`, `cosmos`, `sunbeam`, `enchant`, …). Gledopto
  and LEDEPLY only have the basic 6–8 (`blink`, `breathe`, `okay`, `colorloop`, …).
- Mosquitto: `GET /services/mqtt` is refused for an admin token (expected: only the add-on that
  declares `services: mqtt:need` can read it). Mosquitto's own `logins` list is empty, so it uses HA
  user auth; the Supervisor will issue Luminorium its own credentials. z2m connects to
  `mqtt://192.168.1.104` (host port 1883).

## 3. Govee

- **No Govee device is on the LAN path today.** govee2mqtt reports `ip: null` and `lan: null` for
  all 5 devices; everything goes through the **cloud Platform API** (`source: PLATFORM API`), and 3
  of 5 have no state at all.
- That matters a lot: every segment command is a cloud call, slow (around 1 s) and counted against
  Govee's daily API quota. A wave across 30 segments through the cloud isn't viable.
- My own LAN scan from the PC got no answer either, but that's **inconclusive**: replies come back
  to UDP 4002, which Windows Firewall likely drops.
- Likely causes, in order: LAN Control is off on the devices, or they're on the IoT VLAN
  (192.168.10.x, like WiZ and WLED) where multicast discovery (239.255.255.250:4001) doesn't reach.
  govee2mqtt can be told to scan unicast addresses for the second case.
- **All 5 models support the LAN API**: H7021, H7055, H7066 and H60B0 are all on Govee's official
  LAN list (the JSON behind app-h5.govee.com/user-manual/wlan-guide, checked 2026-10-16).
- LAN protocol: scan to 239.255.255.250:4001, replies on 4002, commands unicast to device:4003
  (`turn`, `brightness`, `colorwc`, `devStatus`). Multicast often fails across Wi-Fi/VLANs, so
  unicast scan of a configured subnet is needed (same as WiZ).
- **Segments over LAN are possible but undocumented**, by two reverse-engineered methods:
  - `ptReal`: base64 BLE frames (`33 05 15 01 RR GG BB … <segment mask>` + XOR). Verified on
    few models; the layout is per model.
  - `razer` streaming (DreamView/desktop-sync mode, used by OpenRGB): one frame carries RGB for
    every segment, ~40 fps reported. Best fit for an effects engine; app scenes pause while it's on.
    Model coverage is unverified for these five; it needs a test per device.
- **govee2mqtt sends segments only through the cloud**, even when LAN is available. So Govee
  segment waves need Luminorium's own LAN driver; govee2mqtt can stay for HA entities and scenes.

## 4. WiZ direct

- Confirmed from the PC (same 192.168.1.x subnet as HA): unicast UDP 38899 to `192.168.10.x`
  routes, and replies come back. A /24 sweep finds bulbs in under a second; match by MAC
  (`getSystemConfig.mac` = the HA device `connections` MAC).
- Round trip is about **100 ms** typical with occasional 400 ms–1.1 s spikes (Wi-Fi power save), not
  the 60 ms DESIGN.md assumes. Start the default latency at 120 ms and let mapping measure it.
- Bifrost's protocol notes carry over as is: `setPilot` with `sceneId`/`speed`, minimum dimming 10 %,
  no transition (software fades), 10–20 updates/s, drops above ~30/s, push `syncPilot` on UDP 38900
  after `registration` (cross-VLAN push is unconfirmed; fall back to polling).
- WLED on `192.168.10.215` answers HTTP from the PC too, so DDP (UDP 4048) should route the same
  way.

## 5. Phone camera through Ingress

- **HTTPS exists:** Nabu Casa remote UI is connected (subscription active). No `external_url` is
  set, so the app should build the phone link from the cloud remote URL.
- **Camera in the companion apps works** in current source: Android maps the WebView camera
  request to the OS CAMERA permission; iOS grants media capture in WKWebView. DESIGN.md's
  "unreliable" is out of date. Keep "Open in browser" as a fallback anyway.
- **The Ingress iframe is not a blocker.** HA's app panel renders the iframe with no `allow`
  attribute, but Ingress is same-origin with the HA frontend, so camera, accelerometer and gyroscope
  are allowed by default. iOS needs `DeviceMotionEvent.requestPermission()` from a tap.
- **Exposure lock:** Android Chrome/WebView supports `exposureMode`, `exposureTime`,
  `whiteBalanceMode`, `iso` (device-dependent). **iOS supports only `whiteBalanceMode: 'manual'`**,
  no exposure lock. The analysis must normalise exposure in software (global brightness tracking
  on stable reference regions), which it needs anyway for auto-exposure on any phone.
- Record-and-upload (`<input type="file" accept="video/*" capture="environment">`) works on both
  apps.
- Not tested on a real phone yet: that needs a stub page installed in HA (phase 1).

## 6. Image size

- The HA host is **amd64 only** (generic x86-64, HAOS 18.2). aarch64 can wait.
- **opencv-python-headless has no musllinux (Alpine) wheels.** The Sonorium-style Alpine base
  (`hassio-addons/base`) would mean building OpenCV from source. Use a **Debian base**
  (`ghcr.io/home-assistant/base-debian:trixie`, ~35 MB compressed, Python 3.13 from apt).
- Installed sizes (PyPI, 2026-10-16): opencv-python-headless 5.0 ≈ 160 MB on x86_64 (90 MB
  aarch64), numpy ≈ 56 MB. Expected image: **~250–300 MB on amd64**. Fine for HAOS; it's a
  one-time pull per version.
- Not measured by a real build (Docker isn't on this PC). Phase 1 ships without OpenCV; it arrives
  with phase 5, when the real size gets measured.

## Mapping prototype: synthetic, guided capture

Decided 2026-10-16: no recording of the house. Mapping is a guided capture (centre, 45° left,
45° right, anchor kept centred; DESIGN.md §8). The prototype (`proto/mapping/`, outside the
add-on) is tested on synthetic data instead:

- a small 3D scene: house-front and ground planes, windows and lamps as emitters, some occluded
  from one station
- rendered from three stations with hand shake, slow drift, auto-exposure drift, sensor noise
  and a jolt, while lights toggle with known latencies
- scored against the known truth: detection, region, latency, station poses, 3D positions

That gives exact ground truth, which a real video wouldn't. The first real check is Chris doing
the guided capture in phase 5.

## Tests I'd like to run on real lights (need your OK)

(Superseded for the phase 2 drivers by [docs/driver-tests.md](docs/driver-tests.md), which
covers these and a few more, run from Luminorium itself.)

None of these has been done.

1. **Z-Wave multicast:** one `multicast_set_value` to two insecure GE 12724s (for example basement
   main + lower hallway) at 30 %, then back. Then the same for the two S2 dimmers (ZEN77 + ZEN35).
   Daytime, about 10 s total.
2. **Z-Wave duration:** one 3 s fade on the ZEN77, to confirm the duration is honoured.
3. **WiZ:** one `setPilot` brightness change on the C3B549 bulb, to measure command latency.

## What this changes in DESIGN.md

1. **§2 inventory:** replace the table with section 0 above. "15 Z-Wave dimmers" is 8; "29 MQTT
   Govee devices" is 5; WLED is 1 live controller. Add an **"Outside" pseudo-floor** for areas with
   no floor.
2. **§4 lights:** `switch.*` is excluded by default; the user opts in **light relays** (11 here,
   including backyard and back patio) with an `on_off_relay` profile: on/off only, a slow minimum
   toggle interval (relay wear, and some click), never streamed. Everything else stays excluded,
   including locked-on relays that already control smart bulbs (front porch, entryway, driveway).
3. **§4 de-duplication:** add cross-integration duplicates (the H60B0 is both Matter and
   govee2mqtt). Rule: same manufacturer + model in two integrations → suggest "same light",
   user confirms; prefer the better driver. And: Z-Wave `_basic` mirror entities are excluded.
4. **§4 Z-Wave driver:** connect by hostname, fall back to the Supervisor-reported IP. Multicast
   groups are split **by security class**. Multilevel Switch **v1** (the five GE 12724s) has no
   duration: the planner must treat them as "snap" lights. Default latency stays 600 ms until
   measured.
5. **§4 z2m driver:** names from `bridge/devices` by IEEE (a trailing space exists), groups from
   `bridge/groups`.
6. **§4 Govee driver:** govee2mqtt's segments are cloud-only, so it can't carry waves. The Govee
   LAN driver (unicast subnet scan, `razer` streaming for segments) moves **up from phase 8 to
   phase 2/3**, because the front path lights are Govee. Until then Govee gets whole-device colour
   and native scenes only.
7. **§4 defaults:** WiZ latency 100–120 ms, not 60.
8. **§7 plugins:** Sonorium's framework is "plugin API 1.2" (`docs/PLUGIN_DEVELOPMENT.md`):
   manifest.json + `BasePlugin` with async `on_load/on_enable/on_disable/on_unload/
   on_settings_changed`, zip upload or catalog install, **live enable and reload without restart**,
   plugins in the `addon_config` folder (`/config`), optional wheel-only pip deps. Mirror that
   instead of "install, then restart".
9. **§8 phone capture:** guided three-station capture with triangulation (already written into §8
   and BRIEF phase 5). The companion apps do allow the camera (drop "unreliable"). iOS can't
   lock exposure from the web, so the analysis must normalise exposure in software on every
   phone. HTTPS comes from Nabu Casa.
10. **§12 packaging:** Debian base (`ghcr.io/home-assistant/base-debian:trixie`), not Alpine, because
    of OpenCV. `arch: [amd64]` first (the host is amd64). User content in `addon_config`
    (`/config`), runtime state in `/data`; both are in backups.

## Proposed phase 1 plan

Goal unchanged: installed on HA, every real light shown by floor and area with capabilities, and a
test button that turns one chosen light on, off, and restores it.

1. **Repo skeleton:** add-on folder (`config.yaml`, `build.yaml`, Debian `Dockerfile`, run script),
   Python package `luminorium/` (asyncio, FastAPI + uvicorn like Sonorium), pytest, ruff.
2. **HA link:** websocket client with reconnect; auth by `SUPERVISOR_TOKEN` in the add-on, or URL +
   token from env when run on the PC. Subscribes to registry updates and `state_changed`.
3. **Fake HA:** a websocket server that replays fixtures made from today's dumps, scrubbed (fake
   MACs, IDs, Nabu Casa domain removed), and records service calls with timestamps. All phase 1
   tests run against it.
4. **Inventory:** floors (plus "Outside"), areas, lights; area from entity, else device. Default
   exclusions (browser_mod, `group`, signalrgb, voice-satellite rings, Z-Wave `_basic` mirrors),
   z2m groups as group handles, Govee parent + segments folded under one device, cross-integration
   duplicate suggestions, `switch.*` opt-in per entity, dead/unavailable shown, not hidden.
5. **Profiles:** capabilities from HA attributes; network, driver, rate and latency defaults per
   integration (the corrected table); Z-Wave MLS version and security class pulled from
   `zwave_js/node_capabilities` and `node_status`.
6. **HA driver and safety:** `light.*` / `switch.*` services; snapshot (state, brightness, colour
   mode, xy/ct, effect) persisted to `/data`; restore on stop, on error and **on startup after a
   crash**; "Stop all"; a minimal per-light latest-wins limiter and a ~10 calls/s HA budget; detect
   outside changes (state change without our context id) and drop the light.
7. **Web UI (Ingress), mobile-first, no build step:** Lights page by floor → area with capability
   badges, driver, network, include/exclude, switch opt-in, test button (on → off → restore).
8. **Camera check page:** a small page that reports `getUserMedia`, the track's capabilities
   (exposure and white-balance modes), and `DeviceMotionEvent`, so phase 5's phone questions are
   answered on your real phone, in the browser and in the companion app.
9. **Packaging and deploy:** versioned image tag per build, no digest in `build_from`, add-on
   repository. Needs your answers on the repo (below) before this step.

In parallel, if you want it: the synthetic mapping prototype above (`proto/mapping/`), outside the
add-on. It doesn't depend on phase 1.

## Open questions

1. **Answered (Z-Wave `switch.*`):** use this list for now, revisit later.
   - **Lights:** backyard, back patio, back entryway (500s), laundry, theater stairwell, kitchen
     sink, kitchen overhead (ZEN32), front garage ceiling, office overhead (new), basement
     perimeter, 3D printer shelf.
   - **Not lights:** living room ceiling fan, the three garage doors, the ZEN32 LED indicator and
     identify switches.
2. **Answered (front relays):** the porch, entryway and driveway relays (ZEN71, ZEN71, Eaton
   RF9601) are locked on and their paddles already control the Hue bulbs. Those three `switch.*`
   entities are simply **excluded**; the Hue bulbs are the lights.
3. **Govee:** is LAN Control on, and are the devices on the 192.168.10.x VLAN? (All five models
   support it; govee2mqtt sees none of them on the LAN today.)
4. **HTTPS:** Nabu Casa remote is active. OK to use the Nabu Casa URL for phone mapping?
5. **Dead and missing devices:** Z-Wave nodes 2, 8, 16, 17, 32, 33 are dead, and 3 WLED
   controllers are unavailable. Coming back (seasonal?) or gone?
6. **Repository and licence:** `synssins/luminorium`, public or private, which licence?
7. **Real-light tests** above: OK to run, and when?

## Driver checks on the real house (2026-10-16, 21:08–21:30, Luminorium 0.2.0-dev.2 → dev.3)

Run with Chris's OK, from the installed add-on (`host_network: true`), each light restored after.
State timings are from HA's `state_changed` events, relative to a watcher started ~2 s before
each Test.

| Check | Result |
|---|---|
| 0. Discovery (read-only) | Ingress works with host networking. MQTT credentials from the Supervisor (`addons` user); z2m 46 devices, 4 groups; Z-Wave JS 3.10.2 at `ws://core-zwave-js:3000`, 35 nodes; WiZ: **all 4 bulbs** (192.168.10.64, .161, .195, .230); WLED front pathway (8 LEDs, 220 effects). Badges as expected (porch Hue via z2m with the trailing-space name, ZEN77 node 26, C3B549 via WiZ, pathway via WLED segment 0). |
| Govee LAN | **Off:** govee2mqtt already holds UDP 4002 on the host, and the Govee devices were offline. Govee stays on HA. Needs a decision (below). |
| 1a. Z-Wave multicast, GE 12724 ×2 (insecure) | **Bug found and fixed.** Node 38 took the multicast; **node 22 (lower hallway) missed it**: multicast isn't routed and node 22 is out of the stick's direct range. The read-back corrected it by unicast, but Safety took the read-back's old level for a person, dropped the light and didn't restore it. Fixed in dev.3 (unicast after a miss; settling window). Rerun: run 1 miss → corrected, restored, nothing dropped; run 2 node 22 by unicast, both on within 0.17 s, off within 0.05 s. A plain unicast Test of node 22 alone worked cleanly. |
| 1b. Z-Wave S2 multicast, ZEN77 + ZEN35 | **Works.** One S2 multicast each for on and off, no misses; both off at the same instant; cabinets restored to 240. HA saw the ZEN35's "on" ~3 s after the ZEN77's (a late report; the read-back found the right level). |
| 2. 3 s fade, ZEN77 vs GE 12724 | Sequence correct for both (on, 3 s fade + 3 s hold, off, restore). HA reports only the end points, so the ramp itself wasn't measurable from here; to be confirmed by eye. |
| 3. WiZ C3B549 | **Works** via WiZ: HA saw the change ~0.2 s after the command; restored to on/full. |
| 4. WLED pathway, Breathe 5 s | **Works** via WLED: Breathe for 5 s, off, restored to Chris's Rainbow. (The controller's reboot at 21:09 was Chris, not the driver.) |
| 5. Govee `devStatus` | Not run (see Govee above). |

Open:
- **Govee LAN vs govee2mqtt:** both want UDP 4002 on the host. Either turn off govee2mqtt's LAN
  side (it would then use the cloud only, which it already does here) or stop govee2mqtt and let
  Luminorium own Govee on the LAN, keeping HA entities through govee2mqtt's cloud path or not at
  all. Govee replies always go to 4002, so they can't share it.
- `unicast_only` is relearned after every restart (one miss + correction). Persisting it is a
  small follow-up if the first-show flicker matters.
