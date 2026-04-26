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

  it("calls openGenerator on click and posts to /classify-artifact", async () => {
    seedNode("n1", "Alpha");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        session_id: "s",
        top_choice: "prd",
        confidence: 0.82,
        candidates: [
          { type: "prd", score: 0.82, why: "Feature ideation" },
          { type: "decision", score: 0.1, why: "Some tradeoffs" },
          { type: "brief", score: 0.05, why: "Generic fallback" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<ArtifactButton />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("artifact-button"));
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/sessions/s/classify-artifact`);
    expect(init.method).toBe("POST");

    await waitFor(() => {
      expect(useArtifactStore.getState().phase).toBe("confirming");
    });
    expect(useArtifactStore.getState().classifyResult?.top_choice).toBe("prd");
  });
});

describe("ClassifyConfirmModal", () => {
  it("renders nothing when phase is idle", () => {
    render(<ClassifyConfirmModal />);
    expect(screen.queryByTestId("classify-modal")).toBeNull();
  });

  it("renders top_choice and confidence when phase is confirming", () => {
    useArtifactStore.setState({
      phase: "confirming",
      classifyResult: {
        top_choice: "prd",
        confidence: 0.82,
        candidates: [
          { type: "prd", score: 0.82, why: "Feature ideation conversation." },
          { type: "decision", score: 0.1, why: "Some tradeoffs discussion." },
          { type: "brief", score: 0.05, why: "Generic fallback." },
        ],
      },
    });
    render(<ClassifyConfirmModal />);
    expect(screen.getByTestId("classify-modal")).toBeInTheDocument();
    expect(screen.getByText("PRD")).toBeInTheDocument();
    expect(screen.getByTestId("classify-confidence")).toHaveTextContent(
      "0.82 confidence",
    );
    expect(screen.getByText("Feature ideation conversation.")).toBeInTheDocument();
  });

  it("override picker switches the displayed type", () => {
    useArtifactStore.setState({
      phase: "confirming",
      classifyResult: {
        top_choice: "prd",
        confidence: 0.5,
        candidates: [{ type: "prd", score: 0.5, why: "..." }],
      },
    });
    render(<ClassifyConfirmModal />);

    fireEvent.click(screen.getByTestId("classify-type-pill"));
    expect(screen.getByTestId("classify-override-menu")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("classify-option-decision"));
    expect(useArtifactStore.getState().overrideType).toBe("decision");
    // Pill now shows "Decision Doc" (menu's exit animation may briefly leave
    // the option label in the DOM, so accept any occurrence ≥ 1).
    expect(screen.getAllByText("Decision Doc").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByTestId("classify-type-pill").textContent).toContain(
      "Decision Doc",
    );
  });

  it("Generate posts to /generate-artifact with the chosen type and refinement", async () => {
    useArtifactStore.setState({
      phase: "confirming",
      classifyResult: {
        top_choice: "prd",
        confidence: 0.82,
        candidates: [{ type: "prd", score: 0.82, why: "..." }],
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({
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

    render(<ClassifyConfirmModal />);
    fireEvent.change(screen.getByTestId("classify-refinement"), {
      target: { value: "more technical" },
    });
    fireEvent.click(screen.getByTestId("classify-generate"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/sessions/s/generate-artifact`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.artifact_type).toBe("prd");
    expect(body.refinement_hint).toBe("more technical");

    await waitFor(() => {
      expect(useArtifactStore.getState().phase).toBe("ready");
    });
    expect(useArtifactStore.getState().activeArtifact?.title).toBe("Auth PRD");
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
