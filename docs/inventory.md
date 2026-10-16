# Inventory rules

`inventory/builder.py` turns HA's registries and states into the inventory. These are its rules.

## Floors and areas

- Floors come from HA's floor registry, highest level first.
- Two extra buckets: **Outside / no floor** (`_no_floor`) for areas without a floor (in this house:
  Porch, Driveway, Front Yard, Back Yard, Back Patio, Wood Shop, Back Entrance), and **No area**
  (`_no_area`) for lights without an area.
- A light's area is the entity's area, else its device's area. Its floor comes from the area.

## What counts as what (`Kind`)

| Kind | What | Default |
|---|---|---|
| `light` | a `light.*` entity | included, unless a rule below excludes it |
| `segment` | `light.<x>_segment_NNN` on a device with exactly one other light (Govee strips) | follows its parent; listed as a count on the parent, not on its own |
| `group` | HA light group (platform `group`) or a Zigbee2MQTT group (device model `Group`) | excluded; a group handle for later phases, not a light |
| `switch` | a `switch.*` entity on a device without a light | excluded until the user includes it (a relay) |
| `setting` | a `switch.*` on a device that has a light (gradient, sync, nightlight, power toggles) | always excluded; can't be included |

WLED segment lights (`light.wled_segment_1_2`) are real lights and stay `light`.

## Default exclusions (most specific reason first)

1. **Z-Wave Basic mirror:** a `zwave_js` entity whose unique id has command class 32 (`-32-`).
2. **Excluded platforms:** `browser_mod` (browser screens), `signalrgb` (PC lighting).
3. **Groups:** see above.
4. **Voice assistant LEDs:** any light on a device that also has an `assist_satellite.*` entity.
5. **Stale:** the state has `restored: true`, meaning HA keeps a placeholder for an entity its
   integration no longer provides.
6. **Switches:** excluded until included.

Disabled entities are skipped entirely. The user's choice (`choices.json`) overrides every default
except for segments and settings.

## Hints and suggestions

- **"looks like a light relay"**: a non-stale `switch` whose name mentions light, lamp, sconce,
  flood or chandelier, and not indicator, identify, fan or garage door. Only a hint.
- **Duplicates:** the same product code (for example `H60B0`) in two different integrations
  (Matter and govee2mqtt) → each light lists the other in `duplicates`. The user decides which
  to keep by excluding the other.

## Integration

`platform` is HA's; `integration` refines MQTT: device identifier `zigbee2mqtt_…` →
`zigbee2mqtt`, `gv2mqtt-…` → `govee2mqtt`, else `mqtt`.

## Profiles

`inventory/profiles.py` builds one per light.

**Capabilities** from HA attributes:
- `dimming`: any supported colour mode other than `onoff`
- `white`: kelvin range when `color_temp` (or `rgbww`) is supported
- `color_modes`: `xy`, `hs`, `rgb`, `rgbw`, `rgbww`
- `effects`: `effect_list` minus empty, `none` and the z2m stop/finish entries
- `transition`: `native` by default; `none` for WiZ and govee2mqtt, and for Z-Wave dimmers with
  Multilevel Switch v1
- `segments`: the number of folded segments

**Network defaults** (refined by measurement in later phases):

| Network | Integration | Latency | Max per light |
|---|---|---|---|
| `zwave` | zwave_js | 600 ms | 0.5 Hz |
| `zigbee` | zigbee2mqtt | 200 ms | 5 Hz |
| `wiz` | wiz | 120 ms | 15 Hz |
| `wled` | wled | 30 ms | 40 Hz |
| `govee_cloud` | govee2mqtt (no LAN path today) | 1000 ms | 0.5 Hz |
| `esphome` | esphome | 100 ms | 10 Hz |
| `matter` | matter | 300 ms | 2 Hz |
| `mqtt` | other MQTT | 200 ms | 5 Hz |
| `other` | anything else | 250 ms | 2 Hz |

Phase 1 drives everything through HA, so each profile's latency adds 50 ms and its rate is capped
at 2 Hz. **Relays** (included switches) are on/off only, at most one toggle per 5 s (0.2 Hz).

**Z-Wave details** come from `zwave_js/node_status` and `zwave_js/node_capabilities` (read once
per device and cached): node id, node status (alive, dead, asleep), security class, Z-Wave Plus
version, Multilevel Switch and Binary Switch versions, Supervision.
