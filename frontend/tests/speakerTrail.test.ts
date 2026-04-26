import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useGraphStore } from "../src/state/graphStore";
import {
  useTrailDecayer,
  pruneSpeakerTrails,
  interpolatePolyline,
} from "../src/lib/speakerTrail";

describe("speakerTrail helpers", () => {
  beforeEach(() => useGraphStore.getState().resetGraph());

  it("pushSpeakerTrail dedupes consecutive same-entity calls", () => {
    const { pushSpeakerTrail } = useGraphStore.getState();
    pushSpeakerTrail("s1", "n1");
    pushSpeakerTrail("s1", "n1"); // dup, should be ignored
    pushSpeakerTrail("s1", "n2");
    pushSpeakerTrail("s1", "n2"); // dup
    pushSpeakerTrail("s1", "n3");

    const points = useGraphStore.getState().speakerTrails["s1"];
    expect(points.map((p) => p.entity_id)).toEqual(["n3", "n2", "n1"]);
  });

  it("pushSpeakerTrail caps at 4 points per speaker", () => {
    const { pushSpeakerTrail } = useGraphStore.getState();
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      pushSpeakerTrail("s1", id);
    }
    const points = useGraphStore.getState().speakerTrails["s1"];
    expect(points.length).toBe(4);
    // Most recent first.
    expect(points[0].entity_id).toBe("f");
  });

  it("pruneSpeakerTrails drops old points", () => {
    const trails = {
      s1: [
        { entity_id: "young", speaker_id: "s1", ts: 9_000 },
        { entity_id: "old", speaker_id: "s1", ts: 1_000 },
      ],
    };
    const next = pruneSpeakerTrails(trails, 10_000, 5_000);
    expect(next).not.toBe(trails);
    expect(next["s1"].map((p) => p.entity_id)).toEqual(["young"]);
  });

  it("pruneSpeakerTrails returns same reference when nothing changes", () => {
    const trails = {
      s1: [{ entity_id: "young", speaker_id: "s1", ts: 9_000 }],
    };
    const next = pruneSpeakerTrails(trails, 10_000, 5_000);
    expect(next).toBe(trails);
  });

  it("pruneSpeakerTrails removes empty speaker entries", () => {
    const trails = {
      s1: [{ entity_id: "old", speaker_id: "s1", ts: 1_000 }],
    };
    const next = pruneSpeakerTrails(trails, 10_000, 5_000);
    expect(next["s1"]).toBeUndefined();
  });

  it("interpolatePolyline skips entities with no position", () => {
    const points = [
      { entity_id: "a", speaker_id: "s1", ts: 1 },
      { entity_id: "ghost", speaker_id: "s1", ts: 2 },
      { entity_id: "b", speaker_id: "s1", ts: 3 },
    ];
    const positions = new Map<string, { x: number; y: number }>([
      ["a", { x: 1, y: 2 }],
      ["b", { x: 3, y: 4 }],
    ]);
    expect(interpolatePolyline(points, positions)).toEqual([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });
});

describe("useTrailDecayer", () => {
  beforeEach(() => {
    useGraphStore.getState().resetGraph();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("prunes trail points older than maxAgeMs", () => {
    // Hand-craft trails with stale ts.
    const now = Date.now();
    useGraphStore.setState({
      speakerTrails: {
        s1: [
          { entity_id: "fresh", speaker_id: "s1", ts: now },
          { entity_id: "stale", speaker_id: "s1", ts: now - 20_000 },
        ],
      },
    });

    const { unmount } = renderHook(() => useTrailDecayer(5_000));
    vi.advanceTimersByTime(1_500);

    const trail = useGraphStore.getState().speakerTrails["s1"];
    expect(trail.map((p) => p.entity_id)).toEqual(["fresh"]);
    unmount();
  });
});
