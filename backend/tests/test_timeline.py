"""Timeline correctness: querying graph state at a past timestamp."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from backend.db import nodes_repo, sessions_repo


pytestmark = pytest.mark.asyncio


async def test_find_at_returns_only_nodes_existing_at_t(db):
    s = await sessions_repo.create_session(db, name="s")
    base = datetime.now(timezone.utc) - timedelta(minutes=10)
    times = [base + timedelta(minutes=i) for i in range(5)]
    for i, t in enumerate(times):
        await nodes_repo.create_node(
            db,
            {
                "session_id": s["_id"],
                "label": f"n{i}",
                "created_at": t,
                "updated_at": t,
            },
        )

    # T2 = base + 1.5 min → only n0 and n1 should exist.
    t2 = base + timedelta(minutes=1, seconds=30)
    snap = await nodes_repo.find_at(db, s["_id"], t2)
    assert len(snap) == 2
    assert {n["label"] for n in snap} == {"n0", "n1"}

    # Live read returns all 5.
    live = await nodes_repo.list_live(db, s["_id"])
    assert len(live) == 5


async def test_soft_deleted_node_excluded_after_deletion_but_visible_before(db):
    s = await sessions_repo.create_session(db, name="s")
    base = datetime.now(timezone.utc) - timedelta(minutes=10)
    n = await nodes_repo.create_node(
        db,
        {
            "session_id": s["_id"],
            "label": "doomed",
            "created_at": base,
            "updated_at": base,
        },
    )
    # Manually mark deletion at base + 2 min.
    deletion_time = base + timedelta(minutes=2)
    await db.nodes.update_one({"_id": n["_id"]}, {"$set": {"deleted_at": deletion_time}})

    # At base + 1 min → still exists.
    snap_before = await nodes_repo.find_at(db, s["_id"], base + timedelta(minutes=1))
    assert len(snap_before) == 1

    # At base + 5 min → gone.
    snap_after = await nodes_repo.find_at(db, s["_id"], base + timedelta(minutes=5))
    assert len(snap_after) == 0
