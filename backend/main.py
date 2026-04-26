"""FastAPI app entry point for the MindMap backend.

Exposes:
  - GET  /healthz
  - REST routes from routes/ (sessions, nodes, edges)
  - WS   /ws/transcript        (frontend → backend)
  - WS   /ws/graph/{session_id} (backend → frontend)

Lifespan handler:
  - Connects to MongoDB and creates required indexes.
  - Starts the attention tracker background task.
  - On shutdown, cancels the task and closes the Mongo client.
"""
from __future__ import annotations

import logging
import os
import sys
from contextlib import asynccontextmanager

# Ensure project root is on sys.path so ``import shared`` works regardless
# of where uvicorn is launched from.
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), os.pardir))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend import attention
from backend.db.client import close_client, create_indexes, init_client
from backend.routes import agent_callbacks as agent_callback_routes
from backend.routes import artifacts as artifacts_routes
from backend.routes import assembly_token as assembly_token_routes
from backend.routes import edges as edges_routes
from backend.routes import nodes as nodes_routes
from backend.routes import pivots as pivots_routes
from backend.routes import sessions as sessions_routes
from backend.routes import synthesis as synthesis_routes
from backend.ws import graph_socket, transcript_socket

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: D401
    # Startup
    try:
        init_client()
        await create_indexes()
    except Exception as exc:  # pragma: no cover — keep app booting in dev
        logger.warning("startup: mongo init skipped: %s", exc)

    try:
        attention.start()
    except Exception as exc:  # pragma: no cover
        logger.warning("startup: attention tracker failed to start: %s", exc)

    yield

    # Shutdown
    try:
        await attention.stop()
    except Exception:
        pass
    try:
        await close_client()
    except Exception:
        pass


app = FastAPI(title="MindMap Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://localhost:5174"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/healthz")
async def healthz():
    return {"status": "ok"}


app.include_router(sessions_routes.router)
app.include_router(nodes_routes.router)
app.include_router(edges_routes.router)
app.include_router(synthesis_routes.router)
app.include_router(pivots_routes.router)
app.include_router(artifacts_routes.router)
app.include_router(assembly_token_routes.router)
app.include_router(agent_callback_routes.router)
app.include_router(transcript_socket.router)
app.include_router(graph_socket.router)


__all__ = ["app"]
