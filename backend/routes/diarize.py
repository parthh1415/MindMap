"""Background-task batch diarization endpoint.

Frontend uploads accumulated session audio (16-bit PCM @ 16 kHz, mono,
WAV-encoded) here every ~30 s and on mic-stop. We immediately return
202 (accepted) and run the AssemblyAI batch flow in a background
asyncio task — by the time the user clicks Generate, the speaker
transcript is sitting in ``diarize_cache``.

This keeps the artifact-generation latency identical to today: the
slow AssemblyAI batch (5-15 s upload + transcribe + poll) runs in
parallel with the user talking, not synchronously when they hit
Generate.

Endpoint:
    POST /internal/diarize-batch?session_id=<id>
        body: raw audio bytes (WAV, 16 kHz mono PCM)
        → 202 Accepted, body={"queued": true}

    GET /internal/diarize-status/{session_id}
        → {"present": bool, "generated_at_ms": int, "utterances": int}
"""
from __future__ import annotations

import asyncio
import logging
import os
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request

from backend import diarize_cache

logger = logging.getLogger(__name__)
router = APIRouter(tags=["diarize"])

_AAI_UPLOAD = "https://api.assemblyai.com/v2/upload"
_AAI_TRANSCRIPT = "https://api.assemblyai.com/v2/transcript"
_POLL_INTERVAL_SECONDS = 1.5
_HARD_TIMEOUT_SECONDS = 90.0  # well past typical 5-15s


async def _run_diarize(session_id: str, audio_bytes: bytes) -> None:
    """Long-running background task: upload audio → submit batch
    transcript → poll until complete → cache the result."""
    api_key = os.getenv("ASSEMBLYAI_API_KEY", "").strip()
    if not api_key:
        logger.warning("diarize: ASSEMBLYAI_API_KEY not set — skipping")
        return

    headers = {"Authorization": api_key}
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            # 1. Upload audio (raw bytes, no Content-Type header — AssemblyAI accepts this).
            up = await client.post(_AAI_UPLOAD, headers=headers, content=audio_bytes)
            if up.status_code != 200:
                logger.warning(
                    "diarize: AAI upload failed (%d): %s",
                    up.status_code, up.text[:300],
                )
                return
            audio_url = up.json().get("upload_url")
            if not audio_url:
                logger.warning("diarize: AAI upload returned no upload_url")
                return

            # 2. Submit transcript with speaker_labels — this IS the diarized one.
            sub = await client.post(
                _AAI_TRANSCRIPT,
                headers=headers,
                json={
                    "audio_url": audio_url,
                    "speaker_labels": True,
                    "speech_models": ["universal-2"],
                },
            )
            if sub.status_code != 200:
                logger.warning(
                    "diarize: AAI transcript submit failed (%d): %s",
                    sub.status_code, sub.text[:300],
                )
                return
            transcript_id = sub.json().get("id")
            if not transcript_id:
                logger.warning("diarize: AAI submit returned no id")
                return

            # 3. Poll until complete (AssemblyAI calls this 'completed').
            poll_url = f"{_AAI_TRANSCRIPT}/{transcript_id}"
            deadline = asyncio.get_event_loop().time() + _HARD_TIMEOUT_SECONDS
            while True:
                if asyncio.get_event_loop().time() > deadline:
                    logger.warning("diarize: timed out waiting for AAI batch")
                    return
                await asyncio.sleep(_POLL_INTERVAL_SECONDS)
                pol = await client.get(poll_url, headers=headers)
                if pol.status_code != 200:
                    logger.warning("diarize: AAI poll %d", pol.status_code)
                    continue
                data = pol.json()
                status = data.get("status")
                if status == "completed":
                    break
                if status == "error":
                    logger.warning(
                        "diarize: AAI returned error: %s",
                        data.get("error", "unknown"),
                    )
                    return

            # 4. Compress to per-speaker utterances + cache.
            words = data.get("words") or []
            # AssemblyAI also returns its own 'utterances' field; prefer
            # that when present (already speaker-segmented).
            aai_utts = data.get("utterances")
            if isinstance(aai_utts, list) and aai_utts:
                utterances = [
                    {
                        "speaker": u.get("speaker", "?"),
                        "text": (u.get("text") or "").strip(),
                        "start": u.get("start"),
                        "end": u.get("end"),
                    }
                    for u in aai_utts
                ]
            else:
                utterances = diarize_cache.words_to_utterances(words)

            payload: dict[str, Any] = {
                "utterances": utterances,
                "raw_words": words,
                "audio_duration_seconds": data.get("audio_duration"),
                "language_code": data.get("language_code"),
                "transcript_id": transcript_id,
            }
            await diarize_cache.put(session_id, payload)
            logger.info(
                "diarize: cached %d utterances for session %s",
                len(utterances), session_id,
            )

    except httpx.HTTPError as exc:
        logger.warning("diarize: HTTP error: %s", exc)
    except Exception as exc:  # noqa: BLE001
        logger.exception("diarize: unexpected error: %s", exc)


@router.post("/internal/diarize-batch")
async def diarize_batch(request: Request, session_id: str) -> dict:
    """Accept audio, kick off AssemblyAI batch in background, return 202.

    The frontend uploads the FULL session audio each call — each
    diarization run sees more context than the last and replaces the
    cached entry, so the cache always reflects the latest accuracy.
    """
    audio = await request.body()
    if not audio:
        raise HTTPException(400, "empty body")
    if len(audio) > 50 * 1024 * 1024:  # 50 MB safety cap (~50 min mono 16k)
        raise HTTPException(413, "audio too large")
    asyncio.create_task(_run_diarize(session_id, audio))
    return {"queued": True, "bytes": len(audio)}


@router.get("/internal/diarize-status/{session_id}")
async def diarize_status(session_id: str) -> dict:
    payload = await diarize_cache.get(session_id)
    if not payload:
        return {"present": False}
    return {
        "present": True,
        "generated_at_ms": payload.get("generated_at_ms"),
        "utterances": len(payload.get("utterances") or []),
        "audio_duration_seconds": payload.get("audio_duration_seconds"),
    }
