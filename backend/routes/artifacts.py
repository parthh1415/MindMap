"""Artifact-generator routes — classify + generate + history.

Frozen endpoint shapes (per shared.agent_messages):
  POST  /sessions/{sid}/classify-artifact     → ArtifactClassifyResponse
  POST  /sessions/{sid}/generate-artifact     → ArtifactGenerateResponse + persist
        body: {artifact_type, refinement_hint?, section_anchor?, at?: ISO}
  GET   /sessions/{sid}/artifacts             → {artifacts: [...]}
  GET   /artifacts/{artifact_id}              → single artifact
  POST  /internal/artifact-result             → agent callback
"""
from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase
from pydantic import BaseModel, Field

from backend import agent_artifact_client
from backend.db import artifacts_repo, edges_repo, nodes_repo
from backend.db.client import get_db
from backend import diarize_cache
from backend.ring_buffer import get_buffer

from shared.agent_messages import ARTIFACT_TYPES

logger = logging.getLogger(__name__)
router = APIRouter(tags=["artifacts"])


# ---------------------------------------------------------------------------
# Request bodies
# ---------------------------------------------------------------------------
class ClassifyArtifactBody(BaseModel):
    at: Optional[str] = None  # ISO timestamp; defaults to live state


class GenerateArtifactBody(BaseModel):
    artifact_type: str
    refinement_hint: str = ""
    section_anchor: str = ""
    at: Optional[str] = None


class ArtifactResultBody(BaseModel):
    kind: str  # "classify" | "generate"
    session_id: str
    request_id: Optional[str] = None
    # classify fields
    top_choice: Optional[str] = None
    confidence: Optional[float] = None
    candidates: Optional[list[dict]] = None
    # generate fields
    artifact_type: Optional[str] = None
    title: Optional[str] = None
    markdown: Optional[str] = None
    files: Optional[list[dict]] = None
    evidence: Optional[list[dict]] = None
    section_anchor: Optional[str] = None
    refinement_hint: Optional[str] = None


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


def _parse_timestamp(at: Optional[str]) -> Optional[datetime]:
    if not at:
        return None
    try:
        # Tolerate "Z" suffix.
        if at.endswith("Z"):
            at = at[:-1] + "+00:00"
        ts = datetime.fromisoformat(at)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts
    except ValueError as exc:
        raise HTTPException(400, f"invalid 'at' timestamp: {exc}")


async def _gather_payload(
    db: AsyncIOMotorDatabase,
    session_id: str,
    at: Optional[str],
) -> tuple[str, str, str, Optional[datetime]]:
    """Build (nodes_json, edges_json, transcript, parsed_at)."""
    parsed_at = _parse_timestamp(at)
    if parsed_at is not None:
        nodes = await nodes_repo.find_at(db, session_id, parsed_at)
        edges = await edges_repo.find_at(db, session_id, parsed_at)
    else:
        nodes = await nodes_repo.list_live(db, session_id)
        edges = await edges_repo.list_live(db, session_id)

    nodes_json = json.dumps(_isoformat(nodes), default=str)
    edges_json = json.dumps(_isoformat(edges), default=str)

    # Prefer the speaker-diarized transcript when the parallel batch
    # job has populated it for this session. Falls back to the live
    # ring buffer if diarization isn't ready yet — the artifact LLM
    # then runs exactly like Phase 12 (no speaker context, no extra
    # latency). This is the "zero added latency" promise.
    transcript = ""
    try:
        diarized = await diarize_cache.get(session_id)
        if diarized:
            transcript = diarize_cache.format_for_prompt(diarized)
    except Exception:  # noqa: BLE001
        transcript = ""

    if not transcript:
        try:
            transcript = get_buffer().snapshot(session_id)
        except Exception:  # noqa: BLE001
            transcript = ""

    return nodes_json, edges_json, transcript, parsed_at


def _serialize_artifact(doc: dict) -> dict:
    out = dict(doc)
    out["artifact_id"] = out.pop("_id")
    if isinstance(out.get("generated_at"), datetime):
        out["generated_at"] = out["generated_at"].isoformat()
    if isinstance(out.get("pinned_at"), datetime):
        out["pinned_at"] = out["pinned_at"].isoformat()
    # Default to False so the frontend doesn't have to handle undefined.
    out.setdefault("pinned", False)
    return out


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------
@router.post("/sessions/{session_id}/classify-artifact")
async def classify_artifact_route(
    session_id: str,
    body: Optional[ClassifyArtifactBody] = None,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    at = body.at if body else None
    nodes_json, edges_json, transcript, _ = await _gather_payload(db, session_id, at)

    try:
        payload = await agent_artifact_client.classify(
            session_id=session_id,
            nodes_json=nodes_json,
            edges_json=edges_json,
            transcript_excerpt=transcript,
            timeout=agent_artifact_client.DEFAULT_TIMEOUT_SECONDS,
        )
    except agent_artifact_client.ArtifactClientError as exc:
        raise HTTPException(503, f"artifact agent unavailable: {exc.reason}")
    except asyncio.TimeoutError:
        raise HTTPException(504, "artifact agent timed out")

    return {
        "session_id": session_id,
        "top_choice": payload.get("top_choice", "brief"),
        "confidence": payload.get("confidence", 0.0),
        "candidates": payload.get("candidates", []) or [],
    }


@router.post("/sessions/{session_id}/generate-artifact")
async def generate_artifact_route(
    session_id: str,
    body: GenerateArtifactBody,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    if body.artifact_type not in ARTIFACT_TYPES:
        raise HTTPException(
            400,
            f"artifact_type must be one of {list(ARTIFACT_TYPES)}",
        )

    nodes_json, edges_json, transcript, _ = await _gather_payload(
        db, session_id, body.at
    )

    try:
        payload = await agent_artifact_client.generate(
            session_id=session_id,
            artifact_type=body.artifact_type,
            nodes_json=nodes_json,
            edges_json=edges_json,
            transcript_excerpt=transcript,
            refinement_hint=body.refinement_hint or "",
            section_anchor=body.section_anchor or "",
            at_timestamp=body.at or "",
            timeout=agent_artifact_client.DEFAULT_TIMEOUT_SECONDS,
        )
    except agent_artifact_client.ArtifactClientError as exc:
        raise HTTPException(503, f"artifact agent unavailable: {exc.reason}")
    except asyncio.TimeoutError:
        raise HTTPException(504, "artifact agent timed out")

    title = str(payload.get("title", "")).strip() or body.artifact_type.title()
    markdown = str(payload.get("markdown", ""))
    files = payload.get("files") or []
    evidence = payload.get("evidence") or []

    # Persist.
    doc = {
        "session_id": session_id,
        "artifact_type": body.artifact_type,
        "title": title,
        "markdown": markdown,
        "files": files,
        "evidence": evidence,
        "refinement_hint": body.refinement_hint or "",
        "section_anchor": body.section_anchor or "",
        "at_timestamp": body.at or None,
    }
    saved = await artifacts_repo.create_artifact(db, doc)

    return {
        "session_id": session_id,
        "artifact_id": saved["_id"],
        "artifact_type": body.artifact_type,
        "title": title,
        "markdown": markdown,
        "files": files,
        "evidence": evidence,
    }


@router.get("/sessions/{session_id}/artifacts")
async def list_session_artifacts(
    session_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    docs = await artifacts_repo.list_for_session(db, session_id, limit=20)
    return {"artifacts": [_serialize_artifact(d) for d in docs]}


@router.get("/artifacts/{artifact_id}")
async def get_artifact_route(
    artifact_id: str,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    doc = await artifacts_repo.get_artifact(db, artifact_id)
    if doc is None:
        raise HTTPException(404, "artifact not found")
    return _serialize_artifact(doc)


class PinArtifactBody(BaseModel):
    pinned: bool


@router.patch("/artifacts/{artifact_id}/pin")
async def pin_artifact_route(
    artifact_id: str,
    body: PinArtifactBody,
    db: AsyncIOMotorDatabase = Depends(get_db),
):
    """Toggle the saved/pinned flag on an artifact. Pinned artifacts
    are kept indefinitely and surface to the top of the session
    history list."""
    doc = await artifacts_repo.set_pinned(db, artifact_id, body.pinned)
    if doc is None:
        raise HTTPException(404, "artifact not found")
    return _serialize_artifact(doc)


@router.post("/internal/artifact-result")
async def post_artifact_result(body: ArtifactResultBody):
    """Callback from the artifact agent. Resolves the pending future."""
    request_id = body.request_id
    payload = body.model_dump()

    # Implicit-claim fallback: frozen request schemas don't carry request_id.
    if not request_id:
        if body.kind == "classify":
            request_id = agent_artifact_client.lookup_implicit(
                body.session_id, ("classify",)
            )
        elif body.kind == "generate" and body.artifact_type:
            request_id = agent_artifact_client.lookup_implicit(
                body.session_id,
                ("generate", body.artifact_type, body.section_anchor or ""),
            )

    resolved = await agent_artifact_client.deliver_result(request_id, payload)
    return {"ok": True, "resolved": resolved}
