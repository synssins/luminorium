# Luminorium: design

*Working name.* A Home Assistant add-on (app) that does one thing: **light effects, shows and
sequences** across every light HA knows about, whatever the brand or protocol.

Status: design, 2026-10-16. The route was chosen by Chris on that date. See [BRIEF.md](BRIEF.md)
for the build plan.

## 1. Principles

1. **HA is the source of truth.** The app reads lights, floors, areas and devices from HA's
   registries. It never asks the user to recreate rooms. When something moves in HA, the app
   follows.
2. **Native first.** If a light can do an effect itself (a WiZ "Fireplace", a Hue "candle", a WLED
   effect), send that. Software effects are only for lights that can't.
3. **Respect the slowest network.** Every light has a profile with a safe rate and a measured
   latency. The engine never sends more than a light or its network can carry. Z-Wave especially
   must never be flooded.
4. **Leave things as they were.** Every show snapshots the lights it touches and restores them when
   it ends, is stopped, or crashes.
5. **What you see is the unit.** Effects run on *elements*: a porch light, a lit window, a segment
   of a strip, as seen from a *view* of the house. Not on bulbs.
6. **Direct where it pays, HA where it doesn't.** HA is always the fallback driver. Protocol-direct
   drivers are added where speed or features matter.

## 2. The house today (inventory read from HA, 2026-10-16)

| Integration | Light entities | Notes |
|---|---|---|
| MQTT, **Govee** (govee2mqtt) | 99 (29 MQTT light devices in total; one device has 31 entities) | Segment-addressable strips: each segment is its own entity. Excellent for waves. |
| MQTT, **Zigbee2MQTT** | about 24 (Philips 7, Gledopto 7, CREE 3, LEDEPLY 2, Sunricher 1, plus 4 z2m groups) | Hue bulbs have native Hue effects through z2m |
| **Z-Wave JS** | 15 (GE 7, Honeywell 5, Zooz 2, GE/Enbrighten 1), all in areas | Dimmers. Plus 29 Z-Wave switch entities (some are relays). |
| **WLED** | 9 lights (4 controllers) | Native effects and palettes; DDP streaming |
| **WiZ** (HA's own integration) | 4 | Also behind Bifrost on `192.168.10.x` |
| ESPHome / Matter | 3 / 1 | |
| **Exclude by default** | browser_mod (20, browser screens), `group` (9), signalrgb (1, PC RGB) | Not real house lights; offer an opt-in |

Floors: Bedroom Level, Main Level, Ground Level, Basement. There are 23 areas, for example Porch,
Driveway, Front Yard, Front Entrance, Living Room, Office, Master Bedroom.

Bifrost (`192.168.1.104`, Hue API) is **not** linked to HA, so there are no duplicates from HA's
Hue integration. The app may still use Bifrost as a driver (section 4).

## 3. Architecture

```
            ┌──────────────────────── Luminorium add-on ───────────────────────┐
 HA core ◄──┤ HA link (websocket: registries, states, events, services)        │
            │   │                                                              │
            │ Inventory ──► Profiles (capabilities, rate, latency, driver)     │
            │   │                                                              │
            │ Views & Elements (spatial model, from phone mapping)             │
            │   │                                                              │
            │ Show engine ── effects, palettes, timeline, layers, priorities   │
            │   │                                                              │
            │ Rate governor (per light + per network budgets, latest wins)     │
            │   │                                                              │
            │ Drivers: HA │ z2m (MQTT) │ Z-Wave JS │ WiZ │ WLED │ Govee │ Hue    │
            │                                                                  │
            │ Triggers & rules ◄── HA events/states, plugins (sources)         │
            │ Plugins (sources, triggers, effects, drivers)                    │
            │ Web UI (Ingress) + REST/WS API + MQTT entities                   │
            └──────────────────────────────────────────────────────────────────┘
```

- **Language:** Python 3 (asyncio). The plugin model is the same as Sonorium's: install, then
  restart.
- **Process:** one add-on container, `host_network: true` (UDP to WiZ, Govee and WLED; multicast
  discovery).
- **State:** the add-on's `/data`, so it is included in HA backups. Config and user content as
  JSON or YAML, measurements in SQLite.

## 4. Inventory, profiles, drivers

### Inventory

Built from HA's websocket API (`config/floor_registry/list`, `config/area_registry/list`,
`config/device_registry/list`, `config/entity_registry/list`, plus `get_states`), and kept current
by subscribing to registry updates and `state_changed`.

**A light** is a `light.*` entity, or a `switch.*` that the user marks as a light (relays).

A `switch.*` is excluded by default. The user opts in the ones that are **light relays**: on/off
only, slow minimum toggle interval, never streamed. Everything else stays excluded and is never
commanded: fans, garage doors, indicators, and locked-on relays whose paddle already controls
smart bulbs (Chris's front porch, entryway and driveway; the Hue bulbs behind them are the lights).

**Area resolution:** the entity's area, else its device's area. Floor comes from the area.

**De-duplication:**
- If HA exposes the same physical device twice (a light group plus its members, a z2m group plus
  its bulbs), groups are treated as **group handles**, not lights.
- Members are found from the group's `entity_id` attribute.

### Profile (per light)

```yaml
entity_id: light.porch_left
device: { integration: zwave_js, manufacturer: GE, model: "14294", node_id: 23 }
area: porch
floor: main_level
capabilities:
  on_off: true
  dimming: { min: 1 }
  white: { min_mireds: 153, max_mireds: 500 }   # or null
  color: { modes: [xy, hs, rgb] }                # or null
  native_effects: [ ... ]                        # normalised names, see 6.1
  transition: native | software | none
  segments: null | { count: 31, entities: [...] }
driver: zwave_js                                  # chosen driver
limits:
  max_rate_hz: 0.5          # safe sustained command rate for this light
  network: zwave            # shared budget it draws from
latency_ms: { default: 600, measured: 540, measured_at: 2026-10-20 }
```

Capabilities come from HA attributes (`supported_color_modes`, `min_mireds`, `max_mireds`,
`effect_list`, `supported_features`). Drivers add what HA doesn't know, such as all WiZ scenes or
Govee segment mode.

### Drivers

All drivers implement one interface:

```python
class Driver:
    async def capabilities(light) -> Capabilities
    async def set(lights, state: LightState, transition_ms: int | None)  # on/off, level, colour/white
    async def effect(lights, name: str, params: dict)                    # native effect
    async def group_set(lights, state, transition_ms)                    # optional: one message for many
    async def snapshot(lights) -> dict; async def restore(snapshot)
```

| Driver | Reaches | Path | Why direct |
|---|---|---|---|
| **ha** (fallback) | everything | `light.turn_on` and friends over the websocket | Always works. About 2–10 commands/s across the system; fine for slow effects. |
| **z2m** | Zigbee via Zigbee2MQTT | Publish to `<base>/<friendly_name>/set` on Mosquitto (credentials from the Supervisor `services` API) | No HA overhead; z2m groups for simultaneous changes; Hue effects through z2m's `effect` |
| **zwave_js** | Z-Wave | Z-Wave JS server websocket (from the Z-Wave JS add-on) | **Multicast** to many dimmers at once; exact durations |
| **wiz** | WiZ | UDP 38899, found by MAC from the device registry with a subnet sweep (`192.168.10.0/24`) | All 32+ firmware scenes; 10–20 updates/s |
| **wled** | WLED | JSON API for effects and palettes; **DDP** for streaming | 30–60 frames/s; native effects |
| **govee** | Govee | LAN API (UDP multicast discovery, control on 4003) where "LAN Control" is on; else through govee2mqtt | Segment colours in one message; fast |
| **hue** (later) | Hue bridges / Bifrost | Hue API v2 and Entertainment | Native Hue effects; streaming |

Driver choice per light is automatic (the best available), and the user can override it.

**Defaults before measuring** (refined by mapping, section 8):

| Network | Default latency | Safe per light | Shared budget |
|---|---|---|---|
| Z-Wave | 600 ms | 0.5 Hz | **2 commands/s for the whole network** (multicast counts as 1) |
| Zigbee (z2m) | 200 ms | 5 Hz | ~25 messages/s for the network; groups count as 1 |
| WiZ | 60 ms | 15 Hz | – |
| Govee LAN | 100 ms | 10 Hz | – |
| WLED (DDP) | 30 ms | 40 Hz | – |
| HA fallback | 250 ms | 2 Hz | ~10 calls/s |

## 5. Rate governor

- Every command goes through a governor with **per-light** and **per-network** budgets.
- **Latest value wins:** if a light can't keep up, intermediate frames are dropped, never queued.
  Queues are what make Z-Wave fall seconds behind.
- **Priorities:** restore > safety (stop all) > live show > ambient palette.
- **Group optimisation:** when many lights on one network get the same value at the same moment,
  the governor uses one group message (Z-Wave multicast, z2m group, WLED sync).

## 6. Effects and palettes

### 6.1 Native effect resolution

The app works with **normalised effect names**, for example `fire`, `candle`, `ocean`, `forest`,
`party`, `sparkle`, `aurora`, `lightning`, `breathe`, `sunrise`, `sunset`.

Each driver maps a normalised name to its own effect: WiZ `Fireplace` (scene 5), Hue `fire`,
WLED `Fire 2012`, Govee scene "Fire", or HA `effect_list` entries.

Resolution for a light:
1. **Native exact:** the light has the effect. Send it.
2. **Native close:** a defined alternative exists (`forest` → WiZ "Jungle", or a green WLED
   palette effect).
3. **Software:** the engine runs it within the light's rate limit (flicker, candle, lightning,
   breathe).
4. **Static fallback:** the effect's key colour, or skip the light.

The resolution table is data (`effects/*.yaml`), so plugins and users can extend it.

### 6.2 Palettes

```yaml
id: forest_canopy
name: Forest canopy
category: [nature, forest]
colors:                         # weighted
  - { xy: [0.25, 0.55], weight: 3 }
  - { xy: [0.32, 0.50], weight: 2 }
  - { kelvin: 2700, weight: 1 }
brightness: [35, 70]            # percent range
transition_s: [8, 20]           # per change, random in range
hold_s: [5, 30]
spread: per_element             # each element cycles independently, with phase offsets
```

- The **palette cycler** keeps a per-element random walk through the palette, with long
  transitions. That is kind to Zigbee and Z-Wave and looks alive.
- White-only lights get the palette's warm or cool equivalent.
- There are predefined palettes per **theme category**, matching Sonorium's theme categories.

### 6.3 Shows and the timeline

A **show** is a set of layers on a timeline:

```yaml
id: green_wave_front
view: front                     # spatial reference (section 8)
layers:
  - target: { view_elements: all }
    space: screen
    field: { type: linear, angle_deg: 0, stops: [{at: 0, color: black}, {at: 0.15, color: green}, {at: 0.3, color: black}] }
    animate: [{ scroll: { speed: 0.5 } }]   # screen widths per second, left to right
    duration_s: 6
    loop: 3
on_end: restore                 # restore | hold | fade_to_palette
```

- **Layer types:**
  - `static`, `palette`, `native_effect`, `software_effect`
  - `field`: a colour field, static or animated, over a view or the yard (section 6.4). Waves,
    chases and flows in any direction are all fields.
  - `dip` (dim to a level, hold, restore each element's own level)
  - `flash`, `sequence` (explicit keyframes per element)
- **Compilation:** for each element, the engine computes its colour and brightness as a function of
  time from its position. It then plans commands per light. **Latency compensation:** a light with
  600 ms latency is sent its command 600 ms earlier than a 60 ms one, so the effect *lands* evenly.
- **Slow lights inside fast effects:** the planner turns a passing wave into one transitioned fade
  for a Z-Wave dimmer, and a crisp edge for WLED. The look degrades gracefully instead of lagging.
- **Concurrency:** shows on separate elements run side by side. On overlapping elements, the
  higher priority wins; the lower one resumes or ends.

### 6.4 Colour fields and animations (the designer)

Chris's model: **design a picture of colour, lay it over the house, and every light shows the
colour under it.** It can be static, or animated.

**A colour field** is a function from a position (in the layer's coordinate space: `screen`,
`world` or `path`, see section 8) and a time to a colour and brightness. Every element samples
the field at its position; segments sample along their extent.

#### Field types

| Type | Defined by | Example |
|---|---|---|
| `solid` | one colour | everything warm white |
| `linear` | 2+ colour stops along a direction at **any angle** | left red → right white; bottom → top; 30° diagonal |
| `corners` | 4 corner colours, blended across the rectangle | top-left red, bottom-left green, top-right blue, bottom-right white; a light in the middle gets the blend |
| `radial` | centre point plus stops outward | a ripple out from the front door |
| `conic` | centre plus stops around | a colour wheel spinning around the porch |
| `path` | stops along a drawn polyline | a gradient down the driveway |
| `image` | an uploaded picture, stretched over the view | paint the house with a flag or a sunset photo |
| `noise` | palette plus scale and "turbulence" | organic flicker: fire, aurora, water |
| `points` | colours pinned at points, blended by distance | hand-placed colour blobs |

**Blending happens in a perceptual colour space (OKLab), not RGB.** Red-to-green passes through a
clean yellow instead of muddy brown. The result is then converted to each light's capability: its
colour gamut, the nearest white temperature for white-only lights, or brightness only for
dimmers.

#### Animation

Any field parameter can move over time:
- **Transforms:**
  - `scroll` (direction at any angle, speed): the "flow" left to right, top to bottom, bottom to
    top, or diagonal
  - `rotate`, `scale` (pulse in and out)
  - `ripple` (radial scroll)
- **Colour:** `hue_shift`, `palette_cycle`, `brightness` envelope, and `fade` between two fields.
- **Repeat:** loop, ping-pong, once; the field can **wrap** (tile) so a scroll flows forever.
- **Timing:** speed in m/s (world), screen widths per second (screen), or **BPM**, so Sonorium or
  music can set the tempo.
- **Keyframes:** any parameter can be keyframed on the timeline (for example the angle sweeps from
  0° to 90° over 10 s).

Animated fields are sampled at the engine rate (for example 20 Hz). The rate governor (section 5)
and the planner then send each light only what it can take: crisp updates for WLED and WiZ, a
smoothed, low-pass version with transitions for Zigbee, and occasional long fades for Z-Wave.

#### The designer (web UI)

- **Live preview on the view's photo:** the field is drawn semi-transparent over the house, with
  each element as a dot or outline showing the colour it would get, animated in real time.
- **Simple first:**
  - choose a field type
  - drag colour stops or corner swatches
  - drag an arrow for direction and angle
  - a speed slider, and a "static / animated" toggle
- **"Try on the house"** sends the design to the real lights, for preview, with one tap to undo
  (restore).
- **Advanced:** layers with blend modes (normal, add, multiply, mask), keyframes, BPM sync, and
  per-layer coordinate space and targets.
- **Library:**
  - **Predefined animations** ship with the app: flows, ripples, colour wheel, aurora, fire,
    lightning storm, police, candy cane, team colours, sunrise/sunset wash.
  - Users **save their own**.
  - Everything is stored as plain YAML or JSON, so it can be shared, imported, or added by
    plugins.

```yaml
# example: four-corner blend that slowly rotates, on the front view
id: four_corner_spin
layers:
  - space: screen
    view: front
    field:
      type: corners
      top_left: red
      bottom_left: green
      top_right: blue
      bottom_right: white
    animate:
      - { rotate: { degrees_per_s: 6 } }
    targets: { view_elements: all }
```

```yaml
# example: green flow, bottom to top at 60°, in real metres
id: green_flow_up
layers:
  - space: world
    field:
      type: linear
      angle_deg: 60
      stops: [{ at: 0, color: black }, { at: 0.4, color: green }, { at: 0.8, color: black }]
      wrap: true
    animate:
      - { scroll: { speed_m_s: 1.5 } }
```

## 7. Triggers, rules and plugins

### Triggers
- HA events and state changes: motion, buttons, doors, sun, alarm, `media_player` states. The app
  subscribes to the event bus.
- **From HA automations, with no custom integration:**
  - The app listens for a custom event,
    `luminorium_command {action: play|stop|dip, show, targets, params}`. Any automation can fire it.
  - The app publishes **MQTT discovery entities**:
    - `select.luminorium_show`
    - `button.luminorium_stop_all`
    - per-show `button`s
    - `switch.luminorium_<mode>` (for example "Haunted mode", "Game day")
    - `sensor.luminorium_status`

### Rules (in the app UI)

`when <trigger> [and <conditions>] then <show / effect / dip> on <targets>`, with cooldowns.

Example: "Porch motion after sunset, and haunted mode on → `scare_porch`, cooldown 2 min".

### Plugins

Python packages, installed from the UI and loaded on restart, exactly like Sonorium.

| Kind | Does | Example |
|---|---|---|
| **source** | Pulls outside data and emits app events | Sports: game schedule, live score, "goal scored" (or reads HA's Team Tracker sensors); weather alerts; holidays |
| **trigger** | Turns events into rule triggers | "my team scored" |
| **effect** | New software effects or layer types | `lightning_storm`, `police`, `fireworks` |
| **driver** | New light protocols | LIFX, Nanoleaf, Yeelight |

The manifest, lifecycle and settings form follow Sonorium's plugin framework v2 conventions, so
the two apps feel the same.

## 8. Spatial model and phone mapping

### Concepts
- **View:** a viewpoint with a reference photo, such as "Front of house", "Back yard", "Driveway
  side". Each view has its own 2D picture coordinates (normalised 0–1, so the phone's resolution
  doesn't matter).
- **Plane:** a flat real-world surface marked in a view: the **ground** (lawn, beds, driveway,
  path), the **house front**, a side wall, a fence. Each plane is defined by four tapped points
  forming a rectangle, with optional real sizes ("driveway 6 m × 10 m"). The app uses the four
  points to convert picture positions on that surface into real positions (a perspective
  transform).
- **Element:** what a viewer sees change. It is one or more lights, with:
  - a **region** in the view (polygon plus centroid)
  - the **plane** it lies on (or "free" for things off any plane)
  - a **world position**: metres across, along and up, derived through its plane, or triangulated
    (see *Depth and 3D*)
  - a **mode**: `single` (all its lights act as one) or `segments` (each light is a sub-element,
    ordered along the region)

### Mapping flow (designed with Chris)

**Targets:** handheld, no tripod; **under about a minute per station** for a typical 15–25
visible lights.

**Guided capture (decided 2026-10-16).** Mapping is a pre-programmed walk the app leads, not a
free-form video. The user picks an **anchor** (for example the front door) and keeps it centred
in frame the whole time. The app then directs three **stations**:

1. **Centre:** straight on to the anchor.
2. **Left:** walk about 45° to the left around the anchor, still filming it centred.
3. **Right:** walk about 45° to the right of centre, still filming it centred.

At each station the app runs the flash pass (step 3 below) and then tells the user to move on.
More stations can be added for a bigger property. A three-station capture per side of the house
gives:
- **3D positions by default:** each light is identified in each station by its flash, so the
  lights themselves are the point correspondences between views. No feature matching is needed.
  Their sightlines from two or more stations give a 3D point (see *Depth and 3D*).
- **Occlusion coverage:** a light hidden by a tree from the centre is usually visible from one
  side.
- **Separation:** two windows that overlap from the centre come apart from 45°.

Walking guidance uses the phone's compass and gyroscope (`DeviceOrientationEvent`): orbiting the
anchor while keeping it centred turns the phone by about the orbit angle, so the app can say
"keep going… stop" at about 45°. While walking, the frame-alignment tracker checks that the anchor
stays centred.

1. **Create or pick a view, then "What's visible from here?"** The user ticks lights by floor and
   area. Only those are flashed. Lights on the back of the house are never tested from the front,
   so they never report as "not found". The side stations reuse this list.
2. **Take the reference photo** (one tap, at the centre station; each station keeps its own
   reference frame). Optionally mark planes now or later.
3. **The fast pass: toggle one light at a time, and don't put it back between lights.**
   - Each step inverts **one more** light (on → off, off → on) and leaves it inverted. Each frame
     difference then contains exactly one change, the newest light. Every light is restored
     **together** at the end. This halves the time against toggling and restoring each light in
     turn.
   - **Fixtures toggle as one:** lights the user grouped into a fixture (two bulbs in one ceiling
     fan) are inverted together in one step; one bulb of a pair wouldn't show on video. The result
     is one region for the fixture.
   - **Order by speed:** fast lights first (WLED, WiZ, Govee, z2m: about 0.5–0.8 s per step), slow
     lights last (Z-Wave: about 1.5–2.5 s per step).
   - Slow lights are toggled through their direct driver with **transition 0**, so a dimmer snaps
     instead of ramping.
   - Each step lasts **latency + ramp + exposure + a settled window (~0.25 s)**: the analysis
     compares "settled before" with "settled after". Advance **adaptively**: send the next command
     once the live detector has seen the change settle for about 3 frames, with a per-driver timeout
     of about 2× the profile latency (fast 0.8 s, Z-Wave 2.5 s on a first mapping). The prototype
     worked at fixed 0.6 s / 1.6 s steps and broke at 0.5 s / 1.2 s.
   - Rough budget: 15 fast lights × 0.7 s + 6 Z-Wave × 2 s ≈ **25 s per station**, plus the
     restore; about 2 minutes for three stations including the walking.
4. **Clock:** the phone timestamps its frames, and the app estimates the phone↔add-on clock offset
   over the websocket (NTP-style ping). A **sync blink** (one fast light toggling 4 times, within a
   few seconds of the reference photo) is a check, not the only source: with the blink alone, every
   latency inherits the sync light's own latency. The sync light is not the first light of the pass
   (or a pause follows the blink), and its latency is measured once and stored.
5. **Handheld robustness** (analysis in the add-on, Python with OpenCV):
   - **Frame alignment:** every frame is aligned to the reference. It tracks stable features
     (house edges, windows that stay lit, streetlights), rejects outliers with RANSAC, and fits a
     **rotation + scale model** (`S·K·R·K⁻¹`), not a free homography (which bends at feature-poor
     edges and makes false lights).
   - **Shake-aware differences:** shake leaves thin bright edges in a difference image, while a
     light change makes a filled region that rises or falls together. So: morphological
     open/close, minimum area, a "filled vs. edge" test, and the change must start within the
     expected latency window after the command (at least 30 ms after it). The decisive check is the
     **shift test**: if shifting the "before" frame by up to ±4 px removes most of the difference,
     it is shake or parallax, not a light. Parallax from hand *translation* (near trees and lamps
     move 1–4 px against the house) is the main residual; no global transform removes it.
   - **Motion sensor assist:** the page reads the phone's motion sensor (`DeviceMotionEvent`). A
     big jolt during a step (smoothed rotation rate > 45 °/s or acceleration > 4 m/s²), or a step
     whose frames align badly, is marked "retake". At the end the pass **reverts that light once**
     (one more single-light change). It doesn't restart the whole pass.
   - **Live feedback:** a steadiness indicator and "hold still" prompts. A step whose frames
     align badly is retaken like a jolted one. (Built: the live detector only times the steps;
     confidence comes from the offline analysis. A change that never settles makes a long step,
     which is good data, so it isn't retaken. See docs/mapping.md.)
   - **Exposure:** normalised in software on every frame, from flat mid-tone reference pixels,
     with near-saturated pixels treated as clipped. This handles auto-exposure reacting to every
     light change. A browser exposure or white-balance lock is a bonus, not a requirement (iOS has
     no exposure lock).
6. **Results per light:** region, confidence, measured **latency** (stored in the profile), and
   whether it rose or fell. The light's image position is the bright core of its region (≥ 50 % of
   the peak change); plain centroids are pulled by glows and ground light pools.
7. **Grouping suggestions:**
   - Regions that **overlap strongly** (several lights in a small room behind one small window) →
     **one element** (`single`).
   - Regions side by side within a larger region (a long room with a long window) → one element in
     **`segments`** mode, ordered along the window, when they are of similar size, share a long
     boundary and their union fills a rectangle (adjacency alone would merge neighbouring lamps).
     The user can switch it to `single`.
   - **No visible change** → "not visible from this view". Place by hand, or leave out.
8. **Review screen:** the photo with element outlines; drag, merge, split, reorder, rename, assign
   planes. Re-map one element, one room, or the whole view.

### Depth and 3D

**Planes first (single viewpoint).** Most outdoor lighting sits on a few flat surfaces: landscape
and path lights on the ground, windows on the house front. With planes marked:
- A lawn light closer to the camera, lower and bigger in the picture, gets its true spot on a
  **top-down yard map**.
- A window gets its true position across and up the house front.
- Each element is assigned a plane automatically (low in the frame inside the ground plane → ground)
  and the user confirms.

**Multi-station triangulation (the default, from guided capture).** For every light, including
those at varying heights off any plane (trees, posts, pergolas):
- The guided capture gives each light's position in the centre, left and right stations. Because
  the flash pass identifies every light, these are known correspondences.
- From them the app solves the stations' relative poses (essential matrix with outlier rejection,
  then a small bundle adjustment that also refines the phone's focal length, starting from a
  typical main-camera field of view of about 70°).
- An element seen from two or more stations gets a 3D point where its sightlines cross. One seen
  from one station only falls back to its plane, or to the manual yard plan.
- Scale comes from one known distance (a plane's real size, or "the driveway is 6 m wide").
  Without it, positions are correct in shape but not in metres; `screen` and relative `world`
  effects still work.
- Twinkly's 3D modes use the same idea: scans from several angles with already-mapped lights as
  shared points.
- **Expected accuracy** (synthetic prototype, `proto/mapping/`, 16 lights at ~15 m): light
  positions to about 1 % of the scene (2–10 cm); one known distance gives metres to about 5 cm
  (10 cm under heavy shake). The focal length is pinned only to about ±5 % and station poses to
  1–3° (depth range is small against the stand-off), so seed the focal length from the phone model
  where possible. Three stations matter: centre + one side gave 1.7 % mean / 4.3 % max error.

**Manual yard plan.** A simple top-down editor for anything the camera can't place: drag lights
onto a sketch or photo of the property.

**Later:** phone AR (ARKit, ARCore) measures 3D directly, but only in a native app; web pages on
iPhones can't use it yet. That's a possible future companion app, not version 1.

### Coordinate spaces for effects

Each layer chooses where its colour field lives (section 6.4):
- **`screen`**: the view's picture, normalised 0–1. "Left to right as seen from the street"; it
  looks perfect from that viewpoint.
- **`world`**: real metres (yard map plus heights). "From the street to the house", "north to
  south". It looks consistent from anywhere, and lets a wave roll across the lawn by real distance,
  then climb the house front.
- **`path`**: distance along a drawn polyline (the driveway, a garden path, the roofline).

Segments (of `segments` elements, Govee and WLED strips) sample the field along their own extent,
so a flow moves *through* a long window or along a strip.

### Phone capture: practical details
- The UI is served through **Ingress**. Camera access (`getUserMedia`) and the motion sensor need
  **HTTPS**: HA's HTTPS address (Nabu Casa or the user's own certificate).
- Camera access in the **HA companion app**'s embedded page is unreliable, so the page offers
  **"Open in browser"** and a **record-and-upload** fallback (the same analysis on a video file).
- Live mode sends low-resolution frames (for example 640×360 at 15 frames/s) plus motion-sensor
  readings over a websocket. The heavy work happens in the add-on.
- Night-time mapping is recommended. The page warns when the picture is too bright or noisy.

## 9. Web UI (Ingress)

- **Home:** running shows, quick buttons (Stop all, modes), recent triggers.
- **Lights:** inventory by floor and area, with capabilities, driver, latency, rate and a test
  button. Include/exclude, and driver override.
- **Views:** mapping wizard, review, elements.
- **Shows:** a library and an editor with a timeline (layers, targets, preview on a view picture).
- **Designer:** colour fields (linear at any angle, four corners, radial, image, noise…), static or
  animated, previewed live on the house photo, and "try on the house" (section 6.4).
- **Palettes & effects:** browse, edit, and assign to theme categories.
- **Rules:** trigger → show, with conditions and cooldowns.
- **Plugins:** install, settings, status.
- **Settings:** networks and budgets, quiet hours, restore behaviour, MQTT entities, API keys.
- The UI is mobile-first: mapping happens on a phone.

## 10. API (for Sonorium and others)

- **REST:** `/api/shows`, `/api/play`, `/api/stop`, `/api/dip`, `/api/palette`, `/api/lights`,
  `/api/views`, `/api/events`.
- **WebSocket** `/api/ws`: live status, plus low-latency cues (for example a Sonorium track
  `thunder` arriving as a `flash` cue, with an offset for speaker delay).
- **Auth:** Ingress session for the UI; API tokens for other apps. Sonorium runs on the same HA host
  and can use the internal add-on hostname.

**Sonorium becomes a client:** a theme picks a palette or show, and track cues trigger cues. The
lighting work moves here; the Sonorium plugin stays thin.

## 11. Safety

- **Stop all**, always one tap away (UI, MQTT button, HA event). It restores every touched light.
- Snapshot and restore are persisted. After a crash or restart, the app restores lights it left in
  a show state.
- **Quiet hours** and per-area opt-out (for example never flash bedrooms after 22:00).
- **Photosensitivity:** a global cap on flash frequency (for example a maximum of 3 Hz unless a
  show explicitly allows "strobe"), with a warning shown.
- **Never fight HA:** if a light is changed outside the app during a show (a wall switch, an
  automation), drop that light from the show and don't restore over the user's change.

## 12. Packaging

```yaml
# add-on config.yaml (sketch)
name: Luminorium
slug: luminorium
arch: [amd64, aarch64]
ingress: true
ingress_port: 8099
panel_icon: mdi:lightbulb-group
homeassistant_api: true     # websocket with SUPERVISOR_TOKEN
hassio_api: true            # find other add-ons (Z-Wave JS, Mosquitto)
services: [mqtt:need]       # Mosquitto credentials from the Supervisor
host_network: true          # WiZ/Govee/WLED UDP, multicast discovery
map: [share:rw]             # optional: import and export of shows and palettes
```

- **Image:** Python 3.12, `opencv-python-headless`, `numpy`, `aiohttp` or FastAPI. Measure the
  image size; OpenCV is the big one.
- **Repository:** an HA add-on repository with a `repository.yaml`, like Sonorium and
  bifrost-hassio.
