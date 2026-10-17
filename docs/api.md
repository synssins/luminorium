# HTTP API

Served by `web/server.py` on the Ingress port (8199). Through Ingress the paths sit under HA's
per-session prefix, so the UI uses relative URLs. In the add-on only the Supervisor's ingress proxy
(`172.30.32.2`) and localhost may connect; anything else gets `403`. Responses are JSON and
`Cache-Control: no-store`.

## Pages

| Path | What |
|---|---|
| `GET /` | Lights page |
| `GET /camera` | Phone camera and motion-sensor check |
| `GET /static/…` | `app.js`, `style.css` |

## `GET /api/status`

```json
{
  "version": "0.1.0-dev.1",
  "connected": true,
  "ha_version": "2026.9.2",
  "read_only": false,
  "loaded": true,
  "counts": {"lights": 41, "segments": 94, "switches": 0, "excluded": 179},
  "sessions": ["test:light.front_porch_light"],
  "touched": ["light.front_porch_light"],
  "activity": [{"at": 1792166234.5, "message": "Testing Front Porch Light via z2m", "entity_ids": ["light.front_porch_light"]}],
  "drivers": {
    "ha": {"enabled": true, "connected": true},
    "z2m": {"enabled": true, "connected": true, "error": null, "devices": 20, "groups": 4, "bridge_online": true},
    "zwave_js": {"enabled": true, "connected": true, "error": null, "url": "ws://core-zwave-js:3000",
                 "server": "3.10.2", "nodes": 29, "multicasts": 0, "read_back_misses": 0},
    "wiz": {"enabled": true, "connected": true, "error": null, "bulbs": 2, "subnets": ["192.168.10.0/24"],
            "found": [{"mac": "…", "ip": "192.168.10.64", "module": "ESP01_SHRGB1C_31", "online": true}]},
    "wled": {"enabled": true, "connected": true, "error": null, "devices": 1},
    "govee": {"enabled": true, "connected": true, "error": null, "devices": 1, "subnets": ["192.168.10.0/24"],
              "razer_models": [], "found": [{"device": "…", "sku": "H7055", "ip": "…", "online": true,
                                             "status": {"onOff": 1, "brightness": 100, "color": {…}, "colorTemInKelvin": 0}}]}
  }
}
```

`activity` is the latest 30 events, newest first. `drivers` has one entry per direct driver:
`{"enabled": false}` when switched off in the options; `connected` is the link to its hub (or
its UDP socket); `error` the last problem ("no MQTT broker (Mosquitto not found)", "can't listen
on UDP 4002: …").

## `GET /api/inventory`

```json
{
  "floors": [{"id": "bedroom_level", "name": "Bedroom Level", "level": 4}, …],
  "areas":  [{"id": "porch", "name": "Porch", "floor_id": "_no_floor"}, …],
  "lights": [ <light>, … ],
  "fixtures": [{"id": "fx_1a2b3c4d", "name": "Office fan", "area_id": "office",
                "floor_id": "ground_level", "members": ["light.office_fan_rgb1", "light.office_fan_rgb2"]}],
  "suggestions": [{"name": "Garage Light Bulb", "area_id": "front_garage",
                   "members": ["light.garage_light_bulb_1", "light.garage_light_bulb_2"],
                   "reason": "same room, same model (Connected bulb), numbered names"}]
}
```

Segments are not listed; their parent's `segments` holds their entity ids. A light:

```json
{
  "entity_id": "light.front_porch_light",
  "name": "Front Porch Light",
  "platform": "mqtt",
  "integration": "zigbee2mqtt",
  "kind": "light",
  "area_id": "porch",
  "floor_id": "_no_floor",
  "device_id": "…", "device_name": "Front Porch Light ",
  "manufacturer": "Philips", "model": "Hue White and Color Ambiance BR30 with bluetooth",
  "state": "off",
  "available": true,
  "included": true,
  "exclude_reason": null,
  "user_choice": null,
  "hint": null,
  "parent": null, "segment_index": null, "segments": [],
  "members": [],
  "duplicates": [],
  "fixture": null,
  "profile": {
    "capabilities": {"on_off": true, "dimming": true, "white": [2000, 6535],
                     "color_modes": ["xy"], "effects": ["blink", "candle", …],
                     "transition": "native", "segments": 0},
    "network": "zigbee", "driver": "z2m", "max_rate_hz": 5.0, "latency_ms": 200,
    "relay": false, "details": {},
    "drivers": ["z2m", "ha"], "driver_override": null, "driver_note": null,
    "endpoint": "z2m 'Front Porch Light '"
  },
  "driver_options": ["ha", "z2m"]
}
```

`profile.driver` is the driver used now, with the `network`, `latency_ms` and `max_rate_hz` that
come with it; `drivers` is every driver that reaches the light now (the chosen one first);
`driver_override` the user's pin (`null`: automatic); `driver_note` why a pinned driver isn't
used ("Zigbee2MQTT can't reach it now: using HA"); `endpoint` how it is reached.
`driver_options` are the values `PUT …/driver` accepts besides `null`.

For Z-Wave, `profile.details` has `node_id`, `node_status`, `security`, `zwave_plus`,
`multilevel_switch_version` or `binary_switch_version`, and `supervision`.

## `PUT /api/lights/{entity_id}/include`

Body `{"include": true}`, `{"include": false}`, or `{"include": null}` to go back to the default.
Returns the updated light. `404` for unknown entities, segments and settings.

## `PUT /api/lights/{entity_id}/driver`

Body `{"driver": "z2m"}` (any of the light's `driver_options`) to pin a driver, or
`{"driver": null}` for automatic. Stored in `choices.json`. Returns the light. `400` for a
driver the light can't use, `404` for unknown entities.

## `POST /api/lights/{entity_id}/test`

Starts the Test sequence. Optional body `{"transition_ms": 3000, "effect": "candle",
"hold_s": 3}` (fade 0–10000 ms on the way on and off, an effect the light lists while on, hold
0–30 s). `{"started": entity_id}`; `409` if read-only, excluded, unavailable, part of a fixture
(test the fixture), already testing, in use, or the options are out of range; `404` if unknown.

## Fixtures

| Request | Body | Result |
|---|---|---|
| `POST /api/fixtures` | `{"name": "Office fan", "members": [entity_id, …]}` (name optional) | the fixture; `400` if fewer than two members, a member can't be in a fixture, or is already in one |
| `PUT /api/fixtures/{id}` | `{"name"?, "members"?}` | the fixture; `400` / `404` |
| `DELETE /api/fixtures/{id}` | | `{"deleted": id}`; its lights become single lights again |
| `POST /api/fixtures/{id}/test` | | `{"started": id, "skipped": [entity_id, …]}`: every testable member on, off and restored together; unavailable or excluded members are skipped; `409` if none can be tested |
| `POST /api/fixture_suggestions/dismiss` | `{"members": [entity_id, …]}` | `{"dismissed": [...]}`; that suggestion isn't shown again |

## `POST /api/stop_all`

Ends everything and restores every touched light. `{"restored": n}`.
