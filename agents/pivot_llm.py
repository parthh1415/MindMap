"""LLM helper for the pivot agent.

`detect_pivots` asks Groq Llama 3.3 70B for 0..3 pivot-point candidates
given the recent transcript and the labels on the current mind map.

The contract returned to the agent is a list[dict] of:
    {
      "timestamp_offset_seconds": int,   # negative; seconds back from now
      "why": str,
      "pivot_label": str,                # 1–4 words
    }

This file follows the same shape as agents/llm.py: a tolerant streaming
parser is unnecessary here (responses are tiny) so we use generate_json.
Defensive parsing because Groq sometimes returns near-JSON.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

# Make `from shared.agent_messages import ...` work when running from agents/.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Local helper imports.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm  # noqa: E402  reuse provider classes + retry helpers

logger = logging.getLogger("agents.pivot_llm")

MAX_PIVOTS = 3
MIN_OFFSET_SECONDS = -600  # 10 minutes
RETRY_SLEEP_SECONDS = 1.0
MAX_RETRIES_429 = 2


def _load_prompt() -> str:
    return llm.load_prompt("pivot_system.txt")


def _coerce_pivots(data: dict | list) -> list[dict]:
    """Normalize various JSON shapes into a clean list of pivot dicts.

    Accepts:
        {"pivots": [...]}
        [...]                # bare list
        {"items": [...]}     # tolerant
        {"pivot_label": ...} # single object — wraps as length-1 list
    """
    if isinstance(data, list):
        raw = data
    elif isinstance(data, dict):
        if "pivots" in data and isinstance(data["pivots"], list):
            raw = data["pivots"]
        elif "items" in data and isinstance(data["items"], list):
            raw = data["items"]
        elif "pivot_label" in data:
            raw = [data]
        else:
            raw = []
    else:
        raw = []

    cleaned: list[dict] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        label = str(entry.get("pivot_label") or entry.get("label") or "").strip()
        why = str(entry.get("why") or entry.get("reason") or "").strip()
        if not label or not why:
            continue

        ts_raw = entry.get("timestamp_offset_seconds")
        if ts_raw is None:
            ts_raw = entry.get("offset_seconds")
        try:
            ts = int(ts_raw) if ts_raw is not None else 0
        except (TypeError, ValueError):
            ts = 0
        # Force non-positive and clamp.
        if ts > 0:
            ts = -ts
        if ts < MIN_OFFSET_SECONDS:
            ts = MIN_OFFSET_SECONDS

        # Trim label to ~4 words.
        label_words = label.split()
        if len(label_words) > 4:
            label = " ".join(label_words[:4])
        # Trim why to ~24 words defensively.
        why_words = why.split()
        if len(why_words) > 24:
            why = " ".join(why_words[:24])

        cleaned.append(
            {
                "timestamp_offset_seconds": ts,
                "why": why,
                "pivot_label": label,
            }
        )
        if len(cleaned) >= MAX_PIVOTS:
            break

    return cleaned


def _build_provider() -> "llm.LLMProvider":
    return llm.GroqProvider()


async def detect_pivots(
    transcript_excerpt: str,
    current_node_labels: list[str],
    *,
    system_prompt: Optional[str] = None,
    provider: Optional["llm.LLMProvider"] = None,
) -> list[dict]:
    """Return 0..3 pivot-point candidates."""
    system = system_prompt or _load_prompt()
    labels_blob = ", ".join(current_node_labels[:50]) or "(none yet)"

    user_prompt = (
        "CURRENT_NODE_LABELS:\n"
        f"{labels_blob}\n\n"
        "TRANSCRIPT_EXCERPT (most recent ~400 words):\n"
        f"{transcript_excerpt or '(silence)'}\n\n"
        'Return ONLY a JSON object: {"pivots": [...]} with at most 3 items.'
    )

    primary = provider or _build_provider()

    last_exc: Optional[BaseException] = None
    for attempt in range(MAX_RETRIES_429 + 1):
        try:
            data = await primary.generate_json(user_prompt, system)
            return _coerce_pivots(data)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if llm._is_429(exc) and attempt < MAX_RETRIES_429:
                logger.warning(
                    "Groq 429 (pivot); retry %d/%d after %.1fs",
                    attempt + 1,
                    MAX_RETRIES_429,
                    RETRY_SLEEP_SECONDS,
                )
                await asyncio.sleep(RETRY_SLEEP_SECONDS)
                continue
            if llm._is_429(exc) and os.getenv("GEMINI_API_KEY"):
                logger.warning(
                    "Groq exhausted 429 retries on pivots; falling back to Gemini"
                )
                try:
                    fallback = llm.GeminiProvider()
                    data = await fallback.generate_json(user_prompt, system)
                    return _coerce_pivots(data)
                except Exception as fb_exc:  # noqa: BLE001
                    last_exc = fb_exc
            break

    # Defensive: never raise — pivots are advisory. Log and return empty.
    if last_exc is not None:
        logger.warning("detect_pivots failed: %r", last_exc)
    return []


__all__ = ["detect_pivots", "MAX_PIVOTS", "MIN_OFFSET_SECONDS"]
