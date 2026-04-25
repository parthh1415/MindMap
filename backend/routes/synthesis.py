"""Synthesis routes — POST /nodes/{id}/expand, POST /sessions/{id}/synthesize.

Each route fires a uagents-style dispatch to the synthesis agent and awaits
its HTTP callback (POST /internal/synth-result) via the future bridge in
``backend.agent_synth_client``. Timeout is 25s; on timeout we return 504.

GET /nodes/{id}/evidence is a best-effort lookup against the in-memory
ring buffer + nodes_repo timestamps (returns empty when the buffer has
been pruned).
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from backend import agent_synth_client
from backend.db import edges_repo, nodes_repo
from backend.db.client import get_db
from backend.ring_buffer import get_buffer

logger = logging.getLogger(__name__)
router = APIRouter(tags=["synthesis"])


# ---------------------------------------------------------------------------
# Bodies
# ---------------------------------------------------------------------------
class SynthesizeBody(BaseModel):
    scope: str = "all"  # "all" | "selected"
    node_ids: Optional[list[str]] = None
    format: str = "doc"  # "doc" | "email" | "issue" | "summary"


class SynthResultBody(BaseModel):
    kind: str  # "expand" | "synthesize"
    session_id: str
    node_id: Optional[str] = None
    request_id: Optional[str] = None
    children: Optional[list[dict]] = None
    title: Optional[str] = None
    markdown: Optional[str] = None
    target_format: Optional[str] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _isoformat(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, dict):
        return {k: _isoformat(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_isoformat(v) for v in value]
    return value


async def _gather_synth_payload(
    db: AsyncIOMotorDatabase, session_id: str, scope: str, node_ids: Optional[list[str]]
) -> tuple[str, str, str]:
    """Build (nodes_json, edges_json, transcript_excerpts) for the request."""
    all_nodes = await nodes_repo.list_live(db, session_id)
    all_edges = await edges_repo.list_live(db, session_id)

    if scope == "selected" and node_ids:
        keep = set(node_ids)
        chosen_nodes = [n for n in all_nodes if n["_id"] in keep]
        chosen_edges = [
            e for e in all_edges
            if e.get("source_id") in keep and e.get("target_id") in keep
        ]
    else:
        chosen_nodes = all_nodes
        chosen_edges = all_edges

    nodes_json = json.dumps(_isoformat(chosen_nodes), default=str)
    edges_json = json.dumps(_isoformat(chosen_edges), default=str)

    # Best-effort transcript excerpts: snapshot of the in-memory ring buffer.
    try:
        buf = get_buffer()
        transcript = buf.snapshot(session_id)
    except Exception:  # noqa: BLE001
        transcript = ""

    return nodes_json, edges_json, transcript


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.post("/nodes/{node_id}/expand")
async def expand_node(node_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    node = await nodes_repo.get_node(db, node_id)
    if node is None:
        raise HTTPException(404, "node not found")
    session_id = node["session_id"]
    label = node.get("label", "")

    # Pull a transcript window for context (best-effort).
    try:
        transcript = get_buffer().snapshot(session_id)
    except Exception:  # noqa: BLE001
        transcript = ""

    try:
        payload = await agent_synth_client.expand_node(
            session_id=session_id,
            node_id=node_id,
            node_label=label,
            transcript_window=transcript,
            timeout=agent_synth_client.DEFAULT_TIMEOUT_SECONDS,
        )
    except agent_synth_client.SynthClientError as exc:
        raise HTTPException(503, f"synthesis agent unavailable: {exc.reason}")
    except asyncio.TimeoutError:
        raise HTTPException(504, "synthesis agent timed out")

    children = payload.get("children", []) or []
    return {
        "session_id": session_id,
        "node_id": node_id,
        "children": children,
    }


@router.post("/sessions/{session_id}/synthesize")
async def synthesize(
    session_id: str,
    body: SynthesizeBody,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    if body.format not in ("doc", "email", "issue", "summary"):
        raise HTTPException(400, f"unsupported format: {body.format}")
    if body.scope not in ("all", "selected"):
        raise HTTPException(400, f"unsupported scope: {body.scope}")

    nodes_json, edges_json, transcript = await _gather_synth_payload(
        db, session_id, body.scope, body.node_ids
    )

    try:
        payload = await agent_synth_client.synthesize(
            session_id=session_id,
            nodes_json=nodes_json,
            edges_json=edges_json,
            transcript_excerpts=transcript,
            target_format=body.format,
            timeout=agent_synth_client.DEFAULT_TIMEOUT_SECONDS,
        )
    except agent_synth_client.SynthClientError as exc:
        raise HTTPException(503, f"synthesis agent unavailable: {exc.reason}")
    except asyncio.TimeoutError:
        raise HTTPException(504, "synthesis agent timed out")

    return {
        "session_id": session_id,
        "title": payload.get("title", "Synthesis"),
        "markdown": payload.get("markdown", ""),
        "target_format": payload.get("target_format", body.format),
    }


@router.get("/nodes/{node_id}/evidence")
async def node_evidence(node_id: str, db: AsyncIOMotorDatabase = Depends(get_db)):
    """Best-effort: return transcript chunks within +/- 60s of node.created_at."""
    node = await nodes_repo.get_node(db, node_id)
    if node is None:
        raise HTTPException(404, "node not found")
    session_id = node["session_id"]
    created_at = node.get("created_at")
    label = (node.get("label") or "").lower()

    chunks: list[dict] = []
    try:
        buf = get_buffer()
        sentences = buf.recent_sentences(session_id, n=32)
    except Exception:  # noqa: BLE001
        sentences = []

    # Prefer sentences that mention any token of the node label.
    label_tokens = {t for t in label.split() if len(t) >= 4}
    for sent in sentences:
        sent_lower = sent.lower()
        is_match = any(tok in sent_lower for tok in label_tokens) if label_tokens else False
        chunks.append(
            {
                "text": sent,
                "is_match": is_match,
                "speaker_id": node.get("speaker_id"),
            }
        )

    # If we got nothing, leave an empty list — frontend handles it.
    return {
        "session_id": session_id,
        "node_id": node_id,
        "node_label": node.get("label", ""),
        "node_created_at": (
            created_at.isoformat() if isinstance(created_at, datetime) else created_at
        ),
        "window_seconds": 60,
        "transcript_chunks": chunks,
    }


@router.post("/internal/synth-result")
async def post_synth_result(body: SynthResultBody):
    """Callback from the synthesis agent. Resolves the pending future."""
    request_id = body.request_id
    payload = body.model_dump()

    # If the agent did not echo a request_id (current frozen schemas don't
    # carry one), fall back to the implicit-claim map.
    if not request_id:
        if body.kind == "expand" and body.node_id:
            request_id = agent_synth_client.lookup_implicit(
                body.session_id, ("expand", body.node_id)
            )
        elif body.kind == "synthesize" and body.target_format:
            request_id = agent_synth_client.lookup_implicit(
                body.session_id, ("synthesize", body.target_format)
            )

    resolved = await agent_synth_client.deliver_result(request_id, payload)
    return {"ok": True, "resolved": resolved}
