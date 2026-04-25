"""Edge-level REST routes."""
from __future__ import annotations

from datetime import datetime
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel

from backend.db import edges_repo
from backend.db.client import get_db

router = APIRouter(tags=["edges"])


class PatchEdgeBody(BaseModel):
    edge_type: Optional[str] = None
    source_id: Optional[str] = None
    target_id: Optional[str] = None


def _serialize(doc: Optional[dict]) -> Optional[dict]:
    if doc is None:
        return None
    out: dict[str, Any] = dict(doc)
    for key, value in list(out.items()):
        if isinstance(value, datetime):
            out[key] = value.isoformat()
    return out


@router.patch("/edges/{edge_id}")
async def patch_edge(edge_id: str, body: PatchEdgeBody, db: AsyncIOMotorDatabase = Depends(get_db)):
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items() if v is not None}
    if not patch:
        raise HTTPException(400, "no fields to update")
    doc = await edges_repo.update_edge(db, edge_id, patch)
    if doc is None:
        raise HTTPException(404, "edge not found")
    return _serialize(doc)


@router.delete("/edges/{edge_id}")
async def delete_edge(edge_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    ok = await edges_repo.soft_delete_edge(db, edge_id)
    if not ok:
        raise HTTPException(404, "edge not found")
    return {"ok": True, "edge_id": edge_id}
