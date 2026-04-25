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

    def should_dispatch_topology(self, session_id: str, debounce_seconds: float) -> bool:
        """Return True if enough time has passed since the last dispatch."""
        buf = self._get(session_id)
        now = time.monotonic()
        if now - buf.last_topology_dispatch >= debounce_seconds:
            buf.last_topology_dispatch = now
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
