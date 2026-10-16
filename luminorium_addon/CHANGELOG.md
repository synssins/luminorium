# Changelog

## 0.1.0-dev.4

Phase 5: views and camera mapping.

- **Views:** a photo of the house per viewpoint, with lights and fixtures placed on it. Place by
  hand (tap a light, tap the photo, drag to move), or map with the phone camera; both make the
  same elements. Segmented lights and several lights in a row can be spread along a drawn line.
- **Planes:** mark the lawn or the house front with four taps and an optional real size; lights
  on a plane get positions in metres on it.
- **Map with the camera:** pick what's visible, then the app leads three stations (centre, about
  45° left, about 45° right) with a steadiness meter and compass guidance. At each station it
  takes a reference, blinks a sync light, inverts one light (or fixture) at a time and moves on as
  soon as the change has settled, retakes jolted steps with a single revert, and puts every light
  back. Frames, motion and the command log are saved under `/config/mapping/sessions` and
  analysed in the add-on (OpenCV): regions, latency, grouping (one window = one element, a long
  window = segments), 3D positions from the three stations.
- **Review:** the results go onto the view: outlines on the photo; merge, split, reorder,
  rename, assign planes. Measured latencies replace the profile defaults.
- Record-and-upload fallback when the live camera doesn't work in the HA app.
- Stop all ends a capture and restores; nothing is flashed in read-only mode.
- New dependencies: numpy, opencv-python-headless, websockets (the image grows by about 220 MB).

## 0.1.0-dev.3

- Levels and rooms fold (tap a heading), with Collapse all / Expand all, remembered per device.
- **Fixtures:** group lights that share one physical fixture (the two office fan bulbs). A fixture
  is tested as one (all its lights on, off, restored together) and will be mapped as one.
  Suggestions for numbered lights of one model in one room; Group lights, Rename, Ungroup.
- Messages show in the page instead of browser pop-ups (which the HA app may not show).

## 0.1.0-dev.2

- Fix: the add-on couldn't find `SUPERVISOR_TOKEN` under s6-overlay's init and stopped.
  `run.sh` now runs under `with-contenv`, and the token is also read from s6's container
  environment. Running as an add-on without a token now stops with a clear error instead of
  falling back to development settings.

## 0.1.0-dev.1

Phase 1, first build.

- Inventory from HA: floors (plus "Outside / no floor"), areas, lights; default exclusions with
  reasons; switches opt-in; Govee segments folded under their light; light-device settings
  recognised; duplicates across integrations suggested.
- Profiles from HA attributes and Z-Wave node details (command class versions, security,
  dead nodes); per-network defaults for rate and latency.
- HA driver with a rate governor (per light, per network, latest value wins).
- Snapshots before every change, restore on finish, Stop all, restore after a crash; lights
  changed outside Luminorium are dropped, not overwritten.
- Ingress web UI: lights by floor and area, include/exclude, Test button, activity; phone
  camera check page.
