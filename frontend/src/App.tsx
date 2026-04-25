import { useEffect } from "react";
import { useGraphStore, useNodeList, useGhostList } from "@/state/graphStore";
import { useSessionStore } from "@/state/sessionStore";
import { GraphSocketClient } from "@/ws/graphSocketClient";
import { GraphCanvas } from "@/components/graph/GraphCanvas";
import { TopBar } from "@/components/TopBar";
import { TimelineScrubber } from "@/components/TimelineScrubber";
import { SpeakerLegend } from "@/components/SpeakerLegend";
import { EmptyState } from "@/components/EmptyState";
import { NodeEditModal } from "@/components/NodeEditModal";
import { ImageDropZone } from "@/components/ImageDropZone";
import { TranscriptStream } from "@/components/TranscriptStream";
import { NodeActionMenu } from "@/components/NodeActionMenu";
import { ExpandButton } from "@/components/ExpandButton";
import { SynthesizeDrawer } from "@/components/SynthesizeDrawer";
import { BranchNavigator } from "@/components/BranchNavigator";
import { BranchDiffView } from "@/components/BranchDiffView";
import { PivotToast } from "@/components/PivotToast";
import { playClick } from "@/lib/sound";
import { useSessionBootstrap } from "@/integration/sessionBootstrap";
import { useTranscriptPipeline } from "@/integration/transcriptPipeline";
import { usePivotPoller } from "@/integration/pivotPoller";
import { DevPanel } from "@/lib/devPanel";

/**
 * MindMap — App shell.
 *
 *   ┌─────────── TopBar ────────────┐
 *   │                               │
 *   │       GraphCanvas             │  ← SpeakerLegend (top-right)
 *   │       (or EmptyState)         │
 *   │                               │
 *   │  ┌─── TimelineScrubber ───┐   │
 *   └───────────────────────────────┘
 *           SidePanel (slides from right)
 */
function App() {
  const sessionId = useSessionStore((s) => s.currentSessionId);
  const setReducedMotion = useSessionStore((s) => s.setReducedMotion);
  const soundEnabled = useSessionStore((s) => s.soundEnabled);
  const micActive = useSessionStore((s) => s.micActive);
  const nodes = useNodeList();
  const ghosts = useGhostList();

  // Bootstrap a session id (from URL or by creating one against the backend)
  // and hydrate the graph store from /sessions/{id}/graph.
  useSessionBootstrap();

  // Drive speech → backend → topology agent whenever the mic is on.
  useTranscriptPipeline({ sessionId, enabled: micActive });

  // Poll for branchable pivot points while the mic is on.
  usePivotPoller({ sessionId, enabled: micActive });

  // Connect the graph WS once a session exists.
  useEffect(() => {
    if (!sessionId) return;
    const client = new GraphSocketClient(sessionId);
    client.connect();
    return () => client.close();
  }, [sessionId]);

  // Detect reduced-motion preference.
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReducedMotion(mq.matches);
    const fn = () => setReducedMotion(mq.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, [setReducedMotion]);

  // Web Audio click on node creation / merge (toggleable via TopBar).
  useEffect(() => {
    if (!soundEnabled) return;
    const unsub = useGraphStore.subscribe((state, prev) => {
      const nNow = Object.keys(state.nodes).length;
      const nPrev = Object.keys(prev.nodes).length;
      if (nNow > nPrev) playClick({ freq: 880 });
      const gNow = Object.keys(state.ghostNodes).length;
      const gPrev = Object.keys(prev.ghostNodes).length;
      if (gNow < gPrev && nNow === nPrev) playClick({ freq: 660 });
    });
    return unsub;
  }, [soundEnabled]);

  const showEmpty = nodes.length === 0 && ghosts.length === 0;

  return (
    <div className="app-shell">
      <div className="ambient-bg" aria-hidden />
      <TopBar />
      <main className="app-main">
        <GraphCanvas />
        {showEmpty ? <EmptyState /> : null}
      </main>
      <SpeakerLegend />
      <TimelineScrubber />
      <BranchNavigator />
      <BranchDiffView />
      <PivotToast />
      <NodeActionMenu />
      <ExpandButton />
      <SynthesizeDrawer />
      <NodeEditModal />
      <ImageDropZone />
      <TranscriptStream />
      <DevPanel />

      <style>{`
        .app-main {
          position: absolute;
          inset: 0;
          z-index: 1;
        }
      `}</style>
    </div>
  );
}

export default App;
