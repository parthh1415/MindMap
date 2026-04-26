import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { LiveSoundwave } from "../src/components/LiveSoundwave";
import { useSessionStore } from "../src/state/sessionStore";

beforeEach(() => {
  useSessionStore.setState({ micActive: false });
  // jsdom doesn't ship AudioContext; we stub it with a no-op so the
  // component's setup() doesn't throw if it tries to construct one.
  // The component swallows audio errors and still renders the chrome.
  (window as unknown as { AudioContext?: unknown }).AudioContext = vi
    .fn()
    .mockImplementation(() => ({
      state: "running",
      resume: vi.fn().mockResolvedValue(undefined),
      createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
      createAnalyser: vi.fn(() => ({
        fftSize: 128,
        smoothingTimeConstant: 0.78,
        frequencyBinCount: 64,
        getByteFrequencyData: vi.fn(),
        connect: vi.fn(),
        disconnect: vi.fn(),
      })),
      close: vi.fn().mockResolvedValue(undefined),
    }));
  // jsdom getUserMedia stub.
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
      }),
    },
  });
});

afterEach(() => {
  cleanup();
});

describe("LiveSoundwave", () => {
  it("renders nothing when mic is off", () => {
    const { container } = render(<LiveSoundwave />);
    expect(container.querySelector(".live-soundwave")).toBeNull();
  });

  it("mounts the listening chrome when micActive flips on", () => {
    useSessionStore.setState({ micActive: true });
    const { container } = render(<LiveSoundwave />);
    expect(container.querySelector(".live-soundwave")).not.toBeNull();
  });

  it("unmounts the chrome when micActive flips off", () => {
    useSessionStore.setState({ micActive: true });
    const { container, rerender } = render(<LiveSoundwave />);
    expect(container.querySelector(".live-soundwave")).not.toBeNull();
    useSessionStore.setState({ micActive: false });
    rerender(<LiveSoundwave />);
    expect(container.querySelector(".live-soundwave")).toBeNull();
  });

  it("exposes itself to assistive tech with role=status + aria-live", () => {
    useSessionStore.setState({ micActive: true });
    const { container } = render(<LiveSoundwave />);
    const el = container.querySelector(".live-soundwave") as HTMLElement;
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.getAttribute("aria-label")).toBe("Listening to microphone");
  });
});
