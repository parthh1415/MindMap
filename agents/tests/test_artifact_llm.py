"""Unit tests for agents/artifact_llm.py.

Hermetic: a fake provider returns canned JSON; we verify shape contracts
and the 429-retry + Gemini fallback path.
"""
from __future__ import annotations

import os
from typing import AsyncIterator

import pytest

import artifact_llm
import llm as _llm
from shared.agent_messages import ARTIFACT_TYPES


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------
class _FakeProvider:
    def __init__(self, payload):
        self.payload = payload
        self.calls: list[dict] = []

    async def stream_json(self, prompt: str, system: str) -> AsyncIterator[str]:  # pragma: no cover
        if False:
            yield ""

    async def generate_json(self, prompt: str, system: str):
        self.calls.append({"prompt": prompt, "system": system})
        return self.payload


class _Fake429(Exception):
    """Mimic a Groq RateLimitError so _is_429 picks it up."""

    def __init__(self):
        super().__init__("rate limit exceeded (429)")
        self.status_code = 429


class _Flaky429ThenOk:
    """Raises 429 a few times, then returns payload."""

    def __init__(self, payload, raises_n: int):
        self.payload = payload
        self.raises_n = raises_n
        self.calls = 0

    async def stream_json(self, prompt, system):  # pragma: no cover
        if False:
            yield ""

    async def generate_json(self, prompt, system):
        self.calls += 1
        if self.calls <= self.raises_n:
            raise _Fake429()
        return self.payload


class _Always429:
    async def stream_json(self, prompt, system):  # pragma: no cover
        if False:
            yield ""

    async def generate_json(self, prompt, system):
        raise _Fake429()


# ---------------------------------------------------------------------------
# classify_artifact
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_classify_returns_top_choice_in_artifact_types():
    provider = _FakeProvider(
        {
            "top_choice": "prd",
            "confidence": 0.82,
            "candidates": [
                {"type": "prd", "score": 0.82, "why": "users + problem"},
                {"type": "research", "score": 0.41, "why": "exploratory"},
                {"type": "brief", "score": 0.18, "why": "fallback"},
            ],
        }
    )
    out = await artifact_llm.classify_artifact(
        nodes_json="[]",
        edges_json="[]",
        transcript_excerpt="we should build an app for users",
        system_prompt="SYS",
        provider=provider,
    )
    assert out["top_choice"] in ARTIFACT_TYPES
    assert out["top_choice"] == "prd"
    assert 0.0 <= out["confidence"] <= 1.0
    assert out["candidates"][0]["type"] == out["top_choice"]


@pytest.mark.asyncio
async def test_classify_caps_at_three_candidates():
    provider = _FakeProvider(
        {
            "top_choice": "prd",
            "confidence": 0.9,
            "candidates": [
                {"type": "prd", "score": 0.9, "why": "..."},
                {"type": "research", "score": 0.7, "why": "..."},
                {"type": "brief", "score": 0.6, "why": "..."},
                {"type": "decision", "score": 0.5, "why": "..."},
                {"type": "scaffold", "score": 0.4, "why": "..."},
            ],
        }
    )
    out = await artifact_llm.classify_artifact(
        nodes_json="[]", edges_json="[]", transcript_excerpt="x",
        system_prompt="SYS", provider=provider,
    )
    assert len(out["candidates"]) == artifact_llm.MAX_CANDIDATES == 3


@pytest.mark.asyncio
async def test_classify_filters_unknown_types():
    provider = _FakeProvider(
        {
            "top_choice": "frob",
            "confidence": 0.5,
            "candidates": [
                {"type": "frob", "score": 0.9, "why": "bogus"},
                {"type": "prd", "score": 0.7, "why": "..."},
                {"type": "research", "score": 0.5, "why": "..."},
            ],
        }
    )
    out = await artifact_llm.classify_artifact(
        nodes_json="[]", edges_json="[]", transcript_excerpt="x",
        system_prompt="SYS", provider=provider,
    )
    types = [c["type"] for c in out["candidates"]]
    assert "frob" not in types
    assert all(t in ARTIFACT_TYPES for t in types)
    assert out["top_choice"] in ARTIFACT_TYPES


@pytest.mark.asyncio
async def test_classify_falls_back_to_brief_when_empty():
    provider = _FakeProvider({"top_choice": "frob", "confidence": 0.0, "candidates": []})
    out = await artifact_llm.classify_artifact(
        nodes_json="[]", edges_json="[]", transcript_excerpt="",
        system_prompt="SYS", provider=provider,
    )
    assert out["top_choice"] == "brief"
    assert out["candidates"][0]["type"] == "brief"


# ---------------------------------------------------------------------------
# generate_artifact — scaffold has 3+ files
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_generate_scaffold_has_three_plus_files():
    provider = _FakeProvider(
        {
            "title": "Auth Service",
            "markdown": "# Auth Service\n\n## Overview\n\nx",
            "files": [
                {"path": "README.md", "content": "# Auth Service\n\n..."},
                {"path": "architecture.md", "content": "# Arch\n\n```mermaid\nflowchart LR\nA-->B\n```"},
                {"path": "routes.md", "content": "# Routes\n\n- POST /login"},
            ],
            "evidence": [
                {"section_anchor": "overview", "node_ids": ["n1"], "transcript_excerpts": ["..."]},
            ],
        }
    )
    out = await artifact_llm.generate_artifact(
        artifact_type="scaffold",
        nodes_json="[]", edges_json="[]", transcript_excerpt="auth and queue",
        system_prompt="SYS", provider=provider,
    )
    assert len(out["files"]) >= 3
    paths = {f["path"] for f in out["files"]}
    assert "README.md" in paths
    assert "architecture.md" in paths
    assert "routes.md" in paths


@pytest.mark.asyncio
async def test_generate_scaffold_backfills_missing_files():
    """If LLM under-delivers, helper backfills to 3 mandatory files."""
    provider = _FakeProvider(
        {
            "title": "Tiny",
            "markdown": "# Tiny\n\n## Overview\n\nshort",
            "files": [{"path": "README.md", "content": "# Tiny\n\nshort"}],
            "evidence": [],
        }
    )
    out = await artifact_llm.generate_artifact(
        artifact_type="scaffold",
        nodes_json="[]", edges_json="[]", transcript_excerpt="",
        system_prompt="SYS", provider=provider,
    )
    assert len(out["files"]) >= 3


# ---------------------------------------------------------------------------
# generate_artifact — PRD markdown begins with "# "
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_generate_prd_markdown_begins_with_h1():
    provider = _FakeProvider(
        {
            "title": "Voice Notes PRD",
            "markdown": "# Voice Notes PRD\n\n## Problem\n\nUsers struggle to capture ideas.",
            "files": [],
            "evidence": [
                {"section_anchor": "problem", "node_ids": [], "transcript_excerpts": []},
            ],
        }
    )
    out = await artifact_llm.generate_artifact(
        artifact_type="prd",
        nodes_json="[]", edges_json="[]", transcript_excerpt="",
        system_prompt="SYS", provider=provider,
    )
    assert out["markdown"].startswith("# ")
    assert out["files"] == []


@pytest.mark.asyncio
async def test_generate_prd_files_forced_empty_even_if_llm_returns_some():
    provider = _FakeProvider(
        {
            "title": "X",
            "markdown": "# X\n\n## Problem\n\nP",
            "files": [{"path": "rogue.md", "content": "should be dropped"}],
            "evidence": [],
        }
    )
    out = await artifact_llm.generate_artifact(
        artifact_type="prd",
        nodes_json="[]", edges_json="[]", transcript_excerpt="",
        system_prompt="SYS", provider=provider,
    )
    assert out["files"] == []


# ---------------------------------------------------------------------------
# section_anchor mode
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_generate_section_anchor_returns_h2_only():
    provider = _FakeProvider(
        {
            "title": "Voice Notes PRD",
            "markdown": "## Problem\n\nUpdated body here.",
            "files": [],
            "evidence": [
                {"section_anchor": "problem", "node_ids": ["n1"], "transcript_excerpts": ["..."]},
            ],
        }
    )
    out = await artifact_llm.generate_artifact(
        artifact_type="prd",
        nodes_json="[]", edges_json="[]", transcript_excerpt="",
        section_anchor="problem",
        system_prompt="SYS", provider=provider,
    )
    assert out["markdown"].startswith("## ")
    assert out["files"] == []
    assert len(out["evidence"]) == 1
    assert out["evidence"][0]["section_anchor"] == "problem"


@pytest.mark.asyncio
async def test_generate_section_anchor_repairs_missing_h2():
    """Even if LLM returns plain text, helper prepends a synthesized H2."""
    provider = _FakeProvider(
        {
            "title": "X",
            "markdown": "Just some body text without a heading.",
            "files": [],
            "evidence": [],
        }
    )
    out = await artifact_llm.generate_artifact(
        artifact_type="prd",
        nodes_json="[]", edges_json="[]", transcript_excerpt="",
        section_anchor="users",
        system_prompt="SYS", provider=provider,
    )
    assert out["markdown"].startswith("## ")


# ---------------------------------------------------------------------------
# Refinement hint propagates to the user prompt
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_generate_includes_refinement_hint_in_prompt():
    provider = _FakeProvider(
        {"title": "T", "markdown": "# T\n\n## TL;DR\n\nx", "files": [], "evidence": []}
    )
    await artifact_llm.generate_artifact(
        artifact_type="brief",
        nodes_json="[]", edges_json="[]", transcript_excerpt="",
        refinement_hint="more technical, please",
        system_prompt="SYS", provider=provider,
    )
    assert "REFINEMENT: more technical, please" in provider.calls[0]["prompt"]


@pytest.mark.asyncio
async def test_generate_rejects_unknown_type():
    provider = _FakeProvider({"title": "T", "markdown": "# T", "files": [], "evidence": []})
    with pytest.raises(ValueError):
        await artifact_llm.generate_artifact(
            artifact_type="bogus",
            nodes_json="[]", edges_json="[]", transcript_excerpt="",
            system_prompt="SYS", provider=provider,
        )


# ---------------------------------------------------------------------------
# 429 retry + Gemini fallback
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_classify_retries_on_429_then_succeeds(monkeypatch):
    flaky = _Flaky429ThenOk(
        {
            "top_choice": "brief",
            "confidence": 0.5,
            "candidates": [{"type": "brief", "score": 0.5, "why": "x"}],
        },
        raises_n=1,
    )
    # Speed up retry sleep.
    monkeypatch.setattr(artifact_llm, "RETRY_SLEEP_SECONDS", 0.0)
    out = await artifact_llm.classify_artifact(
        nodes_json="[]", edges_json="[]", transcript_excerpt="",
        system_prompt="SYS", provider=flaky,
    )
    assert out["top_choice"] == "brief"
    assert flaky.calls == 2


@pytest.mark.asyncio
async def test_classify_falls_back_to_gemini_on_persistent_429(monkeypatch):
    """When Groq exhausts retries with 429, GeminiProvider is invoked."""
    monkeypatch.setattr(artifact_llm, "RETRY_SLEEP_SECONDS", 0.0)
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")

    gemini_payload = {
        "top_choice": "research",
        "confidence": 0.7,
        "candidates": [{"type": "research", "score": 0.7, "why": "fallback"}],
    }

    class _FakeGemini:
        def __init__(self, *a, **kw):
            pass

        async def generate_json(self, prompt, system):
            return gemini_payload

    monkeypatch.setattr(_llm, "GeminiProvider", _FakeGemini)

    out = await artifact_llm.classify_artifact(
        nodes_json="[]", edges_json="[]", transcript_excerpt="",
        system_prompt="SYS", provider=_Always429(),
    )
    assert out["top_choice"] == "research"


@pytest.mark.asyncio
async def test_generate_falls_back_to_gemini_on_persistent_429(monkeypatch):
    monkeypatch.setattr(artifact_llm, "RETRY_SLEEP_SECONDS", 0.0)
    monkeypatch.setenv("GEMINI_API_KEY", "fake-key")

    gemini_payload = {
        "title": "Fallback Title",
        "markdown": "# Fallback Title\n\n## TL;DR\n\nfallback body",
        "files": [],
        "evidence": [],
    }

    class _FakeGemini:
        def __init__(self, *a, **kw):
            pass

        async def generate_json(self, prompt, system):
            return gemini_payload

    monkeypatch.setattr(_llm, "GeminiProvider", _FakeGemini)

    out = await artifact_llm.generate_artifact(
        artifact_type="brief",
        nodes_json="[]", edges_json="[]", transcript_excerpt="",
        system_prompt="SYS", provider=_Always429(),
    )
    assert out["title"] == "Fallback Title"
    assert out["markdown"].startswith("# ")
