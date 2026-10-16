"""Scores a capture against the simulated house's ground truth (as proto/mapping/score.py)."""

from __future__ import annotations

import math

import numpy as np

from luminorium.mapping.analysis import Params, Solution, StationResult, merge_groups


def umeyama(src: np.ndarray, dst: np.ndarray, with_scale: bool = True):
    """dst ~ s R src + T (least squares)."""
    mu_s, mu_d = src.mean(0), dst.mean(0)
    xs, xd = src - mu_s, dst - mu_d
    cov = xd.T @ xs / len(src)
    U, S, Vt = np.linalg.svd(cov)
    D = np.eye(3)
    if np.linalg.det(U) * np.linalg.det(Vt) < 0:
        D[2, 2] = -1
    R = U @ D @ Vt
    s = float(np.trace(np.diag(S) @ D) / xs.var(0).sum()) if with_scale else 1.0
    T = mu_d - s * R @ mu_s
    return s, R, T


def rot_angle(R: np.ndarray) -> float:
    return math.degrees(math.acos(np.clip((np.trace(R) - 1) / 2, -1, 1)))


def score(gt: dict, stations: dict, results: list[StationResult], sol: Solution) -> dict:
    p = Params()
    out: dict = {"stations": {}}
    ious, lat_err, rise_ok, n_tp, n_vis, n_fp = [], [], [], 0, 0, 0
    for r in results:
        g = stations[r.name]
        vis = set(g["visible"])
        det = set(r.detected(p.min_conf))
        tp = vis & det
        fp = det - vis
        st_iou = []
        for k in tp:
            m_gt, m = g["masks"][k], r.lights[k].region
            iou = np.logical_and(m, m_gt).sum() / max(1, np.logical_or(m, m_gt).sum())
            st_iou.append(iou)
            if iou < 0.05:
                fp.add(k)
            lat = r.lights[k].latency
            if lat is not None:
                lat_err.append(abs(lat - gt["lights"][k]["latency"]))
            rise_ok.append(r.lights[k].rise == gt["lights"][k]["rise"])
        ious += st_iou
        n_tp += len(tp)
        n_vis += len(vis)
        n_fp += len(fp)
        out["stations"][r.name] = {
            "visible": len(vis),
            "detected": len(tp),
            "missed": sorted(vis - det),
            "false": sorted(fp),
            "iou_mean": float(np.mean(st_iou)) if st_iou else 0.0,
            "clock_error": r.clock_offset - g["video_offset"],
            "clock_source": r.clock_source,
        }
    out["detection_rate"] = n_tp / max(1, n_vis)
    out["false_detections"] = n_fp
    out["iou_mean"] = float(np.mean(ious)) if ious else 0.0
    out["latency_err_mean"] = float(np.mean(lat_err)) if lat_err else float("nan")
    out["latency_err_max"] = float(np.max(lat_err)) if lat_err else float("nan")
    out["rise_fall_acc"] = float(np.mean(rise_ok)) if rise_ok else 0.0

    size = gt["scene_size"]
    ids = [k for k, m in sol.method.items() if m == "triangulated"]
    out["n_triangulated"] = len(ids)
    out["single_station"] = sorted(k for k, m in sol.method.items() if m == "single-station")
    if len(ids) >= 3:
        est = np.array([sol.points[k] for k in ids])
        tru = np.array([gt["lights"][k]["pos"] for k in ids])
        s, Ra, T = umeyama(est, tru)
        al = (s * (Ra @ est.T)).T + T
        err = np.linalg.norm(al - tru, axis=1)
        out["pos_err_pct_mean"] = 100 * float(err.mean()) / size
        out["pos_err_pct_max"] = 100 * float(err.max()) / size
        out["pos_err_by_light"] = {k: float(e) for k, e in zip(ids, err, strict=True)}
        if sol.scale_known:
            _, Rm, Tm = umeyama(est, tru, with_scale=False)
            alm = (Rm @ est.T).T + Tm
            out["pos_err_metric_mean"] = float(np.linalg.norm(alm - tru, axis=1).mean())
        ref = results[0].name
        g0 = stations[ref]
        pose = {}
        for r in results:
            if r.name not in sol.R:
                continue
            g = stations[r.name]
            C_est = s * Ra @ sol.centre(r.name) + T
            pos_err = float(np.linalg.norm(C_est - g["C"]))
            R_rel_gt = g["R"] @ g0["R"].T
            pose[r.name] = {
                "centre_err_pct": 100 * pos_err / size,
                "rot_err_deg": rot_angle(sol.R[r.name] @ R_rel_gt.T),
            }
        out["pose_rot_err_max"] = max(v["rot_err_deg"] for v in pose.values())
        out["pose_centre_err_pct_max"] = max(v["centre_err_pct"] for v in pose.values())
        ray_err = {}
        for k, (o, d) in sol.rays.items():
            oa, da = s * Ra @ o + T, Ra @ d
            v = gt["lights"][k]["pos"] - oa
            ray_err[k] = float(np.linalg.norm(v - (v @ da) * da))
        out["single_station_ray_err_m"] = ray_err
    out["focal_err_pct"] = 100 * (sol.f - gt["f"]) / gt["f"]
    out["elements"] = merge_groups(results)
    return out


def row(name: str, s: dict) -> str:
    return (
        f"| {name} | {100 * s['detection_rate']:.0f} % | {s['false_detections']} | "
        f"{s['iou_mean']:.2f} | {1000 * s['latency_err_mean']:.0f} / "
        f"{1000 * s['latency_err_max']:.0f} ms | {s['pos_err_pct_mean']:.2f} % "
        f"({s['pos_err_pct_max']:.2f} %) | "
        f"{100 * s.get('pos_err_metric_mean', float('nan')):.1f} cm"
        f" | {s['pose_rot_err_max']:.1f}° | {s['pose_centre_err_pct_max']:.1f} % | "
        f"{s['focal_err_pct']:+.1f} % |"
    )
