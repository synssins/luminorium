# Mapping prototype: synthetic guided capture

An offline prototype of the phase 5 phone mapping (DESIGN.md §8, SPIKES.md "Mapping prototype").
It renders a small night-time house with known lights and runs the guided capture from three
stations: centre, about 45° left and about 45° right of the front door (the anchor). It adds hand
shake, auto-exposure, noise and a jolt, then analyses the frames the way the add-on would and
scores the result against exact ground truth. Nothing here touches Home Assistant or real lights.

## Running it

```
cd proto\mapping
py -3.13 -m venv .venv
.venv\Scripts\python -m pip install numpy opencv-python-headless scipy pytest
.venv\Scripts\python run_demo.py all          # four scenarios, scores and debug PNGs in out\
.venv\Scripts\python sweep.py                 # design sweep (frame rate, step timing, stations)
```

Tests (from the repo root, about 3 minutes; each full scenario renders and analyses ~1,100 frames):

```
proto\mapping\.venv\Scripts\python -m pytest proto/mapping
```

| File | What it does |
|---|---|
| `synth.py` | Scene, renderer, capture plan (command log, light transitions, shake, DeviceMotion samples, auto-exposure, sensor) and ground truth |
| `analyze.py` | Per station: alignment, exposure normalisation, clock sync, shake-aware differencing, latency, retake flags, grouping. Across stations: essential matrix, PnP, triangulation, bundle adjustment with focal length |
| `motion.py` | Jolt detection on the motion stream (used by the simulated live controller and by the analysis) |
| `score.py` | Detection, IoU, latency, rise/fall, 3D error after similarity alignment, metric error with a known distance, pose and focal error, grouping |
| `run_demo.py` | Runs a scenario end to end (stations in parallel processes) and writes `out/<scenario>_<station>.png`, `out/<scenario>_topdown.png`, `out/<scenario>_scores.json` |
| `sweep.py` | Variants for the recommendations below; writes `out/sweep.json` |
| `tests/` | pytest: the six scenarios plus unit tests |

### The synthetic scene

- A 14 m × 6 m two-storey house front (gable, siding, trim, door) with side walls, a lawn, a paved
  path, a driveway, a sidewalk and road, a static streetlight with a light pool, and a tree box.
- 16 lights: one den window; a small bedroom window with **two** lights (should become one
  `single` element); a **long window with three lights** behind three panes (should become
  `segments`); a kitchen window; a porch light with a wall wash (also the sync light); four path
  lights with ground pools; a blue driveway pair 3.0 m apart (the known distance); a garden post
  light **hidden by the tree from the centre**; and a side-wall sconce visible **only from the
  right**. Five lights start on (they fall when inverted), eleven start off.
- Drivers: 12 fast (latency 0.12–0.45 s, ramp 0.04–0.12 s) and 4 slow Z-Wave (0.8–1.3 s, ramp
  0.2–0.35 s).
- Camera: 640×360 at 15 fps, 1/20 s exposure, true HFOV 66° (the analysis starts from 70°), aimed
  at the anchor. Station angle ±4°, distance 15 ± 1 m and aim are randomised per seed.
- Shake: tremor 3–10 Hz plus slow drift in rotation and translation (normal: 0.06° / 0.4° / 0.1 mm
  / 2 cm; heavy: 0.2° / 1.2° / 0.3 mm / 5 cm), motion blur from the angular rate. A jolt is 7.5°
  plus 3.5 cm in 0.12 s, decaying back over about 2 s, with matching 60 Hz DeviceMotion samples.
- Auto-exposure follows the scene mean with a 0.6 s time constant, so every light change also
  moves the gain. "Exposure drift" adds two slow oscillations and four ±18–25 % steps per station.
  Sensor: shot and read noise, gamma 2.2, 8-bit, clipping.
- The capture: 1.5 s still lead-in (reference photo), sync blink (porch toggles 4 times, 0.4 s
  apart), the fast pass (fast lights 0.8 s per step, slow 2.2 s), a retake step for each step the
  live controller flagged from the motion stream, then restore all. That makes about 24.5 s per
  station. The video clock has an unknown offset from the command log.

### What the analysis does

1. **Reference:** the average of the 8 lead-in frames, aligned to the first.
2. **Alignment:** track features from the reference into every frame (pyramidal LK, initialised
   from the previous frame), reject outliers with a RANSAC homography, then fit a **rotation +
   scale model `H = S·K·R·K⁻¹`** to the inliers.
3. **Exposure:** a per-frame gain from about 30,000 stable mid-tone, low-gradient reference
   pixels (ratio of sums after trimming). Pixels at ≥ 240 (plus a 1 px margin) count as clipped.
4. **Clock sync:** a coarse search for the 4-toggle pattern in the frame-to-frame change energy,
   within 4 s of the reference. The best candidates are verified: the same region must flip with
   alternating sign, and must be still just before the first toggle. Then the offset is the median
   50 % crossing time minus an assumed 0.10 s sync-light latency.
5. **Each step** (invert or retake-revert): the median of the frames in the 0.25 s before the
   command vs. the median in the 0.25 s before the next command. Then, in order:
   - brightness-binned robust noise → z-score
   - per sign: threshold |z| > 4, open 3×3, close 5×5, components with area ≥ 10 px, thickness ≥ 1.5 px
   - a gradient (optical-flow) shake fit with R² < 0.5, and opposite-sign ring energy < 0.8
   - a **shift test:** if shifting "before" by up to ±4 px removes ≥ 60 % of the difference, it is
     parallax or shake, not a light
   - region = |D| ≥ 20 % of peak, region SNR ≥ 8
   - centroid = |D|-weighted over the core (≥ 50 % of peak), so glows and ground pools don't pull it
   - latency = 50 % crossing of the region's time series, interpolated between frames; it must fall
     inside [0.03 s, step end]
   - a change that continues the previous step's region in the first 0.1 s is labelled "leftover of
     the previous step", not this light.
6. **Retake:** a step whose motion window has a smoothed rotation rate > 45 °/s or acceleration
   > 4 m/s², or whose frames align badly (failure or residual > 2.5 px), is flagged. If a retake
   step exists, its result is used.
7. **Grouping:** overlap ≥ 60 % of the smaller region → one `single` element. `segments` needs
   regions of similar size (≤ 2×), aligned, sharing a long boundary, and a union that fills a
   rectangle (≥ 75 %). Across stations, `single` needs overlap in every station where both lights
   were seen.
8. **3D:** the centre camera is the frame. Essential matrix (RANSAC, 3 px) for the second
   station, PnP RANSAC for the third, multi-view DLT, then a bundle adjustment (soft-L1) over the
   shared focal length, the poses and the points, with a weak focal prior and a scale gauge.
   Observations over 4 px are dropped and BA is re-run; a two-view point whose rays disagree is not
   placed. A light seen from one station gets a ray. With the driveway's 3.0 m, everything is in
   metres.

## Results

`run_demo.py all`, fixed seeds. Scene size = bounding-box diagonal of the 16 lights, 15.7 m.
Detection counts every (station, light) pair the ground truth says is visible (at least 6 px of
change): 43–46 pairs per scenario. Latency is command → 50 % of the change; the truth includes
each light's ramp. 3D error is after a similarity alignment; "metric" uses the driveway's 3.0 m
instead.

| scenario | detection | false det. | region IoU (mean) | latency err mean / max | 3D err mean (max), % of scene | metric 3D err | station rotation err | camera position err | focal err |
|---|---|---|---|---|---|---|---|---|---|
| clean | 100 % (43/43) | 0 | 0.90 | 54 / 106 ms | 0.25 % (0.52 %) | 4.9 cm | 1.3° | 1.8 % | +2.1 % |
| heavy shake | 100 % (44/44) | 0 | 0.80 | 47 / 87 ms | 0.52 % (0.76 %) | 10 cm | 2.5° | 3.7 % | −2.6 % |
| exposure drift | 100 % (44/44) | 0 | 0.89 | 42 / 92 ms | 0.16 % (0.50 %) | 5.3 cm | 0.2° | 1.7 % | −1.6 % |
| jolt (centre, during `long1`) | 100 % (43/43) | 0 | 0.90 | 49 / 99 ms | 0.14 % (0.26 %) | 3.8 cm | 0.5° | 0.7 % | 0.0 % |

Also from these runs:
- **Retake:** in the jolt scenario, exactly the `long1` step at the centre station is flagged.
  Its single-revert retake gives the region (IoU 0.95) and the latency. Neither the decay
  after the jolt nor any step at the other stations is flagged.
- **Occluded light:** the garden `post` light is hidden by the tree from the centre. It is not
  reported there, is found from both side stations and is triangulated to within 1.2–1.8 cm
  (11 cm under heavy shake).
- **Single-station light:** the side-wall sconce is only visible from the right station. It gets a
  ray that passes 3–6 cm from its true position. It is not placed in 3D.
- **Grouping:** the long window comes out as one `segments` element, `long1 | long2 | long3` in
  order. The two lights behind the small bedroom window come out as one `single` element. Nothing
  else is merged, in every scenario.
- **Clock sync** on the blink: within 39–62 ms of the true offset. This is almost entirely the
  sync light's assumed latency (0.10 s) against its true one (0.14 s), and it shows up again as a
  systematic −40 to −55 ms in every measured latency.
- **Time:** about 50 s per scenario on this PC (3 stations in parallel; rendering is about 60 % of
  that). The analysis alone is about 10 s per station of 370 frames, in Python.

The pytest thresholds: clean detection 100 %, no false detections and 3D max < 2 %. In all
scenarios: detection ≥ 95 % (heavy shake ≥ 90 %), 3D mean < 1 % (heavy 2 %) and max < 5 %,
rotation < 3°, camera position < 5 %, |focal error| < 8 %, latency mean < 0.1 s (heavy 0.15 s)
and clock error < 0.1 s.

### Design sweep (`sweep.py`, clean scene unless stated)

| variant | detection | false | IoU | latency err mean / max | 3D err mean / max | metric err | rotation err | focal err | lights only on a ray | time per station |
|---|---|---|---|---|---|---|---|---|---|---|
| baseline (seed 1) | 100 % | 0 | 0.90 | 54 / 106 ms | 0.25 / 0.52 % | 4.9 cm | 1.3° | +2.1 % | 1 | 24.5 s |
| seed 5 | 100 % | 0 | 0.89 | 51 / 98 ms | 0.12 / 0.33 % | 3.7 cm | 0.3° | −1.7 % | 1 | 24.5 s |
| seed 6 | 100 % | 0 | 0.89 | 45 / 87 ms | 0.17 / 0.30 % | 3.3 cm | 0.5° | +0.6 % | 1 | 24.5 s |
| 10 fps | 100 % | 0 | 0.90 | 63 / 112 ms | 0.25 / 0.50 % | 4.7 cm | 1.2° | +2.2 % | 1 | 24.5 s |
| 30 fps (1/30 s) | 100 % | 0 | 0.91 | 44 / 95 ms | 0.23 / 0.46 % | 3.8 cm | 1.0° | +1.4 % | 1 | 24.5 s |
| steps 0.6 s fast / 1.6 s slow | 100 % | 0 | 0.90 | 50 / 101 ms | 0.33 / 0.58 % | 8.0 cm | 1.5° | +1.1 % | 1 | **19.7 s** |
| steps 0.5 s / 1.2 s | **91 %** | **8** | 0.74 | 179 / 1377 ms | 5.2 / **30 %** | 82 cm | 1.1° | +0.9 % | 1 | 16.9 s |
| 2× sensor noise | 100 % | 0 | 0.90 | 54 / 107 ms | 0.24 / 0.49 % | 4.4 cm | 1.2° | +1.9 % | 1 | 24.5 s |
| heavy shake + 2× noise | 96 % | 0 | 0.78 | 39 / 86 ms | 0.40 / 0.68 % | 9.0 cm | 2.1° | −4.3 % | 1 | 24.5 s |
| 2 stations: centre + right | 100 % | 0 | 0.92 | 53 / 100 ms | **1.7 / 4.3 %** | 51 cm | 5.1° | −6.9 % | 2 | 24.5 s |
| 2 stations: left + right | 100 % | 0 | 0.91 | 53 / 100 ms | 0.66 / 1.1 % | n/a (driveway hidden) | 4.6° | −6.2 % | **3** | 24.5 s |

The 0.5 s / 1.2 s case fails because the Z-Wave lights (latency up to 1.3 s plus ramp) and the
slowest fast lights (0.45 s plus 0.12 s ramp) don't settle before the next command.

### What worked

- **The lights are the correspondences.** The flash pass labels every light, so the essential
  matrix, PnP and the bundle adjustment get perfect data association for free. 3D error is
  0.1–0.7 % of the scene (2–10 cm at 15 m) with about 15 points, even with the starting focal
  length 7 % wrong.
- **Cumulative inversion (no restore between lights)** keeps each step's difference to exactly one
  light. With the leftover check, a slow light that overruns its step is labelled, not
  misattributed.
- **Software exposure normalisation** handles auto-exposure that reacts to every light, slow
  drift, and sudden ±20–25 % steps. Nothing like an exposure lock is needed (iOS can't lock
  anyway). Two details mattered: compute the gain on flat mid-tones, and treat near-saturated
  pixels (≥ 240) as clipped. Otherwise a lamp head "changes" when the exposure steps.
- **A rotation + scale alignment model** (`S·K·R·K⁻¹`, 4 parameters) instead of a free
  homography. The free homography bent at the image edges, where there are few features (sky,
  dark lawn), and made false "lights" along the house corner.
- **The shift test** is what really separates shake from light. Edges and parallax can be shifted
  away and a light change can't. It removed every false detection from heavy shake and jolts.
  Morphology, minimum area and thickness alone (DESIGN.md's list) were not enough. Parallax
  from 2–5 cm of hand translation moves near objects (the tree, a lamp at 4 m) by 1–4 px relative
  to the house. No global transform can fix that.
- **The latency window** is a cheap, strong filter: the change must start at least 30 ms after
  the command and before the next one.
- **Motion-sensor retakes:** a smoothed rate threshold (45 °/s or 4 m/s²) separates a jolt
  (80+ °/s) from heavy tremor (30 °/s or less). In a cumulative pass, a retake is a **single
  revert of that light**: one more single-light change, with the opposite sign. No need to
  revert and redo.
- **Region-based clock sync on the blink**, verified by "the same region flips with alternating
  sign", is accurate to within the sync light's own latency.
- **Core-weighted centroids** (≥ 50 % of peak) keep glows and ground light pools from pulling lamp
  positions.
- **Grouping:** overlap gives `single`; adjacent, with a long shared boundary and a
  rectangle-like union, gives `segments`. That gets the long window and the shared small window
  right, without merging two path lights that touch in the image.

### What didn't (and what the prototype doesn't model)

Problems found and fixed along the way, which phase 5 should keep in mind:
- The first clock-sync search locked onto the wrong blink twice. Once it found a pattern far
  later in the video. Once it was exactly one toggle late, because the sync light (porch) was
  also the first light in the pass, so "toggles 2–4 + the porch's own pass step" also looks like
  four alternating flips. Fixed by limiting the search to 4 s after the reference and requiring
  the sync region to be still before the first toggle.
- Under heavy shake the coarse sync can be about 0.15 s off, which puts the refine windows across
  a transition. The refine now retries with shifted windows.
- Step timing is a hard limit (see the sweep).

Still weak:
- **Focal length vs. distance ("dolly zoom") ambiguity.** The scene's depth range is small
  compared with the 15 m stand-off, so the bundle adjustment pins the focal length only to ±2–5 %
  (±7 % with two stations). Station rotations come out 0.2–2.5° off and camera positions 1–4 % of
  the scene, even though the lights themselves are accurate.
- **The restore check** (end of station vs. the reference) sometimes reports 1 small residual
  region: parallax at the tree edge after 25 s of drift. It is a soft check only.
- **A light seen from one station** only gets a ray. The plane fallback from DESIGN.md is not
  built here.
- Latencies carry the sync light's unknown latency as a bias (−40 to −55 ms here).
- Some thresholds are tuned on this one scene: region SNR ≥ 8, shift test 60 %, 45 °/s. True
  lights here score SNR ≥ 10, so a very dim or distant light on a real house could fall below
  the threshold.

Not modelled (all could matter on a real phone):
- rolling shutter
- lens distortion
- real tone curves (we invert an exact gamma 2.2)
- video or JPEG compression of streamed frames
- iOS night mode or multi-frame processing
- white-balance shifts
- reflections in windows
- light spilling onto other surfaces beyond simple pools and washes
- moving cars, people and wind-blown trees
- colour or effect lights
- dimmers with long fades
- lights that fail to respond
- the walk between stations (each station is its own clip with its own clock offset)

## Recommendations for phase 5

1. **Frame rate: 15 fps is enough; 10 fps works.** 10, 15 and 30 fps gave the same detection and
   3D. Latency error went 63 → 54 → 44 ms, because 50 % crossings are interpolated between frames.
   Keep 640×360 at 15 fps over the websocket; drop to 10 fps if bandwidth is tight. 30 fps buys
   nothing.
2. **Step timing:** a step must last *latency + ramp + exposure + a ~0.25 s settled window*
   before the next command, because the analysis compares "settled before" with "settled after".
   Fixed 0.6 s / 1.6 s steps worked here (19.7 s per station for 16 lights); 0.5 s / 1.2 s broke.
   In the add-on, **advance adaptively**: send the next command once the live detector has seen
   the change settle for about 3 frames, with a per-driver timeout of about 2× the profile
   latency (fast 0.8 s, Z-Wave 2.5 s on the first mapping). Keep the leftover check as a guard.
3. **Stations: keep three; two is the minimum, and the third is not just for occlusion.**
   - Centre + right: 3D error 1.7 % mean, 4.3 % max; focal −7 %; metric error 51 cm.
   - Left + right (~90° apart): 0.7 % mean, but three lights only get a ray (the tree hides the
     driveway pair from the left).
   - All three: 0.25 % mean, and only the side-wall sconce is unplaced.

   The centre view also gives the natural `screen` coordinates. For a bigger property, add
   stations for occlusion and coverage.
4. **Clock:** keep the sync blink as a check, but don't rely on it alone.
   - Timestamp frames on the phone and estimate the phone↔add-on clock offset over the websocket
     (NTP-style ping). With the blink alone, every latency inherits the sync light's own latency.
   - Start the blink within a few seconds of the reference photo.
   - **Don't use the sync light as the first pass step** (or add a pause after the blink).
   - Measure the sync light's latency once (for example from HA state events) and store it.
5. **Retakes: one revert step per flagged light**, appended before the restore. Also flag steps
   where frame alignment fails or has a high residual, not only motion-sensor jolts. Thresholds:
   smoothed (50 ms) rotation rate > 45 °/s or acceleration > 4 m/s².
6. **Proposed changes to DESIGN.md §8** (not edited here):
   - *Exposure:* replace "locked after the reference photo (where the browser allows)" with
     "normalised in software on every frame (flat mid-tone reference pixels; near-saturated
     pixels treated as clipped)". A lock is a bonus, not a requirement.
   - *Frame alignment:* specify a rotation + scale model fitted to RANSAC-filtered features, not a
     free transform.
   - *Shake-aware differences:* add the **shift test** and a **minimum latency**. Note that
     parallax from hand translation, not rotation, is the main residual.
   - *Step timing:* change "latency plus a few frames" to "latency + ramp + exposure + a settled
     window (~0.25 s)", with adaptive advance.
   - *Retake:* change "repeats it automatically at the end" to "reverts that light once at the end
     (one more single-light change)".
   - *Depth and 3D:* set expectations:
     - light positions to about 1 % of the scene
     - focal length from the bundle adjustment only to about ±5 %, and station poses to 1–3°
     - seed the focal length from the phone model or EXIF where possible (this tightens poses,
       not light positions)
     - one known distance gives metres to about 5 cm (10 cm in heavy shake)
   - *Results per light:* the image position is the bright core of the region (≥ 50 % of the
     peak change). Plain centroids are pulled by glows and ground pools.
   - *Grouping:* `segments` needs a long shared boundary and a rectangle-like union. Adjacency alone
     merges neighbouring lamps.
7. **The first real capture should check what synthetic data can't:**
   - iOS auto-exposure and tone mapping
   - streaming compression
   - rolling shutter
   - reflections
   - how steady a real hand stays over 25 s per station

   Record the raw frames, motion stream and command log, so this analysis can be re-run on them
   offline.
8. **Performance:** the analysis takes about 10 s per station in plain Python/NumPy on a desktop.
   Budget roughly 30 s per station on the HA box, after the capture. Live detection for adaptive
   stepping only needs the latest difference near the expected light, which is cheap.
