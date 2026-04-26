"""Pivot/branch routes.

Endpoints:
  GET  /sessions/{sid}/pivot-suggestions  → PivotResponse (timestamps ISO)
       Cached for 30 s per session.
  GET  /sessions/{sid}/branches           → branches metadata
  GET  /sessions/{sid}/diff/{other_sid}   → label-level branch diff
  POST /internal/pivot-result             → bridge endpoint (called by agent)

The pivot-suggestions endpoint dispatches a PivotRequest to the pivot
uagent (via backend.agent_client) and waits on an asyncio.Future that is
resolved when the agent POSTs back to /internal/pivot-result. Same
future-bridge pattern as synthesis. Hard 25 s timeout.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from backend.branch_diff import compute_diff
from backend.db import edges_repo, nodes_repo, sessions_repo
from backend.db.client import get_db
from backend.ring_buffer import get_buffer
from shared.agent_messages import PivotRequest

logger = logging.getLogger(__name__)

router = APIRouter(tags=["pivots"])


# ---------------------------------------------------------------------------
# Future bridge — pending requests keyed by request_id.
# ---------------------------------------------------------------------------
_pending: dict[str, asyncio.Future] = {}
# Mirror keyed by session_id to support agents that don't echo a request_id.
_pending_by_session: dict[str, str] = {}

# Per-session pivot cache: session_id → (epoch_ts_ms, response_dict).
_CACHE_TTL_SECONDS = 30.0
_pivot_cache: dict[str, tuple[float, dict]] = {}

PIVOT_TIMEOUT_SECONDS = 45.0  # bumped from 25 — Gemini fallback path needs more headroom


def _register_future(request_id: str, session_id: str) -> asyncio.Future:
    fut: asyncio.Future = asyncio.get_event_loop().create_future()
    _pending[request_id] = fut
    _pending_by_session[session_id] = request_id
    return fut


def _resolve_future(request_id: str, session_id: str, payload: dict) -> bool:
    fut = _pending.pop(request_id, None)
    # Fall back to the session-keyed pending if the agent didn't echo
    # the request_id we sent.
    if fut is None and session_id:
        rid_alt = _pending_by_session.get(session_id)
        if rid_alt:
            fut = _pending.pop(rid_alt, None)
    if session_id and _pending_by_session.get(session_id) == request_id:
        _pending_by_session.pop(session_id, None)
    if fut is None or fut.done():
        return False
    fut.set_result(payload)
    return True


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------
class PivotPointPayload(BaseModel):
    timestamp: str
    why: str
    pivot_label: str


class PivotResultBody(BaseModel):
    request_id: str = ""
    session_id: str
    pivots: list[PivotPointPayload] = Field(default_factory=list)


class PivotSuggestionsResponse(BaseModel):
    session_id: str
    pivots: list[PivotPointPayload]
    cached: bool = False
    generated_at: str


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def _build_pivot_request(
    db: AsyncIOMotorDatabase, session_id: str
) -> PivotRequest:
    """Snapshot the recent transcript + current node labels for the agent."""
    transcript = ""
    try:
        transcript = get_buffer().snapshot(session_id) or ""
    except Exception as exc:  # noqa: BLE001
        logger.warning("ring buffer snapshot failed: %s", exc)

    labels: list[str] = []
    try:
        nodes = await nodes_repo.list_live(db, session_id)
        labels = [str(n.get("label", "")).strip() for n in nodes if n.get("label")]
    except Exception as exc:  # noqa: BLE001
        logger.warning("node label snapshot failed: %s", exc)

    return PivotRequest(
        session_id=session_id,
        transcript_excerpt=transcript,
        current_node_labels=labels,
    )


async def _dispatch_pivot(req: PivotRequest) -> bool:
    """Send a PivotRequest to the pivot uagent. Best-effort.

    We import lazily so the routes module can be imported in unit tests
    without pulling in uagents.
    """
    try:
        from backend import agent_client

        # Reuse the address-loading machinery; pivot agent writes "pivot".
        data = agent_client._load_addresses()
        addr = (data or {}).get("pivot")
        if not addr:
            logger.info("pivot agent address not registered yet; skipping dispatch")
            return False
        return await agent_client._send(addr, req)
    except Exception as exc:  # noqa: BLE001
        logger.warning("pivot dispatch failed: %s", exc)
        return False


def _cache_get(session_id: str) -> Optional[dict]:
    item = _pivot_cache.get(session_id)
    if not item:
        return None
    ts, payload = item
    if (time.monotonic() - ts) > _CACHE_TTL_SECONDS:
        _pivot_cache.pop(session_id, None)
        return None
    return payload


def _cache_put(session_id: str, payload: dict) -> None:
    _pivot_cache[session_id] = (time.monotonic(), payload)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.get("/sessions/{session_id}/pivot-suggestions")
async def get_pivot_suggestions(
    session_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    parent = await sessions_repo.get_session(db, session_id)
    if parent is None:
        raise HTTPException(404, "session not found")

    # Cache hit?
    cached = _cache_get(session_id)
    if cached is not None:
        return {**cached, "cached": True}

    req = await _build_pivot_request(db, session_id)
    request_id = uuid.uuid4().hex
    future = _register_future(request_id, session_id)

    dispatched = await _dispatch_pivot(req)
    if not dispatched:
        # No agent — clean up and return empty (don't 500; pivots are advisory).
        _pending.pop(request_id, None)
        _pending_by_session.pop(session_id, None)
        body = {
            "session_id": session_id,
            "pivots": [],
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        _cache_put(session_id, body)
        return {**body, "cached": False}

    try:
        result = await asyncio.wait_for(future, timeout=PIVOT_TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        _pending.pop(request_id, None)
        _pending_by_session.pop(session_id, None)
        logger.info("pivot request %s timed out", request_id)
        body = {
            "session_id": session_id,
            "pivots": [],
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        # Don't cache timeouts — the next call should retry quickly.
        return {**body, "cached": False}

    pivots = result.get("pivots", []) or []
    body = {
        "session_id": session_id,
        "pivots": pivots,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }
    _cache_put(session_id, body)
    return {**body, "cached": False}


@router.get("/sessions/{session_id}/branches")
async def list_session_branches(
    session_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """List sessions that branched FROM the given session_id.

    Returns metadata: _id, name, branched_from (with timestamp), node_count.
    """
    parent = await sessions_repo.get_session(db, session_id)
    if parent is None:
        raise HTTPException(404, "session not found")

    # Find all sessions whose branched_from.session_id matches.
    # We filter in-memory because Mongo's dot-path query doesn't round-trip
    # cleanly through the fake DB used in tests; the real Mongo could use
    # {"branched_from.session_id": session_id}.
    cursor = db.sessions.find({})
    all_sessions = [doc async for doc in cursor]
    matches = [
        s
        for s in all_sessions
        if isinstance(s.get("branched_from"), dict)
        and s["branched_from"].get("session_id") == session_id
    ]

    out: list[dict[str, Any]] = []
    for s in matches:
        sid = s.get("_id")
        try:
            nodes = await nodes_repo.list_live(db, sid)
            count = len(nodes)
        except Exception:  # noqa: BLE001
            count = 0
        bf = dict(s.get("branched_from") or {})
        ts = bf.get("timestamp")
        if hasattr(ts, "isoformat"):
            bf["timestamp"] = ts.isoformat()
        created = s.get("created_at")
        if hasattr(created, "isoformat"):
            created = created.isoformat()
        out.append(
            {
                "_id": sid,
                "name": s.get("name", "Branch"),
                "branched_from": bf,
                "created_at": created,
                "node_count": count,
            }
        )

    # Sort newest first if we have created_at.
    out.sort(key=lambda d: str(d.get("created_at") or ""), reverse=True)
    return {"branches": out}


@router.get("/sessions/{session_id}/diff/{other_sid}")
async def get_branch_diff(
    session_id: str,
    other_sid: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    a = await sessions_repo.get_session(db, session_id)
    b = await sessions_repo.get_session(db, other_sid)
    if a is None or b is None:
        raise HTTPException(404, "session not found")

    nodes_a = await nodes_repo.list_live(db, session_id)
    edges_a = await edges_repo.list_live(db, session_id)
    nodes_b = await nodes_repo.list_live(db, other_sid)
    edges_b = await edges_repo.list_live(db, other_sid)

    diff = compute_diff(nodes_a, edges_a, nodes_b, edges_b)
    return {
        "session_a": session_id,
        "session_b": other_sid,
        **diff,
    }


@router.post("/internal/pivot-result")
async def post_pivot_result(body: PivotResultBody):
    """Bridge endpoint: pivot agent posts back here once it has results."""
    payload = {
        "session_id": body.session_id,
        "pivots": [p.model_dump() for p in body.pivots],
    }
    resolved = _resolve_future(body.request_id or "", body.session_id, payload)
    return {"ok": True, "resolved": resolved}


__all__ = ["router"]
