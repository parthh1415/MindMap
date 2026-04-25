"""Unit tests for agents/synthesis_llm.py.

These tests do NOT hit the network. We inject a fake provider that records
the (system, prompt) it was called with so we can assert format-specific
prompt construction and schema enforcement.
"""
from __future__ import annotations

import json
from typing import AsyncIterator

import pytest

import synthesis_llm


class _FakeProvider:
    def __init__(self, payload):
        self.payload = payload
        self.calls: list[dict] = []

    async def stream_json(self, prompt: str, system: str) -> AsyncIterator[str]:
        # Not used by synthesis helpers, but keeps the protocol shape.
        if False:
            yield ""

    async def generate_json(self, prompt: str, system: str):
        self.calls.append({"prompt": prompt, "system": system})
        return self.payload


# ---------------------------------------------------------------------------
# expand_node
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_expand_node_returns_children():
    provider = _FakeProvider(
        {
            "children": [
                {"label": "alpha sub", "edge_type": "solid", "importance_score": 0.9},
                {"label": "beta", "edge_type": "dashed", "importance_score": 0.7},
                {"label": "gamma", "edge_type": "dotted", "importance_score": 0.5},
            ]
        }
    )
    children = await synthesis_llm.expand_node(
        label="Alpha", transcript_window="some context here", system_prompt="SYS",
        provider=provider,
    )
    assert len(children) == 3
    assert all(c["edge_type"] in ("solid", "dashed", "dotted") for c in children)
    assert all(0.5 <= c["importance_score"] <= 1.0 for c in children)


@pytest.mark.asyncio
async def test_expand_node_caps_at_five():
    too_many = [
        {"label": f"child{i}", "edge_type": "solid", "importance_score": 0.8}
        for i in range(10)
    ]
    provider = _FakeProvider({"children": too_many})
    children = await synthesis_llm.expand_node(
        label="Root", transcript_window="", system_prompt="SYS", provider=provider,
    )
    assert len(children) == synthesis_llm.MAX_EXPAND_CHILDREN == 5


@pytest.mark.asyncio
async def test_expand_node_dedupes_and_sanitizes():
    provider = _FakeProvider(
        {
            "children": [
                {"label": "Foo", "edge_type": "solid", "importance_score": 0.9},
                {"label": "foo", "edge_type": "dashed", "importance_score": 0.7},  # dup
                {"label": "  ", "edge_type": "solid", "importance_score": 0.6},  # blank
                {"label": "Bar", "edge_type": "weird", "importance_score": 99.0},  # bad type
                {"label": "Baz", "edge_type": "solid", "importance_score": "nope"},  # bad score
            ]
        }
    )
    children = await synthesis_llm.expand_node(
        label="Root", transcript_window="x", system_prompt="SYS", provider=provider,
    )
    labels = [c["label"] for c in children]
    assert "Foo" in labels
    assert labels.count("foo") + labels.count("Foo") == 1  # dedupe
    bar = next(c for c in children if c["label"] == "Bar")
    assert bar["edge_type"] == "solid"  # bad type coerced
    assert 0.5 <= bar["importance_score"] <= 1.0  # bad score clamped
    baz = next(c for c in children if c["label"] == "Baz")
    assert isinstance(baz["importance_score"], float)


@pytest.mark.asyncio
async def test_expand_node_accepts_bare_list():
    provider = _FakeProvider(
        [{"label": "a", "edge_type": "solid", "importance_score": 0.7}]
    )
    children = await synthesis_llm.expand_node(
        label="Root", transcript_window="", system_prompt="SYS", provider=provider,
    )
    assert children == [{"label": "a", "edge_type": "solid", "importance_score": 0.7}]


# ---------------------------------------------------------------------------
# synthesize
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_synthesize_returns_title_and_markdown():
    provider = _FakeProvider(
        {"title": "Brief", "markdown": "# Brief\n\nBody here."}
    )
    result = await synthesis_llm.synthesize(
        nodes_json="[]", edges_json="[]", transcript_excerpts="ctx",
        target_format="doc", system_prompt="SYS", provider=provider,
    )
    assert result["title"] == "Brief"
    assert "# Brief" in result["markdown"]


@pytest.mark.asyncio
async def test_synthesize_format_specific_prompt_doc():
    provider = _FakeProvider({"title": "T", "markdown": "M"})
    await synthesis_llm.synthesize(
        nodes_json="[]", edges_json="[]", transcript_excerpts="",
        target_format="doc", system_prompt="SYS", provider=provider,
    )
    assert "TARGET_FORMAT=doc" in provider.calls[0]["prompt"]
    assert "250-500" in provider.calls[0]["prompt"]


@pytest.mark.asyncio
async def test_synthesize_format_specific_prompt_email():
    provider = _FakeProvider({"title": "T", "markdown": "Subject: hi\n\nbody"})
    await synthesis_llm.synthesize(
        nodes_json="[]", edges_json="[]", transcript_excerpts="",
        target_format="email", system_prompt="SYS", provider=provider,
    )
    assert "TARGET_FORMAT=email" in provider.calls[0]["prompt"]
    assert "80-150" in provider.calls[0]["prompt"]


@pytest.mark.asyncio
async def test_synthesize_format_specific_prompt_issue():
    provider = _FakeProvider({"title": "T", "markdown": "# T\n\n## Summary\n..."})
    await synthesis_llm.synthesize(
        nodes_json="[]", edges_json="[]", transcript_excerpts="",
        target_format="issue", system_prompt="SYS", provider=provider,
    )
    assert "TARGET_FORMAT=issue" in provider.calls[0]["prompt"]
    assert "Acceptance criteria" in provider.calls[0]["prompt"]


@pytest.mark.asyncio
async def test_synthesize_format_specific_prompt_summary():
    provider = _FakeProvider({"title": "T", "markdown": "one para"})
    await synthesis_llm.synthesize(
        nodes_json="[]", edges_json="[]", transcript_excerpts="",
        target_format="summary", system_prompt="SYS", provider=provider,
    )
    assert "TARGET_FORMAT=summary" in provider.calls[0]["prompt"]
    assert "60-100" in provider.calls[0]["prompt"]


@pytest.mark.asyncio
async def test_synthesize_rejects_unknown_format():
    provider = _FakeProvider({"title": "T", "markdown": "M"})
    with pytest.raises(ValueError):
        await synthesis_llm.synthesize(
            nodes_json="[]", edges_json="[]", transcript_excerpts="",
            target_format="bogus", system_prompt="SYS", provider=provider,
        )


@pytest.mark.asyncio
async def test_synthesize_doc_truncates_at_hard_cap():
    too_long = " ".join(["word"] * 1500)
    provider = _FakeProvider({"title": "T", "markdown": too_long})
    result = await synthesis_llm.synthesize(
        nodes_json="[]", edges_json="[]", transcript_excerpts="",
        target_format="doc", system_prompt="SYS", provider=provider,
    )
    word_count = len(result["markdown"].replace("…", "").split())
    assert word_count <= synthesis_llm.DOC_HARD_WORD_CAP


@pytest.mark.asyncio
async def test_synthesize_strips_outer_code_fences():
    fenced = "```markdown\n# Hello\n\nbody\n```"
    provider = _FakeProvider({"title": "T", "markdown": fenced})
    result = await synthesis_llm.synthesize(
        nodes_json="[]", edges_json="[]", transcript_excerpts="",
        target_format="doc", system_prompt="SYS", provider=provider,
    )
    assert not result["markdown"].startswith("```")
    assert result["markdown"].startswith("# Hello")


@pytest.mark.asyncio
async def test_synthesize_handles_missing_keys():
    provider = _FakeProvider({})  # no title, no markdown
    result = await synthesis_llm.synthesize(
        nodes_json="[]", edges_json="[]", transcript_excerpts="",
        target_format="summary", system_prompt="SYS", provider=provider,
    )
    assert result["title"] == "Synthesis"
    assert result["markdown"] == ""
