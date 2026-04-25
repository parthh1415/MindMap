"""Unit tests for agents/pivot_llm.py.

Mocks the LLM provider so no network calls happen.
"""
from __future__ import annotations

import pytest

import pivot_llm


class _FakeProvider:
    def __init__(self, payload):
        self.payload = payload
        self.calls = 0

    async def stream_json(self, prompt, system):  # pragma: no cover
        if False:
            yield ""

    async def generate_json(self, prompt, system):
        self.calls += 1
        return self.payload


@pytest.mark.asyncio
async def test_detect_pivots_basic_shape():
    provider = _FakeProvider(
        {
            "pivots": [
                {
                    "timestamp_offset_seconds": -90,
                    "why": "Speaker raised cost but team moved on.",
                    "pivot_label": "Cost Deep-Dive",
                },
                {
                    "timestamp_offset_seconds": -30,
                    "why": "Brief mention of caching never followed up.",
                    "pivot_label": "Caching Layer",
                },
            ]
        }
    )
    out = await pivot_llm.detect_pivots(
        transcript_excerpt="we should think about cost ... lets talk infra",
        current_node_labels=["cost", "infra"],
        system_prompt="SYS",
        provider=provider,
    )
    assert provider.calls == 1
    assert len(out) == 2
    assert out[0]["pivot_label"] == "Cost Deep-Dive"
    assert out[0]["timestamp_offset_seconds"] == -90
    assert out[1]["pivot_label"] == "Caching Layer"


@pytest.mark.asyncio
async def test_detect_pivots_caps_at_three():
    payload = {
        "pivots": [
            {
                "timestamp_offset_seconds": -i * 10,
                "why": f"reason {i}",
                "pivot_label": f"Path {i}",
            }
            for i in range(1, 7)  # six entries
        ]
    }
    provider = _FakeProvider(payload)
    out = await pivot_llm.detect_pivots(
        transcript_excerpt="x",
        current_node_labels=["x"],
        system_prompt="SYS",
        provider=provider,
    )
    assert len(out) == pivot_llm.MAX_PIVOTS == 3


@pytest.mark.asyncio
async def test_detect_pivots_accepts_bare_list():
    provider = _FakeProvider(
        [
            {
                "timestamp_offset_seconds": -45,
                "why": "tangent dropped",
                "pivot_label": "Side Thread",
            }
        ]
    )
    out = await pivot_llm.detect_pivots(
        transcript_excerpt="x",
        current_node_labels=[],
        system_prompt="SYS",
        provider=provider,
    )
    assert len(out) == 1
    assert out[0]["pivot_label"] == "Side Thread"


@pytest.mark.asyncio
async def test_detect_pivots_clamps_positive_offset():
    """Positive offsets are coerced to negative."""
    provider = _FakeProvider(
        {
            "pivots": [
                {
                    "timestamp_offset_seconds": 90,  # invalid
                    "why": "should be clamped",
                    "pivot_label": "Clamp Me",
                }
            ]
        }
    )
    out = await pivot_llm.detect_pivots(
        transcript_excerpt="x", current_node_labels=[], system_prompt="SYS", provider=provider
    )
    assert out[0]["timestamp_offset_seconds"] == -90


@pytest.mark.asyncio
async def test_detect_pivots_clamps_extreme_negative():
    provider = _FakeProvider(
        {
            "pivots": [
                {
                    "timestamp_offset_seconds": -99999,
                    "why": "way too far back",
                    "pivot_label": "Ancient",
                }
            ]
        }
    )
    out = await pivot_llm.detect_pivots(
        transcript_excerpt="x", current_node_labels=[], system_prompt="SYS", provider=provider
    )
    assert out[0]["timestamp_offset_seconds"] == pivot_llm.MIN_OFFSET_SECONDS


@pytest.mark.asyncio
async def test_detect_pivots_drops_empty_label():
    provider = _FakeProvider(
        {
            "pivots": [
                {"timestamp_offset_seconds": -10, "why": "x", "pivot_label": ""},
                {
                    "timestamp_offset_seconds": -20,
                    "why": "good one",
                    "pivot_label": "Real Pivot",
                },
            ]
        }
    )
    out = await pivot_llm.detect_pivots(
        transcript_excerpt="x", current_node_labels=[], system_prompt="SYS", provider=provider
    )
    assert len(out) == 1
    assert out[0]["pivot_label"] == "Real Pivot"


@pytest.mark.asyncio
async def test_detect_pivots_truncates_label_words():
    provider = _FakeProvider(
        {
            "pivots": [
                {
                    "timestamp_offset_seconds": -10,
                    "why": "ok",
                    "pivot_label": "this is a very very long label",
                }
            ]
        }
    )
    out = await pivot_llm.detect_pivots(
        transcript_excerpt="x", current_node_labels=[], system_prompt="SYS", provider=provider
    )
    assert len(out[0]["pivot_label"].split()) == 4


@pytest.mark.asyncio
async def test_detect_pivots_returns_empty_on_error(monkeypatch):
    """LLM failures should produce [] rather than raising — pivots are advisory."""

    class _Boom:
        async def generate_json(self, prompt, system):
            raise RuntimeError("boom")

        async def stream_json(self, prompt, system):  # pragma: no cover
            if False:
                yield ""

    out = await pivot_llm.detect_pivots(
        transcript_excerpt="x",
        current_node_labels=[],
        system_prompt="SYS",
        provider=_Boom(),
    )
    assert out == []


@pytest.mark.asyncio
async def test_detect_pivots_handles_garbage_payload():
    provider = _FakeProvider("not a dict")  # type: ignore[arg-type]
    out = await pivot_llm.detect_pivots(
        transcript_excerpt="x",
        current_node_labels=[],
        system_prompt="SYS",
        provider=provider,
    )
    assert out == []
