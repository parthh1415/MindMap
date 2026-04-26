"""Artifact uAgent — listens for ArtifactClassifyRequest + ArtifactGenerateRequest.

Run standalone:
    python agents/artifact_agent.py

Port: ARTIFACT_AGENT_PORT (default 8005)
Seed: ARTIFACT_AGENT_SEED (optional)

Behavior:
- Receives an ArtifactClassifyRequest or ArtifactGenerateRequest.
- Calls the matching helper in ``artifact_llm`` (Groq primary, Gemini
  fallback on 429).
- Replies via uagents ctx.send AND posts the result to the backend HTTP
  fallback at ``${BACKEND_URL}/internal/artifact-result`` so the backend
  can resolve a pending asyncio.Future keyed by request_id.
"""
from __future__ import annotations

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
    ArtifactClassifyRequest,
    ArtifactClassifyResponse,
    ArtifactGenerateRequest,
    ArtifactGenerateResponse,
)

# Sibling imports.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import artifact_llm  # noqa: E402
from agentverse_register import register_chat_agent  # noqa: E402

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
)
logger = logging.getLogger("agents.artifact")

PORT = int(os.getenv("ARTIFACT_AGENT_PORT", "8005"))
SEED = os.getenv("ARTIFACT_AGENT_SEED") or "mindmap-artifact-default-seed"
BACKEND_URL = os.getenv("BACKEND_URL", "http://localhost:8000")
BACKEND_RESULT_ENDPOINT = f"{BACKEND_URL.rstrip('/')}/internal/artifact-result"

agent = Agent(
    name="mindmap_artifact",
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
        logger.warning(
            "Backend artifact-result POST failed (%s): %s",
            BACKEND_RESULT_ENDPOINT,
            exc,
        )


@agent.on_event("startup")
async def _on_startup(ctx: Context) -> None:
    logger.info("Artifact agent starting on port %d", PORT)
    logger.info("Artifact agent address: %s", agent.address)
    try:
        register_chat_agent(agent, "artifact")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Agentverse registration failed: %s", exc)


@agent.on_message(model=ArtifactClassifyRequest)
async def _handle_classify(
    ctx: Context, sender: str, msg: ArtifactClassifyRequest
) -> None:
    logger.info(
        "ArtifactClassifyRequest session=%s nodes_chars=%d edges_chars=%d transcript_chars=%d",
        msg.session_id,
        len(msg.nodes_json or ""),
        len(msg.edges_json or ""),
        len(msg.transcript_excerpt or ""),
    )
    request_id = getattr(msg, "request_id", None)

    top_choice = "brief"
    confidence = 0.0
    candidates: list[dict] = []
    try:
        result = await artifact_llm.classify_artifact(
            nodes_json=msg.nodes_json,
            edges_json=msg.edges_json,
            transcript_excerpt=msg.transcript_excerpt,
        )
        top_choice = result["top_choice"]
        confidence = result["confidence"]
        candidates = result["candidates"]
    except Exception as exc:  # noqa: BLE001
        logger.exception("classify_artifact failed: %s", exc)
        candidates = [{"type": "brief", "score": 0.5, "why": "fallback"}]
        top_choice = "brief"
        confidence = 0.5

    response = ArtifactClassifyResponse(
        session_id=msg.session_id,
        top_choice=top_choice,
        confidence=confidence,
        candidates=candidates,
    )
    try:
        await ctx.send(sender, response)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ctx.send(ArtifactClassifyResponse) failed: %s", exc)

    await _post_back(
        {
            "kind": "classify",
            "session_id": msg.session_id,
            "request_id": request_id,
            "top_choice": top_choice,
            "confidence": confidence,
            "candidates": candidates,
        }
    )


@agent.on_message(model=ArtifactGenerateRequest)
async def _handle_generate(
    ctx: Context, sender: str, msg: ArtifactGenerateRequest
) -> None:
    logger.info(
        "ArtifactGenerateRequest session=%s type=%s anchor=%r refine=%r",
        msg.session_id,
        msg.artifact_type,
        msg.section_anchor,
        msg.refinement_hint,
    )
    request_id = getattr(msg, "request_id", None)

    title = ""
    markdown = ""
    files: list[dict] = []
    evidence: list[dict] = []
    try:
        result = await artifact_llm.generate_artifact(
            artifact_type=msg.artifact_type,
            nodes_json=msg.nodes_json,
            edges_json=msg.edges_json,
            transcript_excerpt=msg.transcript_excerpt,
            refinement_hint=msg.refinement_hint or "",
            section_anchor=msg.section_anchor or "",
        )
        title = result["title"]
        markdown = result["markdown"]
        files = result["files"]
        evidence = result["evidence"]
    except Exception as exc:  # noqa: BLE001
        logger.exception("generate_artifact failed: %s", exc)
        title = f"{msg.artifact_type.title()} unavailable"
        markdown = (
            f"# {title}\n\n"
            "The artifact service could not produce a result. Please try again."
        )
        files = []
        evidence = []

    response = ArtifactGenerateResponse(
        session_id=msg.session_id,
        artifact_type=msg.artifact_type,
        title=title,
        markdown=markdown,
        files=files,
        evidence=evidence,
    )
    try:
        await ctx.send(sender, response)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ctx.send(ArtifactGenerateResponse) failed: %s", exc)

    await _post_back(
        {
            "kind": "generate",
            "session_id": msg.session_id,
            "request_id": request_id,
            "artifact_type": msg.artifact_type,
            "title": title,
            "markdown": markdown,
            "files": files,
            "evidence": evidence,
            "section_anchor": msg.section_anchor or "",
            "refinement_hint": msg.refinement_hint or "",
        }
    )


if __name__ == "__main__":
    agent.run()
