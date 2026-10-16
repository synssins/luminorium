# Luminorium

Light effects, shows and sequences across every light Home Assistant knows about.

This is phase 1: the inventory and the safety net. Luminorium reads your floors, areas and lights
from Home Assistant and shows each light with what it can do. A **Test** button turns one light on,
then off, then puts it back exactly as it was.

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
