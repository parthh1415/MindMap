"""Tests for /internal/topology-partial-node and /internal/topology-diff
streaming dedupe semantics.
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(db, monkeypatch):
    from backend.db import client as client_module

    monkeypatch.setattr(client_module, "_db", db, raising=False)
    # Clear partial-broadcast state across tests.
    from backend.routes import agent_callbacks as cb

    cb._partial_broadcast.clear()

    from backend.main import app

    return TestClient(app)


@pytest.fixture
def captured_broadcasts(monkeypatch):
    """Capture node_upsert broadcasts so we can count them."""
    calls: list[tuple[str, dict, str | None]] = []

    async def fake_broadcast(session_id, node, resolves_ghost_id=None):
        calls.append((session_id, node, resolves_ghost_id))

    # Patch where the route module imported it from.
    from backend.routes import agent_callbacks as cb_module
    from backend.ws import graph_socket

    monkeypatch.setattr(cb_module, "broadcast_node_upsert", fake_broadcast)
    monkeypatch.setattr(graph_socket, "broadcast_node_upsert", fake_broadcast)
    return calls


def test_partial_node_creates_and_broadcasts_once(client, captured_broadcasts):
    sid = "sess-partial-1"
    body = {"session_id": sid, "node": {"label": "Alpha", "speaker_id": "s1"}}
    r = client.post("/internal/topology-partial-node", json=body)
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert "node_id" in r.json()
    assert len(captured_broadcasts) == 1

    # Re-post the same label — should be a no-op.
    r2 = client.post("/internal/topology-partial-node", json=body)
    assert r2.status_code == 200
    assert r2.json().get("duplicate") is True
    assert len(captured_broadcasts) == 1  # still one broadcast


def test_partial_node_dedup_uses_normalized_label(client, captured_broadcasts):
    sid = "sess-partial-2"
    client.post(
        "/internal/topology-partial-node",
        json={"session_id": sid, "node": {"label": "  Beta  "}},
    )
    r = client.post(
        "/internal/topology-partial-node",
        json={"session_id": sid, "node": {"label": "beta"}},
    )
    assert r.json().get("duplicate") is True
    assert len(captured_broadcasts) == 1


def test_topology_diff_skips_already_broadcast_labels(client, captured_broadcasts):
    sid = "sess-diff-1"
    # First, drop a partial.
    client.post(
        "/internal/topology-partial-node",
        json={"session_id": sid, "node": {"label": "Gamma"}},
    )
    assert len(captured_broadcasts) == 1

    # Now post the full diff — Gamma should be skipped, Delta created.
    diff_body = {
        "session_id": sid,
        "additions_nodes": [
            {"label": "Gamma"},
            {"label": "Delta"},
        ],
        "additions_edges": [],
        "merges": [],
        "edge_updates": [],
    }
    r = client.post("/internal/topology-diff", json=diff_body)
    assert r.status_code == 200
    # Total broadcasts: 1 (Gamma partial) + 1 (Delta from diff) = 2.
    assert len(captured_broadcasts) == 2
    labels = [c[1].get("label") for c in captured_broadcasts]
    assert labels == ["Gamma", "Delta"]


def test_topology_diff_clears_partial_set(client, captured_broadcasts):
    sid = "sess-diff-2"
    client.post(
        "/internal/topology-partial-node",
        json={"session_id": sid, "node": {"label": "Eps"}},
    )
    # Settle round 1.
    client.post(
        "/internal/topology-diff",
        json={
            "session_id": sid,
            "additions_nodes": [{"label": "Eps"}],
            "additions_edges": [],
            "merges": [],
            "edge_updates": [],
        },
    )
    # Round 2: same label should NOT be treated as duplicate by partial route.
    r = client.post(
        "/internal/topology-partial-node",
        json={"session_id": sid, "node": {"label": "Eps"}},
    )
    assert r.status_code == 200
    assert r.json().get("duplicate") is not True
    # Total broadcasts: 1 (round-1 partial) + 1 (round-2 partial) = 2;
    # the round-1 diff was skipped via dedupe.
    assert len(captured_broadcasts) == 2


def test_partial_node_rejects_missing_label(client, captured_broadcasts):
    r = client.post(
        "/internal/topology-partial-node",
        json={"session_id": "s", "node": {"speaker_id": "x"}},
    )
    assert r.status_code == 400
    assert len(captured_broadcasts) == 0
