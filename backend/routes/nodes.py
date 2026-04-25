"""Node-level REST routes."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel

from backend.db import nodes_repo
from backend.db.client import get_db

router = APIRouter(tags=["nodes"])


class PatchNodeBody(BaseModel):
    label: Optional[str] = None
    importance_score: Optional[float] = None
    parent_id: Optional[str] = None
    image_url: Optional[str] = None


class ImageBody(BaseModel):
    image_url: str


def _serialize(doc: Optional[dict]) -> Optional[dict]:
    if doc is None:
        return None
    out: dict[str, Any] = dict(doc)
    for key, value in list(out.items()):
        if isinstance(value, datetime):
            out[key] = value.isoformat()
        elif isinstance(value, list):
            out[key] = [
                {**v, "created_at": v["created_at"].isoformat()}
                if isinstance(v, dict) and isinstance(v.get("created_at"), datetime)
                else v
                for v in value
            ]
    return out


@router.patch("/nodes/{node_id}")
async def patch_node(node_id: str, body: PatchNodeBody, db: AsyncIOMotorDatabase = Depends(get_db)):
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not patch:
        raise HTTPException(400, "no fields to update")
    doc = await nodes_repo.update_node(db, node_id, patch)
    if doc is None:
        raise HTTPException(404, "node not found")
    return _serialize(doc)


@router.delete("/nodes/{node_id}")
async def delete_node(node_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    ok = await nodes_repo.soft_delete_node(db, node_id)
    if not ok:
        raise HTTPException(404, "node not found")
    return {"ok": True, "node_id": node_id}


@router.post("/nodes/{node_id}/image")
async def set_node_image(node_id: str, body: ImageBody, db: AsyncIOMotorDatabase = Depends(get_db)):
    doc = await nodes_repo.set_image(db, node_id, body.image_url)
    if doc is None:
        raise HTTPException(404, "node not found")
    return _serialize(doc)
