# The show engine (as built, phase 3 core)

How palettes, effects and shows become commands to lights. The target design is
[DESIGN.md](../DESIGN.md) sections 5–6; this is what the code does today. Safety (snapshots, Stop
all, outside changes) and the rate governor are in [safety.md](safety.md).

```
 show spec (YAML / API)
   │  layers: static, palette, native_effect, software_effect, dip, flash
   ▼
 Engine (engine/engine.py)          20 Hz tick
   │  targets → elements (a light, or a fixture's lights)
   │  per light: compose the layers that cover it → Span (look now, and where it's heading)
   ▼
 Planner (engine/planner.py)        latency lead, fades, steps, low-pass, threshold, budgets
   │  render(look, light) → LightState (engine/color.py)
   ▼
 Safety.command → Governor.send → HADriver
```

## Modules

| Module | What |
|---|---|
| `engine/color.py` | `Color` (sRGB at full value, optional `kelvin`), OKLab blending, xy/hs/rgb/kelvin conversions, `parse_color`, `Look` (colour, brightness 0–1, native effect, white hint), `render()` to each light, `look_from_state()`, `perceptible()` |
| `engine/effects.py` | `EffectLibrary`: normalised effects from `data/effects/*.yaml` plus `/config/effects/*.yaml`; `resolve(effect, light)` |
| `engine/layers.py` | `Span`, `Palette` and its per-element random walk, the software effects, the six layer types, `build_layer()` |
| `engine/planner.py` | `Planner`: per-light rate, per-network budgets, what to send and with what transition |
| `engine/engine.py` | `Engine`: play, stop, the tick, overlap, handing lights back; `resolve_targets()` |
| `library.py` | `Library`: palettes and shows as YAML (built-in and user) |
| `data/palettes/*.yaml` | Starter palettes: forest, ocean, fire, aurora, sunset, team_colours, warm_white, halloween |
| `data/effects/builtin.yaml` | Normalised effects and their names per integration |

## Colour

- A `Color` is a hue and saturation at full value: the largest sRGB channel is 1. How bright a
  light is lives in `Look.brightness` (0 is off). Blending never changes brightness, and
  brightness never changes the colour.
- **Blending is in OKLab**, so red to green passes through yellow, not brown. Two whites given as
  kelvin blend along the white locus (in mireds) and stay whites.
- Colours in YAML or JSON: `"#ff8800"`, `red`, `warm_white`, `"2700K"`, `{xy: [x, y]}`,
  `{kelvin: 2700}`, `{rgb: [255, 0, 0]}`, `{hs: [30, 100]}`, `{hex: "#ff8800"}`.

### Rendering to a light (`render`)

| Light | Gets |
|---|---|
| Colour (`xy`, `hs`, `rgb`, `rgbww`, `rgbw`; preferred in that order) | the colour in its mode, brightness separately. `rgbw`: the common white part goes to W. `rgbww`: it is split between cold and warm white by the colour's temperature. |
| Colour with a white range, and a colour defined as kelvin | `color_temp_kelvin`, clamped to the light's range (a real white beats an RGB mix) |
| White only | the nearest kelvin in its range: the palette's `white` if it has one, else the colour's correlated temperature; saturated colours count as warm (red side) or cool (blue side) |
| Dimmer | brightness only |
| Relay | on when the look is at least 30 % bright (`RELAY_THRESHOLD`), else off |
| Anything, black or brightness 0 | off |

A native effect (`Look.effect`) is sent as the light's own effect name with brightness.

### Threshold

`perceptible(a, b)` is false when a change wouldn't be seen: OKLab distance below 0.02 and
lightness (cube root of brightness) within 0.01. On/off and effect changes always count. The
planner sends nothing for imperceptible changes.

## Layers

Every layer samples per element at a time and returns a **span**: the look now, and either "the
same until T" or "a straight fade to look X at T". Layers stack by priority; each sees the span
below it. The bottom of the stack is the light's own state from before the engine touched it
(so a fade-in starts from where the light is, and a dip dims the light's own level).

Common keys: `targets`, `priority`, `at_s` (start after the show starts), `duration_s`,
`fade_in_s` (from what's below; default 2 s for palettes, 1 s for static, else 0), `fade_out_s`.
Percentages are 0–100.

| Type | Keys | What |
|---|---|---|
| `static` | `color`, `brightness` | One look |
| `palette` | `palette` (an id, or a palette inline), `brightness` (scales the palette's range) | The palette cycler (below) |
| `native_effect` | `effect` (normalised name), `color`, `brightness`, `allow_close`, `allow_software` | Resolution (below) per element: native where every light of the element has it, else the software version, else the key colour |
| `software_effect` | `effect`: `flicker` (`speed_hz` 6, `depth` 50 %), `candle` (`speed_hz` 3, `depth` 40 %, colour 1900 K), `breathe` (`period_s` 4, `low` 15 %), `lightning` (`interval_s` 6); `color`, `brightness` | Deterministic functions of time, seeded per element. Lightning shows the layer below between strikes. |
| `dip` | `level` (20), `fade_s` (0.5), `hold_s` (3), `restore_s` (1) | Dim to a fraction of each element's own level (whatever is below: a palette, or the light's own state), hold, come back to it. Off lights stay off. |
| `flash` | `color`, `brightness`, `count` (1), `on_s` (0.3), `off_s` (0.3) | Flash, dark between, then whatever is below. Never faster than 3 per second (photosensitivity). |

Default priorities: static and palette 10, effects 20, dip 50, flash 60. A show's `priority`
comes first: a priority-1 show is above every layer of a priority-0 show.

### The palette cycler

```yaml
id: forest
name: Forest
category: [nature, forest]
colors:                       # weighted
  - { xy: [0.25, 0.55], weight: 3 }
  - { hex: "#1f6b3a", weight: 2 }
  - { kelvin: 2700, weight: 1 }
brightness: [35, 70]          # percent
transition_s: [8, 20]         # each fade, random in the range
hold_s: [5, 30]               # each hold
spread: per_element           # or together: every element the same
white: { kelvin: 3000 }       # optional: what white-only lights show
```

Each element walks on its own: hold, fade to another colour (weighted, never the same one twice
in a row) at a new brightness, hold, and so on. The first hold is a random part of `hold_s`, so
elements are out of phase. The walk is generated from `seed:layer:element` (SHA-512-seeded
`random.Random`), so **the same seed gives the same show**; the seed is reported by the API.

## Native effect resolution

`data/effects/builtin.yaml` lists normalised effects (`fire`, `candle`, `ocean`, `forest`,
`aurora`, `party`, `sparkle`, `lightning`, `breathe`, `sunrise`, `sunset`). For each:
`name`, key `color` and `brightness` (for fallbacks), an optional `software` effect, and per
integration (`zigbee2mqtt`, `wiz`, `wled`, `govee2mqtt`, or `*` for any) the `exact` and `close`
names. Names are matched against the light's own `effect_list`, ignoring case and spacing.

For a light: **native exact → native close → software → static key colour.** Examples from the
house: `fire` is `fireplace` on Hue, `Fireplace` on WiZ, `Fire 2012` on WLED, `Fire` on Govee, and
a software candle on a plain dimmer. `aurora` on Hue is close (`cosmos`). z2m's `breathe` is an
identify blink, so `breathe` on Hue runs in software.

Files in `/config/effects/*.yaml` are read after the built-in one (at start-up); the same key
replaces an entry. `GET /api/lights/{entity_id}/effects` shows how each effect resolves for a
light.

## The planner

Every tick (20 Hz), for each light whose own interval (`1 / max_rate_hz`) has passed:

1. **Latency compensation:** the layers are sampled at `now + latency_ms`, so the change lands on
   time. A 650 ms Z-Wave dimmer is sent a flash 400 ms before a 250 ms Hue bulb.
2. **What to send:**

   | Content at that time | Light fades natively | Light can't fade |
   |---|---|---|
   | Constant | the look; transition 0 if crisp (flash), else the light's default | the look |
   | A straight fade (palette, dip, fade-in) | **the fade's end, with its remaining time**: one command per fade | steps along it at its own rate |
   | Busy (software effect), light interval < 1 s | a sample: transition 0 for flicker and lightning, one interval for candle and breathe | a sample |
   | Busy, light interval ≥ 1 s (Z-Wave, Govee cloud, relays) | **the average over its interval** (8 samples in OKLab), as one fade of that length | the average |

3. **Threshold:** skip if `perceptible(last sent, new)` is false.
4. **Budgets:** the planner keeps its own token buckets at 90 % of the governor's network budgets
   (Z-Wave 2/s for the mesh, Zigbee 25/s, Govee cloud 1/s, Matter 5/s) and of the HA driver's
   10/s. On/off and effect changes go first, then the lights that have waited longest. So the
   governor never has to queue, and a busy Z-Wave mesh shares its two commands a second fairly.

The governor still enforces every limit on its own; the planner just avoids asking for more.

## Shows

```yaml
id: porch_storm
name: Porch storm
priority: 0
targets: { areas: [porch, front_entrance] }   # default for layers without their own
duration_s: 120          # optional; else the longest finite layer, else until stopped
on_end: restore          # restore | fade | hold
fade_s: 2                # for on_end: fade
seed: 1234               # optional: the same seed plays the same show
layers:
  - { type: palette, palette: ocean, brightness: 60 }
  - { type: software_effect, effect: lightning, interval_s: 4 }
  - { type: dip, level: 10, at_s: 30, hold_s: 4, targets: { lights: [light.front_porch_light] } }
```

**Targets:** `all: true`, `floors`, `areas`, `fixtures`, `lights` (entity ids), `exclude`.
Only included, available lights are used. A light in a fixture brings the whole fixture, and the
fixture is one element: all its lights get the same look (each at its own latency).

**Overlap:** all shows share one Safety session (`engine`). Where shows overlap on a light, the
higher priority wins; when it ends, the lower one shows again. Lights a test is using are left
out of a new show.

**Handing back:** a light is released when no running show covers it any more, as the show that
last had it says: `restore` puts back the snapshot (skipped when the light is already there, as
after a dip), `fade` does the same as a fade of `fade_s` (lights with native transitions), `hold`
leaves it as it is and forgets the snapshot. Stop all restores everything regardless.

**Outside changes:** when someone changes a light during a show, Safety drops it and keeps their
change; the engine removes it from every show. A show left with no lights ends. Until a light is
first sent something, the engine follows what it does (so a dip uses its current level).

## Storage

| Where | What |
|---|---|
| `luminorium/data/palettes/*.yaml` | Built-in palettes (read-only) |
| `/config/palettes/<id>.yaml` | The user's palettes; an id matching a built-in one replaces it |
| `/config/shows/<id>.yaml` | Saved shows |
| `/config/effects/*.yaml` | Extra or replacement effect definitions |

`/config` is the add-on's `addon_config` folder (`settings.config_dir`; `.dev-data/<run>/config`
on a PC). Files are read on every request, so edits there show up without a restart (effects:
at start-up). Ids are 1–64 characters of `a-z 0-9 _ -`. Writes are atomic.

## Trying it on the fake HA

```bash
.venv/Scripts/python tools/dev.py
```

Open http://127.0.0.1:8199/, unfold **Palettes**, pick one and a room, **Play**. Or with the API:

```bash
curl -X POST http://127.0.0.1:8199/api/palettes/forest/play -H "Content-Type: application/json" -d '{"targets": {"areas": ["master_bedroom"]}, "seed": 1}'
```

```bash
curl -X POST http://127.0.0.1:8199/api/play -H "Content-Type: application/json" -d '{"targets": {"lights": ["light.front_porch_light", "light.master_closet_light"]}, "layers": [{"type": "native_effect", "effect": "fire"}], "duration_s": 20}'
```

`GET /api/running` lists what's playing; **Activity** and the per-room "on" counts show the fake lights changing.

## Not here yet

Colour fields and the designer, views and spatial layers, `sequence` layers, keyframes and BPM,
show loops, quiet hours, group messages (Z-Wave multicast, z2m groups), and direct drivers
(phases 2, 5 and 6). `fade_to_palette` from the design is `fade` (back to the light's own state)
for now.
