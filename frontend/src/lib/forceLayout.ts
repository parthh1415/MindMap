import { useEffect, useRef, useState } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
  type ForceLink,
} from "d3-force";
import type { Edge as ContractEdge, Node as ContractNode } from "@shared/ws_messages";
import type { GhostNode } from "@/state/graphStore";

// ─────────────────────────────────────────────────────────────────────
// Internal datum types
// ─────────────────────────────────────────────────────────────────────

export type ForceNodeDatum = SimulationNodeDatum & {
  id: string;
  importance: number;
  kind: "solid" | "ghost";
};

export type ForceLinkDatum = SimulationLinkDatum<ForceNodeDatum> & {
  id: string;
  edge_type: "solid" | "dashed" | "dotted";
};

export type ForceLayoutOptions = {
  /** Override default alphaDecay (defaults to 0.025 — slow & graceful). */
  alphaDecay?: number;
  /** Initial alpha when reheating after a structural change. */
  reheatAlpha?: number;
};

export type ForceLayoutResult = {
  positions: Map<string, { x: number; y: number }>;
  tickToken: number;
  /** Pin a node at a coordinate (used during user drag). */
  pinNode: (id: string, x: number, y: number) => void;
  /** Release a pinned node (used at end of user drag). */
  unpinNode: (id: string) => void;
};

// ─────────────────────────────────────────────────────────────────────
// Pure helpers (exported for testability)
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the d3-force datum array from store nodes + ghosts. Reuses the
 * `prev` map's existing datum objects when an id is already present so
 * the simulation keeps positions/velocities — critical: the whole
 * point of force layout in this app is to NOT teleport.
 */
export function buildForceNodes(
  nodes: ContractNode[],
  ghosts: GhostNode[],
  prev: Map<string, ForceNodeDatum>,
): ForceNodeDatum[] {
  const next: ForceNodeDatum[] = [];
  for (const n of nodes) {
    const existing = prev.get(n._id);
    if (existing) {
      existing.importance = n.importance_score;
      existing.kind = "solid";
      next.push(existing);
    } else {
      next.push({
        id: n._id,
        importance: n.importance_score,
        kind: "solid",
      });
    }
  }
  for (const g of ghosts) {
    const existing = prev.get(g.ghost_id);
    if (existing) {
      existing.kind = "ghost";
      next.push(existing);
    } else {
      next.push({
        id: g.ghost_id,
        importance: 0.5,
        kind: "ghost",
      });
    }
  }
  return next;
}

/**
 * Build link data, referencing nodes by id (forceLink resolves them).
 * Drops links whose source/target aren't in the node set.
 */
export function buildForceLinks(
  edges: ContractEdge[],
  nodeIds: Set<string>,
): ForceLinkDatum[] {
  const links: ForceLinkDatum[] = [];
  for (const e of edges) {
    if (!nodeIds.has(e.source_id) || !nodeIds.has(e.target_id)) continue;
    links.push({
      id: e._id,
      source: e.source_id,
      target: e.target_id,
      edge_type: e.edge_type,
    });
  }
  return links;
}

/**
 * For continuity during ghost→solid morph: when a ghost with `ghost_id`
 * disappears and a node `n` resolves it, we want the new node's datum
 * to start at the ghost's last position. The store wires
 * `resolves_ghost_id` into `node_upsert`, but by the time we reach the
 * layout we only have node lists. We approximate by matching the
 * brand-new node ids that match a label of a recently-disappeared ghost.
 *
 * Caller passes `freshSeeds`: a map of id → seed pos to inject before
 * the next tick.
 */
export function applySeeds(
  data: ForceNodeDatum[],
  seeds: Map<string, { x: number; y: number }>,
): void {
  for (const d of data) {
    const seed = seeds.get(d.id);
    if (seed && (d.x === undefined || d.y === undefined)) {
      d.x = seed.x;
      d.y = seed.y;
    }
  }
}

/**
 * Configure (or reconfigure) a simulation with our standard forces.
 * Idempotent — safe to call after node/link arrays change.
 */
export function configureSimulation(
  sim: Simulation<ForceNodeDatum, ForceLinkDatum>,
  opts: ForceLayoutOptions,
): void {
  // Obsidian-feel: longer links, weaker forces, gentle center, smaller
  // collision radius (since we're rendering small orbs not big rectangles).
  // Result: nodes drift instead of snapping; the graph breathes.
  sim
    .force("charge", forceManyBody<ForceNodeDatum>().strength(-90).distanceMax(420))
    .force(
      "link",
      forceLink<ForceNodeDatum, ForceLinkDatum>()
        .id((d) => d.id)
        .distance((d) => (d.edge_type === "dotted" ? 260 : 200))
        .strength(0.18),
    )
    .force("center", forceCenter<ForceNodeDatum>(0, 0).strength(0.04))
    .force(
      "collide",
      forceCollide<ForceNodeDatum>().radius(
        (d) => 16 + (d.importance ?? 0.5) * 14,
      ).strength(0.85),
    )
    .alphaDecay(opts.alphaDecay ?? 0.018);
}

// ─────────────────────────────────────────────────────────────────────
// Public hook
// ─────────────────────────────────────────────────────────────────────

/**
 * Run a d3-force simulation over the store's nodes/edges/ghosts and
 * expose the live positions to React. The simulation is created once
 * and *reused* across input changes — adding a node nudges the system
 * via `simulation.alpha(reheatAlpha).restart()`, never a full rebuild.
 *
 * Important contract: returned positions Map is the SAME reference
 * across renders (only mutated). React re-renders are driven by
 * `tickToken` bumping every animation frame the sim is hot.
 */
export function useForceLayout(
  nodes: ContractNode[],
  edges: ContractEdge[],
  ghosts: GhostNode[],
  opts: ForceLayoutOptions = {},
): ForceLayoutResult {
  const reheatAlpha = opts.reheatAlpha ?? 0.4;

  // Stable refs that survive renders.
  const datumByIdRef = useRef<Map<string, ForceNodeDatum>>(new Map());
  const positionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const simRef = useRef<Simulation<ForceNodeDatum, ForceLinkDatum> | null>(null);
  const seedQueueRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Track previous ghost positions so we can seed solidified nodes.
  const lastGhostPosRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  // Track previous ghost set so we can detect disappearances.
  const prevGhostsRef = useRef<GhostNode[]>([]);

  const [tickToken, setTickToken] = useState(0);

  // ── one-time simulation bootstrap ───────────────────────────────
  if (simRef.current === null) {
    const sim = forceSimulation<ForceNodeDatum, ForceLinkDatum>([]);
    configureSimulation(sim, opts);
    sim.on("tick", () => {
      // Keep positionsRef in sync mutably; bump token to trigger React.
      const map = positionsRef.current;
      for (const d of datumByIdRef.current.values()) {
        if (typeof d.x === "number" && typeof d.y === "number") {
          map.set(d.id, { x: d.x, y: d.y });
        }
      }
      setTickToken((t) => t + 1);
    });
    simRef.current = sim;
  }

  // ── reconcile inputs into the simulation ────────────────────────
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;

    // Detect ghosts that just vanished; remember their last position so a
    // newly-arrived solid node with the same label can spawn from there.
    const prevGhosts = prevGhostsRef.current;
    const currentGhostIds = new Set(ghosts.map((g) => g.ghost_id));
    const currentNodeLabels = new Map(nodes.map((n) => [n.label, n._id] as const));
    for (const pg of prevGhosts) {
      if (!currentGhostIds.has(pg.ghost_id)) {
        const last = lastGhostPosRef.current.get(pg.ghost_id);
        const matchedNodeId = currentNodeLabels.get(pg.label);
        if (last && matchedNodeId && !datumByIdRef.current.has(matchedNodeId)) {
          seedQueueRef.current.set(matchedNodeId, last);
        }
        lastGhostPosRef.current.delete(pg.ghost_id);
      }
    }
    prevGhostsRef.current = ghosts;

    // Build new datum array, reusing prior objects for stability.
    const nextData = buildForceNodes(nodes, ghosts, datumByIdRef.current);
    applySeeds(nextData, seedQueueRef.current);
    seedQueueRef.current.clear();

    // Refresh the id → datum map.
    const nextMap = new Map<string, ForceNodeDatum>();
    for (const d of nextData) nextMap.set(d.id, d);

    // Drop positions for ids that no longer exist.
    for (const id of positionsRef.current.keys()) {
      if (!nextMap.has(id)) positionsRef.current.delete(id);
    }
    datumByIdRef.current = nextMap;

    const nodeIds = new Set(nextData.map((d) => d.id));
    const links = buildForceLinks(edges, nodeIds);

    sim.nodes(nextData);
    const linkForce = sim.force("link") as
      | ForceLink<ForceNodeDatum, ForceLinkDatum>
      | undefined;
    linkForce?.links(links);

    // Track ghost positions every reconcile so we always have the latest
    // when one disappears.
    for (const g of ghosts) {
      const d = nextMap.get(g.ghost_id);
      if (d && typeof d.x === "number" && typeof d.y === "number") {
        lastGhostPosRef.current.set(g.ghost_id, { x: d.x, y: d.y });
      }
    }

    sim.alpha(reheatAlpha).restart();
  }, [nodes, edges, ghosts, reheatAlpha]);

  // Continuously update last ghost positions as the sim ticks.
  useEffect(() => {
    for (const g of ghosts) {
      const d = datumByIdRef.current.get(g.ghost_id);
      if (d && typeof d.x === "number" && typeof d.y === "number") {
        lastGhostPosRef.current.set(g.ghost_id, { x: d.x, y: d.y });
      }
    }
  }, [tickToken, ghosts]);

  // ── teardown ───────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      simRef.current?.stop();
      simRef.current = null;
    };
  }, []);

  // ── pin / unpin (drag) ─────────────────────────────────────────
  const pinNode = (id: string, x: number, y: number) => {
    const d = datumByIdRef.current.get(id);
    if (!d) return;
    d.fx = x;
    d.fy = y;
    d.x = x;
    d.y = y;
    positionsRef.current.set(id, { x, y });
    simRef.current?.alphaTarget(0.3).restart();
  };
  const unpinNode = (id: string) => {
    const d = datumByIdRef.current.get(id);
    if (!d) return;
    d.fx = null;
    d.fy = null;
    simRef.current?.alphaTarget(0);
  };

  return {
    positions: positionsRef.current,
    tickToken,
    pinNode,
    unpinNode,
  };
}
