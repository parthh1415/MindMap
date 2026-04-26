"""Backend → Frontend graph diff egress over WebSocket.

Maintains a per-session subscriber set. The topology agent's ``TopologyDiff``
handler calls :func:`broadcast_topology_diff` which:
  1. Persists the new nodes/edges via the repos.
  2. Broadcasts ``node_upsert`` / ``edge_upsert`` / ``node_merge`` events to
     all WebSocket clients subscribed to the session id.
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from motor.motor_asyncio import AsyncIOMotorDatabase

from backend.db import edges_repo, nodes_repo
from backend.db.client import get_db

logger = logging.getLogger(__name__)
router = APIRouter()


_subscribers: dict[str, set[WebSocket]] = {}
_lock = asyncio.Lock()


async def _add_subscriber(session_id: str, ws: WebSocket) -> None:
    async with _lock:
        _subscribers.setdefault(session_id, set()).add(ws)


async def _remove_subscriber(session_id: str, ws: WebSocket) -> None:
    async with _lock:
        bucket = _subscribers.get(session_id)
        if bucket is not None:
            bucket.discard(ws)
            if not bucket:
                _subscribers.pop(session_id, None)


def _serialize(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _serialize(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_serialize(v) for v in value]
    return value


async def _send_to_session(session_id: str, message: dict) -> None:
    payload = json.dumps(_serialize(message))
    bucket = _subscribers.get(session_id)
    if not bucket:
        return
    dead: list[WebSocket] = []
    for ws in list(bucket):
        try:
            await ws.send_text(payload)
        except Exception as exc:
            logger.debug("ws send failed: %s", exc)
            dead.append(ws)
    for ws in dead:
        await _remove_subscriber(session_id, ws)


@router.websocket("/ws/graph/{session_id}")
async def graph_ws(websocket: WebSocket, session_id: str):
    await websocket.accept()
    await _add_subscriber(session_id, websocket)
    try:
        # Send initial snapshot so the frontend can hydrate.
        try:
            db = get_db()
            nodes = await nodes_repo.list_live(db, session_id)
            edges = await edges_repo.list_live(db, session_id)
            await websocket.send_text(
                json.dumps(
                    _serialize(
                        {
                            "type": "snapshot",
                            "session_id": session_id,
                            "nodes": nodes,
                            "edges": edges,
                        }
                    )
                )
            )
        except Exception as exc:
            logger.debug("snapshot send skipped: %s", exc)

        while True:
            # We don't expect inbound messages on this socket, but we keep the
            # loop alive to detect disconnects. Some starlette code paths raise
            # RuntimeError("WebSocket is not connected") instead of
            # WebSocketDisconnect when the client closes — catch both.
            try:
                await websocket.receive_text()
            except (WebSocketDisconnect, RuntimeError):
                break
    finally:
        await _remove_subscriber(session_id, websocket)


# ---------------------------------------------------------------------------
# Public broadcast helpers — invoked by the topology / enrichment handlers.
# ---------------------------------------------------------------------------


async def broadcast_node_upsert(
    session_id: str, node: dict, resolves_ghost_id: Optional[str] = None
) -> None:
    msg: dict[str, Any] = {
        "type": "node_upsert",
        "session_id": session_id,
        "node": node,
    }
    if resolves_ghost_id:
        msg["resolves_ghost_id"] = resolves_ghost_id
    await _send_to_session(session_id, msg)


async def broadcast_edge_upsert(session_id: str, edge: dict) -> None:
    await _send_to_session(
        session_id, {"type": "edge_upsert", "session_id": session_id, "edge": edge}
    )


async def broadcast_node_merge(session_id: str, ghost_id: str, merged_into_id: str) -> None:
    await _send_to_session(
        session_id,
        {
            "type": "node_merge",
            "session_id": session_id,
            "ghost_id": ghost_id,
            "merged_into_id": merged_into_id,
        },
    )


async def broadcast_node_enriched(
    session_id: str, node_id: str, info: list[dict]
) -> None:
    await _send_to_session(
        session_id,
        {
            "type": "node_enriched",
            "session_id": session_id,
            "node_id": node_id,
            "info": info,
        },
    )


async def broadcast_ghost(session_id: str, ghost_id: str, label: str, speaker_id: str) -> None:
    await _send_to_session(
        session_id,
        {
            "type": "ghost_node",
            "session_id": session_id,
            "ghost_id": ghost_id,
            "label": label,
            "speaker_id": speaker_id,
        },
    )


# ---------------------------------------------------------------------------
# Topology diff persistence + broadcast.
# ---------------------------------------------------------------------------


async def apply_topology_diff(
    db: AsyncIOMotorDatabase,
    session_id: str,
    additions_nodes: list[dict],
    additions_edges: list[dict],
    merges: list[dict],
    edge_updates: list[dict],
    dedupe_labels: Optional[set[str]] = None,
) -> None:
    """Persist topology diff and broadcast to subscribers.

    Each addition node may carry an optional ``ghost_id`` field set by the
    topology agent — we strip it before persistence and pass it through as
    ``resolves_ghost_id`` on the broadcast event.

    When ``dedupe_labels`` is supplied (a set of lower/stripped label
    strings), any addition node whose label matches an entry will be
    skipped — both persistence and broadcast — on the assumption that the
    partial-node streaming endpoint already created+broadcast it.
    """
    now = datetime.now(timezone.utc)

    # Map labels of newly created nodes back to their assigned _id so the
    # additions_edges (which may reference labels) can be resolved.
    label_to_id: dict[str, str] = {}

    for raw in additions_nodes:
        node = dict(raw)
        label_norm = str(node.get("label") or "").lower().strip()
        if dedupe_labels is not None and label_norm and label_norm in dedupe_labels:
            # Already created/broadcast as a partial — skip to avoid dupes.
            continue
        ghost_id = node.pop("ghost_id", None)
        node["session_id"] = session_id
        node.setdefault("created_at", now)
        node.setdefault("updated_at", now)
        node.setdefault("info", [])
        node.setdefault("importance_score", 1.0)
        created = await nodes_repo.create_node(db, node)
        if "label" in created:
            label_to_id[created["label"]] = created["_id"]
        await broadcast_node_upsert(session_id, created, resolves_ghost_id=ghost_id)

    for raw in additions_edges:
        edge = dict(raw)
        edge["session_id"] = session_id
        # Allow the agent to reference newly created nodes by label.
        for ref_field in ("source_id", "target_id"):
            if edge.get(ref_field) in label_to_id:
                edge[ref_field] = label_to_id[edge[ref_field]]
        edge.setdefault("created_at", now)
        edge.setdefault("edge_type", "solid")
        created_edge = await edges_repo.create_edge(db, edge)
        await broadcast_edge_upsert(session_id, created_edge)

    for merge in merges:
        ghost_id = merge.get("ghost_label") or merge.get("ghost_id") or ""
        target = merge.get("into_id") or merge.get("merged_into_id") or ""
        if ghost_id and target:
            await broadcast_node_merge(session_id, ghost_id, target)

    for upd in edge_updates:
        edge_id = upd.get("edge_id")
        new_type = upd.get("new_type")
        if not edge_id or not new_type:
            continue
        updated = await edges_repo.update_edge(db, edge_id, {"edge_type": new_type})
        if updated is not None:
            await broadcast_edge_upsert(session_id, updated)
