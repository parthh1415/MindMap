// Tests for the cinematic Generate→Document swirl transition.
//
// We can't easily assert pixel positions in jsdom (no real layout),
// but we CAN assert the state-machine contract that bridges the
// artifact store and the overlay:
//   - generate() success → phase = "swirl"
//   - advanceFromSwirl() → phase = "ready"
//   - 3s safety timeout in generate() also flips swirl → ready
//
// The overlay's actual render — querying DOM elements by data-id,
// running the RAF spring, drawing SVG lines — is exercised in the
// browser; here we cover the lifecycle.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { useArtifactStore } from "../src/state/artifactStore";
import { useGraphStore } from "../src/state/graphStore";
import GenerateSwirlOverlay from "../src/components/GenerateSwirlOverlay";

beforeEach(() => {
  useGraphStore.getState().resetGraph();
  useArtifactStore.setState({
    phase: "idle",
    classifyResult: null,
    activeArtifact: null,
    history: [],
    historyOpen: false,
    atTimestamp: null,
    refinementHint: "",
    overrideType: null,
    error: null,
    pendingDismissed: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("GenerateSwirlOverlay phase contract", () => {
  it("advanceFromSwirl flips phase swirl → ready", () => {
    useArtifactStore.setState({ phase: "swirl" });
    useArtifactStore.getState().advanceFromSwirl();
    expect(useArtifactStore.getState().phase).toBe("ready");
  });

  it("advanceFromSwirl is a no-op outside the swirl phase", () => {
    useArtifactStore.setState({ phase: "idle" });
    useArtifactStore.getState().advanceFromSwirl();
    expect(useArtifactStore.getState().phase).toBe("idle");

    useArtifactStore.setState({ phase: "ready" });
    useArtifactStore.getState().advanceFromSwirl();
    expect(useArtifactStore.getState().phase).toBe("ready");
  });

  it("renders nothing when phase is not 'swirl'", () => {
    useArtifactStore.setState({ phase: "ready" });
    const { container } = render(<GenerateSwirlOverlay />);
    expect(container.querySelector(".swirl-overlay")).toBeNull();
  });

  it("auto-advances immediately when phase is swirl but artifact has no cited node_ids", () => {
    useArtifactStore.setState({
      phase: "swirl",
      activeArtifact: {
        session_id: "s",
        artifact_type: "brief",
        title: "Empty",
        markdown: "# Empty",
        files: [],
        // evidence with no node_ids — overlay should skip the visuals
        // and call advanceFromSwirl() immediately.
        evidence: [{ section_anchor: "intro", node_ids: [], transcript_excerpts: [] }],
      },
    });
    render(<GenerateSwirlOverlay />);
    expect(useArtifactStore.getState().phase).toBe("ready");
  });

  it("auto-advances when artifact is missing entirely (defensive)", () => {
    useArtifactStore.setState({ phase: "swirl", activeArtifact: null });
    render(<GenerateSwirlOverlay />);
    expect(useArtifactStore.getState().phase).toBe("ready");
  });
});
