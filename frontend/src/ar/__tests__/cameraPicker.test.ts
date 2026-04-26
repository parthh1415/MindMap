// Unit tests for the camera picker — locks in the heuristic that
// macOS users with iPhone Continuity Camera default to their built-in
// FaceTime webcam instead of their phone (the macOS default which is
// almost never what users want for AR).

import { describe, it, expect } from "vitest";
import { pickCamera, type CameraInfo } from "@/ar/cameraLifecycle";

const mk = (label: string, deviceId = label.replace(/\s+/g, "-")): CameraInfo => {
  const l = label.toLowerCase();
  let kind: CameraInfo["kind"] = "unknown";
  if (l.includes("iphone") || l.includes("continuity")) kind = "continuity";
  else if (l.includes("facetime") || l.includes("built-in") || l.includes("integrated"))
    kind = "builtin";
  else if (l.includes("usb") || l.includes("external") || l.includes("logitech"))
    kind = "external";
  return { deviceId, label, kind };
};

describe("pickCamera", () => {
  it("returns null on empty list", () => {
    expect(pickCamera([], null)).toBeNull();
  });

  it("returns the saved preference if it still exists", () => {
    const cams = [mk("FaceTime HD"), mk("Logitech USB")];
    expect(pickCamera(cams, cams[1]!.deviceId)?.label).toBe("Logitech USB");
  });

  it("falls through saved preference if it's no longer plugged in", () => {
    const cams = [mk("FaceTime HD"), mk("Logitech USB")];
    expect(pickCamera(cams, "vanished-device-id")?.label).toBe("FaceTime HD");
  });

  it("prefers built-in (FaceTime) over Continuity Camera (iPhone)", () => {
    const cams = [mk("Charlie's iPhone Camera"), mk("FaceTime HD Camera")];
    expect(pickCamera(cams, null)?.kind).toBe("builtin");
  });

  it("prefers external USB over Continuity Camera", () => {
    const cams = [mk("iPhone (Continuity Camera)"), mk("Logitech USB Webcam")];
    expect(pickCamera(cams, null)?.kind).toBe("external");
  });

  it("only returns Continuity if there's nothing else", () => {
    const cams = [mk("Charlie's iPhone")];
    expect(pickCamera(cams, null)?.kind).toBe("continuity");
  });

  it("classifies 'Built-in' as builtin", () => {
    const cams = [mk("Built-in Camera")];
    expect(cams[0]!.kind).toBe("builtin");
  });

  it("classifies 'Integrated' as builtin", () => {
    const cams = [mk("Integrated Webcam")];
    expect(cams[0]!.kind).toBe("builtin");
  });

  it("falls back to first entry if all are 'unknown' kind", () => {
    const a = mk("Generic Cam A");
    const b = mk("Generic Cam B");
    expect(pickCamera([a, b], null)?.deviceId).toBe(a.deviceId);
  });
});
