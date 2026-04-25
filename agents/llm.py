"""LLM provider abstraction for MindMap agents.

Primary provider: Groq (llama-3.3-70b-versatile) with structured JSON output.
Optional fallback: Google Gemini (free tier).

Top-level helpers exposed to the uAgent processes:
- ``stream_topology_diff`` — streaming JSON, returns a TopologyDiff.
- ``generate_enrichment`` — non-streaming JSON, returns a list[str] of points.

Hard rule: NEVER import from anthropic or openai. Free-tier only.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
from pathlib import Path
from typing import AsyncIterator, Optional, Protocol

# Make `from shared.agent_messages import ...` work when running from agents/.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.agent_messages import TopologyDiff  # noqa: E402

logger = logging.getLogger("agents.llm")

GROQ_MODEL = "llama-3.3-70b-versatile"
GEMINI_MODEL = "gemini-2.5-flash"

MAX_ADDITION_NODES = 5
MAX_RETRIES_429 = 2
RETRY_SLEEP_SECONDS = 1.0


# ---------------------------------------------------------------------------
# Provider Protocol
# ---------------------------------------------------------------------------
class LLMProvider(Protocol):
    async def stream_json(self, prompt: str, system: str) -> AsyncIterator[str]:
        ...

    async def generate_json(self, prompt: str, system: str) -> dict | list:
        ...


# ---------------------------------------------------------------------------
# Groq provider (primary)
# ---------------------------------------------------------------------------
class GroqProvider:
    """Groq client wrapper using the official ``groq`` SDK."""

    def __init__(self, api_key: Optional[str] = None) -> None:
        self.api_key = api_key or os.getenv("GROQ_API_KEY", "")
        if not self.api_key:
            raise RuntimeError("GROQ_API_KEY not set")
        # Imported lazily so test environments that mock the client work.
        from groq import AsyncGroq

        self._client = AsyncGroq(api_key=self.api_key)

    async def stream_json(self, prompt: str, system: str) -> AsyncIterator[str]:
        """Yield content deltas as they arrive. Forces JSON object output."""
        stream = await self._client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            stream=True,
            temperature=0.2,
        )
        async for chunk in stream:
            try:
                delta = chunk.choices[0].delta
                content = getattr(delta, "content", None)
                if content:
                    yield content
            except (AttributeError, IndexError):
                continue

    async def generate_json(self, prompt: str, system: str) -> dict | list:
        resp = await self._client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            response_format={"type": "json_object"},
            temperature=0.2,
        )
        content = resp.choices[0].message.content or "{}"
        return json.loads(content)


# ---------------------------------------------------------------------------
# Gemini provider (optional fallback)
# ---------------------------------------------------------------------------
class GeminiProvider:
    """Free-tier fallback using google-generativeai."""

    def __init__(self, api_key: Optional[str] = None) -> None:
        self.api_key = api_key or os.getenv("GEMINI_API_KEY", "")
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY not set")
        import google.generativeai as genai

        genai.configure(api_key=self.api_key)
        self._genai = genai
        self._model = genai.GenerativeModel(
            GEMINI_MODEL,
            generation_config={"response_mime_type": "application/json"},
        )

    async def stream_json(self, prompt: str, system: str) -> AsyncIterator[str]:
        # Gemini SDK is sync; wrap a generator into async deltas.
        full_prompt = f"{system}\n\n{prompt}"
        loop = asyncio.get_event_loop()

        def _call():
            return self._model.generate_content(full_prompt, stream=True)

        stream = await loop.run_in_executor(None, _call)
        for chunk in stream:
            text = getattr(chunk, "text", None)
            if text:
                yield text

    async def generate_json(self, prompt: str, system: str) -> dict | list:
        full_prompt = f"{system}\n\n{prompt}"
        loop = asyncio.get_event_loop()

        def _call():
            return self._model.generate_content(full_prompt)

        resp = await loop.run_in_executor(None, _call)
        text = getattr(resp, "text", "{}") or "{}"
        return json.loads(text)


# ---------------------------------------------------------------------------
# Prompt loading
# ---------------------------------------------------------------------------
_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


def load_prompt(name: str) -> str:
    return (_PROMPTS_DIR / name).read_text(encoding="utf-8")


# ---------------------------------------------------------------------------
# Tolerant streaming JSON parsing
# ---------------------------------------------------------------------------
def _try_parse(buffer: str) -> Optional[dict | list]:
    """Attempt to parse the streaming buffer; return None until valid."""
    if not buffer:
        return None
    try:
        return json.loads(buffer)
    except json.JSONDecodeError:
        return None


def _is_429(exc: BaseException) -> bool:
    """Detect a Groq rate-limit error in a SDK-version-tolerant way."""
    name = type(exc).__name__.lower()
    if "ratelimit" in name or "429" in name:
        return True
    status = getattr(exc, "status_code", None) or getattr(exc, "status", None)
    if status == 429:
        return True
    msg = str(exc).lower()
    return "rate limit" in msg or "429" in msg


# ---------------------------------------------------------------------------
# Public helpers
# ---------------------------------------------------------------------------
async def _stream_to_json(provider: LLMProvider, prompt: str, system: str) -> dict:
    buffer_parts: list[str] = []
    parsed: Optional[dict | list] = None
    async for delta in provider.stream_json(prompt, system):
        buffer_parts.append(delta)
        # Light optimization: only retry parse on closing-brace deltas.
        if "}" in delta or "]" in delta:
            candidate = _try_parse("".join(buffer_parts))
            if candidate is not None:
                parsed = candidate
                # Don't break — let stream finish so connection closes cleanly.
    if parsed is None:
        parsed = _try_parse("".join(buffer_parts))
    if parsed is None:
        raise RuntimeError("Streamed response did not produce valid JSON")
    if not isinstance(parsed, dict):
        raise RuntimeError(f"Expected JSON object for topology, got {type(parsed)}")
    return parsed


def _build_topology_provider() -> LLMProvider:
    return GroqProvider()


def _truncate_additions(diff_dict: dict) -> dict:
    """Cap node additions at MAX_ADDITION_NODES (defensive truncation)."""
    add_nodes = diff_dict.get("additions_nodes") or []
    if isinstance(add_nodes, list) and len(add_nodes) > MAX_ADDITION_NODES:
        diff_dict["additions_nodes"] = add_nodes[:MAX_ADDITION_NODES]
    return diff_dict


async def stream_topology_diff(
    graph_json: str,
    last_words: str,
    system_prompt: Optional[str] = None,
    session_id: str = "",
    provider: Optional[LLMProvider] = None,
) -> TopologyDiff:
    """Stream a topology diff from the LLM. Retries on 429, falls back to Gemini."""
    system = system_prompt or load_prompt("topology_system.txt")
    user_prompt = (
        "CURRENT_GRAPH_JSON:\n"
        f"{graph_json}\n\n"
        "RECENT_TRANSCRIPT:\n"
        f"{last_words}\n\n"
        "Return ONLY a JSON object with keys "
        "additions_nodes, additions_edges, merges, edge_updates."
    )

    primary = provider or _build_topology_provider()

    last_exc: Optional[BaseException] = None
    for attempt in range(MAX_RETRIES_429 + 1):
        try:
            diff_dict = await _stream_to_json(primary, user_prompt, system)
            diff_dict = _truncate_additions(diff_dict)
            return TopologyDiff(
                session_id=session_id,
                additions_nodes=diff_dict.get("additions_nodes", []) or [],
                additions_edges=diff_dict.get("additions_edges", []) or [],
                merges=diff_dict.get("merges", []) or [],
                edge_updates=diff_dict.get("edge_updates", []) or [],
            )
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if _is_429(exc) and attempt < MAX_RETRIES_429:
                logger.warning("Groq 429; retry %d/%d after %.1fs",
                               attempt + 1, MAX_RETRIES_429, RETRY_SLEEP_SECONDS)
                await asyncio.sleep(RETRY_SLEEP_SECONDS)
                continue
            # If we exhausted retries on a 429, try Gemini fallback.
            if _is_429(exc) and os.getenv("GEMINI_API_KEY"):
                logger.warning("Groq exhausted 429 retries; falling back to Gemini")
                try:
                    fallback = GeminiProvider()
                    diff_dict = await _stream_to_json(fallback, user_prompt, system)
                    diff_dict = _truncate_additions(diff_dict)
                    return TopologyDiff(
                        session_id=session_id,
                        additions_nodes=diff_dict.get("additions_nodes", []) or [],
                        additions_edges=diff_dict.get("additions_edges", []) or [],
                        merges=diff_dict.get("merges", []) or [],
                        edge_updates=diff_dict.get("edge_updates", []) or [],
                    )
                except Exception as fb_exc:  # noqa: BLE001
                    last_exc = fb_exc
            break
    raise RuntimeError(f"stream_topology_diff failed: {last_exc!r}") from last_exc


async def generate_enrichment(
    node_label: str,
    transcript_segment: str,
    system_prompt: Optional[str] = None,
    provider: Optional[LLMProvider] = None,
) -> list[str]:
    """Return 3–5 short bullet enrichment strings for a node."""
    system = system_prompt or load_prompt("enrichment_system.txt")
    user_prompt = (
        f"NODE_LABEL: {node_label}\n\n"
        f"TRANSCRIPT_SEGMENT:\n{transcript_segment}\n\n"
        'Return a JSON object: {"points": ["...", "...", "..."]} '
        "with 3–5 strings, each ≤ 20 words."
    )

    primary = provider or _build_topology_provider()

    last_exc: Optional[BaseException] = None
    for attempt in range(MAX_RETRIES_429 + 1):
        try:
            data = await primary.generate_json(user_prompt, system)
            return _coerce_points(data)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if _is_429(exc) and attempt < MAX_RETRIES_429:
                await asyncio.sleep(RETRY_SLEEP_SECONDS)
                continue
            if _is_429(exc) and os.getenv("GEMINI_API_KEY"):
                try:
                    fallback = GeminiProvider()
                    data = await fallback.generate_json(user_prompt, system)
                    return _coerce_points(data)
                except Exception as fb_exc:  # noqa: BLE001
                    last_exc = fb_exc
            break
    raise RuntimeError(f"generate_enrichment failed: {last_exc!r}") from last_exc


def _coerce_points(data: dict | list) -> list[str]:
    """Accept either {"points": [...]} or a bare list."""
    if isinstance(data, list):
        points = data
    elif isinstance(data, dict):
        points = data.get("points") or data.get("info_entries") or []
    else:
        points = []
    cleaned = [str(p).strip() for p in points if str(p).strip()]
    # Defensive trim to 5.
    return cleaned[:5]
