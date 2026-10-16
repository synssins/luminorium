"""Views API: photos, planes and elements (manual placement and the review editor)."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel

from ..app import Luminorium
from ..spatial.service import SpatialError

MAX_PHOTO_BYTES = 25_000_000


class NameBody(BaseModel):
    name: str = ""


class MergeBody(BaseModel):
    ids: list[str]
    mode: str = "single"


class OrderBody(BaseModel):
    members: list[str]


async def read_body(request: Request, limit: int) -> bytes:
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > limit:
            raise HTTPException(413, "too large")
    return bytes(data)


def router(lum: Luminorium) -> APIRouter:
    api = APIRouter()
    spatial = lum.spatial

    def call(fn, *args, **kwargs) -> Any:
        try:
            return fn(*args, **kwargs)
        except KeyError as err:
            raise HTTPException(404, f"not found: {err.args[0] if err.args else ''}") from err
        except (SpatialError, ValueError, TypeError) as err:
            raise HTTPException(400, str(err)) from err

    @api.get("/api/views")
    async def views():
        return [v.summary() for v in spatial.list()]

    @api.post("/api/views")
    async def create_view(body: NameBody):
        return spatial.create(body.name).to_dict()

    @api.get("/api/views/{view_id}")
    async def get_view(view_id: str):
        return call(spatial.get, view_id).to_dict()

    @api.put("/api/views/{view_id}")
    async def rename_view(view_id: str, body: NameBody):
        return call(spatial.rename, view_id, body.name).to_dict()

    @api.delete("/api/views/{view_id}")
    async def delete_view(view_id: str):
        call(spatial.delete, view_id)
        return {"deleted": view_id}

    @api.put("/api/views/{view_id}/photo")
    async def put_photo(view_id: str, request: Request):
        call(spatial.get, view_id)
        data = await read_body(request, MAX_PHOTO_BYTES)
        return call(spatial.set_photo, view_id, data)

    @api.get("/api/views/{view_id}/photo")
    async def get_photo(view_id: str):
        return FileResponse(call(spatial.photo_path, view_id), media_type="image/jpeg")

    @api.get("/api/views/{view_id}/stations/{name}/photo")
    async def station_photo(view_id: str, name: str):
        view = call(spatial.get, view_id)
        st = next((s for s in view.stations if s.name == name and s.photo), None)
        if st is None:
            raise HTTPException(404, "no photo for this station")
        return FileResponse(call(spatial.photo_path, view_id, st.photo), media_type="image/jpeg")

    @api.post("/api/views/{view_id}/planes")
    async def add_plane(view_id: str, body: dict):
        return vars_of(call(spatial.add_plane, view_id, body))

    @api.put("/api/views/{view_id}/planes/{plane_id}")
    async def update_plane(view_id: str, plane_id: str, body: dict):
        return vars_of(call(spatial.update_plane, view_id, plane_id, body))

    @api.delete("/api/views/{view_id}/planes/{plane_id}")
    async def delete_plane(view_id: str, plane_id: str):
        call(spatial.delete_plane, view_id, plane_id)
        return {"deleted": plane_id}

    @api.post("/api/views/{view_id}/elements")
    async def add_element(view_id: str, body: dict):
        return call(spatial.add_element, view_id, body).to_dict()

    @api.put("/api/views/{view_id}/elements/{element_id}")
    async def update_element(view_id: str, element_id: str, body: dict):
        return call(spatial.update_element, view_id, element_id, body).to_dict()

    @api.delete("/api/views/{view_id}/elements/{element_id}")
    async def delete_element(view_id: str, element_id: str):
        call(spatial.delete_element, view_id, element_id)
        return {"deleted": element_id}

    @api.post("/api/views/{view_id}/elements/merge")
    async def merge(view_id: str, body: MergeBody):
        return call(spatial.merge, view_id, body.ids, body.mode).to_dict()

    @api.post("/api/views/{view_id}/elements/{element_id}/split")
    async def split(view_id: str, element_id: str):
        return [e.to_dict() for e in call(spatial.split, view_id, element_id)]

    @api.put("/api/views/{view_id}/elements/{element_id}/order")
    async def reorder(view_id: str, element_id: str, body: OrderBody):
        return call(spatial.reorder, view_id, element_id, body.members).to_dict()

    return api


def vars_of(plane) -> dict:
    return {
        "id": plane.id,
        "name": plane.name,
        "kind": plane.kind,
        "points": plane.points,
        "size": plane.size,
    }
