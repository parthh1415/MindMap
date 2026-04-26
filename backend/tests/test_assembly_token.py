"""Tests for the AssemblyAI temp-token mint endpoint.

We mock httpx so the tests never hit the real API. Verifies:
  - 503 when ASSEMBLYAI_API_KEY isn't configured (server hasn't been
    set up — the orchestrator treats this as "no AssemblyAI" and falls
    through to the next provider)
  - 200 + token passthrough on a successful mint
  - 502 when AssemblyAI returns a non-200 (e.g. invalid key)
  - the Authorization header carries the API key (not the temp token)
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from fastapi import FastAPI
import httpx

from backend.routes import assembly_token


def _make_app() -> FastAPI:
    app = FastAPI()
    app.include_router(assembly_token.router)
    return app


def test_returns_503_when_key_missing(monkeypatch):
    monkeypatch.delenv("ASSEMBLYAI_API_KEY", raising=False)
    client = TestClient(_make_app())
    resp = client.get("/internal/assembly-token")
    assert resp.status_code == 503
    assert "ASSEMBLYAI_API_KEY" in resp.json().get("detail", "")


def test_returns_200_with_token_on_success(monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "fake-key-123")
    captured_headers: dict = {}

    class _MockClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, headers=None):
            captured_headers.update(headers or {})
            req = httpx.Request("GET", url)
            return httpx.Response(
                200,
                request=req,
                json={"token": "tmp-abc-456", "expires_in_seconds": 600},
            )

    monkeypatch.setattr(assembly_token.httpx, "AsyncClient", _MockClient)

    client = TestClient(_make_app())
    resp = client.get("/internal/assembly-token")
    assert resp.status_code == 200
    body = resp.json()
    assert body["token"] == "tmp-abc-456"
    assert body["expires_in_seconds"] == 600
    # API key flows through Authorization header, not query string.
    assert captured_headers.get("Authorization") == "fake-key-123"


def test_returns_502_when_assemblyai_rejects_key(monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "bad-key")

    class _MockClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, headers=None):
            req = httpx.Request("GET", url)
            return httpx.Response(401, request=req, text='{"error":"invalid api key"}')

    monkeypatch.setattr(assembly_token.httpx, "AsyncClient", _MockClient)
    client = TestClient(_make_app())
    resp = client.get("/internal/assembly-token")
    assert resp.status_code == 502
    assert "401" in resp.json().get("detail", "")


def test_returns_502_on_network_error(monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "fake-key")

    class _MockClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, headers=None):
            raise httpx.ConnectError("simulated network failure")

    monkeypatch.setattr(assembly_token.httpx, "AsyncClient", _MockClient)
    client = TestClient(_make_app())
    resp = client.get("/internal/assembly-token")
    assert resp.status_code == 502
    assert "unreachable" in resp.json().get("detail", "").lower()


def test_returns_502_when_response_missing_token(monkeypatch):
    monkeypatch.setenv("ASSEMBLYAI_API_KEY", "fake-key")

    class _MockClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def get(self, url, headers=None):
            req = httpx.Request("GET", url)
            return httpx.Response(200, request=req, json={"unexpected": "shape"})

    monkeypatch.setattr(assembly_token.httpx, "AsyncClient", _MockClient)
    client = TestClient(_make_app())
    resp = client.get("/internal/assembly-token")
    assert resp.status_code == 502
    assert "missing token" in resp.json().get("detail", "").lower()
