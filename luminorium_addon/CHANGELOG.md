# Changelog

## 0.3.0-dev.2

- **House map in 3D:** the house as a volume you can turn and zoom. Each floor is a slab at its
  height, and each light an orb with a line down to its floor. Tap a light to pick it, tap the
  floor to place it, drag to move it, and drag up or down in **Raise** mode. **3D**, **Top** and
  **Front** reset the view. The flat plan and side views stay as a second tab.
- **Feet and inches:** sizes and heights follow Home Assistant's unit system (imperial here), or
  the choice under **Settings › Units**. Fields take `8' 6"`, `8 ft 6 in`, `102 in`, `2.6 m`, and
  the grid and snapping go by feet and inches.
- **Better first guess for floor heights:** nothing deeper than one storey below the ground; the
  levels below main share that depth, so split levels come out half a storey apart.

## 0.3.0-dev.1

A new UI, and the house map.

- **The UI is redesigned** after the Zigbee2MQTT frontend: a left menu, a top bar with the
  Home Assistant status and Stop all on every page, summary tiles and card grids, an HA-like dark
  theme (and a light one), and phone layouts.
- **New pages:**
  - **Overview:** what's on, what's playing, the drivers, each level, activity.
  - **Lights:** cards by level and room, fixtures, grouping, suggestions.
  - **Light detail:** capabilities, driver choice and timing, test with a fade, an effect and a
    hold time, effects on this light.
  - **Palettes & shows**, **Drivers**, **Activity** and **Settings** (appearance).
  - Views and camera mapping now sit in the same shell.
- **House map:** place every light in 3D by hand, no camera or floorplan needed.
  - Floors come from HA. You set each floor's height above the ground (split levels too), its
    ceiling, and which part of the house it covers.
  - Pick a light, tap where it is from above, and drag its height in the view from the street.
  - Mount types (ceiling, pendant, wall, floor lamp, tabletop, under cabinet, strip, path or
    post, in the ground) set the height.
  - Segmented lights stay one light, and their parts can be placed one by one or along a line:
    WLED LEDs (a device's segment lights fold into its main light) and Govee segments.
  - **Flash** identifies a light, a fixture or one part. WLED LEDs flash through realtime
    frames, Govee segments through their own entities, and everything is put back.
- Cards show brightness, colour temperature and effect (`look` in the inventory API).

## 0.2.0-dev.3

From the first checks on the real lights (docs/driver-tests.md):
- **Z-Wave:** a dimmer that misses a multicast (multicast isn't routed, so a node out of the
  stick's direct range never hears it) is corrected by unicast as before, and from then on gets
  unicast; the others keep sharing a multicast. Shown as `unicast_only` in the driver status.
- **Safety:** while a command is still settling (latency, the driver's read-back, 1 s), a report
  that disagrees is the device catching up, not a person. Before, the missed multicast's
  read-back got the hallway dimmer dropped and left unrestored. During the rest of a fade only an
  on/off flip counts as a person.

## 0.2.0-dev.2

The first build with direct drivers, the show engine core, and views with camera mapping
together. None of them has been tried on the real lights yet.

- Camera mapping keeps each measured latency with the driver it was measured through; a light
  that later uses another driver keeps that driver's default.

### Direct drivers (phase 2)

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

### Show engine core (phase 3)

The show engine core (phase 3).

- **Colour:** OKLab blending; each light gets what it can show: xy, hs, rgb, rgbw, rgbww, the
  nearest white temperature for white-only lights, a level for dimmers, on/off for relays.
- **Engine:** a 20 Hz tick composes layers per light (fixtures as one). The planner sends one
  fade per change to lights that can fade, steps for those that can't, averages fast content for
  slow lights (Z-Wave, Govee cloud), sends nothing for invisible changes, keeps within every
  network's budget, and sends early by each light's latency.
- **Layers:** static, palette (per-light random walk, seeded), native effect, software effect
  (flicker, candle, breathe, lightning), dip (back to each light's own level), flash (at most
  3 per second). Shows overlap by priority; `on_end` restore, fade or hold.
- **Effects:** normalised names resolved per integration from `effects/*.yaml` against each
  light's effect list: native, close, software, then the key colour.
- **Palettes and shows** as YAML in `/config`, with seven starter palettes.
- **API:** play, stop and list palettes and shows; `GET /api/running`. A small Palettes panel on
  the lights page.
- New dependency: PyYAML.

### Views and camera mapping (phase 5)

Phase 5: views and camera mapping.

- **Views:** a photo of the house per viewpoint, with lights and fixtures placed on it. Place by
  hand (tap a light, tap the photo, drag to move), or map with the phone camera; both make the
  same elements. Segmented lights and several lights in a row can be spread along a drawn line.
- **Planes:** mark the lawn or the house front with four taps and an optional real size; lights
  on a plane get positions in metres on it.
- **Map with the camera:** pick what's visible, then the app leads three stations (centre, about
  45° left, about 45° right) with a steadiness meter and compass guidance. At each station it
  takes a reference, blinks a sync light, inverts one light (or fixture) at a time and moves on as
  soon as the change has settled, retakes jolted steps with a single revert, and puts every light
  back. Frames, motion and the command log are saved under `/config/mapping/sessions` and
  analysed in the add-on (OpenCV): regions, latency, grouping (one window = one element, a long
  window = segments), 3D positions from the three stations.
- **Review:** the results go onto the view: outlines on the photo; merge, split, reorder,
  rename, assign planes. Measured latencies replace the profile defaults.
- Record-and-upload fallback when the live camera doesn't work in the HA app.
- Stop all ends a capture and restores; nothing is flashed in read-only mode.
- New dependencies: numpy, opencv-python-headless, websockets (the image grows by about 220 MB).

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
