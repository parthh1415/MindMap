"""Frontend → Backend transcript ingress over WebSocket.

Each ``TranscriptChunk`` is appended to a per-session ring buffer. The
topology agent is invoked at most once every ``TOPOLOGY_DEBOUNCE_SECONDS``
per session, and is sent the full ring-buffer snapshot.
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from shared.agent_messages import TopologyRequest
from shared.schemas import TranscriptChunk

from backend.agent_client import dispatch_topology
from backend.config import get_settings
from backend.db import edges_repo, nodes_repo
from backend.db.client import get_db
from backend.ring_buffer import get_buffer

logger = logging.getLogger(__name__)
router = APIRouter()


async def _build_graph_json(session_id: str) -> str:
    try:
        db = get_db()
        nodes = await nodes_repo.list_live(db, session_id)
        edges = await edges_repo.list_live(db, session_id)
    except Exception as exc:
        logger.debug("graph snapshot for topology unavailable: %s", exc)
        return json.dumps({"nodes": [], "edges": []})

    def _safe(doc: dict) -> dict:
        out: dict[str, Any] = {}
        for k, v in doc.items():
            if hasattr(v, "isoformat"):
                out[k] = v.isoformat()
            else:
                out[k] = v
        return out

    return json.dumps(
        {"nodes": [_safe(n) for n in nodes], "edges": [_safe(e) for e in edges]}
    )


async def _maybe_dispatch_topology(session_id: str, speaker_id: str) -> None:
    settings = get_settings()
    buf = get_buffer()
    if not buf.should_dispatch_topology(
        session_id,
        settings.TOPOLOGY_DEBOUNCE_SECONDS,
        min_new_words=settings.TOPOLOGY_MIN_NEW_WORDS,
    ):
        return
    snapshot = buf.snapshot(session_id)
    graph_json = await _build_graph_json(session_id)
    req = TopologyRequest(
        session_id=session_id,
        speaker_id=speaker_id,
        last_n_words=snapshot,
        current_graph_json=graph_json,
    )
    try:
        await dispatch_topology(req)
    except Exception as exc:
        logger.warning("topology dispatch error: %s", exc)


@router.websocket("/ws/transcript")
async def transcript_ws(websocket: WebSocket):
    await websocket.accept()
    buf = get_buffer()
    try:
        while True:
            try:
                raw = await websocket.receive_text()
            except WebSocketDisconnect:
                break
            try:
                payload = json.loads(raw)
                chunk = TranscriptChunk(**payload)
            except Exception as exc:
                logger.debug("ignoring malformed transcript chunk: %s", exc)
                continue

            buf.append(chunk.session_id, chunk.text)
            # Fire-and-forget agent dispatch (with debounce).
            asyncio.create_task(_maybe_dispatch_topology(chunk.session_id, chunk.speaker_id))
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
