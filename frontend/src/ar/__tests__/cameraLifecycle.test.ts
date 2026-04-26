// Unit tests for describeCameraError — the user-facing translator from
// raw DOMException-style errors to actionable advice.

import { describe, it, expect } from "vitest";
import { describeCameraError } from "@/ar/cameraLifecycle";

const mkErr = (name: string, message = ""): Error => {
  const err = new Error(message);
  err.name = name;
  return err;
};

describe("describeCameraError", () => {
  it("maps NotAllowedError to a Safari-Settings actionable hint", () => {
    const out = describeCameraError(mkErr("NotAllowedError"));
    expect(out).toMatch(/blocked/i);
    expect(out).toMatch(/Settings|address bar/i);
    expect(out).toMatch(/Retry/i);
  });

  it("maps AbortError to a 'click retry' message (the 'session was aborted' case)", () => {
    const out = describeCameraError(mkErr("AbortError"));
    expect(out).toMatch(/aborted/i);
    expect(out).toMatch(/Retry Camera/i);
  });

  it("maps NotFoundError to a no-camera message with a system-settings hint", () => {
    const out = describeCameraError(mkErr("NotFoundError"));
    expect(out).toMatch(/No camera/i);
    expect(out).toMatch(/System Settings|Privacy/i);
  });

  it("maps NotReadableError to a busy-camera message", () => {
    const out = describeCameraError(mkErr("NotReadableError"));
    expect(out).toMatch(/busy|another app|Zoom|FaceTime/i);
  });

  it("maps OverconstrainedError to a relaxing-constraints message", () => {
    const out = describeCameraError(mkErr("OverconstrainedError"));
    expect(out).toMatch(/resolution|relax/i);
  });

  it("maps SecurityError to an https/localhost hint", () => {
    const out = describeCameraError(mkErr("SecurityError"));
    expect(out).toMatch(/https|localhost/i);
  });

  it("falls through to the raw error message for unknown error names", () => {
    const out = describeCameraError(mkErr("WeirdNewError", "the weird message"));
    expect(out).toBe("the weird message");
  });

  it("returns a generic message when the input isn't an Error instance", () => {
    const out = describeCameraError("just a string");
    expect(out).toMatch(/console/i);
  });
});
