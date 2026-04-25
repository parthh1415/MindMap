import { useMemo, useEffect } from "react";
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  type Edge as RFEdge,
  type Node as RFNode,
  type NodeTypes,
  type EdgeTypes,
  ReactFlowProvider,
} from "reactflow";
import "reactflow/dist/style.css";
import { LayoutGroup } from "framer-motion";
import { useGraphStore, selectGhostList, selectNodeList, selectEdgeList } from "@/state/graphStore";
import SolidNode, { type SolidNodeData } from "./SolidNode";
import GhostNode, { type GhostNodeData } from "./GhostNode";
import EdgeRenderer, { type GraphEdgeData } from "./EdgeRenderer";

const NODE_TYPES: NodeTypes = {
  solid: SolidNode,
  ghost: GhostNode,
};

const EDGE_TYPES: EdgeTypes = {
  graph: EdgeRenderer,
};

/**
 * Lays nodes out in a deterministic radial-ish layout when no explicit
 * positions are present. Real production would use ELK or dagre — this is
 * a defensible default that yields a non-overlapping organic spread.
 */
function computePositions(
  nodes: ReturnType<typeof selectNodeList>,
  edges: ReturnType<typeof selectEdgeList>,
  ghosts: ReturnType<typeof selectGhostList>,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  // root nodes: no parent
  const roots = nodes.filter((n) => !n.parent_id);
  const childrenOf = new Map<string, string[]>();
  for (const e of edges) {
    const arr = childrenOf.get(e.source_id) ?? [];
    arr.push(e.target_id);
    childrenOf.set(e.source_id, arr);
  }

  let rootCursor = 0;
  for (const r of roots) {
    const ang = (rootCursor / Math.max(1, roots.length)) * Math.PI * 2;
    positions.set(r._id, { x: Math.cos(ang) * 180, y: Math.sin(ang) * 180 });
    rootCursor += 1;
  }

  // BFS place children radiating outward
  const queue: Array<{ id: string; depth: number; angle: number }> = roots.map((r, i) => ({
    id: r._id,
    depth: 1,
    angle: (i / Math.max(1, roots.length)) * Math.PI * 2,
  }));
  const visited = new Set<string>();
  while (queue.length) {
    const cur = queue.shift()!;
    if (visited.has(cur.id)) continue;
    visited.add(cur.id);
    const kids = childrenOf.get(cur.id) ?? [];
    kids.forEach((kid, idx) => {
      if (positions.has(kid)) return;
      const spread = Math.PI / 3;
      const a = cur.angle + ((idx - (kids.length - 1) / 2) * spread) / Math.max(1, kids.length);
      const r = 180 + cur.depth * 200;
      positions.set(kid, { x: Math.cos(a) * r, y: Math.sin(a) * r });
      queue.push({ id: kid, depth: cur.depth + 1, angle: a });
    });
  }

  // any unplaced nodes get spiral fallback
  let spiralIdx = 0;
  for (const n of nodes) {
    if (!positions.has(n._id)) {
      const t = spiralIdx * 0.6;
      positions.set(n._id, { x: Math.cos(t) * (200 + spiralIdx * 30), y: Math.sin(t) * (200 + spiralIdx * 30) });
      spiralIdx += 1;
    }
  }

  // ghosts fly in near a relevant point — for now near origin offset by ghost index
  ghosts.forEach((g, i) => {
    const t = i * 0.9 + Math.PI / 4;
    positions.set(g.ghost_id, { x: Math.cos(t) * 320, y: Math.sin(t) * 320 - 100 });
  });

  return positions;
}

/**
 * The main canvas. All layout/rendering animations live in the child
 * components; here we just convert the store into reactflow primitives.
 *
 * Wrapped in `LayoutGroup` so Framer Motion can correlate `layoutId` across
 * the ghost→solid morph. (See GhostNode + SolidNode.)
 */
function GraphCanvasInner() {
  const nodes = useGraphStore(selectNodeList);
  const edges = useGraphStore(selectEdgeList);
  const ghosts = useGraphStore(selectGhostList);
  const speakerColors = useGraphStore((s) => s.speakerColors);
  const activeSpeakerId = useGraphStore((s) => s.activeSpeakerId);
  const animationQueue = useGraphStore((s) => s.animationQueue);

  // strip queue every render frame after consumption (next tick)
  useEffect(() => {
    if (animationQueue.length === 0) return;
    const t = window.setTimeout(() => {
      // We can't directly mutate; but the queue is read-only here. Reset.
      useGraphStore.setState({ animationQueue: [] });
    }, 50);
    return () => window.clearTimeout(t);
  }, [animationQueue]);

  const positions = useMemo(
    () => computePositions(nodes, edges, ghosts),
    [nodes, edges, ghosts],
  );

  const rfNodes: RFNode<SolidNodeData | GhostNodeData>[] = useMemo(() => {
    const all: RFNode<SolidNodeData | GhostNodeData>[] = [];
    for (const n of nodes) {
      const pos = positions.get(n._id) ?? { x: 0, y: 0 };
      const speakerColor =
        (n.speaker_id && speakerColors[n.speaker_id]) || "var(--border-default)";
      all.push({
        id: n._id,
        type: "solid",
        position: pos,
        data: {
          contractNode: n,
          speakerColor,
          isActiveSpeaker: !!n.speaker_id && n.speaker_id === activeSpeakerId,
          isGhostResolution: false,
        },
        draggable: true,
      });
    }
    for (const g of ghosts) {
      const pos = positions.get(g.ghost_id) ?? { x: 0, y: 0 };
      const speakerColor = speakerColors[g.speaker_id] || "var(--signature-accent)";
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
  }, [nodes, ghosts, positions, speakerColors, activeSpeakerId]);

  const rfEdges: RFEdge<GraphEdgeData>[] = useMemo(() => {
    return edges.map((e) => {
      const sourceNode = nodes.find((n) => n._id === e.source_id);
      const speakerColor =
        (sourceNode?.speaker_id && speakerColors[sourceNode.speaker_id]) ||
        (e.speaker_id && speakerColors[e.speaker_id]) ||
        "var(--border-default)";
      return {
        id: e._id,
        source: e.source_id,
        target: e.target_id,
        type: "graph",
        data: { edge_type: e.edge_type, speakerColor },
      };
    });
  }, [edges, nodes, speakerColors]);

  return (
    <LayoutGroup id="mindmap-canvas">
      <div className="canvas-wrap">
        <div className="dot-grid" aria-hidden />
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={NODE_TYPES}
          edgeTypes={EDGE_TYPES}
          fitView
          fitViewOptions={{ padding: 0.4, maxZoom: 1.1, minZoom: 0.3 }}
          minZoom={0.2}
          maxZoom={2}
          panOnDrag
          zoomOnScroll
          proOptions={{ hideAttribution: true }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={22}
            size={0.6}
            color="rgba(148,163,184,0.05)"
          />
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
