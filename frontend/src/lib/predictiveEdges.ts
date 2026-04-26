import { useEffect } from "react";
import { useGraphStore, type PredictiveEdge } from "@/state/graphStore";

// ─────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Selector returning the active (non-expired) predictive edges, sorted
 * by created_at ascending so they overlay in stable z-order. Pure —
 * does not mutate state.
 */
export function getActivePredictive(state: {
  predictiveEdges: Record<string, PredictiveEdge>;
}): PredictiveEdge[] {
  return Object.values(state.predictiveEdges).sort(
    (a, b) => a.created_at - b.created_at,
  );
}

/**
 * Find predictive edges whose (source_id, target_id) match a given pair
 * — order-insensitive, since edges are conceptually undirected for the
 * purposes of "did the topology agent confirm this hunch?".
 */
export function findMatchingPredictive(
  predictiveEdges: Record<string, PredictiveEdge>,
  source_id: string,
  target_id: string,
): PredictiveEdge[] {
  const matches: PredictiveEdge[] = [];
  for (const e of Object.values(predictiveEdges)) {
    const sameDir = e.source_id === source_id && e.target_id === target_id;
    const reverse = e.source_id === target_id && e.target_id === source_id;
    if (sameDir || reverse) matches.push(e);
  }
  return matches;
}

/**
 * Compute the set of predictive-edge ids to drop given the current
 * predictiveEdges map and the wall-clock `now`. Exposed for unit tests.
 */
export function expiredPredictiveIds(
  predictiveEdges: Record<string, PredictiveEdge>,
  now: number,
  ttlMs: number,
): string[] {
  const out: string[] = [];
  for (const e of Object.values(predictiveEdges)) {
    if (now - e.created_at > ttlMs) out.push(e.id);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Auto-prune hook
// ─────────────────────────────────────────────────────────────────────

const PRUNE_INTERVAL_MS = 1000;

/**
 * Single useEffect that periodically scans `predictiveEdges` and prunes
 * any older than `ttlMs`. Also subscribes to `edges`; whenever a real
 * edge arrives whose endpoints match a predictive edge, the predictive
 * is removed (the topology agent has spoken — hunch confirmed → real).
 *
 * Mount once in GraphCanvasInner. Calling more than once does no harm
 * but wastes interval timers.
 */
export function usePredictiveEdgePruner(ttlMs = 12_000): void {
  useEffect(() => {
    const interval = window.setInterval(() => {
      const state = useGraphStore.getState();
      const expired = expiredPredictiveIds(
        state.predictiveEdges,
        Date.now(),
        ttlMs,
      );
      if (expired.length === 0) return;
      for (const id of expired) state.removePredictiveEdge(id);
    }, PRUNE_INTERVAL_MS);

    // Subscribe to `edges` — when a real edge arrives, drop predictive
    // edges with matching endpoints (the topology agent confirmed the
    // hunch and the real edge will now be drawn by EdgeRenderer).
    const unsub = useGraphStore.subscribe((curr, prev) => {
      if (curr.edges === prev.edges) return;
      const prevKeys = new Set(Object.keys(prev.edges));
      const newEdges = Object.values(curr.edges).filter(
        (e) => !prevKeys.has(e._id),
      );
      if (newEdges.length === 0) return;
      const { predictiveEdges, removePredictiveEdge } = curr;
      for (const re of newEdges) {
        const matches = findMatchingPredictive(
          predictiveEdges,
          re.source_id,
          re.target_id,
        );
        for (const m of matches) removePredictiveEdge(m.id);
      }
    });

    return () => {
      window.clearInterval(interval);
      unsub();
    };
  }, [ttlMs]);
}
