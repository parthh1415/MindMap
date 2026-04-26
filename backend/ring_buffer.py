"""Per-session in-memory ring buffer of transcript words.

Keeps the last N words across all speakers. Thread-safe enough for our use
(asyncio single-threaded).
"""
from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Deque, Optional


@dataclass
class _SessionBuffer:
    words: Deque[str] = field(default_factory=deque)
    sentences: Deque[str] = field(default_factory=deque)
    last_topology_dispatch: float = 0.0
    pending: bool = False
    # Total words appended over the session's lifetime (NOT the current
    # buffer length, which is capped). Used to compute new-word delta
    # since the last topology dispatch — avoids dispatching on silence.
    total_words: int = 0
    total_words_at_last_dispatch: int = 0


class RingBuffer:
    def __init__(self, max_words: int = 200, max_sentences: int = 32):
        self.max_words = max_words
        self.max_sentences = max_sentences
        self._sessions: dict[str, _SessionBuffer] = {}

    def _get(self, session_id: str) -> _SessionBuffer:
        buf = self._sessions.get(session_id)
        if buf is None:
            buf = _SessionBuffer()
            self._sessions[session_id] = buf
        return buf

    def append(self, session_id: str, text: str) -> None:
        if not text:
            return
        buf = self._get(session_id)
        for w in text.split():
            buf.words.append(w)
            buf.total_words += 1
            while len(buf.words) > self.max_words:
                buf.words.popleft()
        # Naïve sentence split for the attention tracker.
        for s in _split_sentences(text):
            if s:
                buf.sentences.append(s)
                while len(buf.sentences) > self.max_sentences:
                    buf.sentences.popleft()

    def snapshot(self, session_id: str) -> str:
        buf = self._sessions.get(session_id)
        if buf is None:
            return ""
        return " ".join(buf.words)

    def recent_sentences(self, session_id: str, n: int = 10) -> list[str]:
        buf = self._sessions.get(session_id)
        if buf is None:
            return []
        if n <= 0:
            return []
        return list(buf.sentences)[-n:]

    def session_ids(self) -> list[str]:
        return list(self._sessions.keys())

    def should_dispatch_topology(
        self,
        session_id: str,
        debounce_seconds: float,
        min_new_words: int = 0,
    ) -> bool:
        """Return True if BOTH (a) at least `debounce_seconds` have passed
        since the last dispatch, AND (b) at least `min_new_words` new words
        have been appended since the last dispatch. Both gates passed →
        record this as the new dispatch point and return True; otherwise
        return False without mutating state.

        The new-words gate prevents wasted LLM calls during silence: a
        3-second debounce alone would still fire a dispatch if the user
        was silent for 3 seconds and then said one filler word. Requiring
        a minimum delta ensures each dispatch sees genuinely new context."""
        buf = self._get(session_id)
        now = time.monotonic()
        new_words = buf.total_words - buf.total_words_at_last_dispatch
        if (
            now - buf.last_topology_dispatch >= debounce_seconds
            and new_words >= min_new_words
        ):
            buf.last_topology_dispatch = now
            buf.total_words_at_last_dispatch = buf.total_words
            return True
        return False

    def mark_dispatch(self, session_id: str) -> None:
        self._get(session_id).last_topology_dispatch = time.monotonic()


def _split_sentences(text: str) -> list[str]:
    out: list[str] = []
    current: list[str] = []
    for ch in text:
        current.append(ch)
        if ch in ".!?":
            out.append("".join(current).strip())
            current = []
    if current:
        leftover = "".join(current).strip()
        if leftover:
            out.append(leftover)
    return out


# Module-level singleton used by ws + attention tracker.
_buffer: Optional[RingBuffer] = None


def get_buffer() -> RingBuffer:
    global _buffer
    if _buffer is None:
        from backend.config import get_settings

        _buffer = RingBuffer(max_words=get_settings().RING_BUFFER_WORDS)
    return _buffer


def reset_buffer() -> None:
    """Test helper."""
    global _buffer
    _buffer = None
