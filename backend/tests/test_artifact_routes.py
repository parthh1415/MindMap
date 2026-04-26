"""Tests for backend/routes/artifacts.py.

Pattern mirrors test_synthesis_routes.py:
  - Monkey-patch ``backend.agent_artifact_client._send_to_agent`` so the
    artifact agent isn't actually contacted.
  - For success paths: schedule a thread that POSTs the agent callback to
    /internal/artifact-result; the route awaits the future bridge.
  - For 504 path: return True from _send but never POST back.
"""
from __future__ import annotations

import asyncio
import threading
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend import agent_artifact_client


@pytest.fixture
def client(db, monkeypatch):
    from backend.db import client as client_module

    monkeypatch.setattr(client_module, "_db", db, raising=False)

    from backend.main import app

    return TestClient(app)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_node(db, *, session_id: str, node_id: str, label: str, created_at=None) -> None:
    db.nodes._docs.append(
        {
            "_id": node_id,
            "session_id": session_id,
            "label": label,
            "created_at": created_at or datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "info": [],
            "importance_score": 1.0,
        }
    )


# Mock-callback helpers shorten DEFAULT_TIMEOUT_SECONDS so tests don't
# pay the production-grade 45s wait for each "completes" assertion.
# The thread-based callback delivers fast in practice; we just need a
# small window so an unexpected hang fails loudly instead of stalling
# the whole suite (the prior default cost ~270s of pure timeout).
_TEST_AGENT_TIMEOUT = 3.0


def _patch_classify_callback(client: TestClient, monkeypatch, payload: dict):
    async def _fake_send(addr, message):
        body = {
            "kind": "classify",
            "session_id": message.session_id,
            "request_id": None,
            **payload,
        }

        def _post():
            client.post("/internal/artifact-result", json=body)

        threading.Thread(target=_post, daemon=True).start()
        return True

    monkeypatch.setattr(agent_artifact_client, "_send_to_agent", _fake_send)
    monkeypatch.setattr(agent_artifact_client, "_artifact_address", lambda: "agent1mockaddr")
    monkeypatch.setattr(agent_artifact_client, "DEFAULT_TIMEOUT_SECONDS", _TEST_AGENT_TIMEOUT)


def _patch_generate_callback(client: TestClient, monkeypatch, payload: dict):
    async def _fake_send(addr, message):
        body = {
            "kind": "generate",
            "session_id": message.session_id,
            "request_id": None,
            "artifact_type": message.artifact_type,
            "section_anchor": message.section_anchor or "",
            "refinement_hint": message.refinement_hint or "",
            **payload,
        }

        def _post():
            client.post("/internal/artifact-result", json=body)

        threading.Thread(target=_post, daemon=True).start()
        return True

    monkeypatch.setattr(agent_artifact_client, "_send_to_agent", _fake_send)
    monkeypatch.setattr(agent_artifact_client, "_artifact_address", lambda: "agent1mockaddr")
    monkeypatch.setattr(agent_artifact_client, "DEFAULT_TIMEOUT_SECONDS", _TEST_AGENT_TIMEOUT)


# ---------------------------------------------------------------------------
# classify route
# ---------------------------------------------------------------------------
def test_classify_503_when_no_agent(client, monkeypatch, db):
    monkeypatch.setattr(agent_artifact_client, "_artifact_address", lambda: None)
    r = client.post("/sessions/s1/classify-artifact", json={})
    assert r.status_code == 503


def test_classify_completes(client, monkeypatch, db):
    _make_node(db, session_id="s1", node_id="n1", label="Auth service")
    _patch_classify_callback(
        client,
        monkeypatch,
        {
            "top_choice": "scaffold",
            "confidence": 0.8,
            "candidates": [
                {"type": "scaffold", "score": 0.8, "why": "infra nouns"},
                {"type": "prd", "score": 0.5, "why": "..."},
                {"type": "brief", "score": 0.3, "why": "fallback"},
            ],
        },
    )
    r = client.post("/sessions/s1/classify-artifact", json={})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["top_choice"] == "scaffold"
    assert len(body["candidates"]) == 3


def test_classify_504_on_timeout(client, monkeypatch, db):
    _make_node(db, session_id="s1", node_id="n1", label="x")
    monkeypatch.setattr(agent_artifact_client, "_artifact_address", lambda: "agent1mockaddr")

    async def _silent(addr, message):
        return True

    monkeypatch.setattr(agent_artifact_client, "_send_to_agent", _silent)
    monkeypatch.setattr(agent_artifact_client, "DEFAULT_TIMEOUT_SECONDS", 0.2)

    r = client.post("/sessions/s1/classify-artifact", json={})
    assert r.status_code == 504


# ---------------------------------------------------------------------------
# generate route
# ---------------------------------------------------------------------------
def test_generate_rejects_unknown_type(client, monkeypatch, db):
    monkeypatch.setattr(agent_artifact_client, "_artifact_address", lambda: "agent1mockaddr")
    r = client.post(
        "/sessions/s1/generate-artifact",
        json={"artifact_type": "frob"},
    )
    assert r.status_code == 400


def test_generate_persists_and_lists(client, monkeypatch, db):
    _make_node(db, session_id="s1", node_id="n1", label="Voice notes")
    _patch_generate_callback(
        client,
        monkeypatch,
        {
            "title": "Voice Notes PRD",
            "markdown": "# Voice Notes PRD\n\n## Problem\n\nUsers...",
            "files": [],
            "evidence": [
                {"section_anchor": "problem", "node_ids": ["n1"], "transcript_excerpts": ["..."]}
            ],
        },
    )
    r = client.post(
        "/sessions/s1/generate-artifact",
        json={"artifact_type": "prd"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["artifact_type"] == "prd"
    assert body["markdown"].startswith("# ")
    assert "artifact_id" in body

    # List should now include this artifact.
    r2 = client.get("/sessions/s1/artifacts")
    assert r2.status_code == 200
    listed = r2.json()["artifacts"]
    assert len(listed) == 1
    assert listed[0]["title"] == "Voice Notes PRD"
    assert listed[0]["artifact_type"] == "prd"

    # Single-fetch by id.
    artifact_id = body["artifact_id"]
    r3 = client.get(f"/artifacts/{artifact_id}")
    assert r3.status_code == 200
    detail = r3.json()
    assert detail["markdown"].startswith("# ")


def test_generate_scaffold_persists_files(client, monkeypatch, db):
    _make_node(db, session_id="s2", node_id="n1", label="Auth service")
    files = [
        {"path": "README.md", "content": "# A\n\nx"},
        {"path": "architecture.md", "content": "# Arch\n\n```mermaid\nflowchart LR\nA-->B\n```"},
        {"path": "routes.md", "content": "# routes"},
    ]
    _patch_generate_callback(
        client,
        monkeypatch,
        {
            "title": "Auth scaffold",
            "markdown": "# A\n\nx",
            "files": files,
            "evidence": [],
        },
    )
    r = client.post(
        "/sessions/s2/generate-artifact",
        json={"artifact_type": "scaffold"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["files"]) >= 3
    paths = {f["path"] for f in body["files"]}
    assert {"README.md", "architecture.md", "routes.md"}.issubset(paths)


def test_generate_504_on_timeout(client, monkeypatch, db):
    monkeypatch.setattr(agent_artifact_client, "_artifact_address", lambda: "agent1mockaddr")

    async def _silent(addr, message):
        return True

    monkeypatch.setattr(agent_artifact_client, "_send_to_agent", _silent)
    monkeypatch.setattr(agent_artifact_client, "DEFAULT_TIMEOUT_SECONDS", 0.2)

    r = client.post(
        "/sessions/s1/generate-artifact",
        json={"artifact_type": "prd"},
    )
    assert r.status_code == 504


def test_generate_503_when_no_agent(client, monkeypatch, db):
    monkeypatch.setattr(agent_artifact_client, "_artifact_address", lambda: None)
    r = client.post(
        "/sessions/s1/generate-artifact",
        json={"artifact_type": "prd"},
    )
    assert r.status_code == 503


# ---------------------------------------------------------------------------
# at= flag pulls historical state
# ---------------------------------------------------------------------------
def test_classify_with_at_pulls_historical_nodes(client, monkeypatch, db):
    """When ?at= is passed, the route uses find_at instead of list_live."""
    now = datetime.now(timezone.utc)
    earlier = now - timedelta(hours=2)
    later = now - timedelta(minutes=10)

    # Two nodes: one created early, one later.
    _make_node(db, session_id="s9", node_id="n_old", label="old", created_at=earlier)
    _make_node(db, session_id="s9", node_id="n_new", label="new", created_at=later)

    captured: dict = {}

    async def _fake_send(addr, message):
        captured["nodes_json"] = message.nodes_json
        body = {
            "kind": "classify",
            "session_id": message.session_id,
            "request_id": None,
            "top_choice": "brief",
            "confidence": 0.5,
            "candidates": [{"type": "brief", "score": 0.5, "why": "x"}],
        }
        threading.Thread(target=lambda: client.post("/internal/artifact-result", json=body), daemon=True).start()
        return True

    monkeypatch.setattr(agent_artifact_client, "_send_to_agent", _fake_send)
    monkeypatch.setattr(agent_artifact_client, "_artifact_address", lambda: "agent1mock")
    monkeypatch.setattr(agent_artifact_client, "DEFAULT_TIMEOUT_SECONDS", _TEST_AGENT_TIMEOUT)

    # at=earlier+30min should include only n_old.
    at_iso = (earlier + timedelta(minutes=30)).isoformat()
    r = client.post("/sessions/s9/classify-artifact", json={"at": at_iso})
    assert r.status_code == 200, r.text
    assert "n_old" in captured["nodes_json"]
    assert "n_new" not in captured["nodes_json"]


# ---------------------------------------------------------------------------
# Internal callback resolves a registered future directly
# ---------------------------------------------------------------------------
def test_internal_artifact_result_resolves_future(client):
    async def run():
        request_id, fut = await agent_artifact_client._register_future()
        ok = await agent_artifact_client.deliver_result(
            request_id, {"kind": "generate", "title": "T", "markdown": "# T"}
        )
        return ok, fut.done(), fut.result() if fut.done() else None

    ok, done, result = asyncio.run(run())
    assert ok is True
    assert done is True
    assert result["title"] == "T"


def test_get_artifact_404(client):
    r = client.get("/artifacts/does-not-exist")
    assert r.status_code == 404


def test_pin_artifact_toggles_saved_flag(client, monkeypatch, db):
    """End-to-end: generate an artifact, pin it, see the flag flip
    in both the single-fetch and the per-session list responses."""
    _make_node(db, session_id="s_pin", node_id="n1", label="Caching")
    _patch_generate_callback(
        client,
        monkeypatch,
        {
            "title": "Caching brief",
            "markdown": "# Caching\n\nuse redis",
            "files": [],
            "evidence": [],
        },
    )
    g = client.post("/sessions/s_pin/generate-artifact", json={"artifact_type": "brief"})
    assert g.status_code == 200, g.text
    artifact_id = g.json()["artifact_id"]

    # Default = unpinned.
    initial = client.get(f"/artifacts/{artifact_id}").json()
    assert initial["pinned"] is False

    # Pin it.
    p = client.patch(f"/artifacts/{artifact_id}/pin", json={"pinned": True})
    assert p.status_code == 200
    assert p.json()["pinned"] is True

    # List + single-fetch both reflect the new flag.
    listed = client.get("/sessions/s_pin/artifacts").json()["artifacts"]
    assert listed[0]["pinned"] is True
    fetched = client.get(f"/artifacts/{artifact_id}").json()
    assert fetched["pinned"] is True

    # Unpin restores default.
    u = client.patch(f"/artifacts/{artifact_id}/pin", json={"pinned": False})
    assert u.status_code == 200
    assert u.json()["pinned"] is False


def test_pin_unknown_artifact_404(client):
    r = client.patch("/artifacts/missing/pin", json={"pinned": True})
    assert r.status_code == 404
