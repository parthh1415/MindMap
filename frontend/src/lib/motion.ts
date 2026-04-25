// Centralized motion tokens — all components import from here so the rhythm
// is unified per the SKILL.md guidance.

import type { Transition } from "framer-motion";

// Stiff spring for entrances (mount, ghost→solid).
export const springEntrance: Transition = {
  type: "spring",
  stiffness: 260,
  damping: 22,
  mass: 0.9,
};

// Slower spring for layout transitions and tween-betweens.
export const springLayout: Transition = {
  type: "spring",
  stiffness: 140,
  damping: 18,
  mass: 1,
};

// Subtle spring for hover/press feedback.
export const springTap: Transition = {
  type: "spring",
  stiffness: 380,
  damping: 28,
};

// Edge draw-in is a tween (not a spring) because pathLength wants a curve.
export const tweenEdgeDraw: Transition = {
  type: "tween",
  duration: 0.4,
  ease: [0.22, 1, 0.36, 1], // ease-out-quint
};

// Cinematic ~1s spring for the branching animation.
export const springBranch: Transition = {
  type: "spring",
  stiffness: 90,
  damping: 16,
  mass: 1.2,
};

// Stagger helper.
export function staggerChildren(delay = 0.04): Transition {
  return { staggerChildren: delay };
}
