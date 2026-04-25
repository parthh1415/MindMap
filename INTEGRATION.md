# Integration Report

Phase 2 outcome of the four-agent parallel build. Frozen contracts in
`shared/` were not edited by any subagent. All four returned
`ready_for_integration: true` and all unit/integration test suites are
green:

| Workstream | Tests | Status |
|---|---|---|
| backend  | 12/12 pytest | ✅ |
| agents   | 7/7 pytest (1 integration test gated on `GROQ_API_KEY`) | ✅ |
| transcript | 20/20 vitest | ✅ |
| frontend | 13/13 vitest, `tsc --noEmit` clean, `vite build` clean | ✅ |

Live smoke (Phase 2):

- Backend booted on `:8000`, `GET /healthz → 200`.
- `POST /sessions` created session against MongoDB Atlas; round-tripped via
  WebSocket subscriber.
- `POST /internal/topology-diff` → backend persisted nodes → broadcast a
  `node_upsert` event to a connected `/ws/graph/{sid}` subscriber. Verified
  end-to-end.
- Topology agent on `:8001`, enrichment agent on `:8002`. Both registered
  with the Almanac, both wrote their addresses to `agents/.addresses.json`.
- **Live Groq topology call**: 708 ms latency, returned 3 sensible nodes
  from a sentence about cybersecurity / authentication / zero-trust,
  honoring the ≤5 cap.
- Frontend dev server booted on `:5173`, `200 OK`. `vite build` passes.

## Contract drift / additive changes

These are deviations from §3 that surfaced during the parallel phase. None
required editing `shared/`. Any future tightening should fold them in.

### 1. `snapshot` WebSocket frame (additive, undocumented)

`backend/ws/graph_socket.py` sends an initial `{"type": "snapshot",
"nodes": [...], "edges": [...]}` payload to a fresh subscriber so the
client can render existing state on reconnect.

`shared/ws_messages.ts` does not declare this type, and
`frontend/src/state/graphStore.ts:applyGraphEvent` switches on `e.type`
with no `default` case — so the snapshot is silently dropped on the
frontend. Live behavior: a fresh subscriber **does not** receive initial
graph state via the WebSocket. Workaround: frontend already calls
`GET /sessions/{id}/graph` on session load, which is the supported source
of truth for the initial snapshot.

**Recommended fix (post-build):** either
- add a `SnapshotEvent` to `shared/ws_messages.ts` and wire the frontend
  store to apply it; OR
- have the backend stream an ordered burst of `node_upsert` /
  `edge_upsert` events on connect instead of a custom blob.

### 2. `ghost_id` round-trip on topology additions (additive, intentional)

The topology agent may include `ghost_id` on each `additions_nodes` entry
to mark ghost solidification. Backend strips it before persistence and
forwards it as `resolves_ghost_id` on the outbound `node_upsert` event.
This matches `shared/ws_messages.ts:NodeUpsertEvent.resolves_ghost_id`,
so it's strictly additive on the agent → backend leg.

### 3. Edge labels-or-IDs in topology output (additive)

`additions_edges[*].source_id` / `target_id` may be either an existing
node `_id` or a label that maps to a same-diff `additions_nodes` entry.
Backend's `apply_topology_diff` resolves labels to assigned IDs within
the same diff. Documented; no schema change.

### 4. HTTP fallback for agent → backend results (additive)

Backend exposes `POST /internal/topology-diff` and
`POST /internal/enrichment` as a transport alternative to native uagents
`ctx.send`. Bodies mirror `shared/agent_messages.py` exactly. Used by
the Phase 2 smoke test; agents currently use native uagents send in
production.

### 5. ElevenLabs realtime endpoint URL (assumption)

The brief named `wss://api.elevenlabs.io/v1/speech-to-text/realtime` but
the documented streaming path is `/stream`. Transcript subagent
implemented against `/stream` and exposed an `endpointUrl` override on
`createElevenLabsClient` and `createTranscriptPipeline` for one-line swap
if a teammate confirms a different URL. The behavior contract (emit
partial + final `TranscriptChunk` with `speaker_id` from diarization) is
honored regardless. See `transcript/docs/README.md` §3.

### 6. Chat Protocol manifest verification

Both agents register on Agentverse, but the `AgentChatProtocol:0.3.0`
manifest fails verification under the locally-installed `uagents`
version — `uagents_core.contrib.protocols.chat`'s manifest hash does
not match what the SDK expects. Agents log a warning and continue
listening locally (per spec). Almanac registration succeeds.

**Demo impact:** the `asi:one`-routed query path is not currently usable
without resolving the protocol version. Mitigation: pin a `uagents`
version known to publish a verifiable Chat Protocol, OR register a fresh
`Protocol("AgentChatProtocol", "0.3.0")` defined locally rather than
imported from `uagents_core.contrib.protocols.chat`.

### 7. Almanac contract registration (informational)

Both agents log:
```
WARNING: I do not have enough funds to register on Almanac contract
```
This is the fetch.ai mainnet/testnet on-chain registration warning, not
a blocker. Off-chain Almanac registration succeeded for both. To enable
on-chain registration: send funds to the printed wallet addresses, or
construct the agents with `network="testnet"`.

### 8. Frontend design tokens (assumption, documented)

`/ui-ux-pro-max` recommended Inter for both heading and body and
`#22C55E` as the accent; the frontend agent upgraded heading to **Geist**
(geometric/display, per the brief's font-pair guidance) and accent to
**`#22D3EE`** (cyan, to differentiate from `--speaker-4` emerald). All
six speaker-color CSS vars were hand-picked to extend the plugin's
10-color palette. Documented in `frontend/PLUGINS_USED.md`.

### 9. Magic MCP not used for surface UI

`mcp__magic__*` tool schemas loaded via `ToolSearch` but the frontend
agent hand-coded all five components originally slated for Magic
(`NodeEditModal`, `TimelineScrubber`, `SidePanel`, `SpeakerLegend`,
`EmptyState`) because deterministic compliance with the visual mandates
(Framer Motion shared-element layout, project tokens only,
`AnimatePresence`, spring physics) outweighed the speed of Magic
generation that would have required near-total token replacement. Soft
fallback per the brief; documented in `frontend/PLUGINS_USED.md`.

### 10. Pre-flight skill path

The brief named `/mnt/skills/public/frontend-design/SKILL.md` (Linux
container path); on this macOS box the skill is at
`/Users/parthsrivastava/.claude/plugins/cache/claude-plugins-official/frontend-design/unknown/skills/frontend-design/SKILL.md`.
Frontend agent was redirected to that local path by the orchestrator
during Phase 0.

### 11. Project root restructure

A Vite + React + TS scaffold pre-existed at the project root (created in
an earlier turn before the build brief was issued). Phase 0 moved it
under `frontend/` to match the §2 layout. The frontend subagent adapted
that scaffold rather than re-init.

## Free-tier verification (§7.6)

```
$ grep -rE "^import anthropic|^from anthropic|^import openai|^from openai" \
    --include="*.py" backend/ agents/                              → empty ✅
$ grep -rE "import.*['\"]anthropic['\"]|import.*['\"]openai['\"]" \
    --include="*.ts" --include="*.tsx" --include="*.js" frontend/ transcript/  → empty ✅
$ grep -E "^(anthropic|openai)" backend/requirements.txt agents/requirements.txt  → empty ✅
$ grep -E '"anthropic"|"openai"' frontend/package.json transcript/*/package.json  → empty ✅
$ grep -rE "(sk-|sk_|gsk_|key-)[A-Za-z0-9_-]{20,}" \
    --include="*.py" --include="*.ts" --include="*.tsx" --include="*.json" \
    --exclude-dir=node_modules --exclude-dir=.venv \
    backend/ agents/ frontend/ transcript/ shared/                 → empty ✅
```

ElevenLabs key is in `.env` (gitignored) only; manual scoped-STT-key
check still required per spec — flag for human review.

## Visual polish greps (§7.5 partial)

```
$ grep -rn "✨" frontend/src                  → empty ✅
$ grep -rn "transition: all" frontend/src    → empty ✅
$ grep -rni "AI-powered" frontend/src        → empty ✅
```

`tokens.css` quotes from `frontend-design/SKILL.md`, defines
`--speaker-1..--speaker-6`, and the rendered app boots dark-mode-first
on `npm run dev`. Full visual inspection (ghost→solid layout morph,
edge `pathLength` 0→1, ~1s branch animation, scrubber spring tween)
requires interactive browser review on `http://localhost:5173`.

## Known gaps (deferred)

- Agentverse/asi:one routing not currently functional (gap #6).
- `infra/test/ws_roundtrip.py` and `infra/test/latency.py` from §7
  not implemented as standalone scripts; smoke equivalents were run
  inline during Phase 2.
- `infra/seed_demo.py` (§8 demo seed with ≥12 nodes + a branch) not
  written — defer to demo-prep phase.
- Playwright latency probe (§7.2) not run; live Groq topology call was
  708 ms (well within the 1500 ms p50 target for agent confirmation).
- Reduced-motion + interactive UI walkthrough requires human review.
