/**
 * Convert getUserMedia errors into user-actionable messages. Browsers
 * use a small set of DOMException names (NotAllowedError, NotFoundError,
 * AbortError, NotReadableError, OverconstrainedError, SecurityError) —
 * each maps to a specific user fix.
 */
export function describeCameraError(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      return "Camera blocked. Click the camera icon in the address bar (or open Safari Settings → Websites → Camera) and allow access for this site, then click Retry Camera.";
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      return "No camera detected. Plug one in or check System Settings → Privacy → Camera.";
    }
    if (name === "NotReadableError" || name === "TrackStartError") {
      return "Camera is busy — another app (Zoom, FaceTime, browser tab) is using it. Close that and click Retry Camera.";
    }
    if (name === "AbortError") {
      return "Camera request was aborted (often by reloading mid-prompt or denying once). Click Retry Camera.";
    }
    if (name === "OverconstrainedError") {
      return "Camera doesn't support the requested resolution. We'll relax constraints — click Retry Camera.";
    }
    if (name === "SecurityError") {
      return "Browser blocked camera over an insecure origin. Use https:// or localhost.";
    }
    if (err.message) return err.message;
  }
  return "Camera failed to start — open the browser console for details.";
}

export interface CameraInfo {
  deviceId: string;
  label: string;
  kind: "builtin" | "external" | "continuity" | "unknown";
}

const LS_PREFERRED_CAMERA = "mindmap-ar-camera-id";

/**
 * Classify a camera by label heuristics so we can default to the built-in
 * webcam (FaceTime HD / "Built-in") and de-prioritize iPhone Continuity
 * Camera (which macOS often selects by default and is rarely what the
 * user wants for AR).
 */
function classifyCamera(label: string): CameraInfo["kind"] {
  const l = label.toLowerCase();
  if (l.includes("iphone") || l.includes("continuity")) return "continuity";
  if (l.includes("facetime") || l.includes("built-in") || l.includes("integrated"))
    return "builtin";
  if (l.includes("usb") || l.includes("external") || l.includes("logitech"))
    return "external";
  return "unknown";
}

/**
 * Sort cameras so the most-likely-correct one is first:
 *   builtin > external > unknown > continuity
 */
function sortCameras(cams: CameraInfo[]): CameraInfo[] {
  const rank: Record<CameraInfo["kind"], number> = {
    builtin: 0,
    external: 1,
    unknown: 2,
    continuity: 3,
  };
  return [...cams].sort((a, b) => rank[a.kind] - rank[b.kind]);
}

/**
 * Enumerate available video-input devices. Labels are only populated
 * AFTER the user has granted camera permission at least once — so call
 * this only after a successful startWebcam.
 */
export async function listCameras(): Promise<CameraInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cams = devices
    .filter((d) => d.kind === "videoinput")
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label || "Camera",
      kind: classifyCamera(d.label),
    }));
  return sortCameras(cams);
}

export function getPreferredCameraId(): string | null {
  try {
    return localStorage.getItem(LS_PREFERRED_CAMERA);
  } catch {
    return null;
  }
}

export function setPreferredCameraId(deviceId: string | null): void {
  try {
    if (deviceId) localStorage.setItem(LS_PREFERRED_CAMERA, deviceId);
    else localStorage.removeItem(LS_PREFERRED_CAMERA);
  } catch {
    // ignore quota / private-mode errors
  }
}

/**
 * Pick the camera most likely to be the user's intent, given a list of
 * available cameras and an optional saved preference.
 *
 * Priority:
 *   1. Saved preference, if it still exists in the list.
 *   2. First builtin / external (NOT Continuity).
 *   3. First entry, whatever it is.
 */
export function pickCamera(
  cams: CameraInfo[],
  preferredId: string | null,
): CameraInfo | null {
  if (cams.length === 0) return null;
  if (preferredId) {
    const saved = cams.find((c) => c.deviceId === preferredId);
    if (saved) return saved;
  }
  const sorted = sortCameras(cams);
  const nonContinuity = sorted.find((c) => c.kind !== "continuity");
  return nonContinuity ?? sorted[0]!;
}

export async function startWebcam(
  video: HTMLVideoElement,
  deviceId?: string | null,
): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia not supported in this browser");
  }
  // If we have a specific device, request it exactly. Otherwise hint
  // facingMode and let the browser pick — we'll re-pick once labels
  // are visible after the first grant.
  // Resolution: request 1080p ideal (FaceTime HD supports it natively
  // on modern Macs); browser falls back to whatever the device offers.
  // Higher framerate helps gesture latency.
  const videoConstraints: MediaTrackConstraints = deviceId
    ? {
        deviceId: { exact: deviceId },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 },
      }
    : {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 60 },
        facingMode: "user",
      };
  const stream = await navigator.mediaDevices.getUserMedia({
    video: videoConstraints,
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return stream;
}

export function stopWebcam(stream: MediaStream | null, video: HTMLVideoElement): void {
  stream?.getTracks().forEach((t) => t.stop());
  video.srcObject = null;
}
