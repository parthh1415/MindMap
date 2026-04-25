// usePivotPoller
//
// Polls GET /sessions/{sid}/pivot-suggestions every 30 seconds while the
// mic is active and a session exists. Pushes results into branchStore.
// Skips while another request is in-flight or while branchStore.isProcessing
// is true (best-effort coordination with the topology pipeline so we don't
// hammer the LLM during ghost storms).
//
// Cancel-safe via AbortController on unmount.

import { useEffect, useRef } from "react";
import {
  useBranchStore,
  type PivotPoint,
} from "@/state/branchStore";

const POLL_INTERVAL_MS = 30_000;

export interface UsePivotPollerArgs {
  sessionId: string | null;
  enabled: boolean;
  /** Test seam: override fetch */
  fetcher?: typeof fetch;
}

function backendUrl(): string {
  const base =
    (import.meta.env?.VITE_BACKEND_URL as string | undefined) ??
    "http://localhost:8000";
  return base.replace(/\/$/, "");
}

interface PivotSuggestionsResponse {
  session_id: string;
  pivots: PivotPoint[];
  cached?: boolean;
  generated_at?: string;
}

export function usePivotPoller({
  sessionId,
  enabled,
  fetcher,
}: UsePivotPollerArgs): void {
  const inflightRef = useRef<AbortController | null>(null);
  const setPivots = useBranchStore((s) => s.setPivots);
  const setLastPolledAt = useBranchStore((s) => s.setLastPolledAt);

  useEffect(() => {
    if (!enabled || !sessionId) return;

    const f = fetcher ?? fetch;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      // Skip if topology pipeline is busy (best-effort).
      if (useBranchStore.getState().isProcessing) {
        scheduleNext();
        return;
      }
      // Skip if a previous request is still inflight.
      if (inflightRef.current) {
        scheduleNext();
        return;
      }
      const ac = new AbortController();
      inflightRef.current = ac;
      try {
        const url = `${backendUrl()}/sessions/${sessionId}/pivot-suggestions`;
        const res = await f(url, { signal: ac.signal });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const body = (await res.json()) as PivotSuggestionsResponse;
        if (cancelled) return;
        setPivots(body.pivots ?? []);
        setLastPolledAt(Date.now());
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        // Pivots are advisory — log and move on.
        // eslint-disable-next-line no-console
        console.warn("[pivotPoller] fetch failed", err);
      } finally {
        if (inflightRef.current === ac) inflightRef.current = null;
        scheduleNext();
      }
    };

    const scheduleNext = () => {
      if (cancelled) return;
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    // Fire one poll right away so the user sees pivots quickly after enabling.
    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      inflightRef.current?.abort();
      inflightRef.current = null;
    };
  }, [enabled, sessionId, fetcher, setPivots, setLastPolledAt]);
}

export const PIVOT_POLL_INTERVAL_MS = POLL_INTERVAL_MS;
