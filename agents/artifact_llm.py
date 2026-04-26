"""LLM helpers for the ARTIFACT agent.

Two functions:

  - ``classify_artifact(nodes_json, edges_json, transcript_excerpt)``
        → {"top_choice", "confidence", "candidates": [{type, score, why}, ...]}
        Top-3 candidates. Scores in [0, 1]. ``top_choice`` always equals
        ``candidates[0].type``.

  - ``generate_artifact(artifact_type, nodes_json, edges_json,
                        transcript_excerpt, refinement_hint, section_anchor)``
        → {"title", "markdown", "files": [...], "evidence": [...]}.
        For ``scaffold`` and SECTION_ANCHOR == "", ``files`` MUST contain at
        least 3 entries. For all other types, ``files`` is empty. When
        ``section_anchor`` is non-empty, ``markdown`` is just the rewritten
        H2 (begins with "## ") and ``files`` is empty.

Provider: Groq (llama-3.3-70b-versatile) via ``agents.llm.GroqProvider``.
Falls back to Gemini on Groq 429 (same shape as synthesis_llm.py).
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
from pathlib import Path
from typing import Optional

# Make `from shared.agent_messages import ARTIFACT_TYPES` work from any cwd.
_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

# Sibling import (matches synthesis_llm pattern).
sys.path.insert(0, str(Path(__file__).resolve().parent))
import llm as _llm  # noqa: E402

from shared.agent_messages import ARTIFACT_TYPES  # noqa: E402

logger = logging.getLogger("agents.artifact_llm")

MAX_RETRIES_429 = _llm.MAX_RETRIES_429
RETRY_SLEEP_SECONDS = _llm.RETRY_SLEEP_SECONDS

MAX_CANDIDATES = 3
MIN_SCAFFOLD_FILES = 3

_PROMPTS_DIR = Path(__file__).resolve().parent / "prompts"


def _load_prompt(name: str) -> str:
    return (_PROMPTS_DIR / name).read_text(encoding="utf-8")


def _build_provider() -> "_llm.LLMProvider":
    # Phase 12: prefer OpenAI when its key is set; otherwise Groq.
    if os.getenv("OPENAI_API_KEY"):
        return _llm.OpenAIProvider()
    return _llm.GroqProvider()


def _slugify(text: str) -> str:
    """Turn an H2 title into a kebab-case anchor slug."""
    text = (text or "").strip().lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-")


# ---------------------------------------------------------------------------
# classify_artifact
# ---------------------------------------------------------------------------
def _coerce_classify(data) -> dict:
    """Defensive parser for the classifier output.

    - Filters candidates whose type isn't in ARTIFACT_TYPES.
    - Caps to MAX_CANDIDATES.
    - Forces top_choice == candidates[0].type when needed.
    - Clamps scores to [0, 1].
    """
    if not isinstance(data, dict):
        data = {}

    raw_candidates = data.get("candidates") or []
    if not isinstance(raw_candidates, list):
        raw_candidates = []

    cleaned: list[dict] = []
    for entry in raw_candidates:
        if not isinstance(entry, dict):
            continue
        atype = str(entry.get("type", "")).strip().lower()
        if atype not in ARTIFACT_TYPES:
            continue
        try:
            score = float(entry.get("score", 0.0))
        except (TypeError, ValueError):
            score = 0.0
        score = max(0.0, min(1.0, score))
        why = str(entry.get("why", "")).strip()
        cleaned.append({"type": atype, "score": score, "why": why})

    # Dedupe by type, keep first (highest assumed).
    seen: set[str] = set()
    deduped: list[dict] = []
    for c in cleaned:
        if c["type"] in seen:
            continue
        seen.add(c["type"])
        deduped.append(c)

    # If empty, fall back to brief.
    if not deduped:
        deduped = [{"type": "brief", "score": 0.5, "why": "fallback"}]

    # Cap.
    deduped = deduped[:MAX_CANDIDATES]

    # Top-choice / confidence resolution.
    raw_top = str(data.get("top_choice", "")).strip().lower()
    if raw_top in ARTIFACT_TYPES and any(c["type"] == raw_top for c in deduped):
        # Reorder so that the named top_choice is first.
        deduped.sort(key=lambda c: 0 if c["type"] == raw_top else 1)
    top_choice = deduped[0]["type"]

    try:
        confidence = float(data.get("confidence", deduped[0]["score"]))
    except (TypeError, ValueError):
        confidence = deduped[0]["score"]
    confidence = max(0.0, min(1.0, confidence))

    return {
        "top_choice": top_choice,
        "confidence": confidence,
        "candidates": deduped,
    }


async def classify_artifact(
    nodes_json: str,
    edges_json: str,
    transcript_excerpt: str,
    system_prompt: Optional[str] = None,
    provider: Optional["_llm.LLMProvider"] = None,
) -> dict:
    """Classify the most likely artifact type for the supplied conversation."""
    system = system_prompt or _load_prompt("artifact_classify.txt")
    user_prompt = (
        f"NODES_JSON:\n{nodes_json or '[]'}\n\n"
        f"EDGES_JSON:\n{edges_json or '[]'}\n\n"
        f"TRANSCRIPT_EXCERPT:\n{transcript_excerpt or '(none)'}\n\n"
        'Return a JSON object: '
        '{"top_choice", "confidence", "candidates":[{type,score,why}]} '
        'with EXACTLY 3 candidates.'
    )

    primary = provider or _build_provider()
    last_exc: Optional[BaseException] = None

    for attempt in range(MAX_RETRIES_429 + 1):
        try:
            data = await primary.generate_json(user_prompt, system)
            return _coerce_classify(data)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if _llm._is_429(exc) and attempt < MAX_RETRIES_429:
                await asyncio.sleep(RETRY_SLEEP_SECONDS)
                continue
            if _llm._is_429(exc) and os.getenv("GEMINI_API_KEY"):
                try:
                    fallback = _llm.GeminiProvider()
                    data = await fallback.generate_json(user_prompt, system)
                    return _coerce_classify(data)
                except Exception as fb_exc:  # noqa: BLE001
                    last_exc = fb_exc
            break
    raise RuntimeError(f"classify_artifact failed: {last_exc!r}") from last_exc


# ---------------------------------------------------------------------------
# generate_artifact
# ---------------------------------------------------------------------------
def _strip_code_fences(text: str) -> str:
    if text.startswith("```") and text.endswith("```"):
        lines = text.splitlines()
        if len(lines) >= 2:
            return "\n".join(lines[1:-1]).strip()
    return text


def _coerce_files(raw_files) -> list[dict]:
    if not isinstance(raw_files, list):
        return []
    cleaned: list[dict] = []
    seen_paths: set[str] = set()
    for entry in raw_files:
        if not isinstance(entry, dict):
            continue
        path = str(entry.get("path", "")).strip()
        if not path:
            continue
        if path in seen_paths:
            continue
        seen_paths.add(path)
        content = str(entry.get("content", ""))
        cleaned.append({"path": path, "content": content})
    return cleaned


def _coerce_evidence(raw_evidence) -> list[dict]:
    if not isinstance(raw_evidence, list):
        return []
    cleaned: list[dict] = []
    for entry in raw_evidence:
        if not isinstance(entry, dict):
            continue
        anchor = str(entry.get("section_anchor", "")).strip()
        if not anchor:
            continue
        anchor = _slugify(anchor)
        node_ids = entry.get("node_ids") or []
        if not isinstance(node_ids, list):
            node_ids = []
        node_ids = [str(n) for n in node_ids if isinstance(n, (str, int))]
        excerpts = entry.get("transcript_excerpts") or []
        if not isinstance(excerpts, list):
            excerpts = []
        excerpts = [str(e) for e in excerpts if isinstance(e, (str, int))]
        cleaned.append(
            {
                "section_anchor": anchor,
                "node_ids": node_ids,
                "transcript_excerpts": excerpts,
            }
        )
    return cleaned


def _ensure_scaffold_files(files: list[dict], markdown: str, title: str) -> list[dict]:
    """Backfill the 3 mandatory scaffold files if the LLM under-delivered."""
    by_path = {f["path"]: f for f in files}

    if "README.md" not in by_path:
        readme_content = markdown if markdown else f"# {title}\n\n## Overview\n\n(generated)"
        by_path["README.md"] = {"path": "README.md", "content": readme_content}

    if "architecture.md" not in by_path:
        arch_content = (
            f"# {title} — Architecture\n\n"
            "## System overview\n\n"
            "```mermaid\nflowchart LR\n  A[Client] --> B[API]\n  B --> C[(Database)]\n```\n\n"
            "## Key decisions\n\n"
            "- Architecture details derived from conversation; refine before adoption.\n"
        )
        by_path["architecture.md"] = {"path": "architecture.md", "content": arch_content}

    if "routes.md" not in by_path:
        routes_content = (
            f"# {title} — API routes\n\n"
            "| Method | Path | Purpose |\n"
            "| ------ | ---- | ------- |\n"
            "| GET | /healthz | health probe |\n"
        )
        by_path["routes.md"] = {"path": "routes.md", "content": routes_content}

    # Preserve original ordering, then append any backfilled paths.
    ordered_paths = []
    for f in files:
        if f["path"] not in ordered_paths:
            ordered_paths.append(f["path"])
    for p in ("README.md", "architecture.md", "routes.md"):
        if p not in ordered_paths:
            ordered_paths.append(p)
    return [by_path[p] for p in ordered_paths]


def _coerce_artifact(
    data, artifact_type: str, section_anchor: str
) -> dict:
    if not isinstance(data, dict):
        data = {}

    title = str(data.get("title", "")).strip() or f"{artifact_type.title()}"
    if len(title) > 100:
        title = title[:97].rstrip() + "…"

    markdown = str(data.get("markdown", "")).strip()
    markdown = _strip_code_fences(markdown)

    files = _coerce_files(data.get("files"))
    evidence = _coerce_evidence(data.get("evidence"))

    is_section_only = bool(section_anchor)

    if is_section_only:
        # Section regen: enforce shape.
        files = []
        # Make sure markdown begins with "## ".
        if not markdown.startswith("## "):
            # Prepend an H2 derived from the anchor slug.
            heading = section_anchor.replace("-", " ").strip().title() or "Section"
            if markdown.startswith("# "):
                # Drop H1 if model included one by mistake.
                lines = markdown.splitlines()
                # find first non-H1 line
                kept = [ln for ln in lines if not ln.startswith("# ")]
                markdown = "\n".join(kept).strip()
            if not markdown.startswith("## "):
                markdown = f"## {heading}\n\n{markdown}".strip()
        # Evidence: keep only entries matching the requested anchor; if none,
        # synthesize one empty entry so callers always see exactly one.
        anchor_slug = _slugify(section_anchor)
        matched = [e for e in evidence if e["section_anchor"] == anchor_slug]
        if matched:
            evidence = matched[:1]
        elif evidence:
            evidence = [evidence[0]]
        else:
            evidence = [{"section_anchor": anchor_slug, "node_ids": [], "transcript_excerpts": []}]
    else:
        # Full document.
        if artifact_type == "scaffold":
            # Ensure the README content matches `markdown` if provided.
            if markdown:
                # Make README the primary file's content.
                readme_present = any(f["path"] == "README.md" for f in files)
                if not readme_present:
                    files = [{"path": "README.md", "content": markdown}, *files]
                else:
                    # Sync README content with markdown to keep them aligned.
                    for f in files:
                        if f["path"] == "README.md" and not f.get("content"):
                            f["content"] = markdown
            files = _ensure_scaffold_files(files, markdown=markdown, title=title)
            # If markdown was empty but README has content, mirror it.
            if not markdown:
                for f in files:
                    if f["path"] == "README.md":
                        markdown = f["content"]
                        break
        else:
            # Non-scaffold artifacts: files MUST be empty.
            files = []

        # Ensure markdown begins with "# " for full docs.
        if not markdown.startswith("# "):
            markdown = f"# {title}\n\n{markdown}".strip()

    return {
        "title": title,
        "markdown": markdown,
        "files": files,
        "evidence": evidence,
    }


def _prompt_filename(artifact_type: str) -> str:
    if artifact_type not in ARTIFACT_TYPES:
        raise ValueError(f"artifact_type must be one of {ARTIFACT_TYPES}")
    return f"artifact_{artifact_type}.txt"


async def generate_artifact(
    artifact_type: str,
    nodes_json: str,
    edges_json: str,
    transcript_excerpt: str,
    refinement_hint: str = "",
    section_anchor: str = "",
    system_prompt: Optional[str] = None,
    provider: Optional["_llm.LLMProvider"] = None,
) -> dict:
    """Generate the artifact for the requested type.

    Returns {"title", "markdown", "files", "evidence"}.
    """
    if artifact_type not in ARTIFACT_TYPES:
        raise ValueError(f"artifact_type must be one of {ARTIFACT_TYPES}")
    system = system_prompt or _load_prompt(_prompt_filename(artifact_type))

    user_parts = [
        f"NODES_JSON:\n{nodes_json or '[]'}",
        f"EDGES_JSON:\n{edges_json or '[]'}",
        f"TRANSCRIPT_EXCERPT:\n{transcript_excerpt or '(none)'}",
    ]
    if section_anchor:
        user_parts.append(f"SECTION_ANCHOR: {section_anchor}")
    user_parts.append(
        'Return a JSON object: '
        '{"title","markdown","files":[],"evidence":[{section_anchor,node_ids,transcript_excerpts}]}'
    )
    user_prompt = "\n\n".join(user_parts)
    if refinement_hint:
        user_prompt = f"{user_prompt}\n\nREFINEMENT: {refinement_hint}"

    primary = provider or _build_provider()
    last_exc: Optional[BaseException] = None

    for attempt in range(MAX_RETRIES_429 + 1):
        try:
            data = await primary.generate_json(user_prompt, system)
            return _coerce_artifact(data, artifact_type, section_anchor)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if _llm._is_429(exc) and attempt < MAX_RETRIES_429:
                await asyncio.sleep(RETRY_SLEEP_SECONDS)
                continue
            if _llm._is_429(exc) and os.getenv("GEMINI_API_KEY"):
                try:
                    fallback = _llm.GeminiProvider()
                    data = await fallback.generate_json(user_prompt, system)
                    return _coerce_artifact(data, artifact_type, section_anchor)
                except Exception as fb_exc:  # noqa: BLE001
                    last_exc = fb_exc
            break
    raise RuntimeError(f"generate_artifact failed: {last_exc!r}") from last_exc


__all__ = [
    "classify_artifact",
    "generate_artifact",
    "ARTIFACT_TYPES",
    "MAX_CANDIDATES",
    "MIN_SCAFFOLD_FILES",
]
