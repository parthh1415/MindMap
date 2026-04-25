import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useEffect, useRef } from "react";
import {
  useGraphStore,
  useNodeList,
  useEdgeList,
  useGhostList,
} from "../src/state/graphStore";
import type { Node } from "../../shared/ws_messages";

function mkNode(id: string): Node {
  const now = new Date().toISOString();
  return {
    _id: id,
    session_id: "s",
    label: id,
    speaker_id: "s1",
    importance_score: 0.5,
    parent_id: null,
    created_at: now,
    updated_at: now,
    info: [],
  } as Node;
}

/**
 * Regression test for the React-18 `useSyncExternalStore` infinite-loop
 * caused by selectors that produced fresh arrays on every snapshot
 * (`Object.values(s.nodes)` etc.). Pre-fix, mounting any component that
 * read from these selectors would trigger "Maximum update depth exceeded"
 * and the dev server would render a blank page.
 *
 * Post-fix (`useShallow`), the hook variants (`useNodeList`, etc.) compare
 * results by shallow array equality, so the snapshot reference is stable
 * when contents are unchanged. The component below renders exactly once
 * per real state mutation. We assert the render count stays bounded across
 * idempotent mutations.
 */
describe("graphStore — selector stability under React subscription", () => {
  beforeEach(() => useGraphStore.getState().resetGraph());

  it("useNodeList does not loop when state is unchanged", () => {
    const renders = { count: 0 };
    function Probe() {
      const nodes = useNodeList();
      const ref = useRef(0);
      ref.current += 1;
      renders.count = ref.current;
      useEffect(() => {});
      return <div data-testid="probe">{nodes.length}</div>;
    }

    const { getByTestId, unmount } = render(<Probe />);
    expect(getByTestId("probe").textContent).toBe("0");
    const initial = renders.count;

    // No state change → no re-render. (Trigger an unrelated setState that
    // doesn't touch nodes; under the broken selector this would still
    // cascade into infinite renders before the test could finish.)
    act(() => {
      useGraphStore.setState({ activeSpeakerId: "alice" });
    });
    expect(renders.count).toBe(initial);

    // Real mutation → exactly one re-render.
    act(() => {
      useGraphStore.getState().applyGraphEvent({
        type: "node_upsert",
        session_id: "s",
        node: mkNode("n1"),
      });
    });
    expect(getByTestId("probe").textContent).toBe("1");
    expect(renders.count).toBe(initial + 1);

    unmount();
  });

  it("useEdgeList and useGhostList are also stable", () => {
    function Probe() {
      const edges = useEdgeList();
      const ghosts = useGhostList();
      return (
        <div>
          <span data-testid="e">{edges.length}</span>
          <span data-testid="g">{ghosts.length}</span>
        </div>
      );
    }
    const { getByTestId } = render(<Probe />);
    expect(getByTestId("e").textContent).toBe("0");
    expect(getByTestId("g").textContent).toBe("0");
  });
});
