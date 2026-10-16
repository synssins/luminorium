# Luminorium

Light effects, shows and sequences across every light Home Assistant knows about.

Luminorium reads your floors, areas and lights from Home Assistant and shows each light with what
it can do. A **Test** button turns one light on, then off, then puts it back exactly as it was.
**Palettes** play slowly changing colours in a room, and the API plays effects and shows (early
days: the designer comes later).

## Lights

- Lights are grouped by HA floor and area. Areas without a floor (outdoor areas, usually) are
  under **Outside / no floor**.
- Some lights are left out by default, with the reason shown: browser screens, light groups,
  Zigbee2MQTT groups, voice-assistant LED rings, Z-Wave "Basic" duplicate entities, and entities
  HA no longer provides. You can include any of them.
- **Switches** are left out until you include them. Include only switches that are light relays.
  Don't include a relay that is locked on and feeds smart bulbs: include the bulbs instead.
  A switch on a light's own device (a gradient or sync toggle) is a setting, not a light.
- Govee strip segments are shown as a count on their light.
- Levels and rooms fold: tap a heading. **Collapse all** / **Expand all** fold everything; your
  choice is remembered on that device. A search shows every match, folded or not.

## Fixtures

Several bulbs in one fixture (the two in a ceiling fan) look like one light from outside. Group
them as a **fixture** and Luminorium tests them together, and later maps them as one.

- **Suggestions** appear in a room when lights of the same model have numbered names ("Office Fan
  RGB1", "RGB2"). Answer **Group as one** or **Not the same**.
- **Group lights** (above the list): tick the lights, optionally name the fixture, then **Group
  as one fixture**.
- On a fixture: **Rename**, **Ungroup**, and **Test** (all its lights on, off, then restored).

## Palettes

Unfold **Palettes** under the lights, pick a palette and a room (or every light), and **Play**.
Each light wanders through the palette's colours on its own, with long fades. **Stop** puts the
lights back as they were.

Starter palettes: Forest, Ocean, Fire, Aurora, Sunset, Team colours, Warm white. Your own go in
the add-on's config folder (`/addon_configs/<slug>/palettes/<id>.yaml`); one with the same id as
a starter palette replaces it. Saved shows go in `shows/`, extra effect names in `effects/`.

Effects use a light's own built-in effect where it has one (a Hue "fireplace", a WiZ
"Fireplace", a WLED "Fire 2012"), and otherwise run in software within what the light and its
network can take. Z-Wave dimmers get slow fades, never a flood of commands.

## Safety

- **Stop all** is always at the bottom of the page. It ends every running test or show and
  restores every light it touched.
- Luminorium saves each light's state before touching it. If the add-on stops or crashes in the
  middle of something, it restores those lights the next time it starts.
- If someone changes a light while Luminorium is using it (a wall switch, an automation), that
  light is dropped and their change is kept.

## Options

- `read_only`: when on, Luminorium never sends anything to any light. Useful for looking around.
- `log_level`: `info` by default.
