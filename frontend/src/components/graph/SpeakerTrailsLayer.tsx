import { useMemo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useViewport } from "reactflow";
import { useGraphStore } from "@/state/graphStore";
import { useSpeakerTrails, interpolatePolyline } from "@/lib/speakerTrail";

type Props = {
  positions: Map<string, { x: number; y: number }>;
};

/**
 * Build an SVG `points` attribute string from a list of {x,y}.
 */
function toPointsAttr(coords: { x: number; y: number }[]): string {
  return coords.map((c) => `${c.x},${c.y}`).join(" ");
}

/**
 * Hash a string to a hex pair (00-ff). Used to derive a deterministic
 * alpha-suffixed color for the drop-shadow when speaker color is a CSS
 * var (we can't compose `<var> + alpha` in a filter safely).
 *
 * NOTE: filter drop-shadow does support color tokens at runtime (the
 * browser resolves CSS vars), so we use the raw color string.
 */

/**
 * SVG overlay rendering one polyline per speaker connecting their last
 * 2-3 "touched" entities. Reads positions from the live force
 * simulation (do NOT spawn a new one here). Coords align with
 * reactflow's viewport via `useViewport()`.
 *
 * Visual design:
 *   stroke = speaker color, width 1.2, no dash
 *   opacity 0.35 (or 0.55 for active speaker)
 *   pathLength 0→1 spring on first appearance
 *   soft drop-shadow in speaker's hue for gentle glow
 */
export function SpeakerTrailsLayer({ positions }: Props) {
  const reduce = useReducedMotion();
  const { x, y, zoom } = useViewport();
  const trails = useSpeakerTrails();
  const speakerColors = useGraphStore((s) => s.speakerColors);
  const activeSpeakerId = useGraphStore((s) => s.activeSpeakerId);

  const polylines = useMemo(() => {
    const out: Array<{
      speakerId: string;
      points: string;
      color: string;
      isActive: boolean;
    }> = [];
    for (const [speakerId, points] of Object.entries(trails)) {
      if (points.length < 2) continue;
      const coords = interpolatePolyline(points, positions);
      if (coords.length < 2) continue;
      const color = speakerColors[speakerId] || "var(--text-tertiary)";
      out.push({
        speakerId,
        points: toPointsAttr(coords),
        color,
        isActive: speakerId === activeSpeakerId,
      });
    }
    return out;
  }, [trails, positions, speakerColors, activeSpeakerId]);

  return (
    <svg
      className="speaker-trails-layer"
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        overflow: "visible",
        zIndex: 3,
      }}
    >
      <g transform={`translate(${x} ${y}) scale(${zoom})`}>
        {polylines.map(({ speakerId, points, color, isActive }) => (
          <motion.polyline
            key={speakerId}
            points={points}
            stroke={color}
            strokeWidth={1.2}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              filter: `drop-shadow(0 0 4px ${color})`,
              opacity: isActive ? 0.55 : 0.35,
            }}
            initial={
              reduce ? { pathLength: 1 } : { pathLength: 0 }
            }
            animate={{ pathLength: 1 }}
            transition={
              reduce
                ? { duration: 0 }
                : { type: "spring", stiffness: 120, damping: 20 }
            }
          />
        ))}
      </g>
    </svg>
  );
}

export default SpeakerTrailsLayer;
