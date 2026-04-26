"""Async Motor CRUD for the ``artifacts`` collection.

Document shape:
{
    "_id": uuid4 hex,
    "session_id": str,
    "artifact_type": str,
    "title": str,
    "markdown": str,
    "files": list[dict],
    "evidence": list[dict],
    "refinement_hint": str,
    "section_anchor": str,
    "at_timestamp": Optional[str],
    "generated_at": datetime (UTC),
    "classify_confidence": Optional[float],
    "classify_top_choice": Optional[str],
}

Lazily ensures a compound (session_id, generated_at) index on first call —
we don't extend ``shared.schemas.REQUIRED_INDEXES`` (frozen).
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from motor.motor_asyncio import AsyncIOMotorDatabase

logger = logging.getLogger(__name__)

_INDEX_READY: set[int] = set()


def _new_id() -> str:
    return uuid.uuid4().hex


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def _ensure_index(db: AsyncIOMotorDatabase) -> None:
    """Idempotent compound index on (session_id, generated_at)."""
    key = id(db)
    if key in _INDEX_READY:
        return
    try:
        await db.artifacts.create_index(
            [("session_id", 1), ("generated_at", -1)]
        )
    except Exception as exc:  # pragma: no cover — index hiccups don't block CRUD
        logger.warning("artifacts index creation failed: %s", exc)
    _INDEX_READY.add(key)


async def create_artifact(db: AsyncIOMotorDatabase, doc: dict) -> dict:
    """Insert an artifact. Assigns _id and generated_at if missing."""
    await _ensure_index(db)
    out: dict[str, Any] = dict(doc)
    out.setdefault("_id", _new_id())
    out.setdefault("generated_at", _utcnow())
    out.setdefault("files", [])
    out.setdefault("evidence", [])
    out.setdefault("refinement_hint", "")
    out.setdefault("section_anchor", "")
    out.setdefault("at_timestamp", None)
    out.setdefault("classify_confidence", None)
    out.setdefault("classify_top_choice", None)
    await db.artifacts.insert_one(out)
    return out


async def list_for_session(
    db: AsyncIOMotorDatabase, session_id: str, limit: int = 20
) -> list[dict]:
    """Return artifacts for a session, newest first."""
    await _ensure_index(db)
    cursor = db.artifacts.find({"session_id": session_id}).sort(
        "generated_at", -1
    ).limit(limit)
    return [doc async for doc in cursor]


async def get_artifact(
    db: AsyncIOMotorDatabase, artifact_id: str
) -> Optional[dict]:
    await _ensure_index(db)
    return await db.artifacts.find_one({"_id": artifact_id})


async def set_pinned(
    db: AsyncIOMotorDatabase, artifact_id: str, pinned: bool
) -> Optional[dict]:
    """Mark an artifact saved/pinned. Pinned artifacts surface to the
    top of the history list and are visually distinguished so users
    can find their kept work fast."""
    await _ensure_index(db)
    res = await db.artifacts.find_one_and_update(
        {"_id": artifact_id},
        {"$set": {"pinned": bool(pinned), "pinned_at": _utcnow() if pinned else None}},
        return_document=True,
    )
    return res


__all__ = [
    "create_artifact",
    "list_for_session",
    "get_artifact",
    "set_pinned",
]
