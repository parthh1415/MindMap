"""uAgent message types — exchanged between backend and the two agent processes."""
from __future__ import annotations

from uagents import Model


class TopologyRequest(Model):
    session_id: str
    speaker_id: str
    last_n_words: str       # ~100 words of recent transcript
    current_graph_json: str # serialized {"nodes": [...], "edges": [...]}


class TopologyDiff(Model):
    session_id: str
    additions_nodes: list[dict]   # nodes to add (no _id yet); see prompts/topology_system.txt
    additions_edges: list[dict]   # edges to add
    merges: list[dict]            # [{ghost_label, into_id}]
    edge_updates: list[dict]      # [{edge_id, new_type}]


class EnrichmentRequest(Model):
    session_id: str
    node_id: str
    node_label: str
    transcript_segment: str       # last ~500 words mentioning the node


class EnrichmentResponse(Model):
    session_id: str
    node_id: str
    info_entries: list[str]       # 3–5 key points


# -----------------------------------------------------------------------------
# Synthesis (Option A): expand a node into children, synthesize a cluster /
# session into a doc/email/issue.
# -----------------------------------------------------------------------------

class ExpandRequest(Model):
    session_id: str
    node_id: str
    node_label: str
    transcript_window: str        # last ~600 words around the node


class ExpandResponse(Model):
    session_id: str
    node_id: str
    children: list[dict]          # [{label, edge_type, importance_score}]


class SynthesisRequest(Model):
    session_id: str
    nodes_json: str               # serialized nodes the user wants synthesized
    edges_json: str               # serialized edges between those nodes
    transcript_excerpts: str      # relevant transcript text
    target_format: str            # "doc" | "email" | "issue" | "summary"


class SynthesisResponse(Model):
    session_id: str
    title: str
    markdown: str
    target_format: str


# -----------------------------------------------------------------------------
# Pivot detection (Option D): identifies branchable moments in the live
# transcript so the UI can offer "branch here" affordances.
# -----------------------------------------------------------------------------

class PivotRequest(Model):
    session_id: str
    transcript_excerpt: str       # last ~400 words
    current_node_labels: list[str]


class PivotPoint(Model):
    timestamp: str                # ISO 8601 — wall clock of the pivot
    why: str                      # one-line rationale
    pivot_label: str              # short name for the alternative path


class PivotResponse(Model):
    session_id: str
    pivots: list[PivotPoint]      # 0..3 candidates per call
