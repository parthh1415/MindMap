"""Enrichment uAgent — listens for EnrichmentRequest, returns EnrichmentResponse.

Run standalone:
    python agents/enrichment_agent.py

Port: ENRICHMENT_AGENT_PORT (default 8002)
Seed: ENRICHMENT_AGENT_SEED (optional)
"""
from __future__ import annotations

import logging
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

load_dotenv(_REPO_ROOT / ".env")

from uagents import Agent, Context  # noqa: E402

from shared.agent_messages import EnrichmentRequest, EnrichmentResponse  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm  # noqa: E402
from agentverse_register import register_chat_agent  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("agents.enrichment")

PORT = int(os.getenv("ENRICHMENT_AGENT_PORT", "8002"))
SEED = os.getenv("ENRICHMENT_AGENT_SEED") or "mindmap-enrichment-default-seed"

agent = Agent(
    name="mindmap_enrichment",
    seed=SEED,
    port=PORT,
    endpoint=[f"http://127.0.0.1:{PORT}/submit"],
)


@agent.on_event("startup")
async def _on_startup(ctx: Context) -> None:
    logger.info("Enrichment agent starting on port %d", PORT)
    logger.info("Enrichment agent address: %s", agent.address)
    try:
        register_chat_agent(agent, "enrichment")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Agentverse registration failed: %s", exc)


@agent.on_message(model=EnrichmentRequest)
async def _handle_enrichment(
    ctx: Context, sender: str, msg: EnrichmentRequest
) -> None:
    logger.info(
        "EnrichmentRequest session=%s node=%s label=%r",
        msg.session_id,
        msg.node_id,
        msg.node_label,
    )
    try:
        points = await llm.generate_enrichment(
            node_label=msg.node_label,
            transcript_segment=msg.transcript_segment,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("Enrichment generation failed: %s", exc)
        points = []

    response = EnrichmentResponse(
        session_id=msg.session_id,
        node_id=msg.node_id,
        info_entries=points,
    )
    await ctx.send(sender, response)


if __name__ == "__main__":
    agent.run()
