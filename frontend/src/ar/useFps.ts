import { useEffect, useRef, useState } from "react";

export function useFps(): { fps: number; tick: (latencyMs: number) => void; latency: number } {
  const [fps, setFps] = useState(0);
  const [latency, setLatency] = useState(0);
  const lastTimeRef = useRef<number>(0);
  const framesRef = useRef(0);
  const lastLatencyRef = useRef(0);

  useEffect(() => {
    lastTimeRef.current = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = now - lastTimeRef.current;
      setFps(Math.round((framesRef.current * 1000) / dt));
      setLatency(lastLatencyRef.current);
      framesRef.current = 0;
      lastTimeRef.current = now;
    }, 500);
    return () => clearInterval(id);
  }, []);

  const tick = (latencyMs: number) => {
    framesRef.current++;
    lastLatencyRef.current = latencyMs;
  };

  return { fps, tick, latency };
}
