import { useNavigate } from "react-router-dom";
import { Suspense, lazy } from "react";

// Lazy-load the heavy ARStage so three/tfjs/mediapipe don't end up in
// the main bundle.
const ARStage = lazy(() => import("./ARStage"));

export default function ARRoute() {
  const navigate = useNavigate();
  const onExit = () => navigate("/");

  return (
    <Suspense fallback={<div style={{ padding: 24, color: "#d6ff3a" }}>loading AR…</div>}>
      <ARStage onExit={onExit} />
    </Suspense>
  );
}
