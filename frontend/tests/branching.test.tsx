import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, act, fireEvent, screen } from "@testing-library/react";

import { useBranchStore, pivotIdFor } from "../src/state/branchStore";
import { useSessionStore } from "../src/state/sessionStore";
import { PivotToast } from "../src/components/PivotToast";
import { BranchNavigator } from "../src/components/BranchNavigator";
import { BranchDiffView } from "../src/components/BranchDiffView";

// Make sonner happy in jsdom (some components transitively import it).
vi.mock("sonner", () => ({
  toast: Object.assign(() => {}, {
    warning: () => {},
    error: () => {},
    success: () => {},
  }),
}));

function resetStores() {
  useBranchStore.setState({
    branches: [],
    pivotSuggestions: [],
    lastPivotPolledAt: 0,
    dismissedPivotIds: new Set<string>(),
    compareSessionId: null,
    isProcessing: false,
  });
  useSessionStore.setState({
    currentSessionId: "sess-current",
    currentSessionName: "Live",
    micActive: false,
    branchedSessions: [],
    branching: { phase: "idle" },
    sidePanelOpen: false,
  });
}

describe("PivotToast", () => {
  beforeEach(() => {
    resetStores();
  });

  it("renders nothing when there are no suggestions", () => {
    const { container } = render(<PivotToast />);
    expect(container.querySelector(".pivot-toast")).toBeNull();
  });

  it("renders when suggestions exist", () => {
    act(() => {
      useBranchStore.getState().setPivots([
        {
          timestamp: new Date().toISOString(),
          why: "the team skipped over caching trade-offs",
          pivot_label: "Caching Layer",
        },
      ]);
    });
    render(<PivotToast />);
    expect(screen.getByText("Caching Layer")).toBeTruthy();
    expect(screen.getByText(/skipped over caching/i)).toBeTruthy();
  });

  it("dismiss removes the toast and adds to dismissed set", () => {
    const ts = new Date().toISOString();
    act(() => {
      useBranchStore.getState().setPivots([
        {
          timestamp: ts,
          why: "missed thread",
          pivot_label: "Side Path",
        },
      ]);
    });
    render(<PivotToast />);
    const dismissBtn = screen.getByLabelText(/dismiss pivot suggestion/i);
    act(() => {
      fireEvent.click(dismissBtn);
    });
    const id = pivotIdFor("sess-current", {
      timestamp: ts,
      pivot_label: "Side Path",
      why: "missed thread",
    });
    expect(useBranchStore.getState().dismissedPivotIds.has(id)).toBe(true);
    // The "active" pivot must now be null (the toast component computes
    // the visible pivot from the store and the dismissed set).
    const visible = useBranchStore
      .getState()
      .pivotSuggestions.filter(
        (p) =>
          !useBranchStore
            .getState()
            .dismissedPivotIds.has(pivotIdFor("sess-current", p)),
      );
    expect(visible.length).toBe(0);
  });

  it("'Branch here' fires POST /sessions/{id}/branch", async () => {
    const ts = new Date().toISOString();
    const fetchSpy = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ _id: "branch-1", name: "Live (branch)" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    act(() => {
      useBranchStore.getState().setPivots([
        {
          timestamp: ts,
          why: "alt path",
          pivot_label: "Alt Path",
        },
      ]);
    });
    render(<PivotToast />);
    const cta = screen.getByText("Branch here");
    await act(async () => {
      fireEvent.click(cta);
      // give the async fetch a tick
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalled();
    const url = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(url).toContain("/sessions/sess-current/branch");
    expect(useBranchStore.getState().branches.find((b) => b._id === "branch-1")).toBeTruthy();
  });
});

describe("BranchNavigator", () => {
  beforeEach(() => {
    resetStores();
  });

  it("renders nothing when closed", () => {
    const { container } = render(<BranchNavigator />);
    expect(container.querySelector(".branch-nav")).toBeNull();
  });

  it("lists branches and switches the active branch on Open", async () => {
    // Pre-populate branches and open the panel.
    act(() => {
      useBranchStore.getState().setBranches([
        {
          _id: "b1",
          name: "Branch 1",
          branched_from: { session_id: "sess-current", timestamp: new Date().toISOString() },
          node_count: 4,
        },
        {
          _id: "b2",
          name: "Branch 2",
          branched_from: { session_id: "sess-current", timestamp: new Date().toISOString() },
          node_count: 7,
        },
      ]);
      useSessionStore.getState().setSidePanelOpen(true);
    });
    // Avoid the panel's auto-fetch overwriting our store state.
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ branches: useBranchStore.getState().branches }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<BranchNavigator />);

    expect(screen.getByText("Branch 1")).toBeTruthy();
    expect(screen.getByText("Branch 2")).toBeTruthy();

    const openBtns = screen.getAllByLabelText(/^Open branch/i);
    await act(async () => {
      fireEvent.click(openBtns[1]); // open Branch 2
      await Promise.resolve();
    });
    expect(useSessionStore.getState().currentSessionId).toBe("b2");
  });

  it("compare button sets compareSessionId", async () => {
    act(() => {
      useBranchStore.getState().setBranches([
        {
          _id: "bX",
          name: "Branch X",
          branched_from: { session_id: "sess-current", timestamp: new Date().toISOString() },
          node_count: 3,
        },
      ]);
      useSessionStore.getState().setSidePanelOpen(true);
    });
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ branches: useBranchStore.getState().branches }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    render(<BranchNavigator />);
    await act(async () => {
      fireEvent.click(screen.getByLabelText(/Compare with Branch X/i));
    });
    expect(useBranchStore.getState().compareSessionId).toBe("bX");
  });
});

describe("BranchDiffView", () => {
  beforeEach(() => {
    resetStores();
  });

  it("renders nothing when no compareSessionId", () => {
    const { container } = render(<BranchDiffView />);
    expect(container.querySelector(".diff-overlay")).toBeNull();
  });

  it("fetches diff and toggles highlight chips", async () => {
    const sharedNode = { _id: "n1", label: "Alpha" };
    const onlyANode = { _id: "n2", label: "Beta" };
    const onlyBNode = { _id: "n3", label: "Gamma" };

    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          session_a: "sess-current",
          session_b: "branch-x",
          shared: { nodes: [sharedNode], edges: [] },
          only_in_a: { nodes: [onlyANode], edges: [] },
          only_in_b: { nodes: [onlyBNode], edges: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    act(() => {
      useBranchStore.getState().openCompare("branch-x");
    });
    render(<BranchDiffView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // Diff chips render with counts.
    expect(screen.getByText("Shared").parentElement?.textContent).toContain("1");
    expect(screen.getByText("Only A").parentElement?.textContent).toContain("1");
    expect(screen.getByText("Only B").parentElement?.textContent).toContain("1");

    // Click "Shared" chip and verify aria-selected toggles.
    const sharedChip = screen.getByText("Shared").closest("button")!;
    await act(async () => {
      fireEvent.click(sharedChip);
    });
    expect(sharedChip.getAttribute("aria-selected")).toBe("true");

    // Promote button swaps the current session.
    const promote = screen.getByLabelText(/open this branch as current/i);
    await act(async () => {
      fireEvent.click(promote);
    });
    expect(useSessionStore.getState().currentSessionId).toBe("branch-x");
    expect(useBranchStore.getState().compareSessionId).toBeNull();
  });

  it("Esc closes the overlay", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(
        JSON.stringify({
          session_a: "sess-current",
          session_b: "branch-x",
          shared: { nodes: [], edges: [] },
          only_in_a: { nodes: [], edges: [] },
          only_in_b: { nodes: [], edges: [] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    act(() => {
      useBranchStore.getState().openCompare("branch-x");
    });
    render(<BranchDiffView />);
    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(useBranchStore.getState().compareSessionId).toBeNull();
  });
});
