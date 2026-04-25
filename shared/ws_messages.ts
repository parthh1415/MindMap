// Single source of truth for WebSocket payloads.
// Mirrors shared/schemas.py. Any change here MUST be reflected there.

export type EdgeType = "solid" | "dashed" | "dotted";

export type NodeInfoEntry = {
  text: string;
  created_at: string; // ISO datetime, UTC
};

export type Node = {
  _id: string;
  session_id: string;
  label: string;
  speaker_id?: string | null;
  importance_score: number;
  parent_id?: string | null;
  created_at: string;
  updated_at: string;
  info: NodeInfoEntry[];
  image_url?: string | null;
  deleted_at?: string | null;
};

export type Edge = {
  _id: string;
  session_id: string;
  source_id: string;
  target_id: string;
  edge_type: EdgeType;
  speaker_id?: string | null;
  created_at: string;
  deleted_at?: string | null;
};

export type BranchedFrom = {
  session_id: string;
  timestamp: string;
};

export type Session = {
  _id: string;
  name: string;
  created_at: string;
  branched_from?: BranchedFrom | null;
};

// ---------------------------------------------------------------------------
// Frontend → Backend (transcript ingress)
// ---------------------------------------------------------------------------

export type TranscriptChunk = {
  type: "transcript";
  session_id: string;
  speaker_id: string; // diarization speaker id, or stable per-tab UUID for fallback
  text: string;
  is_final: boolean; // false = partial, true = committed
  ts_client: number; // epoch ms
};

// ---------------------------------------------------------------------------
// Backend → Frontend (graph diff egress)
// ---------------------------------------------------------------------------

export type GhostNodeEvent = {
  type: "ghost_node";
  session_id: string;
  ghost_id: string;
  label: string;
  speaker_id: string;
};

export type NodeUpsertEvent = {
  type: "node_upsert";
  session_id: string;
  node: Node;
  resolves_ghost_id?: string;
};

export type NodeMergeEvent = {
  type: "node_merge";
  session_id: string;
  ghost_id: string;
  merged_into_id: string;
};

export type EdgeUpsertEvent = {
  type: "edge_upsert";
  session_id: string;
  edge: Edge;
};

export type NodeEnrichedEvent = {
  type: "node_enriched";
  session_id: string;
  node_id: string;
  info: NodeInfoEntry[];
};

export type GraphEvent =
  | GhostNodeEvent
  | NodeUpsertEvent
  | NodeMergeEvent
  | EdgeUpsertEvent
  | NodeEnrichedEvent;
