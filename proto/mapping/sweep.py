"""Design sweep for the README: frame rate, step timing, number of stations, noise, seeds.

    .venv\\Scripts\\python sweep.py [--quick]
"""
from __future__ import annotations

import argparse
import dataclasses
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import run_demo  # noqa: E402
import synth  # noqa: E402

BASE = synth.SCENARIOS["clean"]


def variants(quick: bool):
    v = [
        ("clean, seed 1 (baseline)", BASE),
        ("clean, seed 5", dataclasses.replace(BASE, seed=5)),
        ("clean, seed 6", dataclasses.replace(BASE, seed=6)),
        ("10 fps", dataclasses.replace(BASE, fps=10.0)),
        ("30 fps (1/30 s exposure)", dataclasses.replace(BASE, fps=30.0, exposure_time=1 / 30)),
        ("short steps: fast 0.6 s, slow 1.6 s", dataclasses.replace(BASE, fast_step=0.6, slow_step=1.6)),
        ("very short: fast 0.5 s, slow 1.2 s", dataclasses.replace(BASE, fast_step=0.5, slow_step=1.2)),
        ("2x sensor noise", dataclasses.replace(BASE, noise=2.0)),
        ("heavy shake + 2x noise", dataclasses.replace(BASE, shake="heavy", noise=2.0, seed=7)),
        ("2 stations: centre + right", dataclasses.replace(BASE, stations=("centre", "right"))),
        ("2 stations: left + right", dataclasses.replace(BASE, stations=("left", "right"))),
    ]
    return v[:3] if quick else v


def row(name, sc, s, sim):
    dur = [p.t_end - p.t0 for p in sim.plans]
    return {
        "variant": name,
        "detection": s["detection_rate"], "detection_any": s["detection_rate_any"],
        "false": s["false_detections"], "iou": s["iou_mean"],
        "lat_err_ms": 1000 * s["latency_err_mean"], "lat_err_max_ms": 1000 * s["latency_err_max"],
        "n3d": s["n_triangulated"], "pos_mean_pct": s.get("pos_err_pct_mean", float("nan")),
        "pos_max_pct": s.get("pos_err_pct_max", float("nan")),
        "metric_mean_m": s.get("pos_err_metric_mean", float("nan")),
        "rot_deg": s.get("pose_rot_err_max", float("nan")), "focal_pct": s["focal_err_pct"],
        "single": len(s["single_station"]), "station_s": sum(dur) / len(dur),
    }


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    a = ap.parse_args()
    rows = []
    for name, sc in variants(a.quick):
        sc = dataclasses.replace(sc, name="sweep")
        r = run_demo.run(sc)
        rows.append(row(name, sc, r["scores"], synth.Simulation(sc)))
        x = rows[-1]
        print(f"{name:40s} det {100 * x['detection']:5.1f}% (any {100 * x['detection_any']:5.1f}%) false {x['false']} "
              f"IoU {x['iou']:.2f} lat {x['lat_err_ms']:4.0f}/{x['lat_err_max_ms']:4.0f} ms  3D n={x['n3d']} "
              f"{x['pos_mean_pct']:.2f}/{x['pos_max_pct']:.2f}%  {x['metric_mean_m']:.3f} m  rot {x['rot_deg']:.2f} deg "
              f"f {x['focal_pct']:+.1f}%  single {x['single']}  station {x['station_s']:.1f} s", flush=True)
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "out")
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "sweep.json"), "w") as fh:
        json.dump(rows, fh, indent=1)
