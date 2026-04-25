"""Smoke test the FastAPI routes via TestClient with our fake DB injected."""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(db, monkeypatch):
    from backend.db import client as client_module

    monkeypatch.setattr(client_module, "_db", db, raising=False)

    # Defer import so the patched module-level _db is in effect.
    from backend.main import app

    return TestClient(app)


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_create_session_and_get_graph(client):
    r = client.post("/sessions", json={"name": "demo"})
    assert r.status_code == 200
    sid = r.json()["_id"]

    g = client.get(f"/sessions/{sid}/graph")
    assert g.status_code == 200
    body = g.json()
    assert body["session_id"] == sid
    assert body["nodes"] == []
    assert body["edges"] == []


def test_get_unknown_session_404(client):
    r = client.get("/sessions/nope")
    assert r.status_code == 404
