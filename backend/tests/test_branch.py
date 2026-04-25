"""Branching: copy nodes/edges where created_at <= T into a new session."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from backend.db import edges_repo, nodes_repo, sessions_repo


pytestmark = pytest.mark.asyncio


async def test_branch_creates_new_session_with_subset(db):
    parent = await sessions_repo.create_session(db, name="parent")
    base = datetime.now(timezone.utc) - timedelta(minutes=10)
    times = [base + timedelta(minutes=i) for i in range(5)]
    node_ids = []
    for i, t in enumerate(times):
        n = await nodes_repo.create_node(
            db,
            {
                "session_id": parent["_id"],
                "label": f"n{i}",
                "created_at": t,
                "updated_at": t,
            },
        )
        node_ids.append(n["_id"])

    # Edge between n0 and n1 at t=base+30s → should be copied.
    await edges_repo.create_edge(
        db,
        {
            "session_id": parent["_id"],
            "source_id": node_ids[0],
            "target_id": node_ids[1],
            "created_at": base + timedelta(seconds=30),
        },
    )

    # Branch at T = base + 2.5 min → expect 3 nodes copied, 1 edge copied.
    from backend.routes.sessions import BranchBody, branch_session

    body = BranchBody(timestamp=base + timedelta(minutes=2, seconds=30))
    result = await branch_session(parent["_id"], body, db=db)
    new_session_id = result["_id"]

    # Original session still has 5 nodes.
    parent_live = await nodes_repo.list_live(db, parent["_id"])
    assert len(parent_live) == 5

    # New session has 3 nodes.
    new_live = await nodes_repo.list_live(db, new_session_id)
    assert len(new_live) == 3
    assert {n["label"] for n in new_live} == {"n0", "n1", "n2"}

    # branched_from is set on the new session.
    new_session_doc = await sessions_repo.get_session(db, new_session_id)
    assert new_session_doc is not None
    assert new_session_doc["branched_from"]["session_id"] == parent["_id"]

    # Edge was copied with remapped node ids.
    new_edges = await edges_repo.list_live(db, new_session_id)
    assert len(new_edges) == 1
    new_node_by_label = {n["label"]: n["_id"] for n in new_live}
    assert new_edges[0]["source_id"] == new_node_by_label["n0"]
    assert new_edges[0]["target_id"] == new_node_by_label["n1"]
