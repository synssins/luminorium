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
  "activity": [{"at": 1792166234.5, "message": "Testing Front Porch Light", "entity_id": "light.front_porch_light"}]
}
```

`activity` is the latest 30 events, newest first.

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
    "network": "zigbee", "driver": "ha", "max_rate_hz": 2.0, "latency_ms": 250,
    "relay": false, "details": {}
  }
}
```

For Z-Wave, `profile.details` has `node_id`, `node_status`, `security`, `zwave_plus`,
`multilevel_switch_version` or `binary_switch_version`, and `supervision`.

## `PUT /api/lights/{entity_id}/include`

Body `{"include": true}`, `{"include": false}`, or `{"include": null}` to go back to the default.
Returns the updated light. `404` for unknown entities, segments and settings.

## `POST /api/lights/{entity_id}/test`

Starts the Test sequence. `{"started": entity_id}`; `409` if read-only, excluded, unavailable,
part of a fixture (test the fixture), already testing, or in use; `404` if unknown.

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
