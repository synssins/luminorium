# Luminorium

Light effects, shows and sequences across every light Home Assistant knows about.

This is phase 2: the inventory, the safety net and direct drivers. Luminorium reads your floors,
areas and lights from Home Assistant and shows each light with what it can do. A **Test** button
turns one light on, then off, then puts it back exactly as it was.

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

## Drivers

Every light can be driven through Home Assistant. Where it pays off, Luminorium talks to the
light's own hub or the light itself instead:

| Lights | Driver | Why |
|---|---|---|
| Zigbee2MQTT | **Zigbee2MQTT** over MQTT (Mosquitto) | Faster; z2m groups change several bulbs at once |
| Z-Wave JS | **Z-Wave JS** server | Several dimmers in one message (multicast); exact fade times on dimmers that support them |
| WiZ | **WiZ LAN** (UDP) | All firmware scenes, 10+ changes per second |
| WLED | **WLED** (JSON API, DDP) | Effects and palettes by name; per-LED streaming |
| Govee (govee2mqtt) | **Govee LAN** (UDP) | No cloud round trip; needs "LAN Control" on in the Govee app |

Each light shows **via …** with the driver it uses now. It is chosen automatically: the direct
driver when it can reach the light, otherwise Home Assistant. Under each light, **Driver** lets
you pin it to Home Assistant or to its direct driver instead. A pinned direct driver that can't
reach the light falls back to Home Assistant and says so. The line under the counts shows each
driver's state.

Govee scenes always go through Home Assistant (they aren't in Govee's LAN API).

## Fixtures

Several bulbs in one fixture (the two in a ceiling fan) look like one light from outside. Group
them as a **fixture** and Luminorium tests them together, and later maps them as one.

- **Suggestions** appear in a room when lights of the same model have numbered names ("Office Fan
  RGB1", "RGB2"). Answer **Group as one** or **Not the same**.
- **Group lights** (above the list): tick the lights, optionally name the fixture, then **Group
  as one fixture**.
- On a fixture: **Rename**, **Ungroup**, and **Test** (all its lights on, off, then restored).

## Safety

- **Stop all** is always at the bottom of the page. It ends every running test or show and
  restores every light it touched.
- Luminorium saves each light's state before touching it. If the add-on stops or crashes in the
  middle of something, it restores those lights the next time it starts.
- If someone changes a light while Luminorium is using it (a wall switch, an automation), that
  light is dropped and their change is kept.

## Options

- `read_only`: when on, Luminorium never sends anything to any light. Useful for looking around.
  The drivers still look for devices, so you can see which would be used.
- `drivers`: switch any direct driver off; its lights then go through Home Assistant.
- `wiz_subnets`, `govee_subnets`: the networks searched for WiZ and Govee devices (default
  `192.168.10.0/24`). Unicast search works across VLANs where multicast doesn't.
- `govee_razer_models`: Govee models allowed to stream per-segment colours. Leave empty until a
  model has been tested.
- `z2m_base_topic` (optional, default `zigbee2mqtt`), `zwave_url` (optional, found
  automatically).
- `log_level`: `info` by default.

Luminorium uses host networking (to reach WiZ, WLED and Govee devices) and asks the Supervisor
for its own MQTT login, so the Mosquitto add-on must be installed.
