"""Pytest fixtures: ensure the repo root and agents/ are on sys.path."""
from __future__ import annotations

import sys
from pathlib import Path

_AGENTS_DIR = Path(__file__).resolve().parent.parent
_REPO_ROOT = _AGENTS_DIR.parent

for p in (_REPO_ROOT, _AGENTS_DIR):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))
