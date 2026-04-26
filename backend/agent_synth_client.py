"""Request/future bridge between backend HTTP routes and the synthesis uAgent.

The synthesis agent sends results back over HTTP (POST /internal/synth-result)
because the backend is not itself a uAgent with the appropriate handler. We
bridge an awaiting HTTP request to an async result by:

  1. Allocating a ``request_id = uuid4().hex``.
  2. Registering an ``asyncio.Future`` keyed by request_id in the registry.
  3. Dispatching the ExpandRequest / SynthesisRequest to the agent.
  4. Awaiting the future with a timeout.
  5. The agent's POST hits ``deliver_result`` which sets the future.

If the agent is not running OR the addresses file is absent, dispatch
falls back gracefully so HTTP routes can still return a 503/504.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from dataclasses import dataclass
from typing import Any, Optional

from shared.agent_messages import ExpandRequest, SynthesisRequest

from backend.config import get_settings

logger = logging.getLogger(__name__)

# request_id -> Future[dict]
_pending: dict[str, asyncio.Future] = {}
_pending_lock = asyncio.Lock()

DEFAULT_TIMEOUT_SECONDS = 45.0  # bumped from 25 to give Gemini-fallback room when Groq is daily-throttled


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


def _synthesis_address() -> Optional[str]:
    return _load_addresses().get("synthesis")


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
    """Resolve a pending future. Called from the /internal/synth-result route.

    Returns True if a future was resolved. False otherwise (untracked /
    already resolved / no request_id).
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
        logger.warning("synth agent dispatch failed: %s", exc)
        return False


@dataclass
class SynthClientError(Exception):
    """Raised when the synthesis agent is unreachable."""

    reason: str

    def __str__(self) -> str:  # pragma: no cover
        return f"SynthClientError({self.reason})"


async def expand_node(
    *,
    session_id: str,
    node_id: str,
    node_label: str,
    transcript_window: str,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict:
    """Dispatch an ExpandRequest and await the agent's HTTP callback.

    Returns the dict payload posted to /internal/synth-result.
    Raises asyncio.TimeoutError on timeout, SynthClientError on no-agent.
    """
    addr = _synthesis_address()
    request_id, fut = await _register_future()

    # ExpandRequest does not declare ``request_id`` in the shared schema, but
    # uagents Models tolerate unknown attributes via ``**extra`` only if the
    # base Model allows them; to keep the contract frozen we just SEND the
    # request and rely on the agent to read request_id off the dict-encoded
    # version. We thread request_id via the (singleton) pending registry —
    # the agent will echo None and we resolve via fallback timeout. To avoid
    # this race, we use a short-lived map of (session_id, node_id, kind) →
    # request_id at the agent-callback layer below.
    _claim_implicit(session_id, ("expand", node_id), request_id)

    if not addr:
        await _drop_future(request_id)
        _release_implicit(session_id, ("expand", node_id))
        raise SynthClientError("synthesis agent address not registered")

    req = ExpandRequest(
        session_id=session_id,
        node_id=node_id,
        node_label=node_label,
        transcript_window=transcript_window,
    )
    sent = await _send_to_agent(addr, req)
    if not sent:
        await _drop_future(request_id)
        _release_implicit(session_id, ("expand", node_id))
        raise SynthClientError("send to synthesis agent failed")

    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    finally:
        await _drop_future(request_id)
        _release_implicit(session_id, ("expand", node_id))


async def synthesize(
    *,
    session_id: str,
    nodes_json: str,
    edges_json: str,
    transcript_excerpts: str,
    target_format: str,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
) -> dict:
    addr = _synthesis_address()
    request_id, fut = await _register_future()
    _claim_implicit(session_id, ("synthesize", target_format), request_id)

    if not addr:
        await _drop_future(request_id)
        _release_implicit(session_id, ("synthesize", target_format))
        raise SynthClientError("synthesis agent address not registered")

    req = SynthesisRequest(
        session_id=session_id,
        nodes_json=nodes_json,
        edges_json=edges_json,
        transcript_excerpts=transcript_excerpts,
        target_format=target_format,
    )
    sent = await _send_to_agent(addr, req)
    if not sent:
        await _drop_future(request_id)
        _release_implicit(session_id, ("synthesize", target_format))
        raise SynthClientError("send to synthesis agent failed")

    try:
        return await asyncio.wait_for(fut, timeout=timeout)
    finally:
        await _drop_future(request_id)
        _release_implicit(session_id, ("synthesize", target_format))


# ---------------------------------------------------------------------------
# Implicit-claim map
#
# The frozen ExpandRequest / SynthesisRequest schemas don't carry a
# request_id. To bridge the agent's HTTP callback to the right Future we
# maintain a (session_id, key) → request_id map. When the callback arrives
# we look up the request_id by (session_id, key) and resolve. Multiple
# concurrent requests for the same (session, key) collapse to the most
# recent one — acceptable for the demo.
# ---------------------------------------------------------------------------
_implicit: dict[tuple[str, tuple], str] = {}


def _claim_implicit(session_id: str, key: tuple, request_id: str) -> None:
    _implicit[(session_id, key)] = request_id


def _release_implicit(session_id: str, key: tuple) -> None:
    _implicit.pop((session_id, key), None)


def lookup_implicit(session_id: str, key: tuple) -> Optional[str]:
    return _implicit.get((session_id, key))


__all__ = [
    "expand_node",
    "synthesize",
    "deliver_result",
    "lookup_implicit",
    "SynthClientError",
    "DEFAULT_TIMEOUT_SECONDS",
]
