"""Tests for backend/routes/synthesis.py.

We monkey-patch ``backend.agent_synth_client._send_to_agent`` so the
synthesis agent isn't actually contacted; the test then either:
  - simulates the agent posting back via /internal/synth-result, OR
  - lets the route hit its 25s timeout (with a shortened timeout) for
    the 504 path.
"""
from __future__ import annotations

import asyncio
import json

import pytest
from fastapi.testclient import TestClient

from backend import agent_synth_client


@pytest.fixture
def client(db, monkeypatch):
    from backend.db import client as client_module

    monkeypatch.setattr(client_module, "_db", db, raising=False)

    from backend.main import app

    return TestClient(app)


# ---------------------------------------------------------------------------
# Test helpers
# ---------------------------------------------------------------------------
def _make_node(db, *, session_id: str, node_id: str, label: str) -> None:
    """Insert a node directly into the fake DB."""
    from datetime import datetime, timezone

    db.nodes._docs.append(
        {
            "_id": node_id,
            "session_id": session_id,
            "label": label,
            "created_at": datetime.now(timezone.utc),
            "updated_at": datetime.now(timezone.utc),
            "info": [],
            "importance_score": 1.0,
        }
    )


def _make_edge(db, *, session_id: str, edge_id: str, src: str, dst: str) -> None:
    from datetime import datetime, timezone

    db.edges._docs.append(
        {
            "_id": edge_id,
            "session_id": session_id,
            "source_id": src,
            "target_id": dst,
            "edge_type": "solid",
            "created_at": datetime.now(timezone.utc),
        }
    )


def _patch_dispatch_to_post_back(client: TestClient, monkeypatch, response_payload: dict):
    """Make _send_to_agent a no-op AND simulate the agent's HTTP callback.

    We schedule an asyncio task that POSTs the callback shortly after
    dispatch. The route awaits the future bridge, which is resolved by
    the callback.
    """
    async def _fake_send(addr: str, message):
        # Schedule the callback. Determine kind/key from the message type.
        kind = "expand" if message.__class__.__name__ == "ExpandRequest" else "synthesize"
        if kind == "expand":
            payload = {
                "kind": "expand",
                "session_id": message.session_id,
                "node_id": message.node_id,
                "request_id": None,
                **response_payload,
            }
        else:
            payload = {
                "kind": "synthesize",
                "session_id": message.session_id,
                "request_id": None,
                "target_format": message.target_format,
                **response_payload,
            }

        # Use the test client to post back synchronously — but we are inside
        # an async context. We schedule it in a thread to avoid deadlock.
        import threading

        def _post():
            client.post("/internal/synth-result", json=payload)

        threading.Thread(target=_post, daemon=True).start()
        return True

    monkeypatch.setattr(agent_synth_client, "_send_to_agent", _fake_send)
    monkeypatch.setattr(agent_synth_client, "_synthesis_address", lambda: "agent1mockaddr")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
def test_expand_node_404_when_missing(client):
    r = client.post("/nodes/nope/expand")
    assert r.status_code == 404


def test_expand_node_503_when_no_agent(client, monkeypatch, db):
    _make_node(db, session_id="s1", node_id="n1", label="Alpha")
    monkeypatch.setattr(agent_synth_client, "_synthesis_address", lambda: None)
    r = client.post("/nodes/n1/expand")
    assert r.status_code == 503


def test_expand_node_completes_when_agent_posts_back(client, monkeypatch, db):
    _make_node(db, session_id="s1", node_id="n1", label="Alpha")
    _patch_dispatch_to_post_back(
        client,
        monkeypatch,
        {"children": [{"label": "child", "edge_type": "solid", "importance_score": 0.8}]},
    )
    r = client.post("/nodes/n1/expand")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["node_id"] == "n1"
    assert body["children"][0]["label"] == "child"


def test_expand_node_504_on_timeout(client, monkeypatch, db):
    _make_node(db, session_id="s1", node_id="n1", label="Alpha")
    monkeypatch.setattr(agent_synth_client, "_synthesis_address", lambda: "agent1mockaddr")

    async def _silent(addr, message):
        return True  # pretend send succeeded but never callback

    monkeypatch.setattr(agent_synth_client, "_send_to_agent", _silent)
    monkeypatch.setattr(agent_synth_client, "DEFAULT_TIMEOUT_SECONDS", 0.2)

    r = client.post("/nodes/n1/expand")
    assert r.status_code == 504


def test_synthesize_completes(client, monkeypatch, db):
    _make_node(db, session_id="s1", node_id="n1", label="Alpha")
    _make_node(db, session_id="s1", node_id="n2", label="Beta")
    _make_edge(db, session_id="s1", edge_id="e1", src="n1", dst="n2")

    _patch_dispatch_to_post_back(
        client,
        monkeypatch,
        {"title": "Brief", "markdown": "# Brief\n\nBody."},
    )
    r = client.post(
        "/sessions/s1/synthesize", json={"scope": "all", "format": "doc"}
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "Brief"
    assert "# Brief" in body["markdown"]
    assert body["target_format"] == "doc"


def test_synthesize_rejects_bad_format(client, monkeypatch, db):
    monkeypatch.setattr(agent_synth_client, "_synthesis_address", lambda: "agent1mockaddr")
    r = client.post("/sessions/s1/synthesize", json={"scope": "all", "format": "bogus"})
    assert r.status_code == 400


def test_synthesize_rejects_bad_scope(client, monkeypatch, db):
    monkeypatch.setattr(agent_synth_client, "_synthesis_address", lambda: "agent1mockaddr")
    r = client.post("/sessions/s1/synthesize", json={"scope": "weird", "format": "doc"})
    assert r.status_code == 400


def test_synthesize_504_on_timeout(client, monkeypatch, db):
    _make_node(db, session_id="s1", node_id="n1", label="Alpha")
    monkeypatch.setattr(agent_synth_client, "_synthesis_address", lambda: "agent1mockaddr")

    async def _silent(addr, message):
        return True

    monkeypatch.setattr(agent_synth_client, "_send_to_agent", _silent)
    monkeypatch.setattr(agent_synth_client, "DEFAULT_TIMEOUT_SECONDS", 0.2)

    r = client.post(
        "/sessions/s1/synthesize", json={"scope": "all", "format": "doc"}
    )
    assert r.status_code == 504


def test_evidence_returns_chunks(client, db):
    _make_node(db, session_id="s1", node_id="n1", label="cybersecurity threats")

    # Seed the ring buffer
    from backend.ring_buffer import get_buffer, reset_buffer

    reset_buffer()
    buf = get_buffer()
    buf.append("s1", "We were just talking about cybersecurity threats. Then a different topic. End.")

    r = client.get("/nodes/n1/evidence")
    assert r.status_code == 200
    body = r.json()
    assert body["node_id"] == "n1"
    assert isinstance(body["transcript_chunks"], list)
    matched = [c for c in body["transcript_chunks"] if c["is_match"]]
    assert len(matched) >= 1


def test_internal_synth_result_resolves_future(client):
    """Direct test of the callback resolving a registered future."""

    async def run():
        request_id, fut = await agent_synth_client._register_future()
        # Simulate callback
        ok = await agent_synth_client.deliver_result(
            request_id, {"kind": "expand", "children": []}
        )
        return ok, fut.done(), fut.result() if fut.done() else None

    ok, done, result = asyncio.run(run())
    assert ok is True
    assert done is True
    assert result == {"kind": "expand", "children": []}
