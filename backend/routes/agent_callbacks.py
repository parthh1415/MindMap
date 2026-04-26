"""HTTP callback endpoints invoked by the agent processes.

These give the agents a transport-agnostic way to deliver TopologyDiff and
EnrichmentResponse payloads back to the backend (in addition to the native
uagents message channel). Both shapes mirror the uagents message classes in
``shared.agent_messages``.

Streaming additions:
- ``POST /internal/topology-partial-node`` — invoked once per
  ``additions_nodes[i]`` as soon as the streaming JSON parser closes the
  object. We persist the node and broadcast immediately; the per-session
  set of already-broadcast labels is consulted by the final
  ``/internal/topology-diff`` POST so the same node isn't created twice.
"""
from __future__ import annotations

import asyncio
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from backend.db import nodes_repo
from backend.db.client import get_db
from backend.ws.graph_socket import (
    apply_topology_diff,
    broadcast_node_enriched,
    broadcast_node_upsert,
)

router = APIRouter(tags=["agent-callbacks"])


# Per-session map of lower/stripped label → assigned _id for nodes we've
# already broadcast as partials. The id is needed so the matching
# ``/internal/topology-diff`` can resolve edges that reference these
# nodes by label. Cleared once the diff settles.
# (Phase 13: was previously dict[str, set[str]] — labels only — which
# caused edges spanning partial+final nodes to persist with source_id=None.)
_partial_broadcast: dict[str, dict[str, str]] = {}
_partial_lock = asyncio.Lock()


def _norm_label(label: Any) -> str:
    return str(label or "").lower().strip()


class TopologyDiffBody(BaseModel):
    session_id: str
    additions_nodes: list[dict] = Field(default_factory=list)
    additions_edges: list[dict] = Field(default_factory=list)
    merges: list[dict] = Field(default_factory=list)
    edge_updates: list[dict] = Field(default_factory=list)


class TopologyPartialNodeBody(BaseModel):
    session_id: str
    node: dict
    request_id: str | None = None


class EnrichmentResponseBody(BaseModel):
    session_id: str
    node_id: str
    info_entries: list[str]


@router.post("/internal/topology-partial-node")
async def post_topology_partial_node(
    body: TopologyPartialNodeBody,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Create-and-broadcast a single partial node from the streaming agent.

    Idempotent per (session_id, normalized label): a duplicate POST returns
    ``{"ok": True, "duplicate": True}`` without creating another node.
    """
    from datetime import datetime, timezone

    label_norm = _norm_label(body.node.get("label"))
    if not label_norm:
        # No usable label — can't dedupe; reject quietly.
        raise HTTPException(400, "node.label is required")

    async with _partial_lock:
        seen = _partial_broadcast.setdefault(body.session_id, {})
        if label_norm in seen:
            return {"ok": True, "duplicate": True, "node_id": seen[label_norm]}
        # Reserve the label up front so concurrent posts (e.g. retried
        # network requests) don't both create. Use a sentinel until we
        # have the assigned _id.
        seen[label_norm] = ""  # reservation placeholder

    now = datetime.now(timezone.utc)
    node = dict(body.node)
    ghost_id = node.pop("ghost_id", None)
    node["session_id"] = body.session_id
    node.setdefault("created_at", now)
    node.setdefault("updated_at", now)
    node.setdefault("info", [])
    node.setdefault("importance_score", 1.0)

    try:
        created = await nodes_repo.create_node(db, node)
    except Exception:
        # On persistence failure, release the reservation so a later retry
        # can try again.
        async with _partial_lock:
            _partial_broadcast.get(body.session_id, {}).pop(label_norm, None)
        raise

    # Record the real _id so the eventual /internal/topology-diff can
    # resolve label-referenced edges that point at this node.
    async with _partial_lock:
        _partial_broadcast.setdefault(body.session_id, {})[label_norm] = created["_id"]

    await broadcast_node_upsert(body.session_id, created, resolves_ghost_id=ghost_id)
    return {"ok": True, "node_id": created.get("_id")}


@router.post("/internal/topology-diff")
async def post_topology_diff(
    body: TopologyDiffBody, db: AsyncIOMotorDatabase = Depends(get_db)
):
    # Snapshot + clear the per-session partial-broadcast map so this diff
    # acts as the "settle" — anything not yet broadcast becomes broadcast,
    # then the map resets for the next user utterance.
    async with _partial_lock:
        seen_map = _partial_broadcast.pop(body.session_id, {})
    # Drop reservation placeholders (label_norm with empty _id — created
    # node failed mid-flight). Defensive.
    seen_map = {k: v for k, v in seen_map.items() if v}

    await apply_topology_diff(
        db,
        session_id=body.session_id,
        additions_nodes=body.additions_nodes,
        additions_edges=body.additions_edges,
        merges=body.merges,
        edge_updates=body.edge_updates,
        dedupe_label_id_map=seen_map,
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
