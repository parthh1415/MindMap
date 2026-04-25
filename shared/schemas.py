"""Single source of truth for MongoDB persistence + WebSocket egress payloads.

Mirrors shared/ws_messages.ts for the Backend → Frontend graph events. Any
change here MUST be reflected in ws_messages.ts and surfaced to the
orchestrator before subagents proceed.
"""
from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

EdgeType = Literal["solid", "dashed", "dotted"]


class NodeInfoEntry(BaseModel):
    text: str
    created_at: datetime


class Node(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(alias="_id")
    session_id: str
    label: str
    speaker_id: Optional[str] = None
    importance_score: float = 1.0
    parent_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    info: list[NodeInfoEntry] = []
    image_url: Optional[str] = None
    deleted_at: Optional[datetime] = None  # soft-delete marker; absent on live nodes


class Edge(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(alias="_id")
    session_id: str
    source_id: str
    target_id: str
    edge_type: EdgeType = "solid"
    speaker_id: Optional[str] = None
    created_at: datetime
    deleted_at: Optional[datetime] = None


class BranchedFrom(BaseModel):
    session_id: str
    timestamp: datetime


class Session(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str = Field(alias="_id")
    name: str
    created_at: datetime
    branched_from: Optional[BranchedFrom] = None


# -----------------------------------------------------------------------------
# WebSocket message types — mirror shared/ws_messages.ts
# -----------------------------------------------------------------------------

class TranscriptChunk(BaseModel):
    type: Literal["transcript"] = "transcript"
    session_id: str
    speaker_id: str
    text: str
    is_final: bool
    ts_client: int


class GhostNodeEvent(BaseModel):
    type: Literal["ghost_node"] = "ghost_node"
    session_id: str
    ghost_id: str
    label: str
    speaker_id: str


class NodeUpsertEvent(BaseModel):
    type: Literal["node_upsert"] = "node_upsert"
    session_id: str
    node: Node
    resolves_ghost_id: Optional[str] = None


class NodeMergeEvent(BaseModel):
    type: Literal["node_merge"] = "node_merge"
    session_id: str
    ghost_id: str
    merged_into_id: str


class EdgeUpsertEvent(BaseModel):
    type: Literal["edge_upsert"] = "edge_upsert"
    session_id: str
    edge: Edge


class NodeEnrichedEvent(BaseModel):
    type: Literal["node_enriched"] = "node_enriched"
    session_id: str
    node_id: str
    info: list[NodeInfoEntry]


GraphEvent = Union[
    GhostNodeEvent,
    NodeUpsertEvent,
    NodeMergeEvent,
    EdgeUpsertEvent,
    NodeEnrichedEvent,
]


# Compound indexes the backend MUST create on startup.
REQUIRED_INDEXES = {
    "nodes": [("session_id", 1), ("created_at", 1)],
    "edges": [("session_id", 1), ("created_at", 1)],
    "sessions": [("created_at", 1)],
}
