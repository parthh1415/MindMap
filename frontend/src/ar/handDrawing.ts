import type { TrackedHand } from "./types";

const SKELETON: [number, number][] = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],
  [0,17],
];

const ROLE_COLOR: Record<string, string> = {
  control: "#d6ff3a",  // volt yellow (matches MindMap brand)
  pointer: "#7cd1ff",
  null:    "#888",
};

export function drawHands(
  ctx: CanvasRenderingContext2D,
  tracks: TrackedHand[],
  width: number,
  height: number,
): void {
  ctx.clearRect(0, 0, width, height);
  for (const t of tracks) {
    const color = ROLE_COLOR[t.role ?? "null"] ?? "#888";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.5;

    // Skeleton
    ctx.beginPath();
    for (const [a, b] of SKELETON) {
      const p = t.smoothed[a]!, q = t.smoothed[b]!;
      ctx.moveTo(p.x, p.y); ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();

    // Landmarks
    for (const p of t.smoothed) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Role label near wrist
    const w = t.smoothed[0]!;
    ctx.font = "12px ui-sans-serif, system-ui, -apple-system";
    ctx.fillStyle = color;
    ctx.fillText(`${t.role ?? "?"} ${t.isPinched ? "✊" : ""}`, w.x + 8, w.y - 6);
  }
}
