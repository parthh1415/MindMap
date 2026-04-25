# shared/ — Integration Contracts

This folder is **read-only** during the parallel build phase. All four
subagents conform to the types defined here. Any change requires:

1. Surfacing to the orchestrator before code is written.
2. Updating both `schemas.py` and `ws_messages.ts` in lockstep so Python and
   TypeScript stay aligned.
3. Documenting the change in `INTEGRATION.md`.

## Files

- **schemas.py** — Pydantic models for MongoDB persistence + mirrored
  WebSocket message types (Backend ↔ Frontend). Single source of truth.
  `REQUIRED_INDEXES` is the canonical index list — `backend/db/client.py`
  must create exactly these on startup.
- **ws_messages.ts** — TypeScript mirror of the WebSocket message types in
  `schemas.py`. Frontend imports from here.
- **agent_messages.py** — `uagents.Model` types exchanged between backend
  and the topology / enrichment agent processes.

## Guarantees

- All datetimes are UTC, timezone-aware. Serialized as ISO 8601 in JSON.
- `_id` fields are MongoDB ObjectId strings.
- Ghost nodes are **not** persisted; they live only in the WebSocket layer
  and the frontend store. Solidification = a `node_upsert` event with a
  `resolves_ghost_id` hint.
- Soft-delete only: setting `deleted_at` excludes a node/edge from live
  reads while preserving timeline replay.
