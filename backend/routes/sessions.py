"""Session-level REST routes (per spec §3.4)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel

from backend.db import edges_repo, nodes_repo, sessions_repo
from backend.db.client import get_db
from backend.routes import timeline

router = APIRouter(tags=["sessions"])


class CreateSessionBody(BaseModel):
    name: str


class BranchBody(BaseModel):
    timestamp: datetime


def _serialize(doc: Optional[dict]) -> Optional[dict]:
    if doc is None:
        return None
    out = dict(doc)
    for key, value in list(out.items()):
        if isinstance(value, datetime):
            out[key] = value.isoformat()
    return out


def _serialize_list(docs: list[dict]) -> list[dict]:
    return [_serialize(d) for d in docs]  # type: ignore[misc]


@router.post("/sessions")
async def create_session(body: CreateSessionBody, db: AsyncIOMotorDatabase = Depends(get_db)):
    doc = await sessions_repo.create_session(db, name=body.name)
    return _serialize(doc)


@router.get("/sessions/{session_id}")
async def get_session(session_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    doc = await sessions_repo.get_session(db, session_id)
    if doc is None:
        raise HTTPException(404, "session not found")
    return _serialize(doc)


@router.get("/sessions/{session_id}/graph")
async def get_session_graph(
    session_id: str,
    at: Optional[datetime] = None,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    if at is not None and at.tzinfo is None:
        at = at.replace(tzinfo=timezone.utc)
    graph = await timeline.graph_at_or_live(db, session_id, at)
    return {
        "session_id": session_id,
        "nodes": _serialize_list(graph["nodes"]),
        "edges": _serialize_list(graph["edges"]),
    }


@router.post("/sessions/{session_id}/branch")
async def branch_session(
    session_id: str,
    body: BranchBody,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    parent = await sessions_repo.get_session(db, session_id)
    if parent is None:
        raise HTTPException(404, "session not found")

    timestamp = body.timestamp
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)

    new_session = await sessions_repo.create_session(
        db,
        name=f"{parent['name']} (branch)",
        branched_from={"session_id": session_id, "timestamp": timestamp},
    )

    nodes_at = await nodes_repo.find_at(db, session_id, timestamp)
    edges_at = await edges_repo.find_at(db, session_id, timestamp)

    # Copy nodes preserving their _id mapping under a new id, then remap edges.
    id_map: dict[str, str] = {}
    for node in nodes_at:
        new_node = dict(node)
        old_id = new_node.pop("_id")
        new_node["session_id"] = new_session["_id"]
        new_node.pop("deleted_at", None)
        created = await nodes_repo.create_node(db, new_node)
        id_map[old_id] = created["_id"]

    for edge in edges_at:
        new_edge = dict(edge)
        new_edge.pop("_id", None)
        new_edge["session_id"] = new_session["_id"]
        new_edge["source_id"] = id_map.get(edge["source_id"], edge["source_id"])
        new_edge["target_id"] = id_map.get(edge["target_id"], edge["target_id"])
        new_edge.pop("deleted_at", None)
        await edges_repo.create_edge(db, new_edge)

    return _serialize(new_session)
