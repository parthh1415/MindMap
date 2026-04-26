import { useMemo, useEffect, useCallback, useState } from "react";
import ReactFlow, {
  Controls,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeTypes,
  type EdgeTypes,
  type NodeDragHandler,
  type NodeMouseHandler,
  ReactFlowProvider,
} from "reactflow";
import "reactflow/dist/style.css";
import { LayoutGroup } from "framer-motion";
import {
  useGraphStore,
  useGhostList,
  useNodeList,
  useEdgeList,
} from "@/state/graphStore";
import { useForceLayout } from "@/lib/forceLayout";
import SolidNode, { type SolidNodeData } from "./SolidNode";
import GhostNode, { type GhostNodeData } from "./GhostNode";
import EdgeRenderer, { type GraphEdgeData } from "./EdgeRenderer";
// Predictive-edge + speaker-trail overlays were dropped: their orange/
// amber dashed beziers and polylines (speaker colors mapped to copper
// + amber palette tokens) read as visual noise during transcription.
// The real orb-spawn + white-edge-connect flow is already what we want
// — driven by topology-agent node_upsert + edge_upsert events.
import { usePredictiveEdgePruner } from "@/lib/predictiveEdges";
import { useTrailDecayer } from "@/lib/speakerTrail";

const NODE_TYPES: NodeTypes = {
  solid: SolidNode,
  ghost: GhostNode,
};

const EDGE_TYPES: EdgeTypes = {
  graph: EdgeRenderer,
};

/**
 * Deterministic seed position from a node id. Used as the fallback
 * when d3-force's async tick hasn't populated the positions Map yet.
 *
 * Without this, new nodes default to {x:0, y:0} → all stacked at
 * the origin → looks like nodes 'disappear' until the sim ticks
 * (which triggered the 'unfocus the window and they come back' bug:
 *  the unfocus caused a re-render that picked up the now-populated
 *  positions). Spreading via id-hash makes nodes immediately visible,
 * and the sim converges them naturally on first tick.
 */
function seedPosition(id: string): { x: number; y: number } {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = ((h << 5) - h + id.charCodeAt(i)) | 0;
  }
  // Map hash to a deterministic point on a wide ring around origin.
  const angle = ((h >>> 0) % 360) * (Math.PI / 180);
  const radius = 220 + ((h >>> 8) % 80); // 220..300 px out
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * The main canvas. Positions are produced by a live `d3-force` simulation
 * (see `useForceLayout`) so additions/removals nudge the graph instead of
 * teleporting nodes. Drag pins a node via fx/fy on the simulation, and
 * releases on drop.
 *
 * Wrapped in `LayoutGroup` so Framer Motion can correlate `layoutId` across
 * the ghost→solid morph. (See GhostNode + SolidNode.)
 */
function GraphCanvasInner() {
  // Auto-prune predictive edges (TTL + edge_upsert supersession) and
  // decay speaker trail points. Both are no-op intervals with cleanup.
  usePredictiveEdgePruner();
  useTrailDecayer();

  const nodes = useNodeList();
  const edges = useEdgeList();
  const ghosts = useGhostList();
  const speakerColors = useGraphStore((s) => s.speakerColors);
  const activeSpeakerId = useGraphStore((s) => s.activeSpeakerId);
  const animationQueue = useGraphStore((s) => s.animationQueue);

  // Strip queue once SolidNode has had time to read it on first paint.
  // 50 ms was too tight: under WebSocket bursts, a node could arrive,
  // its SolidNode mount, *and* the queue clear all happen before the
  // mount-only `queuedOnMount` useMemo could read it — so freshly-
  // arrived orbs occasionally missed their pulse. 250 ms is still
  // imperceptible to the user but safely outside React's batching.
  useEffect(() => {
    if (animationQueue.length === 0) return;
    const t = window.setTimeout(() => {
      useGraphStore.setState({ animationQueue: [] });
    }, 250);
    return () => window.clearTimeout(t);
  }, [animationQueue]);

  // Live, force-driven positions. `tickToken` bumps every tick to
  // re-render us with fresh coordinates.
  const { positions, tickToken, pinNode, unpinNode } = useForceLayout(
    nodes,
    edges,
    ghosts,
  );

  // Hover-dim (Obsidian behavior): when a node is hovered, every other
  // node that's not in its 1-hop neighborhood fades to ~22% opacity, and
  // edges between non-hovered nodes fade too. The hovered node itself
  // and its connected edges stay bright.
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const neighborSet = useMemo(() => {
    if (!hoveredId) return null;
    const n = new Set<string>([hoveredId]);
    for (const e of edges) {
      if (e.source_id === hoveredId) n.add(e.target_id);
      else if (e.target_id === hoveredId) n.add(e.source_id);
    }
    return n;
  }, [hoveredId, edges]);

  // SolidNode/GhostNode are wrapped in React.memo so position-only
  // updates per tick don't re-render their bodies — reactflow updates
  // the wrapper transform via CSS and React skips the node body.
  // That's where the streaming-generation lag was coming from: every
  // d3-force tick passed fresh `data` object literals, which (without
  // memo) cascaded into each orb re-painting its glow + spec layers.
  const rfNodes: RFNode<SolidNodeData | GhostNodeData>[] = useMemo(() => {
    const all: RFNode<SolidNodeData | GhostNodeData>[] = [];
    for (const n of nodes) {
      const pos = positions.get(n._id) ?? seedPosition(n._id);
      // Concrete hex (mirrors --text-secondary): the orb gradient uses
      // color-mix(), which fails silently with nested var() in some
      // browsers, leaving the orb body transparent.
      const speakerColor =
        (n.speaker_id && speakerColors[n.speaker_id]) || "#a0aab5";
      const dimmed = !!neighborSet && !neighborSet.has(n._id);
      all.push({
        id: n._id,
        type: "solid",
        position: pos,
        data: {
          contractNode: n,
          speakerColor,
          isActiveSpeaker: !!n.speaker_id && n.speaker_id === activeSpeakerId,
          isGhostResolution: false,
          dimmed,
        },
        draggable: true,
      });
    }
    for (const g of ghosts) {
      const pos = positions.get(g.ghost_id) ?? seedPosition(g.ghost_id);
      // Concrete hex (mirrors --signature-accent) — see comment above.
      const speakerColor = speakerColors[g.speaker_id] || "#d6ff3a";
      all.push({
        id: g.ghost_id,
        type: "ghost",
        position: pos,
        data: { ghost_id: g.ghost_id, label: g.label, speakerColor },
        draggable: false,
        selectable: false,
      });
    }
    return all;
    // tickToken IS a dep so reactflow gets fresh positions every tick.
    // The win comes from React.memo on SolidNode/GhostNode (custom
    // shallow comparator) — they skip body re-renders unless their data
    // actually changed, even though the wrapper allocates new RFNodes.
  }, [nodes, ghosts, positions, speakerColors, activeSpeakerId, tickToken, neighborSet]);

  const rfEdges: RFEdge<GraphEdgeData>[] = useMemo(() => {
    return edges.map((e) => {
      const sourceNode = nodes.find((n) => n._id === e.source_id);
      const speakerColor =
        (sourceNode?.speaker_id && speakerColors[sourceNode.speaker_id]) ||
        (e.speaker_id && speakerColors[e.speaker_id]) ||
        "#a0aab5";
      // Edge is emphasized iff hovered node is one of its endpoints.
      const emphasized =
        !!hoveredId && (e.source_id === hoveredId || e.target_id === hoveredId);
      const dimmed = !!hoveredId && !emphasized;
      return {
        id: e._id,
        source: e.source_id,
        target: e.target_id,
        type: "graph",
        data: { edge_type: e.edge_type, speakerColor, emphasized, dimmed },
      };
    });
  }, [edges, nodes, speakerColors, hoveredId]);

  // ── drag pinning ─────────────────────────────────────────────────
  const onNodeDragStart: NodeDragHandler = useCallback(
    (_, node) => {
      pinNode(node.id, node.position.x, node.position.y);
    },
    [pinNode],
  );
  const onNodeDrag: NodeDragHandler = useCallback(
    (_, node) => {
      pinNode(node.id, node.position.x, node.position.y);
    },
    [pinNode],
  );
  const onNodeDragStop: NodeDragHandler = useCallback(
    (_, node) => {
      unpinNode(node.id);
    },
    [unpinNode],
  );

  const onNodeMouseEnter: NodeMouseHandler = useCallback((_, node) => {
    setHoveredId(node.id);
  }, []);
  const onNodeMouseLeave: NodeMouseHandler = useCallback(() => {
    setHoveredId(null);
  }, []);

  return (
    <LayoutGroup id="mindmap-canvas">
      <div className="canvas-wrap">
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          onNodeDragStart={onNodeDragStart}
          onNodeDrag={onNodeDrag}
          onNodeDragStop={onNodeDragStop}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          fitView
          fitViewOptions={{ padding: 0.4, maxZoom: 1.1, minZoom: 0.3 }}
          // Viewport clamp — `translateExtent` defines the world-space
          // rectangle the viewport center is allowed to occupy. With
          // minZoom=0.4 the visible viewport at extreme zoom-out is
          // roughly the container size / 0.4 (≈ 3000 px wide on a
          // 1200px container), and the extent ±1200 keeps that window
          // overlapping the d3-force cluster (which the simulation's
          // center force pulls toward origin) at every position.
          //
          // Why this matters: previously the viewport was unconstrained.
          // Drag + zoom out could put the orbs entirely outside the
          // visible frame — the orbs were still in the DOM, opacity 1,
          // scale 1, just at world coordinates the viewport no longer
          // intersected. Window resize "fixed" it by triggering reactflow's
          // resize observer, which incidentally re-anchored the user's
          // perception of the canvas. The clamp solves that root cause.
          translateExtent={[
            [-1200, -1200],
            [1200, 1200],
          ]}
          minZoom={0.4}
          maxZoom={2}
          panOnDrag
          zoomOnScroll
          proOptions={{ hideAttribution: true }}
        >
          <Controls position="bottom-right" showInteractive={false} />
        </ReactFlow>
        <style>{`
          .canvas-wrap {
            position: relative;
            width: 100%;
            height: 100%;
            background: transparent;
          }
        `}</style>
      </div>
    </LayoutGroup>
  );
}

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <GraphCanvasInner />
    </ReactFlowProvider>
  );
}

export default GraphCanvas;
