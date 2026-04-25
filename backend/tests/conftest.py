"""Test fixtures.

Provides an in-memory async Mongo replacement implementing only the operations
exercised by our repos. We do this to keep tests hermetic without requiring
mongomock-motor or a real MongoDB instance.
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
from typing import Any, Optional

import pytest

# Ensure project root on path.
_HERE = os.path.dirname(__file__)
_PROJECT_ROOT = os.path.abspath(os.path.join(_HERE, os.pardir, os.pardir))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)


# ---------------------------------------------------------------------------
# Tiny async in-memory Mongo replica.
# ---------------------------------------------------------------------------


def _matches(doc: dict, query: dict) -> bool:
    if not query:
        return True
    for key, val in query.items():
        if key == "$and":
            if not all(_matches(doc, sub) for sub in val):
                return False
            continue
        if key == "$or":
            if not any(_matches(doc, sub) for sub in val):
                return False
            continue
        actual = doc.get(key, _MISSING)
        if isinstance(val, dict):
            for op, opv in val.items():
                if op == "$exists":
                    exists = key in doc
                    if exists != bool(opv):
                        return False
                elif op == "$lte":
                    if actual is _MISSING or actual is None or actual > opv:
                        return False
                elif op == "$gt":
                    if actual is _MISSING or actual is None or not (actual > opv):
                        return False
                elif op == "$in":
                    if actual not in opv:
                        return False
                else:
                    return False
        else:
            if val is None:
                if actual is not None and actual is not _MISSING:
                    return False
            else:
                if actual != val:
                    return False
    return True


_MISSING = object()


class _Cursor:
    def __init__(self, docs: list[dict]):
        self._docs = list(docs)
        self._sort: Optional[tuple[str, int]] = None
        self._limit: Optional[int] = None

    def sort(self, key, direction: int = 1):
        # Accept (key, dir) or just key with direction arg.
        if isinstance(key, list):
            # not exercised
            self._sort = (key[0][0], key[0][1])
        else:
            self._sort = (key, direction)
        return self

    def limit(self, n: int):
        self._limit = n
        return self

    def __aiter__(self):
        docs = self._docs
        if self._sort is not None:
            k, d = self._sort
            docs = sorted(docs, key=lambda x: (x.get(k) is None, x.get(k)), reverse=(d < 0))
        if self._limit is not None:
            docs = docs[: self._limit]
        self._iter = iter(docs)
        return self

    async def __anext__(self):
        try:
            return next(self._iter)
        except StopIteration:
            raise StopAsyncIteration


class _Collection:
    def __init__(self):
        self._docs: list[dict] = []

    async def insert_one(self, doc: dict):
        # Check for _id collision.
        for existing in self._docs:
            if existing.get("_id") == doc.get("_id"):
                raise ValueError("duplicate _id")
        self._docs.append(dict(doc))

        class _Res:
            inserted_id = doc.get("_id")

        return _Res()

    async def find_one(self, query: dict):
        for d in self._docs:
            if _matches(d, query):
                return dict(d)
        return None

    def find(self, query: dict):
        matches = [dict(d) for d in self._docs if _matches(d, query)]
        return _Cursor(matches)

    async def update_one(self, query: dict, update: dict):
        modified = 0
        for d in self._docs:
            if _matches(d, query):
                if "$set" in update:
                    d.update(update["$set"])
                if "$push" in update:
                    for k, v in update["$push"].items():
                        d.setdefault(k, [])
                        if isinstance(v, dict) and "$each" in v:
                            d[k].extend(v["$each"])
                        else:
                            d[k].append(v)
                modified += 1
                break

        class _Res:
            modified_count = modified

        return _Res()

    async def find_one_and_update(self, query: dict, update: dict, return_document=True):
        for d in self._docs:
            if _matches(d, query):
                if "$set" in update:
                    d.update(update["$set"])
                if "$push" in update:
                    for k, v in update["$push"].items():
                        d.setdefault(k, [])
                        if isinstance(v, dict) and "$each" in v:
                            d[k].extend(v["$each"])
                        else:
                            d[k].append(v)
                return dict(d)
        return None

    async def create_index(self, *_args, **_kwargs):
        return "ok"


class _DB:
    def __init__(self):
        self._collections: dict[str, _Collection] = {}

    def __getitem__(self, name: str) -> _Collection:
        return self._collections.setdefault(name, _Collection())

    def __getattr__(self, name: str) -> _Collection:
        if name.startswith("_"):
            raise AttributeError(name)
        return self[name]


@pytest.fixture
def db():
    """Fresh fake DB per test."""
    return _DB()


@pytest.fixture(autouse=True)
def _install_db(db, monkeypatch):
    """Make the global ``get_db()`` return our fake DB."""
    from backend.db import client as client_module

    monkeypatch.setattr(client_module, "_db", db, raising=False)
    monkeypatch.setattr(client_module, "_client", object(), raising=False)
    yield
