"""From analysis results to the spatial model: per-light findings, suggested elements, stations.

The first station (the centre) is the view: its picture coordinates are the view's, and its camera
is the view's 3D frame (x right, y down, z forward from the centre station; metres when a known
distance was given). A light the centre didn't see but two other stations did is projected into
the centre picture from its 3D point.
"""

from __future__ import annotations

import numpy as np

from ..spatial import geometry
from ..spatial.model import Element, Part, Station, World, new_id
from .analysis import Params, Solution, StationResult, merge_groups


def _norm(uv, size) -> list[float]:
    w, h = size
    return [round((float(uv[0]) + 0.5) / w, 5), round((float(uv[1]) + 0.5) / h, 5)]


def station_summary(res: StationResult, p: Params) -> dict:
    lights = {}
    for uid, lr in res.lights.items():
        entry: dict = {
            "detected": bool(lr.detected and lr.confidence >= p.min_conf),
            "confidence": round(lr.confidence, 3),
            "note": lr.note,
            "retake": lr.retake,
            "source": lr.source,
        }
        if lr.detected:
            entry.update(
                centroid=_norm(lr.centroid, res.size),
                region=geometry.mask_polygon(lr.region),
                rise=lr.rise,
                snr=round(lr.snr, 1),
                latency_ms=round(1000 * lr.latency) if lr.latency is not None else None,
            )
        lights[uid] = entry
    return {
        "name": res.name,
        "size": list(res.size),
        "clock_offset": res.clock_offset,
        "clock_source": res.clock_source,
        "sync_latency_ms": round(1000 * res.sync_latency) if res.sync_latency else None,
        "sync_debug": {
            k: v for k, v in res.sync_debug.items() if isinstance(v, int | float | str | list)
        },
        "align_fail": res.align_fail,
        "align_resid": round(res.align_resid, 3) if np.isfinite(res.align_resid) else None,
        "gain_range": [float(res.gains.min()), float(res.gains.max())]
        if res.gains is not None
        else None,
        "restore_residual": res.restore_residual,
        "steps": [
            {
                k: (round(v, 4) if isinstance(v, float) else v)
                for k, v in s.items()
                if isinstance(v, bool | int | float | str)
            }
            for s in res.steps
        ],
        "lights": lights,
    }


def latencies(results: list[StationResult], p: Params) -> dict[str, float]:
    """Median measured latency (ms) per light across stations, from confident detections."""
    out: dict[str, list] = {}
    for res in results:
        for uid, lr in res.lights.items():
            if lr.detected and lr.confidence >= p.min_conf and lr.latency is not None:
                out.setdefault(uid, []).append(lr.latency)
    return {uid: round(1000 * float(np.median(v))) for uid, v in out.items()}


def _world_point(sol: Solution, uid: str) -> World | None:
    if sol.method.get(uid) == "triangulated" and uid in sol.points:
        x, y, z = (round(float(v), 4) for v in sol.points[uid])
        return World("triangulated", x=x, y=y, z=z, metric=sol.scale_known)
    if uid in sol.rays:
        o, d = sol.rays[uid]
        return World(
            "ray",
            origin=[round(float(v), 4) for v in o],
            direction=[round(float(v), 5) for v in d],
            metric=sol.scale_known,
        )
    return None


def _project_first(sol: Solution, uid: str) -> list[float] | None:
    """A triangulated light in the first station's picture."""
    if sol.method.get(uid) != "triangulated":
        return None
    X = sol.points[uid]
    if X[2] <= 0:
        return None
    w, h = sol.size
    u = sol.f * X[0] / X[2] + (w - 1) / 2
    v = sol.f * X[1] / X[2] + (h - 1) / 2
    if not (0 <= u < w and 0 <= v < h):
        return None
    return _norm((u, v), sol.size)


def elements(
    results: list[StationResult], sol: Solution, names: dict[str, str], p: Params
) -> tuple[list[Element], list[str]]:
    """Suggested elements in the first station's picture, and the lights no station found."""
    if not results:
        return [], []
    first = results[0]
    lat = latencies(results, p)
    groups = merge_groups(results)
    out = []
    for g in groups:
        units = (
            [u for seg in g["segments"] for u in seg] if g["mode"] == "segments" else g["lights"]
        )
        parts = []
        conf = 0.0
        for uid in units:
            lr = first.lights.get(uid)
            part = Part(uid, latency_ms=lat.get(uid), world=_world_point(sol, uid))
            if lr is not None and lr.detected and lr.confidence >= p.min_conf:
                part.centroid = _norm(lr.centroid, first.size)
                part.region = geometry.mask_polygon(lr.region)
            else:
                part.centroid = _project_first(sol, uid)
                if part.centroid is not None:
                    part.region = geometry.circle(part.centroid, 0.01)
            best = max((r.lights[uid].confidence for r in results if uid in r.lights), default=0.0)
            part.confidence = round(float(best), 3)
            conf = max(conf, best)
            parts.append(part)
        pts = [pt for part in parts for pt in (part.region or [])]
        region = geometry.hull(pts) if len(pts) >= 3 else []
        if len(parts) == 1:
            region = parts[0].region or region
        centroids = [part.centroid for part in parts if part.centroid]
        centroid = [round(float(v), 5) for v in np.mean(centroids, axis=0)] if centroids else None
        worlds = [
            part.world for part in parts if part.world and part.world.method == "triangulated"
        ]
        world = None
        if worlds:
            xyz = np.mean([[w.x, w.y, w.z] for w in worlds], axis=0)
            world = World(
                "triangulated",
                x=round(float(xyz[0]), 4),
                y=round(float(xyz[1]), 4),
                z=round(float(xyz[2]), 4),
                metric=sol.scale_known,
            )
        elif len(parts) == 1:
            world = parts[0].world
        note = ""
        if centroid is None:
            seen = [r.name for r in results if any(u in r.detected(p.min_conf) for u in units)]
            note = f"seen only from {', '.join(seen)}: place it by hand"
        first_name = names.get(units[0], units[0])
        out.append(
            Element(
                id=new_id("el"),
                name=first_name if len(units) == 1 else f"{first_name} + {len(units) - 1}",
                mode=g["mode"],
                parts=parts,
                region=region,
                centroid=centroid,
                world=world,
                source="mapping",
                confidence=round(float(conf), 3),
                note=note,
            )
        )
    found = {u for r in results for u in r.detected(p.min_conf)}
    all_units = {u for r in results for u in r.lights}
    return out, sorted(all_units - found)


def stations(results: list[StationResult], sol: Solution, session_id: str) -> list[Station]:
    out = []
    for res in results:
        st = Station(name=res.name, session=session_id, size=list(res.size))
        if res.name in sol.R:
            st.rotation = [[round(float(v), 6) for v in row] for row in sol.R[res.name]]
            st.centre = [round(float(v), 4) for v in sol.centre(res.name)]
            st.focal_px = round(float(sol.f), 2)
        out.append(st)
    return out
