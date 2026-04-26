"""In-memory per-session cache of diarized transcripts.

The frontend uploads raw audio to ``/internal/diarize-batch`` every ~30 s
(and on mic-stop). The backend kicks off an AssemblyAI batch
transcription with ``speaker_labels=true`` in a background task. When
the result lands, the speaker-attributed transcript is stored here.

The artifact agent reads from this cache *opportunistically* —
if it's populated when Generate fires, the artifact LLM gets richer
context. If it's empty, the artifact LLM just runs as before. This
preserves the ~11 s artifact latency we worked hard for in Phase 14.

Stored shape:
    {
      session_id: {
        "generated_at": <epoch_ms>,
        "utterances": [
          {"speaker": "A", "text": "...", "start": ms, "end": ms},
          ...
        ],
        "raw_words": [{"word":"...","start":ms,"end":ms,"speaker":"A"}, ...],
      }
    }

The cache is in-memory + per-process. Acceptable for a single-instance
demo; would need redis/db backing in a multi-replica deployment.
"""
from __future__ import annotations

import asyncio
import time
from typing import Any, Optional

# session_id → diarization payload
_cache: dict[str, dict[str, Any]] = {}
_lock = asyncio.Lock()


async def put(session_id: str, payload: dict[str, Any]) -> None:
    """Store the latest diarization for a session, replacing any prior
    entry. Each upload diarizes the FULL session audio so the cache
    always reflects the most-accurate available labeling."""
    async with _lock:
        _cache[session_id] = {
            **payload,
            "generated_at_ms": int(time.time() * 1000),
        }


async def get(session_id: str) -> Optional[dict[str, Any]]:
    async with _lock:
        return _cache.get(session_id)


async def clear(session_id: str) -> None:
    async with _lock:
        _cache.pop(session_id, None)


def words_to_utterances(words: list[dict]) -> list[dict]:
    """Compress AssemblyAI's word-level diarization into per-speaker
    utterances. Adjacent words with the same speaker are joined into
    one utterance string. Mirrors AssemblyAI's own ``utterances`` field
    when it's present, but works whether we have it or not."""
    out: list[dict] = []
    current: Optional[dict] = None
    for w in words:
        speaker = w.get("speaker") or w.get("speaker_id") or "?"
        text = (w.get("text") or w.get("word") or "").strip()
        start = w.get("start")
        end = w.get("end")
        if not text:
            continue
        if current is None or current["speaker"] != speaker:
            if current is not None:
                out.append(current)
            current = {
                "speaker": speaker,
                "text": text,
                "start": start,
                "end": end,
            }
        else:
            current["text"] = f"{current['text']} {text}".strip()
            current["end"] = end
    if current is not None:
        out.append(current)
    return out


def format_for_prompt(payload: dict[str, Any], max_words: int = 1500) -> str:
    """Format cached diarization as a speaker-attributed transcript
    suitable for dropping into an artifact LLM prompt. Caps at
    ``max_words`` total words to keep token budgets in check."""
    utterances = payload.get("utterances") or []
    if not utterances:
        return ""
    lines: list[str] = []
    word_count = 0
    for u in utterances:
        speaker = u.get("speaker", "?")
        text = (u.get("text") or "").strip()
        if not text:
            continue
        ws = text.split()
        if word_count + len(ws) > max_words:
            ws = ws[: max_words - word_count]
            text = " ".join(ws)
            lines.append(f"Speaker {speaker}: {text}")
            lines.append("[…transcript truncated for length…]")
            break
        word_count += len(ws)
        lines.append(f"Speaker {speaker}: {text}")
    return "\n".join(lines)
