# Views and camera mapping (phase 5)

How lights get positions: by hand on a photo, or with the phone camera. Both produce the same
**view** with the same **elements**. The design and the reasoning are in
[DESIGN.md §8](../DESIGN.md); the synthetic prototype the analysis comes from is in
[proto/mapping/](../proto/mapping/README.md).

## The spatial model (`spatial/`)

| Thing | What |
|---|---|
| **View** | A viewpoint ("Front of house") with a photo. Picture coordinates are normalised to the photo: (0, 0) top left, (1, 1) bottom right. |
| **Plane** | A flat surface marked by four picture points (top-left, top-right, bottom-right, bottom-left as on the surface), `kind` ground / wall / other, and an optional real size in metres. |
| **Element** | What a viewer sees change: a `region` polygon, a `centroid`, an optional `plane`, a `world` position, a `mode` (`single`: all its parts act as one; `segments`: each part is a segment, in order), and its `parts`. |
| **Part** | One member of an element: a light, a fixture (lights in one physical fixture, as one) or a segment of a segmented light, with its own centroid, region, world position, latency and confidence. |
| **Station** | A capture position: rotation, camera centre, focal length (pixels), frame size, the capture it came from, and its reference photo. |

A light or fixture is in at most one element per view. A light that belongs to a fixture is
placed as the fixture. A segmented light (a Govee strip) can be placed whole, or spread along a
drawn line as its segments.

`world` says where an element is in the real world, and how that is known:

| `method` | Fields | From |
|---|---|---|
| `triangulated` | `x, y, z` | two or more stations. The frame is the first (centre) station's camera: x right, y down, z forward. `metric` is true when a known distance gave the scale (metres); otherwise the shape is right but not the size. |
| `plane` | `plane, u, v` | the element's centre on its plane: across and along the rectangle from its first corner, in metres when the plane has a size, else 0–1. |
| `ray` | `origin, direction` | one station only: the direction is known, the distance isn't. Place it by hand or put it on a plane. |
| `manual` | | placed by hand |

Elements without a plane get the plane their centre is in when it is created (ground first); the
user can change it.

### Storage

```
/config/views/<view id>/view.json        the view (planes, elements, stations, last mapping)
/config/views/<view id>/photo_<ms>.jpg   its photo (at most 2048 px, JPEG)
/config/views/<view id>/station_<name>.jpg   each capture station's reference photo
```

`/config` is the add-on's `addon_config` folder: it is in HA backups and visible over Samba.

### Changing the photo

A new photo for a view with placements is matched to the old one (ORB features and a RANSAC
homography). If they match, every element, line and plane is moved to the new photo; if not, the
coordinates stay and each element is marked "check position".

## Manual placement (Views page, `/views`)

1. **New view**, then **Photo…** (any image from the phone or a file).
2. Tap a light (or fixture) in the list, then tap where it is on the photo. Drag a placed light to
   move it. Lights already placed are green.
3. **Mark a plane**: tap the four corners, name it, give its size if known.
4. Select an element to rename it, switch `single`/`segments`, put it on a plane, reorder its
   parts, **Draw segment line** (tap the start, then the end: the parts are spread along it in
   order; a segmented light becomes its segments), **Split**, **Merge with…**, or **Remove**.

That is enough for the colour designer (phase 6) to work in `screen` coordinates before any
camera mapping.

## Camera mapping (Capture page, `/capture`)

### On the phone

1. Pick the view and tick the lights visible from here, by floor and area (fixtures as one).
   Optionally give a known distance between two of them (the two driveway lights are 3.0 m apart)
   for positions in metres.
2. **Start** asks for the camera and the motion sensors (iOS asks for permission), creates the
   capture and opens the websocket.
3. Keep the anchor (the front door) in the circle. **Start the centre station**. The page shows
   what is happening ("Hold still", "Sync blink", "4 of 16: Porch", "Putting the lights back"),
   a steadiness meter (smoothed rotation rate: green below 15 °/s, red above 30) and, for the side stations,
   compass guidance: walk left (or right) around the anchor until the phone has turned about 45°.
4. Repeat for the left and right stations. Each takes about 20–30 s.
5. When the last station is analysed, **Put them on the view and review** opens the view with the
   results.

The camera needs HTTPS (Nabu Casa or HA's own certificate). The HA companion apps allow camera
access in their webview. If the camera doesn't start, the page opens **Record a video instead**.

### What the phone sends

The websocket is `api/mapping/sessions/<id>/ws` (relative, so it works through Ingress).

| Direction | Message |
|---|---|
| phone → app, binary | `LMF1` + uint32 sequence + float64 phone time (s) + a JPEG (or PNG/WebP) frame: 640 wide, about 15 fps, quality 0.92. The time is `performance.timeOrigin + captureTime` from `requestVideoFrameCallback` where available. |
| phone → app, binary | `LMP1` + the reference photo (full resolution of the same video track), when asked |
| phone → app | `{"type": "motion", "samples": [[t, rot_α, rot_β, rot_γ, acc_x, acc_y, acc_z], …]}` (DeviceMotion, deg/s and m/s², every 100 ms), `{"type": "orientation", …}`, `{"type": "start", "station"}`, `{"type": "stop"}`, `{"type": "hello"}`, `{"type": "pong", "server", "phone"}` |
| app → phone | `ack` (per frame; the page keeps at most 3 frames unacknowledged), `ping` (clock handshake), `photo` (send the reference now), `phase`, `station_done`, `analysis`, `results`, `stopped`, `error`, `state` |

**Clock handshake.** The app sends `ping {server}`; the phone answers `pong {server, phone}` with
its own clock; the app takes the offset from the three fastest round trips (NTP-style,
`phone = app + offset`). It pings five times at the start of each station and after every step.

### What the add-on does at each station (`mapping/session.py`)

Each station runs as its own Safety session, `mapping:<capture id>:<station>`, so every command
goes through the snapshots and the rate governor, and **Stop all** cancels it and restores its
lights like any other session.

1. **Steady:** wait until the motion stream has been calm for 1 s (smoothed rotation < 30 °/s,
   acceleration < 3 m/s²: heavy tremor is up to ~30 °/s, a jolt 80+), at most 10 s.
2. **Reference:** start recording, ask for the reference photo, record a still lead-in of at
   least 1.5 s and 8 frames.
3. **Sync blink:** the sync light toggles four times (period 0.4 s, or longer if its rate limit
   needs it), then a 0.8 s pause. The sync light is the fastest light picked (not Z-Wave, Govee
   cloud or a relay), unless one is given. It is not the first step of the pass.
4. **Pass:** one unit per step, fast lights first, Z-Wave last. A unit is a light or a fixture;
   a fixture changes as one (all off if any was on, else all on). Lights turn on at full
   brightness, with `transition: 0` where the light supports it. The step ends:
   - when the **live detector** has seen the change and it has settled, at least 0.45 s after
     the command, or
   - when nothing has changed by the light's **timeout**: twice its profile latency plus 0.3 s,
     at least 0.8 s (2.5 s for Z-Wave and Govee cloud until their latency has been measured), or
   - at the timeout plus 1.5 s if a change was seen but never settled.
5. **Retakes:** a step with a jolt in the motion stream (smoothed rotation > 45 °/s or
   acceleration > 4 m/s²), a frame that couldn't be aligned, or two frames aligned worse than
   2 px (at half size) gets one more step at the end that reverts that light (a single-light
   change, the opposite way). A stricter alignment test retook many steps under heavy shake, and
   each extra step was another chance to pick up parallax.
6. **Restore:** every light back together (Safety's restore), then 2.6 s more frames for the
   restore check.

Then the station's recording is analysed in a worker thread (one at a time) while the user walks
on. When every station is analysed, the results are combined.

#### The live detector (`mapping/live.py`)

Only the step timing depends on it; the offline analysis decides what each light is. At half
resolution (320 × 180):

- the baseline is the median of the frames from 0.3 s before the command to 0.05 s after it;
- every new frame is aligned to it with the analysis's rotation + scale model;
- the difference is z-scored per brightness bin **after removing each bin's median change**,
  which follows auto-exposure, the sensor's noise floor and 8-bit steps, and a phone's tone curve
  (a single global gain didn't: dark lawn and sky don't scale with exposure);
- clipped pixels (lamp heads) and an 8 px border are ignored;
- a candidate blob (z > 5, opened, at least 6 px, mean z ≥ 8) is rejected if it was already
  varying before the command (the last light finishing, a passing car), if it overlaps the last
  step's change within 0.5 s, or if a sub-pixel gradient model or a ±2 px shift explains it
  (parallax and shake);
- the step is **settled** when the last 5 values (≈ 0.33 s) of the blob's mean change show no
  trend beyond their noise, stay within 60 % of the peak, and keep a median z ≥ 8; a lock whose
  z falls below 6 is dropped and the search starts again (twinkling texture on a distant lawn
  was the case that needed this).

Excluded pixels (clipped, outside the warped frame, the border) stay out of the per-bin
statistics and stay zero: an exposure step otherwise turned them into a false change along the
frame edge.

Each step's decision is saved in the station's `live.json` (duration, changed, settled, when the
change started, where).

### The analysis (`mapping/analysis.py`)

A port of the prototype's analysis; [its README](../proto/mapping/README.md) has the method and
why. Differences:

- **No SciPy.** `mapping/lm.py` is a small Levenberg–Marquardt solver (forward-difference
  Jacobian, Marquardt scaling, soft-L1 by reweighting) for the 4-parameter frame alignment and
  the bundle adjustment. On the prototype's own renders it gives the same scores as the SciPy
  version (clean: 3D 0.24 / 0.52 % against 0.25 / 0.52 %).
- **Clock:** with the phone handshake the offset is known; the blink is searched within ±0.3 s of
  it and, when it confirms, gives the **sync light's own latency**. If the blink and the
  handshake disagree by more than that, the blink wins (with a note). An uploaded video has no
  handshake: the blink alone gives the offset, searched over the whole video, as in the
  prototype.
- **Memory:** frames are decoded from the recording one at a time, and the per-frame masks are
  bit-packed: about 190 MB for a 370-frame station instead of 500 MB.
- **Unsteady steps:** a step with a jolt still keeps 0.3 of its confidence, but one whose frames
  only align worse than 2.5 px keeps 0.6. Under heavy shake many steps align that badly, and the
  prototype's 0.3 dropped a clean but dim detection (SNR 8) below the 0.15 cut.

Per station the result has, for every light: detected or not, confidence, region, centroid,
latency, rise or fall, retake, and a note ("not visible from this station", "leftover of the
previous step", "pass step jolted; used retake"). Across stations: grouping (overlap → one
`single` element; side by side with a long shared boundary and a rectangle-like union →
`segments`, ordered left to right), then 3D (essential matrix, PnP, triangulation, bundle
adjustment with the focal length; scale from the known distance).

### Results (`mapping/results.py`)

The first station (the centre) is the view: its picture coordinates are the view's and its camera
is the 3D frame. A light the centre didn't see but two other stations did is projected into the
centre picture from its 3D point (a small circle). A light seen from one side station only has no
position on the centre picture: the review lists it as "found by the camera, not on this photo
yet" with a `ray`, to be placed by hand.

- **Latency** per light: the median over stations of the confident detections, command to 50 %
  of the change. Written to `/data/latency.json` and applied to the profile (`latency_ms`,
  `details.latency_measured`) as soon as the capture is solved. Fixtures give every member the
  fixture's latency.
- **Apply** puts the suggested elements on the view: the centre station's reference photo becomes
  the view's photo (manual placements of other lights are carried over to it, see above), lights
  the capture found replace their old placements, and the stations are stored.

### Raw sessions (re-run offline)

```
/config/mapping/sessions/<id>/session.json   targets, stations, sync light, status
/config/mapping/sessions/<id>/commands.json  the command log (app clock)
/config/mapping/sessions/<id>/results.json   the analysis, suggested elements, latencies
/config/mapping/sessions/<id>/<station>/frames.csv, f_000000.jpg …   frames as the phone sent them
/config/mapping/sessions/<id>/<station>/motion.json, orientation.json, clock.json, live.json
/config/mapping/sessions/<id>/<station>/photo.jpg   the reference photo
```

About 20 MB per station. The newest 10 captures are kept. `POST …/reanalyse` runs the analysis
again from these files alone; so does `mapping.session.reanalyse_station(folder, name)` on a PC
(copy the folder off the HA box over Samba).

### Record-and-upload fallback

When the live camera doesn't work (some webviews), each station is done in two parts:
`POST …/stations/<name>/record` runs the pass on fixed timing (0.8 s per fast light, 2.2–2.5 s
per slow one) after a 5 s countdown in which the user starts recording in the camera app; then
`PUT …/stations/<name>/video` uploads the video. It is decoded with OpenCV (FFmpeg) to 640-wide
frames, the blink alone gives the clock, and the analysis runs as usual. There is no motion
stream, so a jolted step is flagged from bad frame alignment only, with no retake.

## Safety

- Nothing is flashed in read-only mode: creating a capture and starting a station are refused.
- Each station is a Safety session: snapshots before the first command, the governor's rate
  limits, restore at the end, and Stop all cancels it and restores.
- If the phone disconnects during a live station, the station stops and the lights go back.
- A light changed by someone during a pass is dropped from it and not restored (as for tests).
- A light in use by another session (a test, later a show) refuses the station start.

## Tests

- `tests/test_spatial.py`: geometry, views, planes, elements, merge/split/reorder/segment lines,
  photo replacement, the views API.
- `tests/test_mapping.py`: units, pass order and sync choice, refusals (read-only, unknown view,
  bad sync light), Stop all mid-pass and a phone disconnect mid-pass (lights restored), the live
  detector, and (`--slow`) the record-and-upload fallback with a rendered video.
- `tests/test_mapping_e2e.py`: the prototype's synthetic house (`proto/mapping/synth.py`) driving
  the real websocket and the fake HA in simulated time (`tests/mapping_sim.py`): the phone
  renders each frame, waits for its `ack`, then the clock moves one frame on. Each synthetic
  light stands in for a fake-HA entity and changes when the app's service call reaches the fake
  HA, after its own latency. The stations are the prototype's own (same poses and shake), so the
  scores compare like for like. The clean scenario always runs; the other three with `--slow`.

### Scores

End to end through the websocket, the fake HA, Safety and the governor, with adaptive steps,
against the prototype's README table (offline analysis, fixed 0.8 / 2.2 s steps, clock from the
blink). Frames lossless, as the prototype analysed them.

| scenario | | detection | false | IoU | latency err mean / max | 3D err mean (max) | metric | rotation | camera pos. | focal |
|---|---|---|---|---|---|---|---|---|---|---|
| clean | **add-on** | 100 % | 0 | 0.90 | 20 / 56 ms | 0.17 % (0.30 %) | 4.1 cm | 0.4° | 1.7 % | +2.1 % |
| | prototype | 100 % | 0 | 0.90 | 54 / 106 ms | 0.25 % (0.52 %) | 4.9 cm | 1.3° | 1.8 % | +2.1 % |
| heavy shake | **add-on** | 100 % | 0 | 0.78 | 14 / 39 ms | 0.18 % (0.33 %) | 3.3 cm | 0.7° | 1.2 % | +1.0 % |
| | prototype | 100 % | 0 | 0.80 | 47 / 87 ms | 0.52 % (0.76 %) | 10 cm | 2.5° | 3.7 % | −2.6 % |
| exposure drift | **add-on** | 100 % | 0 | 0.86 | 21 / 62 ms | 0.14 % (0.38 %) | 3.9 cm | 0.3° | 1.4 % | −1.2 % |
| | prototype | 100 % | 0 | 0.89 | 42 / 92 ms | 0.16 % (0.50 %) | 5.3 cm | 0.2° | 1.7 % | −1.6 % |
| jolt | **add-on** | 100 % | 0 | 0.90 | 18 / 52 ms | 0.14 % (0.28 %) | 2.4 cm | 0.5° | 0.6 % | +0.2 % |
| | prototype | 100 % | 0 | 0.90 | 49 / 99 ms | 0.14 % (0.26 %) | 3.8 cm | 0.5° | 0.7 % | 0.0 % |

- At least as good as the prototype in every column, **except**: region IoU under heavy shake
  (0.78 against 0.80) and with exposure drift (0.86 against 0.89), the jolt scenario's worst 3D
  point (0.28 % against 0.26 %) and focal length (+0.2 % against 0.0 %), and the drift
  scenario's station rotation (0.3° against 0.2°). The tests hold those to the measured values.
- **Latency** is two to three times better: the clock comes from the handshake, so latencies no
  longer carry the sync light's unknown latency (the prototype's −40 to −55 ms bias). The sync
  light's own latency is measured from the blink (147 ms against a true 140 ms).
- **Clock error** is 0 ms in simulation (the handshake is exact there; a real phone adds its
  camera pipeline delay, which the blink check would expose).
- The jolt scenario retakes exactly the jolted step (`long1` at the centre) and nothing else.
- **Station time** with adaptive steps: 17–20 s of pass per station for 16 lights (the prototype's
  fixed steps: 19.7 s at 0.6 / 1.6 s, 24.5 s at 0.8 / 2.2 s). Lights not visible from a station
  cost their full timeout.
- With the JPEG frames the page actually sends (quality 0.92), clean scores 100 %, 0 false,
  IoU 0.90, 20 / 57 ms, 0.18 % (0.34 %), 4.2 cm, 0.5°, 1.5 %, +1.9 %: compression costs very
  little.
- The run is deterministic (simulated time, fixed seeds), about 2.5 minutes per scenario on this
  PC; rendering is most of it.

### Not covered by the simulation

Everything in the prototype README's list (rolling shutter, lens distortion, real tone curves,
iOS night mode, reflections, moving cars), plus: real network delay and jitter on the websocket
(the simulation acknowledges every frame before the next), the camera pipeline delay between
capture and `captureTime`, browser JPEG encoders, a real HA's service-call latency spread, and
Govee cloud lights. The first real capture should record all of it (it does) and be re-run
offline.
