"""Motor async Mongo client + idempotent index creation.

Exposes ``get_db()`` as a FastAPI dependency. Indexes are created from
``shared.schemas.REQUIRED_INDEXES`` on startup (in ``main.lifespan``).
"""
from __future__ import annotations

import logging
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorClient, AsyncIOMotorDatabase

from shared.schemas import REQUIRED_INDEXES

from backend.config import get_settings

logger = logging.getLogger(__name__)

_client: Optional[AsyncIOMotorClient] = None
_db: Optional[AsyncIOMotorDatabase] = None


def init_client(mongo_uri: Optional[str] = None, db_name: Optional[str] = None) -> AsyncIOMotorDatabase:
    """Initialise the global Motor client.

    Idempotent: returns the same database handle on subsequent calls.
    """
    global _client, _db
    settings = get_settings()
    if _client is None:
        uri = mongo_uri or settings.MONGO_URI
        _client = AsyncIOMotorClient(uri, tz_aware=True)
        _db = _client[db_name or settings.MONGO_DB_NAME]
    return _db  # type: ignore[return-value]


def set_db(db: AsyncIOMotorDatabase) -> None:
    """Override the global database handle (used by tests)."""
    global _db
    _db = db


def get_db() -> AsyncIOMotorDatabase:
    """FastAPI dependency: returns the active database handle."""
    if _db is None:
        return init_client()
    return _db


async def create_indexes(db: Optional[AsyncIOMotorDatabase] = None) -> None:
    """Create all required indexes idempotently.

    ``REQUIRED_INDEXES`` maps collection name to a single compound spec like
    ``[("session_id", 1), ("created_at", 1)]``. Motor's ``create_index`` is
    idempotent by default — it's a no-op if an equivalent index already exists.
    """
    target = db if db is not None else get_db()
    for collection_name, spec in REQUIRED_INDEXES.items():
        try:
            await target[collection_name].create_index(list(spec))
        except Exception as exc:  # pragma: no cover — log and continue
            logger.warning("Index creation failed for %s: %s", collection_name, exc)


async def close_client() -> None:
    global _client, _db
    if _client is not None:
        _client.close()
        _client = None
        _db = None
