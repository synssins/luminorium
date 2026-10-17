"""Views, planes and elements: the service and its API (manual placement and the review editor)."""

from __future__ import annotations

import cv2
import httpx
import numpy as np
import pytest

from luminorium.spatial import geometry
from luminorium.spatial.model import Element
from luminorium.spatial.service import SpatialError
from luminorium.web.server import create_app

PORCH = "light.front_porch_light"
CLOSET = "light.master_closet_light"
GOVEE = "light.led_bulb_string_lights"  # 30 segments


def photo(w=400, h=300, seed=0) -> bytes:
    rng = np.random.default_rng(seed)
    img = (rng.random((h // 10, w // 10, 3)) * 255).astype(np.uint8)
    img = cv2.resize(img, (w, h), interpolation=cv2.INTER_NEAREST)
    for _ in range(40):
        x, y = rng.integers(0, w), rng.integers(0, h)
        cv2.circle(img, (int(x), int(y)), int(rng.integers(3, 12)), (255, 255, 255), -1)
    return cv2.imencode(".png", img)[1].tobytes()


@pytest.fixture
async def client(lum):
    app = create_app(lum, manage_lifecycle=False)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


def test_geometry_basics():
    pts = [[0.2, 0.2], [0.8, 0.2], [0.8, 0.8], [0.2, 0.8]]
    assert geometry.picture_to_plane(pts, [6, 3], [0.5, 0.5]) == pytest.approx((3.0, 1.5))
    assert geometry.picture_to_plane(pts, None, [0.8, 0.8]) == pytest.approx((1.0, 1.0))
    assert geometry.point_in_polygon([0.5, 0.5], pts)
    assert not geometry.point_in_polygon([0.1, 0.5], pts)
    assert geometry.along_line([[0, 0], [1, 0]], 4) == [
        [0.125, 0],
        [0.375, 0],
        [0.625, 0],
        [0.875, 0],
    ]
    m = np.zeros((100, 200), bool)
    m[20:40, 50:90] = True
    poly = geometry.mask_polygon(m)
    xs, ys = [p[0] for p in poly], [p[1] for p in poly]
    assert min(xs) == pytest.approx(50.5 / 200) and max(ys) == pytest.approx(39.5 / 100)


def test_camera_pose_from_a_plane():
    # a 6 m x 4 m rectangle on the ground, seen by a camera 1.5 m up, 10 m away
    f, w, h = 500.0, 640, 360
    K = np.array([[f, 0, (w - 1) / 2], [0, f, (h - 1) / 2], [0, 0, 1]])
    rv = np.array([0.25, 0.1, 0.02])
    R = cv2.Rodrigues(rv)[0]
    t = np.array([-3.0, 1.5, 10.0])
    obj = np.array([[0, 0, 0], [6, 0, 0], [6, 4, 0], [0, 4, 0]], float)
    img = (obj @ R.T + t) @ K.T
    uv = img[:, :2] / img[:, 2:]
    pts = [[(u + 0.5) / w, (v + 0.5) / h] for u, v in uv]
    Re, te = geometry.camera_from_plane(pts, [6, 4], f, (w, h))
    assert np.allclose(Re, R, atol=1e-3) and np.allclose(te, t, atol=1e-2)


async def test_views_photo_planes_elements(lum):
    sp = lum.spatial
    view = sp.create("Front")
    assert sp.list()[0].id == view.id
    info = sp.set_photo(view.id, photo())
    assert info["photo"]["width"] == 400 and sp.photo_path(view.id).exists()

    el = sp.add_element(view.id, {"members": [PORCH], "centroid": [0.5, 0.75]})
    assert el.name == "Front Porch Light " or el.name.startswith("Front Porch")
    assert el.region and el.world is None
    with pytest.raises(SpatialError):  # one light, one place per view
        sp.add_element(view.id, {"members": [PORCH], "centroid": [0.1, 0.1]})
    with pytest.raises(SpatialError):
        sp.add_element(view.id, {"members": ["light.nope"], "centroid": [0.1, 0.1]})

    # a ground plane under it: plane position in metres
    ground = sp.add_plane(
        view.id,
        {
            "name": "Lawn",
            "kind": "ground",
            "points": [[0.2, 0.6], [0.8, 0.6], [1, 1], [0, 1]],
            "size": [6, 3],
        },
    )
    v = sp.get(view.id)
    porch = v.element(el.id)
    assert porch.plane == ground.id
    assert porch.world.method == "plane" and porch.world.metric
    assert 2.5 < porch.world.u < 3.5

    # drag it: moved outline, new plane position
    moved = sp.update_element(view.id, el.id, {"centroid": [0.6, 0.8]})
    assert moved.region[0][0] == pytest.approx(porch.region[0][0] + 0.1, abs=1e-4)
    assert moved.world.u > porch.world.u

    # survives a restart (on disk)
    sp._cache.clear()
    assert sp.get(view.id).element(el.id).world.method == "plane"


async def test_merge_split_reorder_and_segment_line(lum):
    sp = lum.spatial
    view = sp.create("Front")
    sp.set_photo(view.id, photo())
    a = sp.add_element(view.id, {"members": [PORCH], "centroid": [0.3, 0.3]})
    b = sp.add_element(view.id, {"members": [CLOSET], "centroid": [0.5, 0.3]})
    merged = sp.merge(view.id, [b.id, a.id], "segments")
    assert merged.mode == "segments" and merged.members == [PORCH, CLOSET]  # left to right
    assert len(sp.get(view.id).elements) == 1
    re = sp.reorder(view.id, merged.id, [CLOSET, PORCH])
    assert re.members == [CLOSET, PORCH]
    with pytest.raises(SpatialError):
        sp.reorder(view.id, merged.id, [CLOSET])
    parts = sp.split(view.id, merged.id)
    assert [p.members for p in parts] == [[CLOSET], [PORCH]]
    assert parts[1].centroid == [0.3, 0.3]

    # a Govee strip placed and given a line becomes its segments, spread along it
    g = sp.add_element(view.id, {"members": [GOVEE], "centroid": [0.5, 0.6]})
    g = sp.update_element(view.id, g.id, {"line": [[0.1, 0.6], [0.9, 0.6]], "mode": "segments"})
    assert g.mode == "segments" and len(g.parts) == 30
    assert g.parts[0].centroid[0] < g.parts[-1].centroid[0]
    assert all(p.member.startswith(GOVEE + "_segment_") for p in g.parts)
    with pytest.raises(SpatialError):  # its segments are placed: the strip can't be placed again
        sp.add_element(view.id, {"members": [GOVEE], "centroid": [0.5, 0.5]})


async def test_new_photo_carries_placements_over(lum):
    sp = lum.spatial
    view = sp.create("Front")
    first = photo(seed=3)
    sp.set_photo(view.id, first)
    el = sp.add_element(view.id, {"members": [PORCH], "centroid": [0.5, 0.5]})
    # the same scene, shifted 20 px right and 10 px down in a bigger frame
    img = cv2.imdecode(np.frombuffer(first, np.uint8), cv2.IMREAD_COLOR)
    M = np.float32([[1, 0, 20], [0, 1, 10]])
    shifted = cv2.warpAffine(img, M, (400, 300))
    info = sp.set_photo(view.id, cv2.imencode(".png", shifted)[1].tobytes())
    assert info["registered"]
    c = sp.get(view.id).element(el.id).centroid
    assert c == pytest.approx([0.55, 0.5333], abs=0.01)


def test_element_validation():
    with pytest.raises(ValueError):
        Element.from_dict({"parts": []})
    with pytest.raises(ValueError):
        Element.from_dict({"parts": ["light.a"], "line": [[0, 0]]})
    el = Element.from_dict({"parts": ["light.a"], "centroid": [1.5, -2]})
    assert el.centroid == [1.0, 0.0]


async def test_views_api(client):
    r = await client.post("/api/views", json={"name": "Front"})
    vid = r.json()["id"]
    assert (await client.get("/api/views")).json()[0]["id"] == vid
    r = await client.put(f"/api/views/{vid}/photo", content=photo())
    assert r.status_code == 200 and r.json()["photo"]["height"] == 300
    assert (await client.get(f"/api/views/{vid}/photo")).headers["content-type"] == "image/jpeg"
    assert (await client.put(f"/api/views/{vid}/photo", content=b"not an image")).status_code == 400

    r = await client.post(
        f"/api/views/{vid}/elements", json={"members": [PORCH], "centroid": [0.4, 0.4]}
    )
    assert r.status_code == 200
    e1 = r.json()["id"]
    r = await client.post(
        f"/api/views/{vid}/elements", json={"members": [PORCH], "centroid": [0.4, 0.4]}
    )
    assert r.status_code == 400
    e2 = (
        await client.post(
            f"/api/views/{vid}/elements", json={"members": [CLOSET], "centroid": [0.6, 0.4]}
        )
    ).json()["id"]
    r = await client.post(
        f"/api/views/{vid}/elements/merge", json={"ids": [e1, e2], "mode": "single"}
    )
    assert r.status_code == 200 and len(r.json()["parts"]) == 2
    m = r.json()["id"]
    r = await client.put(
        f"/api/views/{vid}/elements/{m}", json={"name": "Porch pair", "mode": "segments"}
    )
    assert r.json()["name"] == "Porch pair" and r.json()["mode"] == "segments"
    r = await client.put(f"/api/views/{vid}/elements/{m}/order", json={"members": [CLOSET, PORCH]})
    assert [p["member"] for p in r.json()["parts"]] == [CLOSET, PORCH]
    r = await client.post(f"/api/views/{vid}/elements/{m}/split")
    assert len(r.json()) == 2

    r = await client.post(
        f"/api/views/{vid}/planes",
        json={"name": "Wall", "kind": "wall", "points": [[0, 0], [1, 0], [1, 1], [0, 1]]},
    )
    pid = r.json()["id"]
    assert (
        await client.post(f"/api/views/{vid}/planes", json={"points": [[0, 0]]})
    ).status_code == 400
    r = await client.put(f"/api/views/{vid}/planes/{pid}", json={"size": [10, 5]})
    assert r.json()["size"] == [10, 5]
    view = (await client.get(f"/api/views/{vid}")).json()
    # elements inside a new plane are put on it (the user can change that)
    assert {e["plane"] for e in view["elements"]} == {pid}
    assert {e["world"]["method"] for e in view["elements"]} == {"plane"}
    assert (await client.delete(f"/api/views/{vid}/planes/{pid}")).status_code == 200
    assert (await client.get("/api/views/view_nothere")).status_code == 404
    assert (await client.get("/api/views/..%2F..")).status_code == 404
    assert (await client.delete(f"/api/views/{vid}")).status_code == 200
    assert (await client.get("/api/views")).json() == []


async def test_pages_served(client):
    assert "Views" in (await client.get("/views")).text
    assert "Map with the camera" in (await client.get("/capture")).text
    assert (await client.get("/static/views.js")).status_code == 200
    assert (await client.get("/static/capture.js")).status_code == 200
