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


# -----------------------------------------------------------------------------
# Artifact generator (Phase 7): turn the live map into a downloadable file
# (PRD, engineering scaffold, decision doc, retro, action plan, research
# brief, debate brief, or general one-pager). Two-step flow: classify the
# session, then project the map through the chosen template.
# -----------------------------------------------------------------------------
# 8 fixed types. Keep this list narrow on purpose — generic "doc" is the
# fallback (`brief`); everything else is opinionated with strong skeletons.
ARTIFACT_TYPES = (
    "prd",       # product/feature ideation
    "scaffold",  # engineering project starter (multi-file zip)
    "decision",  # comparison / tradeoffs / recommendation
    "retro",     # what-went-well / what-didn't / actions
    "action",    # goal / milestones / risks
    "research",  # exploratory / question-driven
    "debate",    # multi-speaker disagreement
    "brief",     # general one-pager fallback
)


class ArtifactClassifyRequest(Model):
    session_id: str
    nodes_json: str               # serialized nodes (live or scrubbed snapshot)
    edges_json: str
    transcript_excerpt: str       # ~1500 words


class ArtifactCandidate(BaseModel := __import__("pydantic").BaseModel):  # noqa: E501
    type: str                     # one of ARTIFACT_TYPES
    score: float                  # 0..1
    why: str                      # one-sentence rationale


class ArtifactClassifyResponse(Model):
    session_id: str
    top_choice: str               # one of ARTIFACT_TYPES
    confidence: float             # 0..1
    candidates: list[dict]        # top 3 [{type, score, why}]


class ArtifactGenerateRequest(Model):
    session_id: str
    artifact_type: str            # one of ARTIFACT_TYPES
    nodes_json: str
    edges_json: str
    transcript_excerpt: str
    refinement_hint: str = ""     # "more technical" | "shorter" | "focus on auth" | ""
    section_anchor: str = ""      # non-empty when regenerating a single H2; matches markdown anchor
    at_timestamp: str = ""        # ISO; non-empty when generated from a past timeline state


class ArtifactFile(__import__("pydantic").BaseModel):
    path: str                     # e.g. "README.md", "architecture.md", "routes.md"
    content: str                  # markdown / text


class ArtifactEvidenceEntry(__import__("pydantic").BaseModel):
    section_anchor: str           # H2 slug
    node_ids: list[str] = []      # graph nodes that justified the section
    transcript_excerpts: list[str] = []  # quoted lines


class ArtifactGenerateResponse(Model):
    session_id: str
    artifact_type: str
    title: str
    markdown: str                 # the primary file content (for `scaffold`, this is README.md)
    files: list[dict] = []        # for `scaffold`: extra files [{path, content}]; empty otherwise
    evidence: list[dict] = []     # [{section_anchor, node_ids, transcript_excerpts}]
