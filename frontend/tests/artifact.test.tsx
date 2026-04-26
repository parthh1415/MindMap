import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { useArtifactStore } from "../src/state/artifactStore";
import { useGraphStore } from "../src/state/graphStore";
import { useSessionStore } from "../src/state/sessionStore";
import { ArtifactButton } from "../src/components/ArtifactButton";
import { ClassifyConfirmModal } from "../src/components/ClassifyConfirmModal";
import { ArtifactPreview } from "../src/components/ArtifactPreview";
import { ArtifactHistoryBar } from "../src/components/ArtifactHistoryBar";

const API = "http://test-api";

function seedNode(id: string, label: string, speaker_id = "speaker_0") {
  useGraphStore.getState().applyGraphEvent({
    type: "node_upsert",
    session_id: "s",
    node: {
      _id: id,
      session_id: "s",
      label,
      speaker_id,
      importance_score: 0.7,
      parent_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      info: [],
    },
  });
}

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
    apiBase: API,
    pendingDismissed: false,
  });
  useSessionStore.setState({ currentSessionId: "s", currentSessionName: "Test" });
  vi.unstubAllGlobals();
});

describe("ArtifactButton", () => {
  it("returns null when there are no nodes", () => {
    const { container } = render(<ArtifactButton />);
    expect(container.firstChild).toBeNull();
  });

  it("renders Generate label when nodes exist", () => {
    seedNode("n1", "Alpha");
    render(<ArtifactButton />);
    expect(screen.getByTestId("artifact-button")).toBeInTheDocument();
    expect(screen.getByText("Generate")).toBeInTheDocument();
  });

  it("auto-classifies AND auto-generates on a single click (no confirm modal)", async () => {
    seedNode("n1", "Alpha");
    const fetchMock = vi
      .fn()
      // 1st call: classify-artifact
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session_id: "s",
          top_choice: "prd",
          confidence: 0.82,
          candidates: [
            { type: "prd", score: 0.82, why: "Feature ideation" },
            { type: "brief", score: 0.05, why: "Generic fallback" },
          ],
        }),
      })
      // 2nd call: generate-artifact (auto-fired with the top_choice)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          session_id: "s",
          artifact_type: "prd",
          title: "Auth PRD",
          markdown: "# Auth PRD\n\n## Goals\n\nShip OAuth.",
          files: [],
          evidence: [],
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<ArtifactButton />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("artifact-button"));
    });

    // Both calls should fire one after the other — classify then generate.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [classifyUrl] = fetchMock.mock.calls[0];
    const [generateUrl, generateInit] = fetchMock.mock.calls[1];
    expect(classifyUrl).toBe(`${API}/sessions/s/classify-artifact`);
    expect(generateUrl).toBe(`${API}/sessions/s/generate-artifact`);
    // The generate call uses the classify result's top_choice — context
    // alone picks the doc type, no user confirmation involved.
    expect(JSON.parse(generateInit.body).artifact_type).toBe("prd");

    // Final state: ready with the generated artifact loaded.
    await waitFor(() => {
      expect(useArtifactStore.getState().phase).toBe("ready");
    });
    expect(useArtifactStore.getState().classifyResult?.top_choice).toBe("prd");
    expect(useArtifactStore.getState().activeArtifact?.title).toBe("Auth PRD");
  });
});

describe("ClassifyConfirmModal — suppressed in auto-classify mode", () => {
  it("never renders, even when phase would historically have shown it", () => {
    // Pre-auto-classify, this state would have shown the confirm modal.
    // After the change to skip user confirmation, the modal is hidden
    // unconditionally — the ArtifactButton's status label is the only
    // feedback the user gets while classification + generation run.
    useArtifactStore.setState({
      phase: "confirming",
      classifyResult: {
        top_choice: "prd",
        confidence: 0.82,
        candidates: [
          { type: "prd", score: 0.82, why: "Feature ideation conversation." },
        ],
      },
    });
    render(<ClassifyConfirmModal />);
    expect(screen.queryByTestId("classify-modal")).toBeNull();
  });
});

describe("ArtifactPreview", () => {
  it("renders the artifact title and prose markdown", () => {
    useArtifactStore.setState({
      phase: "ready",
      activeArtifact: {
        session_id: "s",
        artifact_type: "prd",
        title: "Auth PRD",
        markdown: "# Auth PRD\n\n## Goals\n\nShip OAuth quickly.",
        files: [],
        evidence: [],
      },
    });
    render(<ArtifactPreview />);
    expect(screen.getByTestId("artifact-preview")).toBeInTheDocument();
    // Title appears in the modal header AND inside the rendered <h1>; both fine.
    expect(screen.getAllByText("Auth PRD").length).toBeGreaterThanOrEqual(1);
    const prose = screen.getByTestId("artifact-prose");
    expect(prose.innerHTML).toContain('<h2 id="goals">Goals</h2>');
    expect(prose.innerHTML).toContain("Ship OAuth quickly.");
  });

  it("Edit button switches to editing phase", () => {
    useArtifactStore.setState({
      phase: "ready",
      activeArtifact: {
        session_id: "s",
        artifact_type: "brief",
        title: "B",
        markdown: "# B",
        files: [],
        evidence: [],
      },
    });
    render(<ArtifactPreview />);
    fireEvent.click(screen.getByTestId("artifact-edit"));
    expect(useArtifactStore.getState().phase).toBe("editing");
  });
});

describe("ArtifactHistoryBar", () => {
  it("renders history rows and loads one on click", async () => {
    useArtifactStore.setState({
      historyOpen: true,
      history: [
        {
          _id: "a1",
          session_id: "s",
          artifact_type: "prd",
          title: "Earlier PRD",
          generated_at: new Date(Date.now() - 120_000).toISOString(),
        },
      ],
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        _id: "a1",
        session_id: "s",
        artifact_type: "prd",
        title: "Earlier PRD",
        markdown: "# Earlier PRD",
        files: [],
        evidence: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ArtifactHistoryBar />);
    expect(screen.getByText("Earlier PRD")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("history-row-a1"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(`${API}/artifacts/a1`);
    await waitFor(() => {
      expect(useArtifactStore.getState().phase).toBe("ready");
    });
  });
});
