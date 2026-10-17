# HTTP API

Served by `web/server.py` on the Ingress port (8199). Through Ingress the paths sit under HA's
per-session prefix, so the UI uses relative URLs. In the add-on only the Supervisor's ingress proxy
(`172.30.32.2`) and localhost may connect; anything else gets `403`. Responses are JSON and
`Cache-Control: no-store`.

## Pages

The UI pages are listed in [ui.md](ui.md): `/`, `/lights`, `/light`, `/palettes`, `/house`, `/drivers`,
`/activity`, `/settings`, `/views`, `/capture`, `/camera`. The house map API is in
[house.md](house.md#api).


Static files are under `GET /static/…` (`style.css`, `shell.js`, `pages/*.js`, the Views and camera
scripts).

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

`activity` is the latest 30 events, newest first. `units` is `imperial` or `metric`, from Home
Assistant's unit system. `drivers` has one entry per direct driver:
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

## `PUT /api/lights/{entity_id}/white_only`

Body `{"white_only": true}` marks a light whose bulbs only give white, whatever colour they're
sent (the white LEDs of the WLED pathway); `false` clears it. Stored in `choices.json` (the
`white_only` list); the light's `white_only` field shows it. Palette layers leave such lights out
unless the play sets `include_white`. `404` for unknown lights.

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

## Palettes, effects and shows

The engine is described in [engine.md](engine.md). Play requests return `409` when read-only or
before the inventory has loaded, and `400` for a bad show or targets (unknown area, excluded light,
no usable lights).

**Targets** are `{"all": true}` or any of `floors`, `areas`, `fixtures`, `lights` (entity ids),
plus `exclude`.

| Request | Body | Result |
|---|---|---|
| `GET /api/palettes` | | `[{id, name, category, colors: [{hex or kelvin, weight}], brightness, transition_s, hold_s, spread, white?, source}]`; `source` is `builtin` or `user` |
| `PUT /api/palettes/{id}` | a palette (as in [engine.md](engine.md#the-palette-cycler)) | the palette, saved to `/config/palettes/{id}.yaml`; `400` if invalid or the id isn't `a-z 0-9 _ -` |
| `DELETE /api/palettes/{id}` | | `{"deleted": id}`; `404` if there is no user palette (built-ins can't be deleted) |
| `POST /api/palettes/{id}/play` | `{"targets": {...}, "include_white"?: false, "priority"?: 0, "on_end"?: "restore", "fade_s"?: 2, "brightness"?: 100, "duration_s"?, "seed"?}` | a running show; `404` for an unknown palette |
| `GET /api/effects` | | `[{id, name, color, software, integrations}]` |
| `GET /api/lights/{entity_id}/effects` | | `{effect: {"method", "name"}}` for that light; `method` is `native`, `close`, `software` or `static` |
| `GET /api/shows` | | saved shows |
| `PUT /api/shows/{id}` | a show | the show, saved to `/config/shows/{id}.yaml`; `400` if a layer doesn't build |
| `DELETE /api/shows/{id}` | | `{"deleted": id}` |
| `POST /api/shows/{id}/play` | `{"targets"?: {...}, "seed"?}` (targets replace the show's own) | a running show |
| `POST /api/play` | a show, inline (not saved) | a running show |
| `GET /api/running` | | running shows, oldest first |
| `POST /api/running/{run_id}/stop` | `{"on_end"?: "restore", "fade" or "hold"}` | `{"stopped": run_id}`; `404` if not running |
| `POST /api/stop` | | `{"stopped": n}`: every show ends as its `on_end` says |

A running show:

```json
{
  "id": "palette-3fa2c1", "name": "Forest", "kind": "palette", "source": "forest",
  "seed": "3", "priority": 0, "on_end": "restore", "started_at": 1792166234.5,
  "elapsed_s": 12.4, "remaining_s": null,
  "lights": ["light.front_porch_light"],
  "layers": [{"type": "palette", "priority": 10, "at_s": 0.0, "duration_s": null,
              "palette": "forest", "elements": ["light.front_porch_light"]}]
}
```

A `native_effect` layer also has `resolution`: `{element: {entity_id: {"method", "name"}}}`.
`GET /api/status` has `shows: [{id, name}]`.

## `POST /api/stop_all`

Ends everything (tests and shows) and restores every touched light, whatever the shows' `on_end`. `{"restored": n}`.

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
