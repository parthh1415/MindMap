"""Thin client for sending uAgent messages to the topology + enrichment agents.

Address resolution: agents write their addresses to ``agents/.addresses.json``
on startup. We poll lazily — if the file is missing we log once and skip the
dispatch (the call becomes a no-op until addresses appear).
"""
from __future__ import annotations

import json
import logging
import os
from typing import Optional

from shared.agent_messages import EnrichmentRequest, TopologyRequest

from backend.config import get_settings

logger = logging.getLogger(__name__)

_addresses_cache: Optional[dict] = None
_warned_missing = False


def _load_addresses() -> Optional[dict]:
    global _addresses_cache, _warned_missing
    settings = get_settings()
    path = settings.AGENT_ADDRESSES_PATH
    if not os.path.exists(path):
        if not _warned_missing:
            logger.info("agent addresses file %s not present yet; deferring agent dispatch", path)
            _warned_missing = True
        return None
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        _addresses_cache = data
        return data
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        if not _warned_missing:
            logger.info("agent addresses file unreadable: %s", exc)
            _warned_missing = True
        return None


def _topology_address() -> Optional[str]:
    data = _load_addresses()
    if not data:
        return None
    return data.get("topology")


def _enrichment_address() -> Optional[str]:
    data = _load_addresses()
    if not data:
        return None
    return data.get("enrichment")


async def _send(addr: str, message) -> bool:
    """Best-effort send via uagents.communication.send_message.

    The exact send helper differs by uagents version. We try a couple of
    options and silently degrade — the orchestrator's Phase 2 wiring will
    surface real send errors.
    """
    try:
        from uagents.communication import send_sync_message  # type: ignore

        await send_sync_message(addr, message)
        return True
    except Exception:
        pass
    try:
        from uagents.query import query  # type: ignore

        await query(addr, message)
        return True
    except Exception as exc:
        logger.warning("agent dispatch failed: %s", exc)
        return False


async def dispatch_topology(req: TopologyRequest) -> bool:
    addr = _topology_address()
    if not addr:
        return False
    return await _send(addr, req)


async def dispatch_enrichment(req: EnrichmentRequest) -> bool:
    addr = _enrichment_address()
    if not addr:
        return False
    return await _send(addr, req)
