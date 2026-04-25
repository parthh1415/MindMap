"""Topology uAgent — listens for TopologyRequest, returns TopologyDiff.

Run standalone:
    python agents/topology_agent.py

Port: TOPOLOGY_AGENT_PORT (default 8001)
Seed: TOPOLOGY_AGENT_SEED (optional; uagents will derive a deterministic id)
"""
from __future__ import annotations

import json
import logging
import os
import sys
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

from shared.agent_messages import TopologyDiff, TopologyRequest  # noqa: E402

# Local imports (agents/ is the script dir).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm  # noqa: E402
from agentverse_register import register_chat_agent  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("agents.topology")

PORT = int(os.getenv("TOPOLOGY_AGENT_PORT", "8001"))
SEED = os.getenv("TOPOLOGY_AGENT_SEED") or "mindmap-topology-default-seed"
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")
BACKEND_DIFF_ENDPOINT = f"{BACKEND_URL.rstrip('/')}/internal/topology-diff"

agent = Agent(
    name="mindmap_topology",
    seed=SEED,
    port=PORT,
    endpoint=[f"http://127.0.0.1:{PORT}/submit"],
)


@agent.on_event("startup")
async def _on_startup(ctx: Context) -> None:
    logger.info("Topology agent starting on port %d", PORT)
    logger.info("Topology agent address: %s", agent.address)
    try:
        register_chat_agent(agent, "topology")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Agentverse registration failed: %s", exc)


@agent.on_message(model=TopologyRequest)
async def _handle_topology(ctx: Context, sender: str, msg: TopologyRequest) -> None:
    logger.info("TopologyRequest session=%s speaker=%s", msg.session_id, msg.speaker_id)
    try:
        diff: TopologyDiff = await llm.stream_topology_diff(
            graph_json=msg.current_graph_json,
            last_words=msg.last_n_words,
            session_id=msg.session_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Topology generation failed: %s", exc)
        diff = TopologyDiff(
            session_id=msg.session_id,
            additions_nodes=[],
            additions_edges=[],
            merges=[],
            edge_updates=[],
        )
    # Native uagents return path (works only when sender is also a uagent that
    # has registered a TopologyDiff @on_message handler).
    await ctx.send(sender, diff)

    # Backend HTTP fallback. The backend exposes POST /internal/topology-diff
    # as the supported close-the-loop path because it is not itself a uagent
    # with a TopologyDiff handler. This is the path the live mic flow uses:
    # backend → topology agent (via uagents send) → Groq → BACK to backend
    # over HTTP → broadcast to /ws/graph subscribers.
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(BACKEND_DIFF_ENDPOINT, json=json.loads(diff.model_dump_json()))
    except Exception as exc:  # noqa: BLE001
        logger.warning("Backend diff POST failed (%s): %s", BACKEND_DIFF_ENDPOINT, exc)


if __name__ == "__main__":
    agent.run()
