"""Tests for diarize cache + route."""
from __future__ import annotations

import asyncio

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend import diarize_cache
from backend.routes import diarize as diarize_routes


@pytest.fixture(autouse=True)
def _clear_cache(monkeypatch):
    """Reset module-level cache before each test."""
    diarize_cache._cache.clear()
    yield
    diarize_cache._cache.clear()


def _app() -> FastAPI:
    a = FastAPI()
    a.include_router(diarize_routes.router)
    return a


def test_words_to_utterances_groups_by_speaker():
    words = [
        {"text": "hello", "speaker": "A", "start": 0, "end": 100},
        {"text": "world", "speaker": "A", "start": 110, "end": 220},
        {"text": "hi", "speaker": "B", "start": 250, "end": 320},
        {"text": "there", "speaker": "B", "start": 330, "end": 420},
        {"text": "again", "speaker": "A", "start": 500, "end": 600},
    ]
    out = diarize_cache.words_to_utterances(words)
    assert len(out) == 3
    assert out[0] == {"speaker": "A", "text": "hello world", "start": 0, "end": 220}
    assert out[1] == {"speaker": "B", "text": "hi there", "start": 250, "end": 420}
    assert out[2] == {"speaker": "A", "text": "again", "start": 500, "end": 600}


def test_format_for_prompt_yields_speaker_lines():
    payload = {
        "utterances": [
            {"speaker": "A", "text": "lets talk about caching"},
            {"speaker": "B", "text": "redis is the right call"},
        ]
    }
    out = diarize_cache.format_for_prompt(payload)
    assert "Speaker A: lets talk about caching" in out
    assert "Speaker B: redis is the right call" in out


def test_format_for_prompt_truncates_to_max_words():
    long_text = " ".join(["word"] * 2000)
    payload = {"utterances": [{"speaker": "A", "text": long_text}]}
    out = diarize_cache.format_for_prompt(payload, max_words=50)
    assert "[…transcript truncated for length…]" in out


def test_format_for_prompt_empty_returns_empty_string():
    assert diarize_cache.format_for_prompt({}) == ""
    assert diarize_cache.format_for_prompt({"utterances": []}) == ""


def test_post_rejects_empty_body():
    client = TestClient(_app())
    r = client.post("/internal/diarize-batch?session_id=s1", content=b"")
    assert r.status_code == 400


def test_post_returns_202_and_queues_task(monkeypatch):
    """No real AAI call — verify the endpoint accepts and queues."""
    monkeypatch.delenv("ASSEMBLYAI_API_KEY", raising=False)
    client = TestClient(_app())
    r = client.post("/internal/diarize-batch?session_id=s1", content=b"\x00\x01\x02\x03")
    assert r.status_code == 200
    body = r.json()
    assert body["queued"] is True
    assert body["bytes"] == 4


def test_status_reports_absent_then_present():
    client = TestClient(_app())
    r = client.get("/internal/diarize-status/sX")
    assert r.status_code == 200
    assert r.json() == {"present": False}

    asyncio.run(
        diarize_cache.put(
            "sX",
            {"utterances": [{"speaker": "A", "text": "hello"}], "audio_duration_seconds": 12},
        )
    )
    r = client.get("/internal/diarize-status/sX")
    body = r.json()
    assert body["present"] is True
    assert body["utterances"] == 1
    assert body["audio_duration_seconds"] == 12


def test_post_rejects_oversize():
    client = TestClient(_app())
    big = b"\x00" * (50 * 1024 * 1024 + 1)
    r = client.post("/internal/diarize-batch?session_id=s1", content=big)
    assert r.status_code == 413
