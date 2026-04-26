"""Async CRUD for the ``nodes`` collection.

Soft-delete only: ``deleted_at`` is set to mark a node as removed; live reads
filter on ``{"deleted_at": {"$in": [None]}}`` OR absent.
"""
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


def prepare_node_doc(node: dict) -> dict:
    """Build a fully-formed node document WITHOUT touching Mongo.

    Same defaults as :func:`create_node` (assigns ``_id``, timestamps,
    info, importance) but pure-CPU. Lets callers broadcast over WS
    *before* paying the Mongo round-trip — see Phase 14 #4.
    """
    doc: dict[str, Any] = dict(node)
    doc.setdefault("_id", _new_id())
    now = _utcnow()
    doc.setdefault("created_at", now)
    doc.setdefault("updated_at", now)
    doc.setdefault("info", [])
    doc.setdefault("importance_score", 1.0)
    return doc


async def insert_prepared_node(db: AsyncIOMotorDatabase, doc: dict) -> None:
    """Persist a doc that was already built by :func:`prepare_node_doc`."""
    await db.nodes.insert_one(doc)


async def create_node(db: AsyncIOMotorDatabase, node: dict) -> dict:
    """Insert a node. Assigns ``_id`` and timestamps if absent."""
    doc = prepare_node_doc(node)
    await insert_prepared_node(db, doc)
    return doc


async def get_node(db: AsyncIOMotorDatabase, node_id: str) -> Optional[dict]:
    return await db.nodes.find_one(_live_filter({"_id": node_id}))


async def update_node(db: AsyncIOMotorDatabase, node_id: str, patch: dict) -> Optional[dict]:
    update_doc = {k: v for k, v in patch.items() if k not in {"_id", "session_id", "created_at"}}
    update_doc["updated_at"] = _utcnow()
    result = await db.nodes.find_one_and_update(
        _live_filter({"_id": node_id}),
        {"$set": update_doc},
        return_document=True,
    )
    return result


async def soft_delete_node(db: AsyncIOMotorDatabase, node_id: str) -> bool:
    res = await db.nodes.update_one(
        _live_filter({"_id": node_id}),
        {"$set": {"deleted_at": _utcnow()}},
    )
    return res.modified_count > 0


async def append_info(db: AsyncIOMotorDatabase, node_id: str, entries: list[dict]) -> Optional[dict]:
    return await db.nodes.find_one_and_update(
        _live_filter({"_id": node_id}),
        {"$push": {"info": {"$each": entries}}, "$set": {"updated_at": _utcnow()}},
        return_document=True,
    )


async def set_image(db: AsyncIOMotorDatabase, node_id: str, image_url: str) -> Optional[dict]:
    return await update_node(db, node_id, {"image_url": image_url})


async def list_live(db: AsyncIOMotorDatabase, session_id: str) -> list[dict]:
    cursor = db.nodes.find(_live_filter({"session_id": session_id})).sort("created_at", 1)
    return [doc async for doc in cursor]


async def find_at(db: AsyncIOMotorDatabase, session_id: str, timestamp: datetime) -> list[dict]:
    """Return nodes that existed (created_at <= T) and weren't soft-deleted before T.

    Uses the compound (session_id, created_at) index for efficient range scans.
    """
    query = {
        "session_id": session_id,
        "created_at": {"$lte": timestamp},
        "$or": [
            {"deleted_at": {"$exists": False}},
            {"deleted_at": None},
            {"deleted_at": {"$gt": timestamp}},
        ],
    }
    cursor = db.nodes.find(query).sort("created_at", 1)
    return [doc async for doc in cursor]


async def find_existing_at(db: AsyncIOMotorDatabase, session_id: str, timestamp: datetime) -> list[dict]:
    """Return all nodes (live or soft-deleted) created at or before T.

    Used during branching: deleted nodes still appear if they were deleted
    after the branch point — but for simplicity we only copy ones still
    visible at T (same logic as ``find_at``).
    """
    return await find_at(db, session_id, timestamp)
