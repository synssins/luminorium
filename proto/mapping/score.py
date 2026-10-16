"""Scores an analysis against the synthetic ground truth."""
from __future__ import annotations

import math

import numpy as np

from analyze import Params, Solution, StationResult, merge_groups


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


def score(gt: dict, results: list[StationResult], sol: Solution, p: Params | None = None) -> dict:
    p = p or Params()
    out: dict = {"stations": {}}
    vis_any, det_any = set(), set()
    ious, lat_err, rise_ok, n_tp, n_vis, n_fp = [], [], [], 0, 0, 0
    for r in results:
        g = gt["stations"][r.name]
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
        vis_any |= vis
        det_any |= tp
        out["stations"][r.name] = {
            "visible": len(vis), "detected": len(tp), "missed": sorted(vis - det), "false": sorted(fp),
            "detection_rate": len(tp) / max(1, len(vis)), "iou_mean": float(np.mean(st_iou)) if st_iou else 0.0,
            "clock_error": r.clock_offset - g["video_offset"],
            "retake_steps": sorted({s["light"] for s in r.steps if s.get("jolt") and s["action"] == "invert"}),
            "align_fail": r.align_fail, "align_resid": r.align_resid, "restore_residual": r.restore_residual,
        }
    out["detection_rate"] = n_tp / max(1, n_vis)
    out["detection_rate_any"] = len(det_any) / max(1, len(vis_any))
    out["false_detections"] = n_fp
    out["iou_mean"] = float(np.mean(ious)) if ious else 0.0
    out["iou_min"] = float(np.min(ious)) if ious else 0.0
    out["latency_err_mean"] = float(np.mean(lat_err)) if lat_err else float("nan")
    out["latency_err_max"] = float(np.max(lat_err)) if lat_err else float("nan")
    out["rise_fall_acc"] = float(np.mean(rise_ok)) if rise_ok else 0.0

    # ---- 3D
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
        out["pos_err_mean"] = float(err.mean())
        out["pos_err_max"] = float(err.max())
        out["pos_err_pct_mean"] = 100 * float(err.mean()) / size
        out["pos_err_pct_max"] = 100 * float(err.max()) / size
        out["pos_err_by_light"] = {k: float(e) for k, e in zip(ids, err)}
        if sol.scale_known:
            _, Rm, Tm = umeyama(est, tru, with_scale=False)
            alm = (Rm @ est.T).T + Tm
            out["pos_err_metric_mean"] = float(np.linalg.norm(alm - tru, axis=1).mean())
        # poses
        ref = results[0].name
        g0 = gt["stations"][ref]
        pose = {}
        for r in results:
            sname = r.name
            if sname not in sol.R:
                continue
            g = gt["stations"][sname]
            C_est = s * Ra @ sol.centre(sname) + T
            pos_err = float(np.linalg.norm(C_est - g["C"]))
            R_rel_gt = g["R"] @ g0["R"].T
            rot_err = rot_angle(sol.R[sname] @ R_rel_gt.T)
            pose[sname] = {"centre_err_m": pos_err, "centre_err_pct": 100 * pos_err / size, "rot_err_deg": rot_err}
        out["pose"] = pose
        # lights seen from one station: how far does the ray pass from the true position?
        ray_err = {}
        for k, (o, d) in sol.rays.items():
            oa, da = s * Ra @ o + T, Ra @ d
            v = gt["lights"][k]["pos"] - oa
            ray_err[k] = float(np.linalg.norm(v - (v @ da) * da))
        out["single_station_ray_err_m"] = ray_err
        out["pose_rot_err_max"] = max(v["rot_err_deg"] for v in pose.values())
        out["pose_centre_err_pct_max"] = max(v["centre_err_pct"] for v in pose.values())
    out["focal_err_pct"] = 100 * (sol.f - gt["f"]) / gt["f"]
    out["reproj_rms"] = sol.reproj_rms

    # ---- grouping
    els = merge_groups(results)
    out["elements"] = els
    out["bed_single"] = any(e["mode"] == "single" and {"w_bed1", "w_bed2"} <= set(e["lights"]) for e in els)
    out["long_segments"] = any(
        e["mode"] == "segments" and [sorted(x) for x in e["segments"]] == [["long1"], ["long2"], ["long3"]]
        for e in els)
    return out


def summary_row(name: str, s: dict) -> str:
    return (f"| {name} | {100 * s['detection_rate']:.0f}% | {s['iou_mean']:.2f} | "
            f"{1000 * s['latency_err_mean']:.0f} ms | {s.get('pos_err_pct_mean', float('nan')):.2f}% "
            f"({s.get('pos_err_pct_max', float('nan')):.2f}%) | {s.get('pose_rot_err_max', float('nan')):.2f} deg | "
            f"{s['focal_err_pct']:+.1f}% | {s['false_detections']} |")
