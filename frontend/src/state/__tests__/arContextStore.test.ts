import { describe, it, expect, beforeEach } from "vitest";
import { useArContextStore } from "@/state/arContextStore";

beforeEach(() => {
  useArContextStore.setState({ openCards: [] });
});

describe("arContextStore", () => {
  it("toggleCard opens a closed card and closes an open one", () => {
    useArContextStore.getState().toggleCard("a");
    expect(useArContextStore.getState().isOpen("a")).toBe(true);

    useArContextStore.getState().toggleCard("a");
    expect(useArContextStore.getState().isOpen("a")).toBe(false);
  });

  it("caps openCards at 3 by evicting the oldest", () => {
    const t = useArContextStore.getState().toggleCard;
    t("a");
    t("b");
    t("c");
    t("d");
    const ids = useArContextStore.getState().openCards.map((c) => c.nodeId);
    expect(ids).toEqual(["b", "c", "d"]);
  });

  it("closeAll clears the stack", () => {
    const t = useArContextStore.getState().toggleCard;
    t("a");
    t("b");
    useArContextStore.getState().closeAll();
    expect(useArContextStore.getState().openCards).toHaveLength(0);
  });

  it("closeCard removes only the specified id", () => {
    const t = useArContextStore.getState().toggleCard;
    t("a");
    t("b");
    useArContextStore.getState().closeCard("a");
    const ids = useArContextStore.getState().openCards.map((c) => c.nodeId);
    expect(ids).toEqual(["b"]);
  });
});
