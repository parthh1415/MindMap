"""Tests for branch_diff helpers and the pivots routes."""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

from backend import branch_diff


# ---------------------------------------------------------------------------
# branch_diff.compute_diff — pure function tests
# ---------------------------------------------------------------------------


def _node(label: str, _id: str | None = None, **extra) -> dict:
    return {"_id": _id or label, "label": label, **extra}


def _edge(src_label: str, tgt_label: str, _id: str | None = None) -> dict:
    return {
        "_id": _id or f"{src_label}->{tgt_label}",
        "source_id": src_label,
        "target_id": tgt_label,
    }


def test_compute_diff_identical_graphs():
    nodes = [_node("alpha"), _node("beta")]
    edges = [_edge("alpha", "beta")]
    out = branch_diff.compute_diff(nodes, edges, nodes, edges)
    assert out["only_in_a"] == {"nodes": [], "edges": []}
    assert out["only_in_b"] == {"nodes": [], "edges": []}
    shared_labels = {n["label"] for n in out["shared"]["nodes"]}
    assert shared_labels == {"alpha", "beta"}
    assert len(out["shared"]["edges"]) == 1


def test_compute_diff_fully_disjoint():
    nodes_a = [_node("alpha"), _node("beta")]
    edges_a = [_edge("alpha", "beta")]
    nodes_b = [_node("gamma"), _node("delta")]
    edges_b = [_edge("gamma", "delta")]
    out = branch_diff.compute_diff(nodes_a, edges_a, nodes_b, edges_b)
    only_a_labels = {n["label"] for n in out["only_in_a"]["nodes"]}
    only_b_labels = {n["label"] for n in out["only_in_b"]["nodes"]}
    assert only_a_labels == {"alpha", "beta"}
    assert only_b_labels == {"gamma", "delta"}
    assert out["shared"]["nodes"] == []
    assert out["shared"]["edges"] == []
    assert len(out["only_in_a"]["edges"]) == 1
    assert len(out["only_in_b"]["edges"]) == 1


def test_compute_diff_partial_overlap_case_insensitive():
    nodes_a = [_node("Alpha"), _node("Beta"), _node("Gamma")]
    edges_a = [_edge("Alpha", "Beta"), _edge("Beta", "Gamma")]
    # branch B uses lower-case for the same concepts (case-insensitive match)
    # AND drops Gamma, AND adds Delta.
    nodes_b = [_node("alpha"), _node("BETA"), _node("Delta")]
    edges_b = [_edge("alpha", "BETA"), _edge("BETA", "Delta")]
    out = branch_diff.compute_diff(nodes_a, edges_a, nodes_b, edges_b)

    shared_labels = {n["label"].lower() for n in out["shared"]["nodes"]}
    assert shared_labels == {"alpha", "beta"}
    only_a = {n["label"].lower() for n in out["only_in_a"]["nodes"]}
    only_b = {n["label"].lower() for n in out["only_in_b"]["nodes"]}
    assert only_a == {"gamma"}
    assert only_b == {"delta"}

    # Edge Alpha→Beta is shared (case-insensitive). Beta→Gamma is only A.
    # alpha→beta is shared; BETA→Delta is only B.
    assert len(out["shared"]["edges"]) == 1
    assert len(out["only_in_a"]["edges"]) == 1
    assert len(out["only_in_b"]["edges"]) == 1


def test_compute_diff_handles_empty_inputs():
    out = branch_diff.compute_diff([], [], [], [])
    assert out["only_in_a"] == {"nodes": [], "edges": []}
    assert out["only_in_b"] == {"nodes": [], "edges": []}
    assert out["shared"] == {"nodes": [], "edges": []}


def test_compute_diff_skips_non_dict_entries():
    out = branch_diff.compute_diff(
        [_node("alpha"), None, "junk"],  # type: ignore[list-item]
        [],
        [_node("alpha")],
        [],
    )
    assert {n["label"] for n in out["shared"]["nodes"]} == {"alpha"}


# ---------------------------------------------------------------------------
# Pivot suggestions route — uses TestClient + fake DB
# ---------------------------------------------------------------------------
@pytest.fixture
def client(db, monkeypatch):
    from backend.db import client as client_module

    monkeypatch.setattr(client_module, "_db", db, raising=False)

    from backend.main import app

    return TestClient(app)


def test_pivot_suggestions_404_for_unknown_session(client):
    r = client.get("/sessions/nope/pivot-suggestions")
    assert r.status_code == 404


def test_pivot_suggestions_returns_empty_when_agent_unavailable(client, monkeypatch):
    """When the pivot agent isn't registered, the route returns [] gracefully."""
    # Create a session.
    r = client.post("/sessions", json={"name": "demo"})
    assert r.status_code == 200
    sid = r.json()["_id"]

    # Force the agent client to report no addresses.
    from backend import agent_client as ac

    monkeypatch.setattr(ac, "_load_addresses", lambda: {})

    r = client.get(f"/sessions/{sid}/pivot-suggestions")
    assert r.status_code == 200
    body = r.json()
    assert body["session_id"] == sid
    assert body["pivots"] == []


def test_pivot_suggestions_timeout_returns_empty(client, monkeypatch):
    """When the agent is "registered" but never replies, we time out cleanly."""
    r = client.post("/sessions", json={"name": "demo2"})
    sid = r.json()["_id"]

    from backend import agent_client as ac
    from backend.routes import pivots as pivots_route

    # Pretend we have a pivot address but ignore the dispatch (no reply).
    async def fake_dispatch(req):
        return True

    monkeypatch.setattr(pivots_route, "_dispatch_pivot", fake_dispatch)
    # Shrink the timeout so the test finishes fast.
    monkeypatch.setattr(pivots_route, "PIVOT_TIMEOUT_SECONDS", 0.05)

    r = client.get(f"/sessions/{sid}/pivot-suggestions")
    assert r.status_code == 200
    assert r.json()["pivots"] == []


def test_pivot_suggestions_resolved_via_internal_endpoint(client, monkeypatch):
    """Simulate the agent posting back to /internal/pivot-result mid-wait."""
    r = client.post("/sessions", json={"name": "resolved"})
    sid = r.json()["_id"]

    from backend.routes import pivots as pivots_route

    captured_request_id = {"value": None}

    # Capture the request_id at register time.
    real_register = pivots_route._register_future

    def spy_register(request_id, session_id):
        captured_request_id["value"] = request_id
        fut = real_register(request_id, session_id)
        # Schedule the resolution shortly after the request is registered.
        loop = asyncio.get_event_loop()

        def resolve():
            pivots_route._resolve_future(
                request_id,
                session_id,
                {
                    "session_id": session_id,
                    "pivots": [
                        {
                            "timestamp": datetime.now(timezone.utc).isoformat(),
                            "why": "test pivot",
                            "pivot_label": "Test Path",
                        }
                    ],
                },
            )

        loop.call_later(0.01, resolve)
        return fut

    monkeypatch.setattr(pivots_route, "_register_future", spy_register)

    async def fake_dispatch(req):
        return True

    monkeypatch.setattr(pivots_route, "_dispatch_pivot", fake_dispatch)
    monkeypatch.setattr(pivots_route, "PIVOT_TIMEOUT_SECONDS", 1.0)

    r = client.get(f"/sessions/{sid}/pivot-suggestions")
    assert r.status_code == 200
    body = r.json()
    assert len(body["pivots"]) == 1
    assert body["pivots"][0]["pivot_label"] == "Test Path"


def test_pivot_suggestions_caches_results(client, monkeypatch):
    """A second call within the TTL returns cached=True without re-dispatching."""
    r = client.post("/sessions", json={"name": "cache"})
    sid = r.json()["_id"]

    from backend.routes import pivots as pivots_route

    # First call: empty (no agent), gets cached.
    monkeypatch.setattr(pivots_route, "_dispatch_pivot", lambda req: _async_false())
    r1 = client.get(f"/sessions/{sid}/pivot-suggestions")
    assert r1.status_code == 200
    assert r1.json()["cached"] is False

    r2 = client.get(f"/sessions/{sid}/pivot-suggestions")
    assert r2.status_code == 200
    assert r2.json()["cached"] is True


async def _async_false():
    return False


# ---------------------------------------------------------------------------
# /branches and /diff endpoints
# ---------------------------------------------------------------------------
def test_branches_listing(client):
    # Create a parent session, then a child session that references it.
    r = client.post("/sessions", json={"name": "parent"})
    parent_id = r.json()["_id"]

    # Branch endpoint needs an existing session — use it directly with a
    # past timestamp.
    branch_resp = client.post(
        f"/sessions/{parent_id}/branch",
        json={"timestamp": datetime.now(timezone.utc).isoformat()},
    )
    assert branch_resp.status_code == 200
    branch_id = branch_resp.json()["_id"]

    r = client.get(f"/sessions/{parent_id}/branches")
    assert r.status_code == 200
    body = r.json()
    branch_ids = [b["_id"] for b in body["branches"]]
    assert branch_id in branch_ids


def test_branches_listing_404(client):
    r = client.get("/sessions/missing/branches")
    assert r.status_code == 404


def test_branch_diff_endpoint(client, db):
    """Two sessions with overlapping nodes — inserted directly into the
    fake DB (no public node-create route exists in this codebase)."""
    import asyncio as _asyncio

    from backend.db import nodes_repo, sessions_repo

    async def _setup() -> tuple[str, str]:
        s1 = (await sessions_repo.create_session(db, "a"))["_id"]
        s2 = (await sessions_repo.create_session(db, "b"))["_id"]
        for label in ("alpha", "beta"):
            await nodes_repo.create_node(db, {"session_id": s1, "label": label})
        for label in ("alpha", "gamma"):
            await nodes_repo.create_node(db, {"session_id": s2, "label": label})
        return s1, s2

    s1, s2 = _asyncio.get_event_loop().run_until_complete(_setup())

    r = client.get(f"/sessions/{s1}/diff/{s2}")
    assert r.status_code == 200
    body = r.json()
    assert body["session_a"] == s1
    assert body["session_b"] == s2
    only_a = {n["label"].lower() for n in body["only_in_a"]["nodes"]}
    only_b = {n["label"].lower() for n in body["only_in_b"]["nodes"]}
    shared = {n["label"].lower() for n in body["shared"]["nodes"]}
    assert only_a == {"beta"}
    assert only_b == {"gamma"}
    assert shared == {"alpha"}


def test_branch_diff_404(client):
    sid = client.post("/sessions", json={"name": "a"}).json()["_id"]
    r = client.get(f"/sessions/{sid}/diff/missing")
    assert r.status_code == 404


def test_internal_pivot_result_with_no_pending(client):
    """Posting a result with no pending future should be a no-op (resolved=False)."""
    r = client.post(
        "/internal/pivot-result",
        json={
            "request_id": "nonexistent",
            "session_id": "nonexistent",
            "pivots": [],
        },
    )
    assert r.status_code == 200
    assert r.json() == {"ok": True, "resolved": False}
