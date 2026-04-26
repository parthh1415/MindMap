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

export async function startWebcam(video: HTMLVideoElement): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("getUserMedia not supported in this browser");
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" },
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
