"""Synthesis uAgent — listens for ExpandRequest + SynthesisRequest.

Run standalone:
    python agents/synthesis_agent.py

Port: SYNTHESIS_AGENT_PORT (default 8003)
Seed: SYNTHESIS_AGENT_SEED (optional)

Like the topology agent, after returning the response over uagents, this
process ALSO POSTs the result to backend's HTTP fallback at
``${BACKEND_URL}/internal/synth-result`` so backend can resolve a pending
asyncio.Future keyed by request_id (the topology-style pattern).
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

load_dotenv(_REPO_ROOT / ".env")

from uagents import Agent, Context  # noqa: E402

from shared.agent_messages import (  # noqa: E402
    ExpandRequest,
    ExpandResponse,
    SynthesisRequest,
    SynthesisResponse,
)

# Sibling imports.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import synthesis_llm  # noqa: E402
from agentverse_register import register_chat_agent  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("agents.synthesis")

PORT = int(os.getenv("SYNTHESIS_AGENT_PORT", "8003"))
SEED = os.getenv("SYNTHESIS_AGENT_SEED") or "mindmap-synthesis-default-seed"
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")
BACKEND_RESULT_ENDPOINT = f"{BACKEND_URL.rstrip('/')}/internal/synth-result"

agent = Agent(
    name="mindmap_synthesis",
    seed=SEED,
    port=PORT,
    endpoint=[f"http://127.0.0.1:{PORT}/submit"],
)


async def _post_back(payload: dict) -> None:
    """Best-effort POST to the backend HTTP fallback. Never raises."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(BACKEND_RESULT_ENDPOINT, json=payload)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Backend synth-result POST failed (%s): %s", BACKEND_RESULT_ENDPOINT, exc)


@agent.on_event("startup")
async def _on_startup(ctx: Context) -> None:
    logger.info("Synthesis agent starting on port %d", PORT)
    logger.info("Synthesis agent address: %s", agent.address)
    try:
        register_chat_agent(agent, "synthesis")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Agentverse registration failed: %s", exc)


@agent.on_message(model=ExpandRequest)
async def _handle_expand(ctx: Context, sender: str, msg: ExpandRequest) -> None:
    logger.info(
        "ExpandRequest session=%s node=%s label=%r", msg.session_id, msg.node_id, msg.node_label
    )
    request_id = getattr(msg, "request_id", None)  # message field may not exist
    children: list[dict] = []
    try:
        children = await synthesis_llm.expand_node(
            label=msg.node_label,
            transcript_window=msg.transcript_window,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("expand_node failed: %s", exc)
        children = []

    response = ExpandResponse(
        session_id=msg.session_id,
        node_id=msg.node_id,
        children=children,
    )
    try:
        await ctx.send(sender, response)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ctx.send(ExpandResponse) failed: %s", exc)

    await _post_back(
        {
            "kind": "expand",
            "session_id": msg.session_id,
            "node_id": msg.node_id,
            "request_id": request_id,
            "children": children,
        }
    )


@agent.on_message(model=SynthesisRequest)
async def _handle_synthesize(ctx: Context, sender: str, msg: SynthesisRequest) -> None:
    logger.info(
        "SynthesisRequest session=%s format=%s", msg.session_id, msg.target_format
    )
    request_id = getattr(msg, "request_id", None)
    title = ""
    markdown = ""
    try:
        result = await synthesis_llm.synthesize(
            nodes_json=msg.nodes_json,
            edges_json=msg.edges_json,
            transcript_excerpts=msg.transcript_excerpts,
            target_format=msg.target_format,
        )
        title = result["title"]
        markdown = result["markdown"]
    except Exception as exc:  # noqa: BLE001
        logger.exception("synthesize failed: %s", exc)
        title = "Synthesis unavailable"
        markdown = (
            "# Synthesis unavailable\n\n"
            "The synthesis service could not produce a result. Please try again."
        )

    response = SynthesisResponse(
        session_id=msg.session_id,
        title=title,
        markdown=markdown,
        target_format=msg.target_format,
    )
    try:
        await ctx.send(sender, response)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ctx.send(SynthesisResponse) failed: %s", exc)

    await _post_back(
        {
            "kind": "synthesize",
            "session_id": msg.session_id,
            "request_id": request_id,
            "title": title,
            "markdown": markdown,
            "target_format": msg.target_format,
        }
    )


if __name__ == "__main__":
    agent.run()
