"""Request/future bridge between backend HTTP routes and the artifact uAgent.

Mirrors ``backend.agent_synth_client``. The artifact agent posts results to
``/internal/artifact-result``; the bridge resolves the matching pending
asyncio.Future. Because ``ArtifactClassifyRequest`` / ``ArtifactGenerateRequest``
do not carry a ``request_id`` field in the frozen schema, we maintain an
implicit-claim map keyed by (session_id, kind, ...) → request_id.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from dataclasses import dataclass
from typing import Any, Optional

from shared.agent_messages import (
    ArtifactClassifyRequest,
    ArtifactGenerateRequest,
)

from backend.config import get_settings

logger = logging.getLogger(__name__)

# request_id -> Future[dict]
_pending: dict[str, asyncio.Future] = {}
_pending_lock = asyncio.Lock()

DEFAULT_TIMEOUT_SECONDS = 45.0  # see backend/agent_synth_client.py for rationale


# ---------------------------------------------------------------------------
# Address discovery
# ---------------------------------------------------------------------------
def _load_addresses() -> dict:
    settings = get_settings()
    path = settings.AGENT_ADDRESSES_PATH
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        logger.info("agent addresses file unreadable: %s", exc)
        return {}


def _artifact_address() -> Optional[str]:
    return _load_addresses().get("artifact")


# ---------------------------------------------------------------------------
# Future registry
# ---------------------------------------------------------------------------
async def _register_future() -> tuple[str, asyncio.Future]:
    request_id = uuid.uuid4().hex
    loop = asyncio.get_event_loop()
    fut: asyncio.Future = loop.create_future()
    async with _pending_lock:
        _pending[request_id] = fut
    return request_id, fut


async def _drop_future(request_id: str) -> None:
    async with _pending_lock:
        _pending.pop(request_id, None)


async def deliver_result(request_id: Optional[str], payload: dict) -> bool:
    """Resolve a pending future. Called from /internal/artifact-result.

    Returns True if a future was resolved.
    """
    if not request_id:
        return False
    async with _pending_lock:
        fut = _pending.pop(request_id, None)
    if fut is None or fut.done():
        return False
    fut.set_result(payload)
    return True


# ---------------------------------------------------------------------------
# Outbound dispatch
# ---------------------------------------------------------------------------
async def _send_to_agent(addr: str, message: Any) -> bool:
    """Best-effort send. Tolerates uagents version drift."""
    try:
        from uagents.communication import send_sync_message  # type: ignore

        await send_sync_message(addr, message)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.debug("send_sync_message failed: %s", exc)
    try:
        from uagents.query import query  # type: ignore

        await query(addr, message)
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("artifact agent dispatch failed: %s", exc)
        return False


@dataclass
class ArtifactClientError(Exception):
    """Raised when the artifact agent is unreachable."""

    reason: str

    def __str__(self) -> str:  # pragma: no cover
        return f"ArtifactClientError({self.reason})"


# ---------------------------------------------------------------------------
# Implicit-claim map (frozen schemas don't carry request_id)
# ---------------------------------------------------------------------------
_implicit: dict[tuple[str, tuple], str] = {}


def _claim_implicit(session_id: str, key: tuple, request_id: str) -> None:
    _implicit[(session_id, key)] = request_id


def _release_implicit(session_id: str, key: tuple) -> None:
    _implicit.pop((session_id, key), None)


def lookup_implicit(session_id: str, key: tuple) -> Optional[str]:
    return _implicit.get((session_id, key))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------
async def classify(
    *,
    session_id: str,
    nodes_json: str,
    edges_json: str,
    transcript_excerpt: str,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict:
    """Dispatch an ArtifactClassifyRequest, await the agent's HTTP callback."""
    addr = _artifact_address()
    request_id, fut = await _register_future()
    key = ("classify",)
    _claim_implicit(session_id, key, request_id)

    if not addr:
        await _drop_future(request_id)
        _release_implicit(session_id, key)
        raise ArtifactClientError("artifact agent address not registered")

    req = ArtifactClassifyRequest(
        session_id=session_id,
        nodes_json=nodes_json,
        edges_json=edges_json,
        transcript_excerpt=transcript_excerpt,
    )
    sent = await _send_to_agent(addr, req)
    if not sent:
        await _drop_future(request_id)
        _release_implicit(session_id, key)
        raise ArtifactClientError("send to artifact agent failed")

    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    finally:
        await _drop_future(request_id)
        _release_implicit(session_id, key)


async def generate(
    *,
    session_id: str,
    artifact_type: str,
    nodes_json: str,
    edges_json: str,
    transcript_excerpt: str,
    refinement_hint: str = "",
    section_anchor: str = "",
    at_timestamp: str = "",
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict:
    """Dispatch an ArtifactGenerateRequest, await the agent's HTTP callback."""
    addr = _artifact_address()
    request_id, fut = await _register_future()
    key = ("generate", artifact_type, section_anchor)
    _claim_implicit(session_id, key, request_id)

    if not addr:
        await _drop_future(request_id)
        _release_implicit(session_id, key)
        raise ArtifactClientError("artifact agent address not registered")

    req = ArtifactGenerateRequest(
        session_id=session_id,
        artifact_type=artifact_type,
        nodes_json=nodes_json,
        edges_json=edges_json,
        transcript_excerpt=transcript_excerpt,
        refinement_hint=refinement_hint,
        section_anchor=section_anchor,
        at_timestamp=at_timestamp,
    )
    sent = await _send_to_agent(addr, req)
    if not sent:
        await _drop_future(request_id)
        _release_implicit(session_id, key)
        raise ArtifactClientError("send to artifact agent failed")

    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    finally:
        await _drop_future(request_id)
        _release_implicit(session_id, key)


__all__ = [
    "classify",
    "generate",
    "deliver_result",
    "lookup_implicit",
    "ArtifactClientError",
    "DEFAULT_TIMEOUT_SECONDS",
]
