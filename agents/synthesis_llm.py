"""LLM helpers for the SYNTHESIS agent.

Two functions:
  - ``expand_node(label, transcript_window)`` — returns 3..5 children, each
    {"label", "edge_type", "importance_score"}. Strict JSON, capped at 5.
  - ``synthesize(nodes_json, edges_json, transcript_excerpts, target_format)``
    — returns {"title", "markdown"} for the requested target_format.

Provider: Groq llama-3.3-70b-versatile via the existing ``agents.llm``
module's GroqProvider. We re-use its provider abstraction to keep tests
hermetic — they inject a fake provider with a ``generate_json`` method.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

# sys.path tweak so this module works whether imported as ``agents.synthesis_llm``
# or as a sibling script ``import synthesis_llm`` from agents/.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Local sibling import.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm as _llm  # noqa: E402  — re-uses GroqProvider, GeminiProvider, _is_429

logger = logging.getLogger("agents.synthesis_llm")

MAX_EXPAND_CHILDREN = 5
MIN_EXPAND_CHILDREN = 3
DOC_HARD_WORD_CAP = 800
ALLOWED_FORMATS = ("doc", "email", "issue", "summary")
ALLOWED_EDGE_TYPES = ("solid", "dashed", "dotted")
MAX_RETRIES_429 = _llm.MAX_RETRIES_429
RETRY_SLEEP_SECONDS = _llm.RETRY_SLEEP_SECONDS

_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


def _load_prompt(name: str) -> str:
    return (_PROMPTS_DIR / name).read_text(encoding="utf-8")


def _build_provider() -> "_llm.LLMProvider":
    # Phase 12: prefer OpenAI when its key is set; otherwise Groq.
    if os.getenv("OPENAI_API_KEY"):
        return _llm.OpenAIProvider()
    return _llm.GroqProvider()


# ---------------------------------------------------------------------------
# expand_node
# ---------------------------------------------------------------------------
def _coerce_children(data) -> list[dict]:
    """Accept either {"children": [...]} or a bare list. Defensively clean."""
    if isinstance(data, dict):
        raw = data.get("children") or []
    elif isinstance(data, list):
        raw = data
    else:
        raw = []
    cleaned: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        label = str(entry.get("label", "")).strip()
        if not label:
            continue
        # 6 words max per child label.
        words = label.split()
        if len(words) > 8:
            label = " ".join(words[:8])
        edge_type = entry.get("edge_type") or "solid"
        if edge_type not in ALLOWED_EDGE_TYPES:
            edge_type = "solid"
        try:
            score = float(entry.get("importance_score", 0.7))
        except (TypeError, ValueError):
            score = 0.7
        score = max(0.5, min(1.0, score))
        cleaned.append(
            {
                "label": label,
                "edge_type": edge_type,
                "importance_score": score,
            }
        )
    # Dedupe by lowercase label.
    seen: set[str] = set()
    deduped: list[dict] = []
    for c in cleaned:
        key = c["label"].lower()
        if key in seen:
            continue
        seen.add(key)
        deduped.append(c)
    # Cap at MAX_EXPAND_CHILDREN.
    return deduped[:MAX_EXPAND_CHILDREN]


async def expand_node(
    label: str,
    transcript_window: str,
    system_prompt: Optional[str] = None,
    provider: Optional["_llm.LLMProvider"] = None,
) -> list[dict]:
    """Return 3..5 children for the given node label.

    Each child: {"label": str, "edge_type": "solid"|"dashed"|"dotted",
                 "importance_score": float in [0.5, 1.0]}.
    """
    import asyncio  # local import keeps top-level minimal

    system = system_prompt or _load_prompt("expand_system.txt")
    user_prompt = (
        f"NODE_LABEL: {label}\n\n"
        f"TRANSCRIPT_WINDOW:\n{transcript_window or '(none)'}\n\n"
        'Return a JSON object: {"children": [...]} with 3 to 5 entries.'
    )

    primary = provider or _build_provider()
    last_exc: Optional[BaseException] = None

    for attempt in range(MAX_RETRIES_429 + 1):
        try:
            data = await primary.generate_json(user_prompt, system)
            return _coerce_children(data)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if _llm._is_429(exc) and attempt < MAX_RETRIES_429:
                await asyncio.sleep(RETRY_SLEEP_SECONDS)
                continue
            if _llm._is_429(exc) and os.getenv("GEMINI_API_KEY"):
                try:
                    fallback = _llm.GeminiProvider()
                    data = await fallback.generate_json(user_prompt, system)
                    return _coerce_children(data)
                except Exception as fb_exc:  # noqa: BLE001
                    last_exc = fb_exc
            break
    raise RuntimeError(f"expand_node failed: {last_exc!r}") from last_exc


# ---------------------------------------------------------------------------
# synthesize
# ---------------------------------------------------------------------------
def _truncate_words(text: str, max_words: int) -> str:
    words = text.split()
    if len(words) <= max_words:
        return text
    return " ".join(words[:max_words]) + "…"


def _format_directive(target_format: str) -> str:
    """Per-format directives layered on top of the system prompt."""
    if target_format == "doc":
        return (
            "TARGET_FORMAT=doc.\n"
            "Produce a 250-500 word brief with a single H1 title and up to 4 H2 sections "
            "(Overview, Key Concepts, Connections, Open Questions). HARD CAP 800 words."
        )
    if target_format == "email":
        return (
            "TARGET_FORMAT=email.\n"
            "Produce 80-150 words. Start with 'Subject: ...'. Then a 2-4 sentence opener, "
            "exactly 3 bullets, and a one-line close."
        )
    if target_format == "issue":
        return (
            "TARGET_FORMAT=issue.\n"
            "Produce a Linear/GitHub issue body. H1 title, then ## Summary (2-4 sentences), "
            "## Acceptance criteria (3-6 '- [ ]' checkboxes), and ## Notes (≤6 bullets)."
        )
    if target_format == "summary":
        return (
            "TARGET_FORMAT=summary.\n"
            "Produce ONE paragraph of 60-100 words. No headers. No bullets."
        )
    return f"TARGET_FORMAT={target_format}."


def _coerce_synth(data, target_format: str) -> dict:
    if not isinstance(data, dict):
        data = {}
    title = str(data.get("title", "")).strip() or "Synthesis"
    if len(title) > 100:
        title = title[:97].rstrip() + "…"
    markdown = str(data.get("markdown", "")).strip()
    # Hard word cap for "doc" (other formats are short by directive).
    if target_format == "doc":
        markdown = _truncate_words(markdown, DOC_HARD_WORD_CAP)
    # Strip wrapping fences if the model still added them.
    if markdown.startswith("```") and markdown.endswith("```"):
        lines = markdown.splitlines()
        if len(lines) >= 2:
            markdown = "\n".join(lines[1:-1]).strip()
    return {"title": title, "markdown": markdown}


async def synthesize(
    nodes_json: str,
    edges_json: str,
    transcript_excerpts: str,
    target_format: str,
    system_prompt: Optional[str] = None,
    provider: Optional["_llm.LLMProvider"] = None,
) -> dict:
    """Produce a doc/email/issue/summary from the supplied subgraph.

    Returns {"title": str, "markdown": str}.
    """
    import asyncio

    if target_format not in ALLOWED_FORMATS:
        raise ValueError(f"target_format must be one of {ALLOWED_FORMATS}")

    system = system_prompt or _load_prompt("synthesis_system.txt")
    user_prompt = (
        f"{_format_directive(target_format)}\n\n"
        f"NODES_JSON:\n{nodes_json}\n\n"
        f"EDGES_JSON:\n{edges_json}\n\n"
        f"TRANSCRIPT_EXCERPTS:\n{transcript_excerpts or '(none)'}\n\n"
        'Return a JSON object: {"title": "...", "markdown": "..."}'
    )

    primary = provider or _build_provider()
    last_exc: Optional[BaseException] = None

    for attempt in range(MAX_RETRIES_429 + 1):
        try:
            data = await primary.generate_json(user_prompt, system)
            return _coerce_synth(data, target_format)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if _llm._is_429(exc) and attempt < MAX_RETRIES_429:
                await asyncio.sleep(RETRY_SLEEP_SECONDS)
                continue
            if _llm._is_429(exc) and os.getenv("GEMINI_API_KEY"):
                try:
                    fallback = _llm.GeminiProvider()
                    data = await fallback.generate_json(user_prompt, system)
                    return _coerce_synth(data, target_format)
                except Exception as fb_exc:  # noqa: BLE001
                    last_exc = fb_exc
            break
    raise RuntimeError(f"synthesize failed: {last_exc!r}") from last_exc


__all__ = [
    "expand_node",
    "synthesize",
    "MAX_EXPAND_CHILDREN",
    "ALLOWED_FORMATS",
    "DOC_HARD_WORD_CAP",
]
