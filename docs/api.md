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
| `GET /views` | Views: photo, manual placement, planes, review editor |
| `GET /capture` | Camera mapping on the phone |
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

## Views

See [mapping.md](mapping.md) for the model. Errors: `404` unknown view, element or plane; `400`
invalid input (a light that is already placed, part of a fixture, unknown; a plane without four
points; not an image).

| Request | Body | Result |
|---|---|---|
| `GET /api/views` | | `[{id, name, photo, elements, planes, stations, updated}]` |
| `POST /api/views` | `{"name"}` | the view |
| `GET /api/views/{id}` | | the view: `{id, name, photo: {file, width, height}, planes, elements, stations, mapping, created, updated}` |
| `PUT /api/views/{id}` | `{"name"}` | the view |
| `DELETE /api/views/{id}` | | `{"deleted"}` |
| `PUT /api/views/{id}/photo` | the image itself (any format the browser sends, ≤ 25 MB) | `{photo, registered, moved}`: placements are carried over when the old and new photos match |
| `GET /api/views/{id}/photo` | | JPEG |
| `GET /api/views/{id}/stations/{name}/photo` | | a capture station's reference photo |
| `POST /api/views/{id}/planes` | `{"name", "kind": "ground"\|"wall"\|"other", "points": [[x, y] × 4], "size": [w, h] or null}` | the plane |
| `PUT /api/views/{id}/planes/{plane}` | any of those fields | the plane |
| `DELETE /api/views/{id}/planes/{plane}` | | `{"deleted"}` |
| `POST /api/views/{id}/elements` | `{"members": [entity_id or fixture id, …], "centroid": [x, y]}`, optionally `name`, `mode`, `region`, `plane`, `line`, or `parts` instead of `members` | the element |
| `PUT /api/views/{id}/elements/{el}` | any of `name, mode, centroid, region, plane, line, note, members/parts` | the element. A new `centroid` alone moves the outline and parts with it; a `line` spreads the parts along it (a segmented light becomes its segments) |
| `DELETE /api/views/{id}/elements/{el}` | | `{"deleted"}` |
| `POST /api/views/{id}/elements/merge` | `{"ids": [el, …], "mode": "single"\|"segments"}` | the merged element |
| `POST /api/views/{id}/elements/{el}/split` | | one element per part |
| `PUT /api/views/{id}/elements/{el}/order` | `{"members": [...]}` (the same members, in a new order) | the element |

An element:

```json
{
  "id": "el_1a2b3c4d", "name": "Long window", "mode": "segments",
  "parts": [{"member": "light.lr_1", "centroid": [0.42, 0.18], "region": [[…]], "latency_ms": 360,
             "confidence": 1.0, "world": {"method": "triangulated", "x": 1.6, "y": -2.8, "z": 15.1, "metric": true}}, …],
  "region": [[0.38, 0.12], …], "centroid": [0.55, 0.18], "plane": null,
  "world": {"method": "triangulated", "x": 3.7, "y": -2.8, "z": 15.0, "metric": true},
  "line": null, "source": "mapping", "confidence": 1.0, "note": ""
}
```

## Camera mapping

`409` when read-only, when another capture is running, or the request doesn't fit the capture's
state.

| Request | Body | Result |
|---|---|---|
| `GET /api/mapping/sessions` | | captures on disk, newest first |
| `POST /api/mapping/sessions` | `{"view_id", "targets": [entity_id or fixture id, …], "stations"?: ["centre", "left", "right"], "sync"?: unit, "known_distance"?: {"a", "b", "metres"}}` | the capture: `{id, view_id, status, targets, sync, stations: [{name, state, message, mode, frames, retakes, dropped, handshake}], …}` |
| `GET /api/mapping/sessions/{id}` | | the capture plus `results` (when solved) |
| `DELETE /api/mapping/sessions/{id}` | | `{"deleted"}` (not while a station runs) |
| `POST /api/mapping/sessions/{id}/stop` | | ends the running station and restores its lights |
| `POST /api/mapping/sessions/{id}/stations/{name}/record` | | record-and-upload: runs that station's pass on fixed timing after a 5 s countdown |
| `PUT /api/mapping/sessions/{id}/stations/{name}/video` | the video file (≤ 600 MB) | `{"uploaded"}`; it is analysed in the background |
| `POST /api/mapping/sessions/{id}/solve` | `{"known_distance"?}` | combines the analysed stations again (for example with a known distance added) |
| `POST /api/mapping/sessions/{id}/reanalyse` | | analyses every recorded station again from its files, then combines |
| `POST /api/mapping/sessions/{id}/apply` | | puts the results on the view: `{registered, elements}` |
| `GET /api/mapping/sessions/{id}/photo` | | the centre station's reference photo |
| `WS /api/mapping/sessions/{id}/ws` | | the phone's stream: [mapping.md](mapping.md#what-the-phone-sends). Same client allow-list as HTTP. |

`results` (also `results.json` in the capture's folder): `{stations: [per-station summary with
each light's detected, confidence, centroid, region, latency_ms, rise, note, and each step],
elements: [suggested elements], missing: [units no station found], latency_ms: {unit: ms},
sync, solution: {focal_px, reproj_rms, metric, method, note}, station_poses, photo}`.
