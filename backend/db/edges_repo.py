"""Async CRUD for the ``edges`` collection. Soft-delete only."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from motor.motor_asyncio import AsyncIOMotorDatabase


def _new_id() -> str:
    return uuid.uuid4().hex


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _live_filter(extra: Optional[dict] = None) -> dict:
    base: dict[str, Any] = {"$or": [{"deleted_at": {"$exists": False}}, {"deleted_at": None}]}
    if extra:
        return {"$and": [extra, base]}
    return base


async def create_edge(db: AsyncIOMotorDatabase, edge: dict) -> dict:
    doc: dict[str, Any] = dict(edge)
    doc.setdefault("_id", _new_id())
    doc.setdefault("created_at", _utcnow())
    doc.setdefault("edge_type", "solid")
    await db.edges.insert_one(doc)
    return doc


async def get_edge(db: AsyncIOMotorDatabase, edge_id: str) -> Optional[dict]:
    return await db.edges.find_one(_live_filter({"_id": edge_id}))


async def update_edge(db: AsyncIOMotorDatabase, edge_id: str, patch: dict) -> Optional[dict]:
    update_doc = {k: v for k, v in patch.items() if k not in {"_id", "session_id", "created_at"}}
    return await db.edges.find_one_and_update(
        _live_filter({"_id": edge_id}),
        {"$set": update_doc},
        return_document=True,
    )


async def soft_delete_edge(db: AsyncIOMotorDatabase, edge_id: str) -> bool:
    res = await db.edges.update_one(
        _live_filter({"_id": edge_id}),
        {"$set": {"deleted_at": _utcnow()}},
    )
    return res.modified_count > 0


async def list_live(db: AsyncIOMotorDatabase, session_id: str) -> list[dict]:
    cursor = db.edges.find(_live_filter({"session_id": session_id})).sort("created_at", 1)
    return [doc async for doc in cursor]


async def find_at(db: AsyncIOMotorDatabase, session_id: str, timestamp: datetime) -> list[dict]:
    query = {
        "session_id": session_id,
        "created_at": {"$lte": timestamp},
        "$or": [
            {"deleted_at": {"$exists": False}},
            {"deleted_at": None},
            {"deleted_at": {"$gt": timestamp}},
        ],
    }
    cursor = db.edges.find(query).sort("created_at", 1)
    return [doc async for doc in cursor]
