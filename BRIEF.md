# Brief: build Luminorium

**For:** a Claude session starting this project in `F:\Projects\Luminorium`.
**From:** the Bifrost session (`F:\Projects\Bifrost-Hue`), 2026-10-16.
**Owner:** Chris (synssins). "Home Assistant is the end-all be-all." This is **the route we're
going** for light effects. Read [DESIGN.md](DESIGN.md) in full before starting.

## What Chris wants (his words, summarised)

An HA add-on solely for **light effects and the like**:

- **Use HA's rooms, areas and floors.** Don't recreate them.
- **Find all lights in HA.** Where a light runs through an integration, **control the integration
  directly** when that's better.
- **Plugins**, for example "when my team scores, change these lights to these colours", pulling
  online data and game schedules.
- **Lighting automations triggered by HA events:** motion, buttons, and so on.
- **Sequencing** across many lights of many types: a smooth, consistent wave of green left to right
  across the house, using the porch and driveway lights and the lights visible through windows.
- **Phone-camera mapping** of the house, like Twinkly, for positional awareness and per-light
  delays:
  - Not Frigate. Not coded blinking: some lights can't do real-time.
  - First choose "what's visible from here", then flash **one light at a time** and watch windows
    light up or go dark.
  - Small rooms with small windows act as one light. Long rooms with long windows can act as a
    group or as a wave/individual lights.
- Native effects first ("if a bulb supports fire, send fire"), palettes per theme, Sonorium themes
  that drive the lights, and later haunted-house scares (Z-Wave dimmers dipping for 3–4 s and
  recovering).

## Environment and access

| | |
|---|---|
| HA | `http://192.168.1.104:8123`, HA 2026.9.2, amd64, Supervisor. Admin long-lived token in `F:\Projects\Sonorium\ha.tok.txt`. **Never print it.** |
| HA API from the PC | Node 24 has a built-in WebSocket. A working helper is `ha_sup.mjs` in this folder: `node ha_sup.mjs ws '{"type":"config/entity_registry/list"}'`. In Git Bash, set `MSYS_NO_PATHCONV=1`, or paths like `/addons` get rewritten. Add-on logs: `GET /api/hassio/addons/<slug>/logs` with the bearer token. |
| Python | Python 3.12/3.13 is on the PC. **This project can be developed and tested on Windows**; no build box needed. |
| Relevant add-ons | Zigbee2MQTT `45df7312_zigbee2mqtt`, Z-Wave JS `core_zwave_js`, Mosquitto `core_mosquitto`, Node-RED `a0d7b954_nodered`, Sonorium `3395e787_sonorium`, Bifrost `ae6441a5_bifrost` (Hue API at `192.168.1.104`) |
| Sonorium | `F:\Projects\Sonorium` (Chris's own app; it has the plugin framework this app should mirror). GitHub `synssins/sonorium`. |
| Inventory | See DESIGN.md §2: 99 Govee segment entities, ~24 z2m, 15 Z-Wave dimmers, 9 WLED, 4 WiZ, 3 ESPHome, 1 Matter; 4 floors and 23 areas |

**Testing on the real house:** lights are in a lived-in home. **Ask Chris before flashing,
toggling or running shows on real lights**, especially at night, in bedrooms, or on Z-Wave
(29 Z-Wave switch entities, some of them relays for non-light loads: check before touching any
`switch.*`). Read-only registry and state access is fine.

## Decisions already made

- An **HA add-on**, in **Python**, with a web UI through **Ingress**, and plugins installed like
  Sonorium's (install, restart).
- HA is the inventory and area source; **direct drivers** where they pay off; HA services as the
  fallback.
- **Phone-based mapping** using the visible-lights, one-at-a-time, invert-and-restore flow. No
  Frigate.
- Bifrost stays for the Hue app and Hue Sync. It's optional as a driver here, not a dependency.
- The Sonorium lighting plugin becomes a **thin client** of this app (shows, palettes, cues). Tell
  the Sonorium session; its handoff is `F:\Projects\Bifrost-Hue\HANDOFF-sonorium-lighting.md`.

## Research spikes first (short, report back)

1. **Z-Wave JS server access from another add-on:** is the websocket (default port 3000) reachable
   from a second add-on, and under which hostname? Does multicast `set` work on Chris's dimmers
   (GE, Honeywell, Zooz, Enbrighten; mixed S0/S2 security)? Which models honour transition
   durations? Some older GE models ignore them.
2. **z2m over MQTT:** Mosquitto credentials through the Supervisor `services` API. Map HA entities
   to z2m friendly names from the device identifiers. Check the base topic.
3. **Govee:** which of Chris's models support the **LAN API** with LAN Control enabled, against
   staying on govee2mqtt. How do the 99 segment entities map to devices and segments?
4. **WiZ direct:** match HA WiZ devices to IPs by MAC (they're on `192.168.10.x`; the add-on uses
   host networking on `192.168.1.x`; UDP 38899 must be routed). Bifrost's WiZ code
   (`F:\Projects\Bifrost-Hue\bifrost\crates\wiz`, `doc/wiz.md`) documents the protocol, the
   discovery across VLANs, and the rate limits learned.
5. **Phone camera through Ingress:** `getUserMedia` and `DeviceMotionEvent` through HA over HTTPS,
   in a phone browser and in the HA companion app's webview; exposure and white-balance locking;
   the record-and-upload fallback. Prototype the handheld alignment and the three-station
   triangulation (OpenCV) on **synthetic** renders of a 3D house scene with hand shake, **before**
   building the mapping UI. (Decided 2026-10-16: no real recording of the house for the prototype;
   mapping is a guided centre / 45° left / 45° right capture, DESIGN.md §8.)
6. **Image size** with `opencv-python-headless` on amd64 and aarch64 base images.

## Phases

| # | Phase | Done when |
|---|---|---|
| 1 | **Skeleton add-on:** Ingress UI, HA link, inventory (floors, areas, lights, exclusions), profiles from HA attributes, HA driver, "Stop all" and restore | Installed on HA; shows all real lights by floor and area with capabilities; a test button turns one chosen light on and off and restores it |
| 2 | **Direct drivers:** z2m (MQTT), Z-Wave JS (with multicast), WiZ; rate governor with per-network budgets | Same commands work through direct drivers; the Z-Wave network budget is enforced (load test with a fake driver) |
| 3 | **Effects and palettes:** native-effect resolution table, software effects, palette cycler, `dip` | "Forest" palette on an area; "fire" uses native where available; Z-Wave `dip` 3–4 s with restore |
| 4 | **Triggers and rules:** HA event and state triggers, the `luminorium_command` event, MQTT discovery entities, rules UI | An HA automation fires a show; porch motion runs a rule with a cooldown |
| 5 | **Views and phone mapping:** visible-light selection, **guided three-station capture** (centre, 45° left, 45° right, anchor kept centred, compass guidance), the fast cumulative-toggle pass per station, **handheld** analysis (frame alignment, shake-aware differences, motion-sensor retakes), triangulation, grouping suggestions, review editor, measured latency; ground and house-front **planes** | The front is mapped **handheld from Chris's phone in about two minutes** for three stations; elements are grouped as he expects (small windows single, long windows segmented); lights get 3D positions and lawn lights land correctly on the yard map |
| 6 | **Designer and spatial shows:** colour fields (linear at any angle, four corners, radial, path, image, noise), animation (scroll, rotate, ripple, palette cycle, keyframes, BPM), live preview on the house photo, "try on the house", a library of predefined animations; latency compensation | A smooth green flow across the front in any direction (left/right, up/down, diagonal); a four-corner blend shows the right mixed colours on lights in between; static and animated versions both work |
| 7 | **Plugins:** framework (mirroring Sonorium v2), a sports source plugin (live score → event), an example effect plugin | "Team scores → team colours" works end to end |
| 8 | **More drivers and API:** WLED (DDP), Govee LAN, Hue/Bifrost; REST/WS API for Sonorium cues | The Sonorium plugin can play a theme palette and fire a cue |

Phases 2 and 3 can overlap. Phase 5 can start after phase 1, in parallel with 2–4.

## Engineering notes

- **Test without the house:** a fake HA websocket server (registry and state fixtures captured
  read-only from the real HA, scrubbed of anything private), fake drivers recording commands with
  timestamps, and a fake WiZ bulb on loopback UDP (pattern: `F:\Projects\Bifrost-Hue\bifrost\tests\wiz.rs`).
- **Mapping analysis tests:** synthetic videos (render rectangles that brighten or darken with
  noise) with known regions and latencies.
- **Deploying the add-on:** same pattern as bifrost-hassio, an add-on repository on GitHub.
  Lessons from Bifrost:
  - **give every build its own version and image tag** (HA reuses cached tags)
  - **never put a digest in `build_from`**
  - back up before replacing anything
- **Licence and repo:** ask Chris (suggest `synssins/luminorium`, and a licence of his choice).

## Open questions for Chris

1. Final name: Luminorium (working name, a clean slate) or Luminosity (free on PyPI, but crowded:
   a TouchDesigner front end of the same name, a Windows screen dimmer, and close to "Lumosity").
2. Include the 29 Z-Wave `switch.*` entities? Which are lights, and which are other loads?
3. Is HTTPS access to HA from the phone available (Nabu Casa or his own certificate)? Mapping needs
   it for the live camera.
4. Govee: is LAN Control enabled on the devices?
5. Repository name, public or private, licence.
