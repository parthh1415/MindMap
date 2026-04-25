"""Async CRUD for the ``sessions`` collection."""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from motor.motor_asyncio import AsyncIOMotorDatabase


def _new_id() -> str:
    return uuid.uuid4().hex


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def create_session(
    db: AsyncIOMotorDatabase,
    name: str,
    branched_from: Optional[dict] = None,
) -> dict:
    doc: dict[str, Any] = {
        "_id": _new_id(),
        "name": name,
        "created_at": _utcnow(),
    }
    if branched_from is not None:
        doc["branched_from"] = branched_from
    await db.sessions.insert_one(doc)
    return doc


async def get_session(db: AsyncIOMotorDatabase, session_id: str) -> Optional[dict]:
    return await db.sessions.find_one({"_id": session_id})


async def list_sessions(db: AsyncIOMotorDatabase, limit: int = 100) -> list[dict]:
    cursor = db.sessions.find({}).sort("created_at", -1).limit(limit)
    return [doc async for doc in cursor]
