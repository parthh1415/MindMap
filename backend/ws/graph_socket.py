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
    dedupe_label_id_map: Optional[dict[str, str]] = None,
) -> None:
    """Persist topology diff and broadcast to subscribers.

    Each addition node may carry an optional ``ghost_id`` field set by the
    topology agent — we strip it before persistence and pass it through as
    ``resolves_ghost_id`` on the broadcast event.

    Dedupe semantics (Phase 13 fix):
      - ``dedupe_labels`` (legacy): a set of lower/stripped labels already
        broadcast via the partial-node endpoint. Any addition node whose
        label matches is skipped here.
      - ``dedupe_label_id_map`` (new): a richer mapping ``label_norm -> _id``
        sourced from the partial-broadcast tracker. Used to seed
        ``label_to_id`` so EDGES that reference partial-broadcast nodes
        by label can still resolve to the correct ``_id``. Without this,
        edges spanning partial+final nodes were persisting with
        ``source_id=None`` because dedupe skipped the node entry that
        would have populated ``label_to_id``.
    """
    now = datetime.now(timezone.utc)

    # Resolve dedupe_labels from the richer map if supplied.
    if dedupe_label_id_map is not None and dedupe_labels is None:
        dedupe_labels = set(dedupe_label_id_map.keys())

    # Map labels of newly created nodes back to their assigned _id so the
    # additions_edges (which may reference labels) can be resolved.
    # SEED with the partial-broadcast mapping so edges that point at
    # already-broadcast partial nodes can still resolve.
    label_to_id: dict[str, str] = {}
    if dedupe_label_id_map:
        for label_norm, _id in dedupe_label_id_map.items():
            label_to_id[label_norm] = _id

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
            # Index by both the literal label and the normalized label so
            # edges referencing either form resolve correctly.
            label_to_id[created["label"]] = created["_id"]
            label_to_id[str(created["label"]).lower().strip()] = created["_id"]
        await broadcast_node_upsert(session_id, created, resolves_ghost_id=ghost_id)

    for raw in additions_edges:
        edge = dict(raw)
        edge["session_id"] = session_id
        # The topology system prompt tells the LLM to emit edges with
        # ``source_label_or_id`` / ``target_label_or_id`` keys. Earlier
        # code only read ``source_id`` / ``target_id``, which silently
        # turned every emitted edge into ``source_id=None`` (and the
        # frontend failed to render any of them). Accept BOTH keys.
        for canonical, alts in (
            ("source_id", ("source_label_or_id", "source", "source_label")),
            ("target_id", ("target_label_or_id", "target", "target_label")),
        ):
            if not edge.get(canonical):
                for alt in alts:
                    if edge.get(alt):
                        edge[canonical] = edge[alt]
                        break
        # Resolve label references → real ids (literal label first,
        # then normalized).
        for ref_field in ("source_id", "target_id"):
            ref = edge.get(ref_field)
            if isinstance(ref, str):
                if ref in label_to_id:
                    edge[ref_field] = label_to_id[ref]
                else:
                    norm = ref.lower().strip()
                    if norm in label_to_id:
                        edge[ref_field] = label_to_id[norm]
        # Skip edges we couldn't resolve (don't persist garbage).
        if not edge.get("source_id") or not edge.get("target_id"):
            logger.warning(
                "skipping edge with unresolved endpoints: src=%r tgt=%r",
                edge.get("source_id"), edge.get("target_id"),
            )
            continue
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
