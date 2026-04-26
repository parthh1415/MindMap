"""AssemblyAI Universal-Streaming v3 — temp token mint.

The browser cannot safely hold the AssemblyAI master API key, so this
endpoint proxies the temp-token request. The frontend calls
``GET /internal/assembly-token`` just before opening the streaming
WebSocket; the returned short-lived token goes in the WS query string.

Server-side env var: ``ASSEMBLYAI_API_KEY`` (NOT the VITE_-prefixed
flavor — we deliberately keep the master key off the browser).
"""
from __future__ import annotations

import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException

logger = logging.getLogger(__name__)
router = APIRouter(tags=["assembly-token"])

# Per AssemblyAI docs as of late 2025. The token defaults to 600s; we
# request the same so a typical 5-minute mic session never re-auths.
_TOKEN_ENDPOINT = "https://streaming.assemblyai.com/v3/token?expires_in_seconds=600"
_DEFAULT_TIMEOUT = 8.0


@router.get("/internal/assembly-token")
async def mint_assembly_token() -> dict[str, Any]:
    api_key = os.getenv("ASSEMBLYAI_API_KEY", "").strip()
    if not api_key:
        # 503, not 401 — the SERVER hasn't been configured. Frontend
        # treats this the same as "no provider available" and falls
        # back to ElevenLabs / Web Speech.
        raise HTTPException(503, "ASSEMBLYAI_API_KEY not configured on the server")

    try:
        async with httpx.AsyncClient(timeout=_DEFAULT_TIMEOUT) as client:
            resp = await client.get(
                _TOKEN_ENDPOINT,
                headers={"Authorization": api_key},
            )
    except httpx.HTTPError as exc:
        logger.warning("AssemblyAI token mint network error: %s", exc)
        raise HTTPException(502, f"AssemblyAI unreachable: {exc}")

    if resp.status_code != 200:
        body = resp.text[:300]
        logger.warning(
            "AssemblyAI token mint failed: HTTP %d — %s", resp.status_code, body
        )
        # Surface the upstream code through a 502 so the frontend doesn't
        # think OUR server is broken.
        raise HTTPException(502, f"AssemblyAI returned {resp.status_code}: {body}")

    try:
        data = resp.json()
    except ValueError:
        raise HTTPException(502, "AssemblyAI returned non-JSON")

    token = data.get("token")
    if not token:
        raise HTTPException(502, f"AssemblyAI response missing token: {data}")

    return {
        "token": token,
        # Pass through any expiry hint AssemblyAI gives us; defaults to
        # 600s on their side.
        "expires_in_seconds": data.get("expires_in_seconds", 600),
    }
