// Behavioral tests for the new "3D" toolbar button added in the AR feature.
// Verifies the gating contract (disabled while mic is live OR no session),
// and the navigate-on-click behavior. Renders TopBar inside MemoryRouter so
// useNavigate works without a full BrowserRouter.

import { describe, it, expect, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TopBar } from "../src/components/TopBar";
import { useSessionStore } from "../src/state/sessionStore";
import { useGraphStore } from "../src/state/graphStore";

const renderTopBar = () =>
  render(
    <MemoryRouter initialEntries={["/"]}>
      <TopBar />
    </MemoryRouter>,
  );

describe("TopBar 3D button gating", () => {
  beforeEach(() => {
    // Hard-reset stores so each test sees a deterministic baseline.
    act(() => {
      useSessionStore.setState({
        currentSessionId: null,
        currentSessionName: "",
        micActive: false,
      });
      useGraphStore.setState({ activatedNodeIds: new Set() });
    });
  });

  it("disables the 3D button when there is no session id", () => {
    act(() => {
      useSessionStore.setState({ currentSessionId: null, micActive: false });
    });
    renderTopBar();
    const btn = screen.getByRole("button", { name: /open 3d ar view/i });
    expect(btn).toBeDisabled();
  });

  it("ENABLES the 3D button while the mic is live (live AR — orbs appear as you talk)", () => {
    act(() => {
      useSessionStore.setState({
        currentSessionId: "session-abc",
        micActive: true,
      });
    });
    renderTopBar();
    const btn = screen.getByRole("button", { name: /open 3d ar view/i });
    expect(btn).not.toBeDisabled();
    expect(btn.getAttribute("title") ?? "").toMatch(/live/i);
  });

  it("enables the 3D button when session exists and mic is off", () => {
    act(() => {
      useSessionStore.setState({
        currentSessionId: "session-abc",
        micActive: false,
      });
    });
    renderTopBar();
    const btn = screen.getByRole("button", { name: /open 3d ar view/i });
    expect(btn).not.toBeDisabled();
    expect(btn.getAttribute("title") ?? "").toMatch(/3d \/ ar view/i);
  });
});
