"""Agentverse registration helper shared by both agent processes.

- Wires the Chat Protocol from ``uagents_core.contrib.protocols.chat`` onto
  an agent so ASI:One can route to it.
- Idempotently writes the agent's address into ``agents/.addresses.json``
  so the backend can discover both processes.
- Logs (never prints) and never logs the API key.
"""
from __future__ import annotations

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger("agents.agentverse_register")

ADDRESSES_FILE = Path(__file__).resolve().parent / ".addresses.json"

_REGISTERED: set[str] = set()


def _load_addresses() -> dict[str, str]:
    if not ADDRESSES_FILE.exists():
        return {}
    try:
        return json.loads(ADDRESSES_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        logger.warning("Could not read %s; starting fresh", ADDRESSES_FILE)
        return {}


def _atomic_write(data: dict[str, str]) -> None:
    """Write JSON atomically (tmp file + rename) to tolerate concurrent agents."""
    ADDRESSES_FILE.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=".addresses.", suffix=".tmp", dir=str(ADDRESSES_FILE.parent)
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2, sort_keys=True)
        os.replace(tmp_path, ADDRESSES_FILE)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise


def write_address(name: str, address: str) -> None:
    """Merge ``{name: address}`` into the addresses file."""
    existing = _load_addresses()
    existing[name] = address
    _atomic_write(existing)
    logger.info("Wrote %s → %s", name, ADDRESSES_FILE)


def register_chat_agent(agent: Any, name: str) -> None:
    """Attach the Chat Protocol to ``agent`` and persist its address.

    Idempotent: a second call with the same name is a no-op for protocol
    inclusion but will refresh the address on disk.
    """
    address = getattr(agent, "address", None)
    if address:
        write_address(name, address)
        logger.info("Agent '%s' address: %s", name, address)
    else:  # pragma: no cover - defensive
        logger.warning("Agent '%s' has no address yet", name)

    if name in _REGISTERED:
        return

    try:
        from uagents_core.contrib.protocols.chat import chat_protocol_spec
        from uagents import Protocol

        chat_proto = Protocol(spec=chat_protocol_spec)
        # We only need to advertise the protocol so ASI:One can route to it.
        agent.include(chat_proto, publish_manifest=True)
        _REGISTERED.add(name)
        logger.info("Chat Protocol registered for '%s' (publish_manifest=True)", name)
    except Exception as exc:  # noqa: BLE001
        # Never crash the agent process for a registration hiccup.
        logger.warning(
            "Chat Protocol registration failed for '%s': %s — continuing locally",
            name,
            exc,
        )

    if not os.getenv("AGENTVERSE_API_KEY"):
        logger.warning(
            "AGENTVERSE_API_KEY not set — agent '%s' will not appear on Agentverse",
            name,
        )
