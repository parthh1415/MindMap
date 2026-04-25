import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

import { useGraphStore } from "../src/state/graphStore";
import { useSynthStore } from "../src/state/synthStore";
import { useSessionStore } from "../src/state/sessionStore";
import { SynthesizeDrawer, MarkdownView } from "../src/components/SynthesizeDrawer";
import { NodeActionMenu } from "../src/components/NodeActionMenu";

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
  // Reset synth store between tests.
  useSynthStore.setState({
    selectedForSynth: new Set(),
    drawerOpen: false,
    format: "doc",
    lastResult: null,
    inflight: false,
    error: null,
    anchorNodeId: null,
    apiBase: API,
  });
  useSessionStore.setState({ currentSessionId: "s", currentSessionName: "Test" });
  vi.unstubAllGlobals();
});

describe("MarkdownView", () => {
  it("renders headers, paragraphs, and lists without HTML pass-through", () => {
    const md = `# Title\n\n## Section\n\nA paragraph with **bold** and *italic*.\n\n- one\n- two`;
    render(<MarkdownView source={md} />);
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Section")).toBeInTheDocument();
    expect(screen.getByText("bold")).toBeInTheDocument();
    expect(screen.getByText("one")).toBeInTheDocument();
    expect(screen.getByText("two")).toBeInTheDocument();
  });

  it("escapes raw HTML so script tags become text", () => {
    const md = `# Hi\n\n<script>alert(1)</script>`;
    const { container } = render(<MarkdownView source={md} />);
    // No actual <script> element should be in the DOM.
    expect(container.querySelector("script")).toBeNull();
    // The literal text should be present.
    expect(container.textContent).toContain("<script>");
  });
});

describe("SynthesizeDrawer", () => {
  it("renders chip when nodes are selected and drawer is closed", () => {
    seedNode("n1", "Alpha");
    act(() => {
      useSynthStore.getState().toggleSelect("n1");
    });
    render(<SynthesizeDrawer />);
    expect(screen.getByTestId("synth-chip")).toBeInTheDocument();
  });

  it("renders the drawer when openDrawer is called", () => {
    act(() => useSynthStore.getState().openDrawer());
    render(<SynthesizeDrawer />);
    expect(screen.getByTestId("synth-drawer")).toBeInTheDocument();
    expect(screen.getByTestId("format-doc")).toBeInTheDocument();
    expect(screen.getByTestId("format-email")).toBeInTheDocument();
    expect(screen.getByTestId("format-issue")).toBeInTheDocument();
    expect(screen.getByTestId("format-summary")).toBeInTheDocument();
  });

  it("format chooser updates store's format", () => {
    act(() => useSynthStore.getState().openDrawer());
    render(<SynthesizeDrawer />);
    fireEvent.click(screen.getByTestId("format-issue"));
    expect(useSynthStore.getState().format).toBe("issue");
    fireEvent.click(screen.getByTestId("format-email"));
    expect(useSynthStore.getState().format).toBe("email");
  });

  it("Generate hits the synthesize endpoint and renders the markdown result", async () => {
    seedNode("n1", "Alpha");
    seedNode("n2", "Beta");

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        title: "Brief Result",
        markdown: "# Brief Result\n\nBody paragraph.",
        target_format: "doc",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    act(() => useSynthStore.getState().openDrawer());
    render(<SynthesizeDrawer />);

    fireEvent.click(screen.getByTestId("synth-generate"));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/sessions/s/synthesize`);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.format).toBe("doc");
    expect(body.scope).toBe("all");

    await waitFor(() => {
      expect(screen.getByTestId("synth-result")).toBeInTheDocument();
    });
    // The title appears in BOTH the result-title h2 and the rendered H1
    // markdown — so getAllByText is correct.
    expect(screen.getAllByText("Brief Result").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Body paragraph.")).toBeInTheDocument();
  });

  it("Generate sends scope=selected when selectedForSynth is non-empty", async () => {
    seedNode("n1", "Alpha");
    act(() => {
      useSynthStore.getState().toggleSelect("n1");
      useSynthStore.getState().openDrawer();
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        title: "T",
        markdown: "# T",
        target_format: "summary",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SynthesizeDrawer />);
    // change format to summary first
    fireEvent.click(screen.getByTestId("format-summary"));
    fireEvent.click(screen.getByTestId("synth-generate"));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.scope).toBe("selected");
    expect(body.node_ids).toEqual(["n1"]);
    expect(body.format).toBe("summary");
  });
});

describe("NodeActionMenu", () => {
  it("renders nothing when no node is selected", () => {
    render(<NodeActionMenu />);
    expect(screen.queryByTestId("action-expand")).toBeNull();
  });

  it("renders Expand / Add to synthesis / Show evidence / Edit when a node is selected", () => {
    seedNode("n1", "Alpha");
    act(() => useGraphStore.getState().selectNode("n1"));
    render(<NodeActionMenu />);
    expect(screen.getByTestId("action-expand")).toBeInTheDocument();
    expect(screen.getByTestId("action-add-to-synthesis")).toBeInTheDocument();
    expect(screen.getByTestId("action-show-evidence")).toBeInTheDocument();
    expect(screen.getByTestId("action-edit")).toBeInTheDocument();
  });

  it("Expand action posts to /nodes/{id}/expand and adds optimistic ghosts", async () => {
    seedNode("n1", "Alpha");
    act(() => useGraphStore.getState().selectNode("n1"));

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        children: [
          { label: "child A", edge_type: "solid", importance_score: 0.9 },
          { label: "child B", edge_type: "dashed", importance_score: 0.6 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<NodeActionMenu />);

    // Before click, no ghosts.
    expect(Object.keys(useGraphStore.getState().ghostNodes).length).toBe(0);

    fireEvent.click(screen.getByTestId("action-expand"));

    // Optimistic ghosts appear immediately.
    expect(Object.keys(useGraphStore.getState().ghostNodes).length).toBeGreaterThan(0);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${API}/nodes/n1/expand`);
    expect(init.method).toBe("POST");

    // After response, optimistic ghosts replaced with real labels.
    await waitFor(() => {
      const labels = Object.values(useGraphStore.getState().ghostNodes).map(
        (g) => g.label,
      );
      expect(labels).toContain("child A");
      expect(labels).toContain("child B");
    });
  });

  it("Add to synthesis toggles selectedForSynth", () => {
    seedNode("n1", "Alpha");
    act(() => useGraphStore.getState().selectNode("n1"));
    render(<NodeActionMenu />);
    fireEvent.click(screen.getByTestId("action-add-to-synthesis"));
    expect(useSynthStore.getState().selectedForSynth.has("n1")).toBe(true);
    fireEvent.click(screen.getByTestId("action-add-to-synthesis"));
    expect(useSynthStore.getState().selectedForSynth.has("n1")).toBe(false);
  });
});
