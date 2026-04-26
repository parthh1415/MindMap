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
    # Each speaker run is comfortably above the phantom-absorption
    # thresholds (≥4 words OR ≥300 ms) so the post-processor leaves
    # them alone and we can verify the underlying grouping logic.
    words = [
        {"text": "we", "speaker": "A", "start": 0, "end": 80},
        {"text": "should", "speaker": "A", "start": 90, "end": 200},
        {"text": "use", "speaker": "A", "start": 210, "end": 300},
        {"text": "redis", "speaker": "A", "start": 320, "end": 500},
        {"text": "actually", "speaker": "B", "start": 600, "end": 900},
        {"text": "postgres", "speaker": "B", "start": 920, "end": 1200},
        {"text": "scales", "speaker": "B", "start": 1220, "end": 1500},
        {"text": "fine", "speaker": "B", "start": 1520, "end": 1800},
        {"text": "fair", "speaker": "A", "start": 2000, "end": 2300},
        {"text": "point", "speaker": "A", "start": 2320, "end": 2600},
        {"text": "agreed", "speaker": "A", "start": 2620, "end": 2900},
        {"text": "moving", "speaker": "A", "start": 2920, "end": 3200},
    ]
    out = diarize_cache.words_to_utterances(words)
    assert len(out) == 3
    assert out[0]["speaker"] == "A"
    assert out[0]["text"] == "we should use redis"
    assert out[1]["speaker"] == "B"
    assert out[1]["text"] == "actually postgres scales fine"
    assert out[2]["speaker"] == "A"
    assert out[2]["text"] == "fair point agreed moving"


def test_absorbs_phantom_speaker_switches():
    """A 1-word, sub-300ms 'speaker B' island sandwiched between two
    long 'speaker A' runs is the canonical AssemblyAI failure mode:
    a single mislabelled filler word creates a phantom third speaker.
    The absorber merges the island back into the surrounding A run."""
    words = [
        {"text": "the", "speaker": "A", "start": 0, "end": 100},
        {"text": "main", "speaker": "A", "start": 110, "end": 250},
        {"text": "thing", "speaker": "A", "start": 260, "end": 400},
        {"text": "we", "speaker": "A", "start": 410, "end": 520},
        {"text": "want", "speaker": "A", "start": 530, "end": 700},
        # phantom — 90ms, 1 word, mislabelled
        {"text": "yeah", "speaker": "B", "start": 710, "end": 800},
        {"text": "is", "speaker": "A", "start": 820, "end": 950},
        {"text": "scale", "speaker": "A", "start": 960, "end": 1100},
        {"text": "first", "speaker": "A", "start": 1110, "end": 1300},
        {"text": "always", "speaker": "A", "start": 1320, "end": 1500},
    ]
    out = diarize_cache.words_to_utterances(words)
    # Phantom should be folded into the surrounding A run.
    assert len(out) == 1
    assert out[0]["speaker"] == "A"
    assert "yeah" in out[0]["text"]


def test_keeps_legitimate_short_back_and_forth():
    """A short B turn between A and DIFFERENT-speaker C is real
    back-and-forth dialogue — not a phantom. Must NOT be absorbed."""
    words = [
        {"text": "should", "speaker": "A", "start": 0, "end": 200},
        {"text": "we", "speaker": "A", "start": 210, "end": 350},
        {"text": "ship", "speaker": "A", "start": 360, "end": 550},
        {"text": "tonight", "speaker": "A", "start": 560, "end": 800},
        # short B turn between different speakers — keep it.
        {"text": "no", "speaker": "B", "start": 820, "end": 950},
        {"text": "tomorrow", "speaker": "C", "start": 1000, "end": 1300},
        {"text": "morning", "speaker": "C", "start": 1320, "end": 1600},
        {"text": "is", "speaker": "C", "start": 1620, "end": 1800},
        {"text": "safer", "speaker": "C", "start": 1820, "end": 2100},
    ]
    out = diarize_cache.words_to_utterances(words)
    speakers = [u["speaker"] for u in out]
    assert speakers == ["A", "B", "C"]


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
