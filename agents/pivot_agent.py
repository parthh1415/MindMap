"""Pivot uAgent — listens for PivotRequest, returns PivotResponse.

Run standalone:
    python agents/pivot_agent.py

Port: PIVOT_AGENT_PORT (default 8004)
Seed: PIVOT_AGENT_SEED (optional; uagents derives a deterministic id)

Behavior:
- For each PivotRequest, calls Groq via pivot_llm.detect_pivots.
- Converts the timestamp_offset_seconds (negative) into an absolute ISO
  timestamp (UTC) anchored at "now".
- Replies via uagents ctx.send AND posts an HTTP fallback to
  ${BACKEND_URL}/internal/pivot-result so the backend can resolve a
  pending request future (same future-bridge pattern as synthesis).
"""
from __future__ import annotations

import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx
from dotenv import load_dotenv

# sys.path tweak so `from shared.agent_messages import ...` works when running
# from the repo root OR from inside agents/.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

load_dotenv(_REPO_ROOT / ".env")

from uagents import Agent, Context  # noqa: E402

from shared.agent_messages import (  # noqa: E402
    PivotPoint,
    PivotRequest,
    PivotResponse,
)

# Local imports (agents/ is the script dir).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import pivot_llm  # noqa: E402
from agentverse_register import register_chat_agent  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("agents.pivot")

PORT = int(os.getenv("PIVOT_AGENT_PORT", "8004"))
SEED = os.getenv("PIVOT_AGENT_SEED") or "mindmap-pivot-default-seed"
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")
BACKEND_RESULT_ENDPOINT = f"{BACKEND_URL.rstrip('/')}/internal/pivot-result"

agent = Agent(
    name="mindmap_pivot",
    seed=SEED,
    port=PORT,
    endpoint=[f"http://127.0.0.1:{PORT}/submit"],
)


def _offset_to_iso(offset_seconds: int, *, now: datetime | None = None) -> str:
    """Convert a negative offset (sec) into an absolute ISO 8601 UTC string."""
    if now is None:
        now = datetime.now(timezone.utc)
    return (now + timedelta(seconds=offset_seconds)).isoformat()


def _request_id_from(msg: PivotRequest) -> str:
    """Best-effort: callers may smuggle a request_id in the transcript text;
    we prefer the explicit field. PivotRequest does not have a request_id
    in the frozen contract, so the backend derives it from session_id +
    timestamp before dispatch and keys the future on (session_id, request_id).
    Here we just echo session_id; backend matches on the most recent pending.
    """
    return msg.session_id


@agent.on_event("startup")
async def _on_startup(ctx: Context) -> None:
    logger.info("Pivot agent starting on port %d", PORT)
    logger.info("Pivot agent address: %s", agent.address)
    try:
        register_chat_agent(agent, "pivot")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Agentverse registration failed: %s", exc)


@agent.on_message(model=PivotRequest)
async def _handle_pivot(ctx: Context, sender: str, msg: PivotRequest) -> None:
    logger.info(
        "PivotRequest session=%s labels=%d transcript_chars=%d",
        msg.session_id,
        len(msg.current_node_labels),
        len(msg.transcript_excerpt or ""),
    )
    try:
        raw_pivots = await pivot_llm.detect_pivots(
            transcript_excerpt=msg.transcript_excerpt,
            current_node_labels=list(msg.current_node_labels or []),
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Pivot detection failed: %s", exc)
        raw_pivots = []

    now = datetime.now(timezone.utc)
    pivot_points: list[PivotPoint] = []
    for entry in raw_pivots:
        try:
            ts = _offset_to_iso(int(entry["timestamp_offset_seconds"]), now=now)
            pivot_points.append(
                PivotPoint(
                    timestamp=ts,
                    why=str(entry["why"]),
                    pivot_label=str(entry["pivot_label"]),
                )
            )
        except (KeyError, TypeError, ValueError) as exc:
            logger.warning("Discarding malformed pivot %r: %s", entry, exc)
            continue

    response = PivotResponse(session_id=msg.session_id, pivots=pivot_points)
    await ctx.send(sender, response)

    # Backend HTTP fallback. The backend exposes POST /internal/pivot-result
    # as the close-the-loop path because it is not a uagent itself.
    try:
        body = {
            "request_id": _request_id_from(msg),
            "session_id": msg.session_id,
            "pivots": [
                {
                    "timestamp": p.timestamp,
                    "why": p.why,
                    "pivot_label": p.pivot_label,
                }
                for p in pivot_points
            ],
        }
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(BACKEND_RESULT_ENDPOINT, json=body)
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "Backend pivot-result POST failed (%s): %s",
            BACKEND_RESULT_ENDPOINT,
            exc,
        )


if __name__ == "__main__":
    agent.run()
