"""Timeline / replay snapshot helpers.

The HTTP route ``GET /sessions/{id}/graph?at=<ISO>`` lives in ``sessions.py``
and delegates to :func:`snapshot_at` here.
"""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from motor.motor_asyncio import AsyncIOMotorDatabase

from backend.db import edges_repo, nodes_repo


async def live_graph(db: AsyncIOMotorDatabase, session_id: str) -> dict:
    nodes = await nodes_repo.list_live(db, session_id)
    edges = await edges_repo.list_live(db, session_id)
    return {"nodes": nodes, "edges": edges}


async def snapshot_at(
    db: AsyncIOMotorDatabase, session_id: str, timestamp: datetime
) -> dict:
    nodes = await nodes_repo.find_at(db, session_id, timestamp)
    edges = await edges_repo.find_at(db, session_id, timestamp)
    return {"nodes": nodes, "edges": edges}


async def graph_at_or_live(
    db: AsyncIOMotorDatabase, session_id: str, at: Optional[datetime]
) -> dict:
    if at is None:
        return await live_graph(db, session_id)
    return await snapshot_at(db, session_id, at)
