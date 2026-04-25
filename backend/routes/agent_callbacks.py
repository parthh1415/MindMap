"""HTTP callback endpoints invoked by the agent processes.

These give the agents a transport-agnostic way to deliver TopologyDiff and
EnrichmentResponse payloads back to the backend (in addition to the native
uagents message channel). Both shapes mirror the uagents message classes in
``shared.agent_messages``.
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from backend.db import nodes_repo
from backend.db.client import get_db
from backend.ws.graph_socket import (
    apply_topology_diff,
    broadcast_node_enriched,
)

router = APIRouter(tags=["agent-callbacks"])


class TopologyDiffBody(BaseModel):
    session_id: str
    additions_nodes: list[dict] = Field(default_factory=list)
    additions_edges: list[dict] = Field(default_factory=list)
    merges: list[dict] = Field(default_factory=list)
    edge_updates: list[dict] = Field(default_factory=list)


class EnrichmentResponseBody(BaseModel):
    session_id: str
    node_id: str
    info_entries: list[str]


@router.post("/internal/topology-diff")
async def post_topology_diff(
    body: TopologyDiffBody, db: AsyncIOMotorDatabase = Depends(get_db)
):
    await apply_topology_diff(
        db,
        session_id=body.session_id,
        additions_nodes=body.additions_nodes,
        additions_edges=body.additions_edges,
        merges=body.merges,
        edge_updates=body.edge_updates,
    )
    return {"ok": True}


@router.post("/internal/enrichment")
async def post_enrichment(
    body: EnrichmentResponseBody, db: AsyncIOMotorDatabase = Depends(get_db)
):
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    entries = [{"text": t, "created_at": now} for t in body.info_entries]
    updated = await nodes_repo.append_info(db, body.node_id, entries)
    if updated is None:
        raise HTTPException(404, "node not found")
    # Broadcast the full info list.
    out_info: list[dict[str, Any]] = []
    for e in updated.get("info", []):
        e2 = dict(e)
        if hasattr(e2.get("created_at"), "isoformat"):
            e2["created_at"] = e2["created_at"].isoformat()
        out_info.append(e2)
    await broadcast_node_enriched(body.session_id, body.node_id, out_info)
    return {"ok": True}
