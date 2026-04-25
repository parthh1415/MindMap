import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { useGraphStore } from "../src/state/graphStore";
import { NodeEditModal } from "../src/components/NodeEditModal";

beforeEach(() => {
  useGraphStore.getState().resetGraph();
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
});

describe("NodeEditModal", () => {
  it("does not render when no node is selected", () => {
    render(<NodeEditModal />);
    expect(screen.queryByText(/Fix transcription/i)).toBeNull();
  });

  it("opens when a node is selected and shows the rename input", () => {
    useGraphStore.getState().applyGraphEvent({
      type: "node_upsert",
      session_id: "s",
      node: {
        _id: "n1",
        session_id: "s",
        label: "Cache",
        speaker_id: "s1",
        importance_score: 0.5,
        parent_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        info: [],
      },
    });
    act(() => {
      useGraphStore.getState().selectNode("n1");
    });
    render(<NodeEditModal />);
    expect(screen.getByText(/Fix transcription/i)).toBeInTheDocument();
    const input = screen.getByPlaceholderText(/Concept name/i) as HTMLInputElement;
    expect(input.value).toBe("Cache");
  });

  it("Escape key closes the modal", () => {
    useGraphStore.getState().applyGraphEvent({
      type: "node_upsert",
      session_id: "s",
      node: {
        _id: "n1",
        session_id: "s",
        label: "Cache",
        importance_score: 0.5,
        parent_id: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        info: [],
      },
    });
    act(() => useGraphStore.getState().selectNode("n1"));
    render(<NodeEditModal />);
    expect(screen.getByText(/Fix transcription/i)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useGraphStore.getState().selectedNodeId).toBe(null);
  });
});
