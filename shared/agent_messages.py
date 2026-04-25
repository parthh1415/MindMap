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
