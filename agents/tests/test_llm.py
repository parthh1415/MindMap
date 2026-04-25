"""Unit tests for agents/llm.py.

These tests do NOT hit the network. They mock the Groq client so we can
verify:
  - streaming chunks are concatenated and parsed into valid JSON
  - 429 retry behavior (1s sleep, max 2 retries)
  - additions_nodes is truncated to 5
"""
from __future__ import annotations

import json
from typing import AsyncIterator

import pytest

import llm
from shared.agent_messages import TopologyDiff


# ---------------------------------------------------------------------------
# Fake provider helpers
# ---------------------------------------------------------------------------
class _FakeStreamingProvider:
    """Yields preset chunks; reports each call so we can assert."""

    def __init__(self, chunks: list[str], gen_payload: dict | list | None = None):
        self.chunks = chunks
        self.gen_payload = gen_payload or {"points": []}
        self.stream_calls = 0
        self.gen_calls = 0

    async def stream_json(self, prompt: str, system: str) -> AsyncIterator[str]:
        self.stream_calls += 1
        for c in self.chunks:
            yield c

    async def generate_json(self, prompt: str, system: str):
        self.gen_calls += 1
        return self.gen_payload


class _Fake429(Exception):
    """Mimics a Groq RateLimitError without importing the SDK."""

    def __init__(self) -> None:
        super().__init__("429 rate limit exceeded")
        self.status_code = 429


class _FlakyProvider:
    """Fails with 429 N times, then succeeds."""

    def __init__(self, fail_times: int, success_payload: dict):
        self.fail_times = fail_times
        self.success_payload = success_payload
        self.attempts = 0

    async def stream_json(self, prompt: str, system: str) -> AsyncIterator[str]:
        self.attempts += 1
        if self.attempts <= self.fail_times:
            raise _Fake429()
        yield json.dumps(self.success_payload)

    async def generate_json(self, prompt: str, system: str):
        self.attempts += 1
        if self.attempts <= self.fail_times:
            raise _Fake429()
        return self.success_payload


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_stream_topology_diff_partial_chunks():
    payload = {
        "additions_nodes": [{"label": "alpha", "speaker_id": None, "parent_id": None}],
        "additions_edges": [],
        "merges": [],
        "edge_updates": [],
    }
    full = json.dumps(payload)
    # Split into 4 deliberately uneven chunks to exercise partial parsing.
    third = max(1, len(full) // 4)
    chunks = [full[:third], full[third : third * 2], full[third * 2 : third * 3], full[third * 3 :]]
    provider = _FakeStreamingProvider(chunks)

    diff = await llm.stream_topology_diff(
        graph_json='{"nodes": [], "edges": []}',
        last_words="alpha was just mentioned",
        system_prompt="SYS",
        session_id="sess1",
        provider=provider,
    )
    assert isinstance(diff, TopologyDiff)
    assert diff.session_id == "sess1"
    assert diff.additions_nodes == payload["additions_nodes"]
    assert provider.stream_calls == 1


@pytest.mark.asyncio
async def test_stream_topology_diff_truncates_additions(monkeypatch):
    too_many = [{"label": f"n{i}", "speaker_id": None, "parent_id": None} for i in range(10)]
    payload = {
        "additions_nodes": too_many,
        "additions_edges": [],
        "merges": [],
        "edge_updates": [],
    }
    provider = _FakeStreamingProvider([json.dumps(payload)])

    diff = await llm.stream_topology_diff(
        graph_json="{}",
        last_words="x",
        system_prompt="SYS",
        session_id="sess",
        provider=provider,
    )
    assert len(diff.additions_nodes) == llm.MAX_ADDITION_NODES == 5


@pytest.mark.asyncio
async def test_stream_topology_diff_429_retry_then_success(monkeypatch):
    payload = {
        "additions_nodes": [],
        "additions_edges": [],
        "merges": [],
        "edge_updates": [],
    }
    provider = _FlakyProvider(fail_times=1, success_payload=payload)

    # Speed up the test: zero out the retry sleep.
    monkeypatch.setattr(llm, "RETRY_SLEEP_SECONDS", 0.0)

    diff = await llm.stream_topology_diff(
        graph_json="{}",
        last_words="x",
        system_prompt="SYS",
        session_id="sess",
        provider=provider,
    )
    assert isinstance(diff, TopologyDiff)
    assert provider.attempts == 2  # 1 fail + 1 success


@pytest.mark.asyncio
async def test_stream_topology_diff_429_exhausts_without_fallback(monkeypatch):
    monkeypatch.setattr(llm, "RETRY_SLEEP_SECONDS", 0.0)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    provider = _FlakyProvider(fail_times=10, success_payload={})

    with pytest.raises(RuntimeError):
        await llm.stream_topology_diff(
            graph_json="{}",
            last_words="x",
            system_prompt="SYS",
            session_id="sess",
            provider=provider,
        )
    # MAX_RETRIES_429 = 2 -> 3 attempts total (initial + 2 retries).
    assert provider.attempts == llm.MAX_RETRIES_429 + 1


@pytest.mark.asyncio
async def test_generate_enrichment_returns_points():
    provider = _FakeStreamingProvider(
        chunks=[],
        gen_payload={"points": ["one", "two", "three", "four", "five", "six"]},
    )
    points = await llm.generate_enrichment(
        node_label="X",
        transcript_segment="some text",
        system_prompt="SYS",
        provider=provider,
    )
    assert points == ["one", "two", "three", "four", "five"]
    assert provider.gen_calls == 1


@pytest.mark.asyncio
async def test_generate_enrichment_accepts_bare_list():
    provider = _FakeStreamingProvider(
        chunks=[], gen_payload=["a", "b", "c"]
    )
    points = await llm.generate_enrichment(
        node_label="X",
        transcript_segment="text",
        system_prompt="SYS",
        provider=provider,
    )
    assert points == ["a", "b", "c"]


def test_is_429_detection():
    assert llm._is_429(_Fake429()) is True

    class _NotRate(Exception):
        pass

    assert llm._is_429(_NotRate("nope")) is False
