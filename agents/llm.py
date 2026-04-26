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
from typing import Any, AsyncIterator, Awaitable, Callable, Iterator, Optional, Protocol

# Make `from shared.agent_messages import ...` work when running from agents/.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from shared.agent_messages import TopologyDiff  # noqa: E402

logger = logging.getLogger("agents.llm")

GROQ_MODEL = "llama-3.3-70b-versatile"
GEMINI_MODEL = "gemini-2.5-flash"
OPENAI_MODEL = os.getenv("OPENAI_MODEL", "gpt-4.1-nano")

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
# OpenAI provider (primary — user-provided paid key, overrides the original
# free-tier-only rule. The Groq + Gemini providers below are kept as
# cascading fallbacks so demos never go silent if the OpenAI key fails.)
# ---------------------------------------------------------------------------
class OpenAIProvider:
    """OpenAI client wrapper. Uses the official ``openai`` SDK.

    Default model is ``OPENAI_MODEL`` (env, defaults to ``gpt-4.1-nano`` —
    the cheapest / fastest tier). Supports JSON-mode streaming exactly the
    same way Groq does, so it slots into the existing ``LLMProvider``
    protocol without touching any caller.
    """

    def __init__(self, api_key: Optional[str] = None) -> None:
        self.api_key = api_key or os.getenv("OPENAI_API_KEY", "")
        if not self.api_key:
            raise RuntimeError("OPENAI_API_KEY not set")
        from openai import AsyncOpenAI

        self._client = AsyncOpenAI(api_key=self.api_key)

    async def stream_json(self, prompt: str, system: str) -> AsyncIterator[str]:
        """Yield content deltas as they arrive. JSON-mode."""
        stream = await self._client.chat.completions.create(
            model=OPENAI_MODEL,
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
            model=OPENAI_MODEL,
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
    """Primary LLM picker. Prefers OpenAI when its key is present (user
    flipped this in Phase 12); otherwise falls back to Groq."""
    if os.getenv("OPENAI_API_KEY"):
        return OpenAIProvider()
    return GroqProvider()


def _build_fallback_provider_chain() -> list["LLMProvider"]:
    """Ordered fallback chain used when the primary provider hits a rate
    limit. Returns the providers we should try, in order, *excluding*
    the primary."""
    chain: list[LLMProvider] = []
    primary_is_openai = bool(os.getenv("OPENAI_API_KEY"))
    # If primary is OpenAI, fall back to Groq next (still fast), then Gemini.
    if primary_is_openai:
        if os.getenv("GROQ_API_KEY"):
            try:
                chain.append(GroqProvider())
            except Exception:  # noqa: BLE001
                pass
    if os.getenv("GEMINI_API_KEY"):
        try:
            chain.append(GeminiProvider())
        except Exception:  # noqa: BLE001
            pass
    return chain


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
                logger.warning("primary LLM 429; retry %d/%d after %.1fs",
                               attempt + 1, MAX_RETRIES_429, RETRY_SLEEP_SECONDS)
                await asyncio.sleep(RETRY_SLEEP_SECONDS)
                continue
            # Exhausted primary 429 retries — walk the cascading fallback
            # chain (Groq → Gemini, when primary is OpenAI).
            if _is_429(exc):
                for fallback in _build_fallback_provider_chain():
                    fb_name = type(fallback).__name__
                    logger.warning("primary exhausted 429; trying %s", fb_name)
                    try:
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
                        continue
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
            if _is_429(exc):
                for fallback in _build_fallback_provider_chain():
                    try:
                        data = await fallback.generate_json(user_prompt, system)
                        return _coerce_points(data)
                    except Exception as fb_exc:  # noqa: BLE001
                        last_exc = fb_exc
                        continue
            break
    raise RuntimeError(f"generate_enrichment failed: {last_exc!r}") from last_exc


# ---------------------------------------------------------------------------
# Hand-rolled streaming JSON parser — emits nodes inside ``additions_nodes``
# as soon as each one is closed in the stream.
# ---------------------------------------------------------------------------
class _PartialNodeParser:
    """Incrementally scan streamed JSON for closed objects in ``additions_nodes``.

    The Groq stream gives us bytes-of-JSON deltas. We tail the buffer and
    track:
      - whether we're currently inside the value of the ``additions_nodes``
        key (i.e. between its opening ``[`` and closing ``]``);
      - brace/bracket depth, so we know when an inner object closed;
      - quoted-string state, so braces inside string literals don't confuse us.

    On each closed object inside ``additions_nodes`` we ``json.loads`` the
    object's substring; if it parses and has a ``label``, we yield it.

    The parser tolerates code fences (``` and ```json) by skipping any
    leading garbage until the first ``{``.

    Usage:
        p = _PartialNodeParser()
        for node in p.feed(chunk):
            ...
    """

    def __init__(self) -> None:
        self._buf: list[str] = []
        self._pos: int = 0  # next index in joined buffer to scan
        # Lexer state across feeds:
        self._depth: int = 0  # nested {/[ depth (root = 0 outside any {/[)
        self._in_string: bool = False
        self._string_escape: bool = False
        # Where in the doc we are relative to additions_nodes:
        # 'pre'   — haven't yet seen the start of additions_nodes' array
        # 'in'    — inside the additions_nodes array (between [ and ])
        # 'post'  — array closed; ignore the rest
        self._zone: str = "pre"
        # Depth at which the additions_nodes array's [ sits.
        # Each direct child object of that array closes when depth drops
        # back to (_array_depth + 1) after having been deeper.
        self._array_depth: int = -1
        self._object_start_idx: int = -1  # index of '{' of current node-obj

    # --- helpers -----------------------------------------------------------
    def _joined(self) -> str:
        # Cached join — small optim: only re-join when we have new chunks.
        if len(self._buf) > 1:
            joined = "".join(self._buf)
            self._buf = [joined]
            return joined
        return self._buf[0] if self._buf else ""

    @staticmethod
    def _find_additions_nodes_key(text: str, start: int) -> int:
        """Return index of the ``[`` that opens additions_nodes' value, or -1.

        Looks for the literal substring "additions_nodes" used as a key.
        Tolerant of whitespace / newlines between the key, ``:``, and ``[``.
        """
        idx = text.find('"additions_nodes"', start)
        if idx < 0:
            return -1
        # Walk forward to find the ':' then the '['.
        i = idx + len('"additions_nodes"')
        n = len(text)
        # Skip whitespace, then ':'.
        while i < n and text[i].isspace():
            i += 1
        if i >= n or text[i] != ":":
            return -1
        i += 1
        while i < n and text[i].isspace():
            i += 1
        if i >= n:
            return -1
        if text[i] != "[":
            # Could be null or some other value; don't error, just bail.
            return -1
        return i

    # --- main entry --------------------------------------------------------
    def feed(self, chunk: str) -> Iterator[dict]:
        """Feed a chunk of streamed JSON; yield any newly-closed node dicts."""
        if not chunk:
            return
        self._buf.append(chunk)
        text = self._joined()

        # Phase 1: locate additions_nodes if we haven't yet.
        if self._zone == "pre":
            arr_idx = self._find_additions_nodes_key(text, self._pos)
            if arr_idx < 0:
                # Not yet seen — keep buffering. Don't advance pos beyond
                # what we've safely scanned (we may need to re-find with
                # more text).
                return
            # Reset lexer to begin scanning from the '[' itself.
            self._zone = "in"
            self._array_depth = 0  # we'll treat the '[' as depth-1 once entered
            self._pos = arr_idx
            self._depth = 0
            self._in_string = False
            self._string_escape = False
            self._object_start_idx = -1

        # Phase 2: scan character-by-character emitting on closed objects.
        i = self._pos
        n = len(text)
        while i < n:
            ch = text[i]

            if self._in_string:
                if self._string_escape:
                    self._string_escape = False
                elif ch == "\\":
                    self._string_escape = True
                elif ch == '"':
                    self._in_string = False
                i += 1
                continue

            if ch == '"':
                self._in_string = True
                i += 1
                continue

            if ch == "[":
                self._depth += 1
                # First '[' opens additions_nodes; record its depth.
                if self._array_depth == 0 and self._zone == "in":
                    self._array_depth = self._depth
                i += 1
                continue

            if ch == "{":
                self._depth += 1
                # An object child of additions_nodes starts when its '{' lives
                # at depth = array_depth + 1 (one level inside the array).
                if (
                    self._zone == "in"
                    and self._array_depth > 0
                    and self._depth == self._array_depth + 1
                    and self._object_start_idx < 0
                ):
                    self._object_start_idx = i
                i += 1
                continue

            if ch == "}":
                # Closing a node-level object?
                if (
                    self._zone == "in"
                    and self._array_depth > 0
                    and self._depth == self._array_depth + 1
                    and self._object_start_idx >= 0
                ):
                    obj_text = text[self._object_start_idx : i + 1]
                    self._object_start_idx = -1
                    self._depth -= 1
                    i += 1
                    try:
                        parsed = json.loads(obj_text)
                    except json.JSONDecodeError:
                        parsed = None
                    if isinstance(parsed, dict) and parsed.get("label"):
                        yield parsed
                    continue
                self._depth -= 1
                i += 1
                continue

            if ch == "]":
                # Closing additions_nodes itself?
                if (
                    self._zone == "in"
                    and self._array_depth > 0
                    and self._depth == self._array_depth
                ):
                    self._depth -= 1
                    self._zone = "post"
                    i += 1
                    self._pos = i
                    return
                self._depth -= 1
                i += 1
                continue

            i += 1

        self._pos = i


PartialNodeCallback = Callable[[dict], Awaitable[None]]


async def _stream_to_json_with_partials(
    provider: LLMProvider,
    prompt: str,
    system: str,
    on_partial_node: PartialNodeCallback,
) -> dict:
    """Like ``_stream_to_json`` but emits each closed additions_nodes[i].

    Invokes ``on_partial_node`` (an async callable) for each complete node
    object detected mid-stream. Returns the fully-parsed JSON dict at end.
    """
    parser = _PartialNodeParser()
    buffer_parts: list[str] = []
    parsed: Optional[dict | list] = None
    async for delta in provider.stream_json(prompt, system):
        buffer_parts.append(delta)
        # Emit partials as soon as their objects close.
        for node in parser.feed(delta):
            try:
                await on_partial_node(node)
            except Exception as exc:  # noqa: BLE001
                logger.warning("on_partial_node raised: %s", exc)
        if "}" in delta or "]" in delta:
            candidate = _try_parse("".join(buffer_parts))
            if candidate is not None:
                parsed = candidate
    if parsed is None:
        parsed = _try_parse("".join(buffer_parts))
    if parsed is None:
        raise RuntimeError("Streamed response did not produce valid JSON")
    if not isinstance(parsed, dict):
        raise RuntimeError(f"Expected JSON object for topology, got {type(parsed)}")
    return parsed


async def stream_topology_diff_iter(
    graph_json: str,
    last_words: str,
    system_prompt: Optional[str] = None,
    *,
    session_id: str = "",
    on_partial_node: Optional[PartialNodeCallback] = None,
    provider: Optional[LLMProvider] = None,
) -> TopologyDiff:
    """Streaming variant that emits each ``additions_nodes[i]`` as it closes.

    ``on_partial_node`` is an async callable invoked once per complete node
    object detected mid-stream. The final return is the full TopologyDiff.

    Same retry+Gemini-fallback semantics as ``stream_topology_diff``. The
    Gemini fallback path does NOT emit partials — it falls back to the
    non-streaming behavior.
    """
    if on_partial_node is None:
        async def _noop(_: dict) -> None:
            return
        on_partial_node = _noop

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
            diff_dict = await _stream_to_json_with_partials(
                primary, user_prompt, system, on_partial_node
            )
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
                logger.warning(
                    "Groq 429; retry %d/%d after %.1fs",
                    attempt + 1,
                    MAX_RETRIES_429,
                    RETRY_SLEEP_SECONDS,
                )
                await asyncio.sleep(RETRY_SLEEP_SECONDS)
                continue
            # Exhausted retries on 429 — fall back to the non-streaming
            # ``stream_topology_diff`` path (no partials from Gemini).
            if _is_429(exc):
                logger.warning(
                    "Groq exhausted 429 retries; falling back to non-streaming path"
                )
                try:
                    return await stream_topology_diff(
                        graph_json=graph_json,
                        last_words=last_words,
                        system_prompt=system_prompt,
                        session_id=session_id,
                    )
                except Exception as fb_exc:  # noqa: BLE001
                    last_exc = fb_exc
            break
    raise RuntimeError(
        f"stream_topology_diff_iter failed: {last_exc!r}"
    ) from last_exc


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
