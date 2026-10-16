"""Render a scenario, analyse it, score it and write debug PNGs.

    .venv\\Scripts\\python run_demo.py [scenario ...] [--out out] [--serial]
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import cv2
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import analyze  # noqa: E402
import score as score_mod  # noqa: E402
import synth  # noqa: E402


def _station(sc: synth.Scenario, idx: int):
    sim = synth.Simulation(sc)
    cap = sim.render_station(idx)
    res = analyze.analyze_station(cap["name"], cap["frames"], cap["t"], cap["motion"],
                                  sim.command_log(), sim.inventory())
    return res, sim.gt_station(idx)


def run(sc: synth.Scenario | str, out_dir: str | None = None, parallel: bool = True) -> dict:
    if isinstance(sc, str):
        sc = synth.SCENARIOS[sc]
    t0 = time.time()
    sim = synth.Simulation(sc)
    n = len(sim.plans)
    if parallel:
        with ProcessPoolExecutor(max_workers=n) as ex:
            outs = list(ex.map(_station, [sc] * n, range(n)))
    else:
        outs = [_station(sc, i) for i in range(n)]
    results = [o[0] for o in outs]
    gt = sim.ground_truth({r.name: g for r, (_, g) in zip(results, outs)})
    sol = analyze.solve_3d(results, known_distance=gt["known_distance"])
    s = score_mod.score(gt, results, sol)
    s["seconds"] = time.time() - t0
    if out_dir:
        write_debug(sc.name, gt, results, sol, s, out_dir)
    return {"scenario": sc, "results": results, "solution": sol, "scores": s, "gt": gt}


# ---------------------------------------------------------------------------------- debug PNGs
def _color(i):
    hsv = np.uint8([[[(i * 37) % 180, 220, 255]]])
    return tuple(int(c) for c in cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)[0, 0])


def write_debug(name, gt, results, sol, s, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    ids = list(gt["lights"])
    for r in results:
        img = cv2.cvtColor(r.ref_image, cv2.COLOR_RGB2BGR)
        img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_LINEAR)
        g = gt["stations"][r.name]
        for k in g["visible"]:
            cnts, _ = cv2.findContours(g["masks"][k].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(img, [c * 2 for c in cnts], -1, (255, 255, 255), 1)
        for k in r.detected():
            lr = r.lights[k]
            col = _color(ids.index(k))
            cnts, _ = cv2.findContours(lr.region.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(img, [c * 2 for c in cnts], -1, col, 2)
            u, v = lr.centroid
            cv2.drawMarker(img, (int(2 * u), int(2 * v)), col, cv2.MARKER_CROSS, 10, 2)
            lab = f"{k} {lr.confidence:.2f}" + (" R" if lr.retake else "")
            cv2.putText(img, lab, (int(2 * u) + 6, int(2 * v) - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 3)
            cv2.putText(img, lab, (int(2 * u) + 6, int(2 * v) - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.45, col, 1)
        st = s["stations"][r.name]
        cv2.putText(img, f"{name} / {r.name}: {st['detected']}/{st['visible']} detected, IoU {st['iou_mean']:.2f}"
                    f", missed {st['missed']}", (10, 24), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        cv2.imwrite(os.path.join(out_dir, f"{name}_{r.name}.png"), img)
    cv2.imwrite(os.path.join(out_dir, f"{name}_topdown.png"), topdown(gt, results, sol))
    with open(os.path.join(out_dir, f"{name}_scores.json"), "w") as fh:
        json.dump(s, fh, indent=1, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o))


def topdown(gt, results, sol, size=800):
    img = np.full((size, size, 3), 255, np.uint8)
    ids = [k for k, m in sol.method.items() if m == "triangulated"]
    est = np.array([sol.points[k] for k in ids]).reshape(-1, 3)
    tru = np.array([gt["lights"][k]["pos"] for k in ids]).reshape(-1, 3)
    s, Ra, T = score_mod.umeyama(est, tru) if len(ids) >= 3 else (1.0, np.eye(3), np.zeros(3))
    al = (s * (Ra @ est.T)).T + T
    xr, zr = (-14, 14), (-6, 22)
    to_px = lambda x, z: (int((x - xr[0]) / (xr[1] - xr[0]) * size), int((z - zr[0]) / (zr[1] - zr[0]) * size))
    # house footprint and tree
    cv2.rectangle(img, to_px(-7, -8), to_px(7, 0), (200, 200, 200), -1)
    cv2.rectangle(img, to_px(-2.75, 6.0), to_px(-1.95, 6.8), (120, 200, 120), -1)
    for k in gt["lights"]:
        x, _, z = gt["lights"][k]["pos"]
        cv2.circle(img, to_px(x, z), 6, (0, 0, 0), 1)
        cv2.putText(img, k, (to_px(x, z)[0] + 7, to_px(x, z)[1] + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.35, (80, 80, 80), 1)
    for k, p in zip(ids, al):
        cv2.drawMarker(img, to_px(p[0], p[2]), (0, 0, 255), cv2.MARKER_CROSS, 10, 2)
    for r in results:
        g = gt["stations"][r.name]
        c = g["C"]
        fwd = g["R"][2]
        cv2.circle(img, to_px(c[0], c[2]), 7, (0, 0, 0), 2)
        cv2.line(img, to_px(c[0], c[2]), to_px(c[0] + 2 * fwd[0], c[2] + 2 * fwd[2]), (0, 0, 0), 2)
        if r.name in sol.R:
            ce = s * Ra @ sol.centre(r.name) + T
            cv2.drawMarker(img, to_px(ce[0], ce[2]), (0, 0, 255), cv2.MARKER_TILTED_CROSS, 14, 2)
        cv2.putText(img, r.name, (to_px(c[0], c[2])[0] + 9, to_px(c[0], c[2])[1]), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1)
    for k, (o, d) in sol.rays.items():
        a = s * Ra @ o + T
        b = s * Ra @ (o + 25 * d) + T
        cv2.line(img, to_px(a[0], a[2]), to_px(b[0], b[2]), (255, 150, 0), 1)
    cv2.putText(img, "top-down (x right, z towards street): black = truth, red = estimate (similarity-aligned),",
                (10, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)
    cv2.putText(img, "blue = ray of a light seen from one station only", (10, 38),
                cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)
    return img


def print_scores(name, s):
    print(f"\n== {name} ({s['seconds']:.0f} s)")
    for st, v in s["stations"].items():
        print(f"  {st:6s} det {v['detected']}/{v['visible']} IoU {v['iou_mean']:.2f} missed {v['missed']} "
              f"false {v['false']} clock {1000 * v['clock_error']:+.0f} ms retake {v['retake_steps']} "
              f"align_fail {v['align_fail']} resid {v['align_resid']:.2f}px restore {v['restore_residual']}")
    print(f"  detection {100 * s['detection_rate']:.1f}% (any station {100 * s['detection_rate_any']:.1f}%), "
          f"IoU mean {s['iou_mean']:.2f} min {s['iou_min']:.2f}, latency err mean {1000 * s['latency_err_mean']:.0f} ms "
          f"max {1000 * s['latency_err_max']:.0f} ms, rise/fall {100 * s['rise_fall_acc']:.0f}%")
    print(f"  3D: {s['n_triangulated']} triangulated, err mean {s.get('pos_err_pct_mean', math.nan):.2f}% "
          f"max {s.get('pos_err_pct_max', math.nan):.2f}% of {s.get('scene_size', '')}scene size; "
          f"metric (known distance) {s.get('pos_err_metric_mean', math.nan):.3f} m; single-station {s['single_station']}")
    print(f"  poses: {s.get('pose')}, focal err {s['focal_err_pct']:+.2f}%, reproj rms {s['reproj_rms']:.2f}px")
    print(f"  elements: {s['elements']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("scenarios", nargs="*", default=["clean"])
    ap.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "out"))
    ap.add_argument("--serial", action="store_true")
    a = ap.parse_args()
    names = list(synth.SCENARIOS) if a.scenarios == ["all"] else a.scenarios
    rows = []
    for nm in names:
        r = run(nm, a.out, parallel=not a.serial)
        print_scores(nm, r["scores"])
        rows.append(score_mod.summary_row(nm, r["scores"]))
    print("\n| scenario | detection | IoU | latency err | 3D err mean (max) | pose rot err | focal err | false det |")
    print("|---|---|---|---|---|---|---|---|")
    print("\n".join(rows))
