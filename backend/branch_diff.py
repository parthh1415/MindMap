"""Pure helpers for diffing two branches' graphs.

The diff is computed at the LABEL level (case-insensitive) because branches
are copies — the _id values differ across sessions even when they refer to
the "same" concept. We also accept _id matches as a fallback (useful when a
caller passes the same session twice).

Edge equality is by (source_label, target_label) ignoring direction order
for "shared" reporting; we expose direction in the per-side outputs.
"""
from __future__ import annotations

from typing import Iterable


def _norm_label(value) -> str:
    if value is None:
        return ""
    return str(value).strip().lower()


def _index_nodes(nodes: Iterable[dict]) -> tuple[dict[str, dict], dict[str, dict]]:
    """Return (by_label, by_id) lookup dicts for the given nodes."""
    by_label: dict[str, dict] = {}
    by_id: dict[str, dict] = {}
    for n in nodes:
        if not isinstance(n, dict):
            continue
        label = _norm_label(n.get("label"))
        if label:
            by_label.setdefault(label, n)
        nid = n.get("_id")
        if nid:
            by_id[str(nid)] = n
    return by_label, by_id


def _node_key(n: dict, by_label: dict[str, dict], by_id: dict[str, dict]) -> str:
    """Stable comparison key for a node — label preferred, _id as fallback."""
    label = _norm_label(n.get("label"))
    if label:
        return f"L::{label}"
    nid = n.get("_id")
    if nid:
        return f"I::{nid}"
    return f"X::{id(n)}"


def _edge_key(edge: dict, nodes_by_id: dict[str, dict]) -> tuple[str, str]:
    """(source_label, target_label) for an edge, falling back to ids."""
    src_id = str(edge.get("source_id") or "")
    tgt_id = str(edge.get("target_id") or "")
    src_label = _norm_label((nodes_by_id.get(src_id) or {}).get("label")) or src_id
    tgt_label = _norm_label((nodes_by_id.get(tgt_id) or {}).get("label")) or tgt_id
    return src_label, tgt_label


def _node_summary(n: dict) -> dict:
    return {
        "_id": n.get("_id"),
        "label": n.get("label"),
        "speaker_id": n.get("speaker_id"),
    }


def _edge_summary(edge: dict, nodes_by_id: dict[str, dict]) -> dict:
    src_id = str(edge.get("source_id") or "")
    tgt_id = str(edge.get("target_id") or "")
    return {
        "_id": edge.get("_id"),
        "source_id": src_id,
        "target_id": tgt_id,
        "source_label": (nodes_by_id.get(src_id) or {}).get("label"),
        "target_label": (nodes_by_id.get(tgt_id) or {}).get("label"),
        "edge_type": edge.get("edge_type"),
    }


def compute_diff(
    nodes_a: list[dict],
    edges_a: list[dict],
    nodes_b: list[dict],
    edges_b: list[dict],
) -> dict:
    """Compute a label-level diff between two graphs.

    Returns:
        {
          "only_in_a": {"nodes": [...], "edges": [...]},
          "only_in_b": {"nodes": [...], "edges": [...]},
          "shared":    {"nodes": [...], "edges": [...]},
        }

    "shared" entries are reported using the A-side document so callers
    have stable ids to highlight on.
    """
    a_by_label, a_by_id = _index_nodes(nodes_a)
    b_by_label, b_by_id = _index_nodes(nodes_b)

    a_keys = {_node_key(n, a_by_label, a_by_id) for n in nodes_a if isinstance(n, dict)}
    b_keys = {_node_key(n, b_by_label, b_by_id) for n in nodes_b if isinstance(n, dict)}

    shared_keys = a_keys & b_keys
    only_a_keys = a_keys - b_keys
    only_b_keys = b_keys - a_keys

    shared_nodes: list[dict] = []
    only_a_nodes: list[dict] = []
    only_b_nodes: list[dict] = []

    seen_a: set[str] = set()
    for n in nodes_a:
        if not isinstance(n, dict):
            continue
        k = _node_key(n, a_by_label, a_by_id)
        if k in seen_a:
            continue
        seen_a.add(k)
        if k in shared_keys:
            shared_nodes.append(_node_summary(n))
        elif k in only_a_keys:
            only_a_nodes.append(_node_summary(n))

    seen_b: set[str] = set()
    for n in nodes_b:
        if not isinstance(n, dict):
            continue
        k = _node_key(n, b_by_label, b_by_id)
        if k in seen_b:
            continue
        seen_b.add(k)
        if k in only_b_keys:
            only_b_nodes.append(_node_summary(n))

    # Edges by (source_label, target_label).
    a_edge_set: set[tuple[str, str]] = set()
    a_edge_index: dict[tuple[str, str], dict] = {}
    for e in edges_a:
        if not isinstance(e, dict):
            continue
        key = _edge_key(e, a_by_id)
        a_edge_set.add(key)
        a_edge_index.setdefault(key, e)

    b_edge_set: set[tuple[str, str]] = set()
    b_edge_index: dict[tuple[str, str], dict] = {}
    for e in edges_b:
        if not isinstance(e, dict):
            continue
        key = _edge_key(e, b_by_id)
        b_edge_set.add(key)
        b_edge_index.setdefault(key, e)

    shared_edge_keys = a_edge_set & b_edge_set
    only_a_edge_keys = a_edge_set - b_edge_set
    only_b_edge_keys = b_edge_set - a_edge_set

    shared_edges = [
        _edge_summary(a_edge_index[k], a_by_id) for k in shared_edge_keys
    ]
    only_a_edges = [
        _edge_summary(a_edge_index[k], a_by_id) for k in only_a_edge_keys
    ]
    only_b_edges = [
        _edge_summary(b_edge_index[k], b_by_id) for k in only_b_edge_keys
    ]

    return {
        "only_in_a": {"nodes": only_a_nodes, "edges": only_a_edges},
        "only_in_b": {"nodes": only_b_nodes, "edges": only_b_edges},
        "shared": {"nodes": shared_nodes, "edges": shared_edges},
    }


__all__ = ["compute_diff"]
