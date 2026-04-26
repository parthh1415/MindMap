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

const NODE_TYPES: NodeTypes = {
  solid: SolidNode,
  ghost: GhostNode,
};

const EDGE_TYPES: EdgeTypes = {
  graph: EdgeRenderer,
};

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
  const nodes = useNodeList();
  const edges = useEdgeList();
  const ghosts = useGhostList();
  const speakerColors = useGraphStore((s) => s.speakerColors);
  const activeSpeakerId = useGraphStore((s) => s.activeSpeakerId);
  const animationQueue = useGraphStore((s) => s.animationQueue);

  // strip queue every render frame after consumption (next tick)
  useEffect(() => {
    if (animationQueue.length === 0) return;
    const t = window.setTimeout(() => {
      useGraphStore.setState({ animationQueue: [] });
    }, 50);
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

  const rfNodes: RFNode<SolidNodeData | GhostNodeData>[] = useMemo(() => {
    const all: RFNode<SolidNodeData | GhostNodeData>[] = [];
    for (const n of nodes) {
      const pos = positions.get(n._id) ?? { x: 0, y: 0 };
      const speakerColor =
        (n.speaker_id && speakerColors[n.speaker_id]) || "var(--text-secondary)";
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
    // tickToken is intentionally a dep so positions snapshot is fresh each tick.
  }, [nodes, ghosts, positions, speakerColors, activeSpeakerId, tickToken, neighborSet]);

  const rfEdges: RFEdge<GraphEdgeData>[] = useMemo(() => {
    return edges.map((e) => {
      const sourceNode = nodes.find((n) => n._id === e.source_id);
      const speakerColor =
        (sourceNode?.speaker_id && speakerColors[sourceNode.speaker_id]) ||
        (e.speaker_id && speakerColors[e.speaker_id]) ||
        "var(--text-secondary)";
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
          minZoom={0.2}
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
