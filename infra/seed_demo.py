"""Pre-load a demo session with ≥12 nodes and a branch.

Run from the project root after backend + topology agent are up:

    PYTHONPATH=. .venv/bin/python infra/seed_demo.py

The script:
  1. Creates a fresh session "Demo — System Architecture".
  2. Posts 16 transcript chunks through /ws/transcript that walk a
     conversation about distributed-systems design (cybersecurity,
     auth, eventual consistency, backpressure, observability).
  3. Waits for the topology agent to commit nodes + edges.
  4. Branches the session at a midpoint so the SidePanel surface has
     something to show.
  5. Prints the demo URL: http://localhost:5173/?session=<id>
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx
import websockets

BACKEND = os.getenv("BACKEND_URL", "http://localhost:8000")
WS_BACKEND = BACKEND.replace("http://", "ws://").replace("https://", "wss://")

SCRIPT = [
    ("speaker_0", "Let's talk about how we'd architect a distributed mind-map system."),
    ("speaker_1", "First concern is cybersecurity — every connection must be authenticated."),
    ("speaker_0", "Right. Authentication should use short-lived tokens with refresh rotation."),
    ("speaker_1", "And we need a zero-trust model. Every service verifies the caller."),
    ("speaker_0", "For storage, MongoDB with eventual consistency works for the graph state."),
    ("speaker_1", "Eventual consistency means we need conflict resolution on the client."),
    ("speaker_0", "Backpressure is the next concern. Transcripts will arrive faster than the LLM can process."),
    ("speaker_1", "We can debounce at the backend — coalesce partials within a 1.2 second window."),
    ("speaker_0", "Observability is critical. We need to trace transcript through every layer."),
    ("speaker_1", "OpenTelemetry for the spans, Prometheus for metrics, Loki for logs."),
    ("speaker_2", "What about latency? The user feels anything over 500 ms."),
    ("speaker_0", "Optimistic ghost rendering. We surface candidate nodes before the LLM commits."),
    ("speaker_2", "Smart. The ghost morphs into the solid node when the agent confirms."),
    ("speaker_1", "Caching the recent transcript window keeps the LLM context warm."),
    ("speaker_0", "Last piece — image attachment per node, hosted on Cloudinary's free tier."),
    ("speaker_2", "And the timeline scrubber lets us replay the whole session deterministically."),
]


async def post_chunk(ws: websockets.WebSocketClientProtocol, session_id: str, speaker_id: str, text: str) -> None:
    await ws.send(
        json.dumps(
            {
                "type": "transcript",
                "session_id": session_id,
                "speaker_id": speaker_id,
                "text": text,
                "is_final": True,
                "ts_client": int(time.time() * 1000),
            }
        )
    )


async def drain_graph_ws(ws: websockets.WebSocketClientProtocol, deadline: float) -> int:
    upserts = 0
    while time.time() < deadline:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=max(0.1, deadline - time.time()))
        except asyncio.TimeoutError:
            return upserts
        try:
            evt = json.loads(raw)
        except Exception:
            continue
        if evt.get("type") == "node_upsert":
            upserts += 1
    return upserts


async def main() -> int:
    async with httpx.AsyncClient(timeout=10.0) as client:
        sess = await client.post(f"{BACKEND}/sessions", json={"name": "Demo — System Architecture"})
        sess.raise_for_status()
        session = sess.json()
        sid = session["_id"]
        print(f"[seed] created session {sid}")

        async with websockets.connect(f"{WS_BACKEND}/ws/graph/{sid}") as g_ws:
            # consume initial snapshot
            try:
                await asyncio.wait_for(g_ws.recv(), timeout=3.0)
            except asyncio.TimeoutError:
                pass

            async with websockets.connect(f"{WS_BACKEND}/ws/transcript") as t_ws:
                # Send the first half of the script.
                halfway_ts: str | None = None
                for i, (speaker, text) in enumerate(SCRIPT):
                    await post_chunk(t_ws, sid, speaker, text)
                    print(f"[seed] sent  [{speaker}] {text[:60]}…")
                    # backend's debounce window is ~1.2s — pause longer.
                    await asyncio.sleep(1.6)
                    if i == len(SCRIPT) // 2 - 1:
                        # Capture this moment as the branch point.
                        halfway_ts = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())

            # Drain graph events for a final 8 seconds so any in-flight
            # diffs land before we ask for the count.
            print("[seed] draining final graph events for 8s…")
            await drain_graph_ws(g_ws, time.time() + 8)

        graph = await client.get(f"{BACKEND}/sessions/{sid}/graph")
        graph.raise_for_status()
        nodes = graph.json().get("nodes", [])
        edges = graph.json().get("edges", [])
        print(f"[seed] live graph has {len(nodes)} nodes and {len(edges)} edges")

        if halfway_ts is None:
            halfway_ts = nodes[len(nodes) // 2]["created_at"] if nodes else time.strftime(
                "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()
            )

        branch = await client.post(
            f"{BACKEND}/sessions/{sid}/branch", json={"timestamp": halfway_ts}
        )
        if branch.status_code >= 400:
            print(f"[seed] branch endpoint returned {branch.status_code}: {branch.text}")
        else:
            bid = branch.json().get("_id", "?")
            print(f"[seed] branched at {halfway_ts} → new session {bid}")

        url = f"http://localhost:5173/?session={sid}"
        print()
        print(f"DEMO READY → {url}")
        print(f"  nodes: {len(nodes)} (target ≥12)  edges: {len(edges)}")
        return 0 if len(nodes) >= 12 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
