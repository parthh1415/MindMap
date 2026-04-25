"""Integration smoke test for the topology agent.

Skipped by default. Run with:
    GROQ_API_KEY=... pytest -m integration agents/tests/test_integration_smoke.py
"""
from __future__ import annotations

import asyncio
import os

import pytest

from shared.agent_messages import TopologyDiff


pytestmark = pytest.mark.integration


@pytest.mark.asyncio
@pytest.mark.skipif(
    not os.getenv("GROQ_API_KEY"),
    reason="GROQ_API_KEY required for integration test",
)
async def test_stream_topology_diff_live():
    """Live call to Groq — verifies a real, structurally valid diff comes back."""
    import llm  # local import to avoid module-load failures in unit-only runs

    diff = await asyncio.wait_for(
        llm.stream_topology_diff(
            graph_json='{"nodes": [], "edges": []}',
            last_words="We were talking about reinforcement learning and reward hacking.",
            session_id="smoke",
        ),
        timeout=15.0,
    )
    assert isinstance(diff, TopologyDiff)
    assert isinstance(diff.additions_nodes, list)
    assert isinstance(diff.additions_edges, list)
    assert isinstance(diff.merges, list)
    assert isinstance(diff.edge_updates, list)
    assert len(diff.additions_nodes) <= llm.MAX_ADDITION_NODES
