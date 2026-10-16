"""Synthetic guided-capture scenarios (fixed seeds). Each full scenario renders three stations
(~370 frames each), analyses them and scores against the ground truth; about 50 s each."""
import numpy as np
import pytest

import analyze
import motion
import score as score_mod
import synth


def _scores(r):
    return r["scores"]


def _common(s, det=0.95, iou=0.8, lat_mean=0.1, pos_mean=1.0, pos_max=5.0, rot=3.0):
    """Shared thresholds. Positions in % of scene size (bounding-box diagonal, ~16 m)."""
    assert s["detection_rate"] >= det, s["stations"]
    assert s["iou_mean"] >= iou
    assert s["latency_err_mean"] <= lat_mean
    assert s["rise_fall_acc"] == 1.0
    assert s["n_triangulated"] >= 14
    assert s["pos_err_pct_mean"] < pos_mean
    assert s["pos_err_pct_max"] < pos_max
    assert s["pose_rot_err_max"] < rot
    assert s["pose_centre_err_pct_max"] < 5.0
    assert abs(s["focal_err_pct"]) < 8.0
    for st in s["stations"].values():
        assert abs(st["clock_error"]) < 0.1


# ------------------------------------------------------------------------------- scenarios
def test_clean(scenario):
    s = _scores(scenario("clean"))
    _common(s)
    assert s["detection_rate"] == 1.0
    assert s["false_detections"] == 0
    assert s["latency_err_max"] < 0.2
    assert s["pos_err_pct_max"] < 2.0
    # with the driveway width known, positions come out in metres
    assert s["pos_err_metric_mean"] < 0.2


def test_heavy_shake(scenario):
    s = _scores(scenario("heavy_shake"))
    _common(s, det=0.9, iou=0.7, lat_mean=0.15, pos_mean=2.0)
    assert s["false_detections"] <= 1


def test_exposure_drift(scenario):
    r = scenario("exposure_drift")
    s = _scores(r)
    _common(s)
    assert s["false_detections"] == 0
    # the software normaliser really had work to do: gains moved by more than 25 % in a station
    assert max(np.ptp(np.log(st.gains)) for st in r["results"]) > np.log(1.25)


def test_jolt_flagged_as_retake(scenario):
    r = scenario("jolt")
    s = _scores(r)
    _common(s)
    centre = next(x for x in r["results"] if x.name == "centre")
    jolted = [st for st in centre.steps if st["jolt"]]
    # exactly the jolted step is flagged (the decay afterwards is not a jolt)
    assert [st["light"] for st in jolted if st["action"] == "invert"] == ["long1"]
    lr = centre.lights["long1"]
    assert lr.retake and lr.source == "retake" and lr.detected
    m_gt = r["gt"]["stations"]["centre"]["masks"]["long1"]
    iou = np.logical_and(lr.region, m_gt).sum() / np.logical_or(lr.region, m_gt).sum()
    assert iou > 0.7
    assert lr.rise is True
    # the live controller scheduled the retake from the same motion stream
    assert r["gt"]["stations"]["centre"]["retakes"] == ["long1"]
    # no other station had a jolt
    for st in r["results"]:
        if st.name != "centre":
            assert not any(x["jolt"] for x in st.steps)


def test_occluded_light_found_from_side_stations(scenario):
    r = scenario("clean")
    s = _scores(r)
    gt = r["gt"]
    assert "post" not in gt["stations"]["centre"]["visible"]
    by = {x.name: x for x in r["results"]}
    assert "post" not in by["centre"].detected()
    assert "post" in by["left"].detected() and "post" in by["right"].detected()
    assert r["solution"].method["post"] == "triangulated"
    assert s["pos_err_by_light"]["post"] < 0.05 * gt["scene_size"]


def test_single_station_light_gets_a_ray(scenario):
    r = scenario("clean")
    s = _scores(r)
    # the side-wall sconce is only visible from the right station
    assert r["gt"]["stations"]["right"]["visible"].count("side") == 1
    assert r["solution"].method["side"] == "single-station"
    assert s["single_station_ray_err_m"]["side"] < 0.02 * r["gt"]["scene_size"]


def test_long_window_grouped_as_segments(scenario):
    r = scenario("clean")
    els = _scores(r)["elements"]
    seg = [e for e in els if e["mode"] == "segments"]
    assert len(seg) == 1
    assert seg[0]["segments"] == [["long1"], ["long2"], ["long3"]]     # ordered left to right
    # two lights behind one small window are one element
    assert any(e["mode"] == "single" and sorted(e["lights"]) == ["w_bed1", "w_bed2"] for e in els)
    # nothing else got merged
    others = [e for e in els if e["mode"] == "single" and len(e["lights"]) > 1]
    assert len(others) == 1


# ---------------------------------------------------------------------------------- units
def test_motion_jolt_detector():
    t = np.arange(0, 5, 1 / 60)
    rot = np.random.default_rng(0).normal(0, 3, (len(t), 3))
    acc = np.random.default_rng(1).normal(0, 0.1, (len(t), 3))
    m = {"t": t, "rot_rate": rot, "acc": acc}
    assert not motion.is_jolt(m, 0, 5)
    rot[(t > 2) & (t < 2.15), 0] += 120
    assert motion.is_jolt(m, 1.9, 2.5)
    assert not motion.is_jolt(m, 3, 5)


def test_umeyama_recovers_similarity():
    rng = np.random.default_rng(0)
    X = rng.normal(size=(20, 3))
    R = synth.small_rotation([0.3, -0.2, 0.5])
    Y = 2.5 * X @ R.T + np.array([1, 2, 3])
    s, Ra, T = score_mod.umeyama(X, Y)
    assert abs(s - 2.5) < 1e-9 and np.allclose(Ra, R) and np.allclose(T, [1, 2, 3])


def test_grouping_rules():
    h, w = 120, 200
    win = np.zeros((h, w), bool)
    a, b, c = win.copy(), win.copy(), win.copy()
    a[30:60, 20:62] = True          # three panes of one long window, touching
    b[30:60, 60:102] = True
    c[30:60, 100:140] = True
    blob1, blob2 = win.copy(), win.copy()
    yy, xx = np.mgrid[:h, :w]
    blob1[(yy - 90) ** 2 + (xx - 30) ** 2 < 36] = True   # two small lamps next to each other
    blob2[(yy - 90) ** 2 + (xx - 43) ** 2 < 36] = True
    assert analyze._side_by_side(a, b) and analyze._side_by_side(b, c)
    assert not analyze._side_by_side(a, c)
    assert not analyze._side_by_side(blob1, blob2)
    assert analyze._overlap(a, a) == 1.0


def test_shift_test_separates_parallax_from_light():
    rng = np.random.default_rng(0)
    B = np.full((80, 80), 0.05, np.float32) + rng.normal(0, 0.002, (80, 80)).astype(np.float32)
    B[:, 40:] += 0.3                                     # a bright wall edge
    shifted = np.roll(B, 2, axis=1)                      # parallax moves the edge 2 px
    win = np.zeros((40, 40), bool)
    win[10:30, 10:30] = True
    box = (20, 20, 60, 60)
    assert analyze._shift_explained(shifted, B, win, box) > 0.8
    lit = B.copy()
    lit[30:50, 25:35] += 0.2                             # a light turning on, flat interior
    assert analyze._shift_explained(lit, B, win, box) < 0.3


@pytest.mark.parametrize("hfov", [60.0, 70.0])
def test_projection_roundtrip(hfov):
    K = synth.intrinsics(hfov)
    cam = synth.Camera(K, synth.look_at(np.array([3.0, 1.5, 14.0]), synth.ANCHOR), np.array([3.0, 1.5, 14.0]))
    uv, depth = cam.project(synth.ANCHOR)
    assert np.allclose(uv, [(synth.W - 1) / 2, (synth.H - 1) / 2], atol=1e-6) and depth > 0
