"""Attention tracker: periodically scans transcript ring buffer for repeated
references to existing nodes, and dispatches an EnrichmentRequest.

Per-node cooldown enforced in-memory.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional

from shared.agent_messages import EnrichmentRequest

from backend.agent_client import dispatch_enrichment
from backend.config import get_settings
from backend.db import nodes_repo
from backend.db.client import get_db
from backend.ring_buffer import get_buffer

logger = logging.getLogger(__name__)


_last_dispatch: dict[str, float] = {}
_task: Optional[asyncio.Task] = None
_stopping = asyncio.Event()


def _count_mentions(label: str, sentences: list[str]) -> int:
    needle = label.lower().strip()
    if not needle:
        return 0
    return sum(1 for s in sentences if needle in s.lower())


async def _scan_once() -> None:
    settings = get_settings()
    buf = get_buffer()
    try:
        db = get_db()
    except Exception as exc:
        logger.debug("attention: db unavailable: %s", exc)
        return

    for session_id in buf.session_ids():
        sentences = buf.recent_sentences(session_id, 10)
        if not sentences:
            continue
        try:
            nodes = await nodes_repo.list_live(db, session_id)
        except Exception as exc:
            logger.debug("attention: nodes lookup failed: %s", exc)
            continue
        for node in nodes:
            label = node.get("label", "")
            mentions = _count_mentions(label, sentences)
            if mentions < settings.ATTENTION_MIN_MENTIONS:
                continue
            key = f"{session_id}:{node['_id']}"
            now = time.monotonic()
            last = _last_dispatch.get(key, 0.0)
            if now - last < settings.ATTENTION_NODE_COOLDOWN_SECONDS:
                continue
            _last_dispatch[key] = now
            segment = " ".join(sentences[-5:])
            req = EnrichmentRequest(
                session_id=session_id,
                node_id=node["_id"],
                node_label=label,
                transcript_segment=segment,
            )
            try:
                await dispatch_enrichment(req)
            except Exception as exc:
                logger.debug("enrichment dispatch failed: %s", exc)


async def _loop() -> None:
    settings = get_settings()
    interval = settings.ATTENTION_INTERVAL_SECONDS
    while not _stopping.is_set():
        try:
            await _scan_once()
        except Exception as exc:
            logger.warning("attention scan error: %s", exc)
        try:
            await asyncio.wait_for(_stopping.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass


def start() -> asyncio.Task:
    global _task
    if _task is None or _task.done():
        _stopping.clear()
        _task = asyncio.create_task(_loop())
    return _task


async def stop() -> None:
    _stopping.set()
    if _task is not None:
        try:
            await asyncio.wait_for(_task, timeout=2.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            _task.cancel()
