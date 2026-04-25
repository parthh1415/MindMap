# MindMap

Real-time mind-map ideation engine. Speak (alone or in groups), and a graph
of ideas builds itself from the live transcript. Every action is timestamped
so any past graph state can be replayed or branched from. **The map is the
summary** — there is no end-of-session AI write-up.

## Architecture (4 workstreams, isolated during build)

| Folder | Owner | Stack |
|---|---|---|
| `backend/` | FastAPI + Motor + WebSocket relays | Python 3.11+ |
| `transcript/` | Browser-direct mic → ElevenLabs Scribe v2 (Web Speech fallback) | TypeScript |
| `agents/` | Two `uagents` processes (topology + enrichment) on Groq Llama 3.3 70B | Python 3.11+ |
| `frontend/` | React + Vite + reactflow + Framer Motion | TypeScript strict |
| `shared/` | Frozen integration contracts (Pydantic + TS types + uAgent models) | — |

See `shared/README.md` for the contracts that bind these together, and
`INTEGRATION.md` (after Phase 2) for any contract drift that surfaced during
the build.

## Free-tier mandate

No paid LLM SaaS. Groq → Gemini fallback. ElevenLabs free tier → Web Speech
fallback. MongoDB Atlas M0, Cloudinary free tier, Agentverse free.
`grep -r "import anthropic\|import openai" .` must return nothing.

## Quick start

```sh
cp .env.example .env   # fill in values
# Backend
(cd backend && pip install -r requirements.txt && uvicorn main:app --port 8000)
# Agents (two processes)
(cd agents && pip install -r requirements.txt && python topology_agent.py &
 cd agents && python enrichment_agent.py &)
# Frontend
(cd frontend && npm install && npm run dev)
```
