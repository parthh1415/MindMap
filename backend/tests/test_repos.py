"""Repo CRUD smoke tests."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from backend.db import edges_repo, nodes_repo, sessions_repo


pytestmark = pytest.mark.asyncio


async def test_session_crud(db):
    s = await sessions_repo.create_session(db, name="root")
    assert s["name"] == "root"
    fetched = await sessions_repo.get_session(db, s["_id"])
    assert fetched is not None
    assert fetched["_id"] == s["_id"]


async def test_node_crud_and_soft_delete(db):
    s = await sessions_repo.create_session(db, name="s1")
    node = await nodes_repo.create_node(db, {"session_id": s["_id"], "label": "x"})
    assert node["_id"]
    fetched = await nodes_repo.get_node(db, node["_id"])
    assert fetched is not None
    updated = await nodes_repo.update_node(db, node["_id"], {"label": "y"})
    assert updated["label"] == "y"
    ok = await nodes_repo.soft_delete_node(db, node["_id"])
    assert ok
    after = await nodes_repo.get_node(db, node["_id"])
    assert after is None
    live = await nodes_repo.list_live(db, s["_id"])
    assert live == []


async def test_edge_crud(db):
    s = await sessions_repo.create_session(db, name="s1")
    e = await edges_repo.create_edge(
        db, {"session_id": s["_id"], "source_id": "a", "target_id": "b"}
    )
    assert e["edge_type"] == "solid"
    upd = await edges_repo.update_edge(db, e["_id"], {"edge_type": "dashed"})
    assert upd["edge_type"] == "dashed"
    ok = await edges_repo.soft_delete_edge(db, e["_id"])
    assert ok
    assert await edges_repo.get_edge(db, e["_id"]) is None
