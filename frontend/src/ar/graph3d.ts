import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
} from "d3-force-3d";
import type { Vec3 } from "./types";
import { TARGET_GRAPH_RADIUS, FORCE_SIM_ITERATIONS } from "./tunables";

interface SimNode { id: string; x?: number; y?: number; z?: number; }
interface SimLink { source: string; target: string; }

export interface LayoutInput {
  _id: string;
  label: string;
  /** 0..1 — bigger = more important = larger orb. Defaults to 0.5
   *  if not provided. ROOT topics live at 0.9-1.0, BRANCH at 0.55-0.8,
   *  LEAF at 0.25-0.5. */
  importance?: number;
}

export interface LayoutEdge {
  source_id: string;
  target_id: string;
}

export function computeLayout(
  nodes: LayoutInput[],
  edges: LayoutEdge[],
): Record<string, Vec3> {
  if (nodes.length === 0) return {};
  const simNodes: SimNode[] = nodes.map((n) => ({ id: n._id }));
  const simLinks: SimLink[] = edges.map((e) => ({
    source: e.source_id, target: e.target_id,
  }));

  const sim = forceSimulation(simNodes, 3)
    .force("charge", forceManyBody().strength(-30))
    .force("link", forceLink(simLinks).id((d) => (d as SimNode).id).distance(1.0))
    .force("center", forceCenter(0, 0, 0))
    .stop();

  for (let i = 0; i < FORCE_SIM_ITERATIONS; i++) sim.tick();

  // Center
  let cx = 0, cy = 0, cz = 0;
  for (const n of simNodes) { cx += n.x ?? 0; cy += n.y ?? 0; cz += n.z ?? 0; }
  cx /= simNodes.length; cy /= simNodes.length; cz /= simNodes.length;

  // Find max radius after centering
  let maxR = 0;
  for (const n of simNodes) {
    const x = (n.x ?? 0) - cx, y = (n.y ?? 0) - cy, z = (n.z ?? 0) - cz;
    const r = Math.hypot(x, y, z);
    if (r > maxR) maxR = r;
  }
  const scale = maxR > 0 ? TARGET_GRAPH_RADIUS / maxR : 1;

  const out: Record<string, Vec3> = {};
  for (const n of simNodes) {
    out[n.id] = {
      x: ((n.x ?? 0) - cx) * scale,
      y: ((n.y ?? 0) - cy) * scale,
      z: ((n.z ?? 0) - cz) * scale,
    };
  }
  return out;
}

import * as THREE from "three";

export interface SceneRefs {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  graphRoot: THREE.Group;
  // Each "orb" is a billboarded Sprite — tiny bright center + soft
  // radial halo via a shared white-gradient texture, color-tinted per
  // state. The Map key is node._id; we keep a Mesh-typed alias for
  // compatibility with the existing pointer-pick code (Sprite extends
  // Object3D, but ARStage's projectNodeToScreen expects Mesh — we use
  // a tiny invisible Mesh as the pickable proxy at the same position).
  nodeMeshes: Map<string, THREE.Mesh>;
  orbSprites: Map<string, THREE.Sprite>;
  labelSprites: Map<string, THREE.Sprite>;
  edgeLines: THREE.LineSegments;
  edgeLineGeom: THREE.BufferGeometry;
  edgeLineMat: THREE.LineBasicMaterial;
  orbTexture: THREE.CanvasTexture;
}

// Visual feel — orbs scale by importance. ROOT topics (importance ~1.0)
// render as fat luminous spheres with the topic name inside; LEAF
// nodes (importance ~0.3) render as small dots with tight labels.
//
// Linear interpolation between MIN and MAX based on importance.
const ORB_SCALE_MIN = 0.18;       // leaves (importance 0.0)
const ORB_SCALE_MAX = 0.55;       // roots (importance 1.0)
const PICK_RADIUS_MIN = 0.05;     // invisible pick mesh — used for getWorldPosition only

function orbScaleFor(importance: number): number {
  const t = Math.max(0, Math.min(1, importance));
  return ORB_SCALE_MIN + (ORB_SCALE_MAX - ORB_SCALE_MIN) * t;
}
const COLOR_NODE_BASE = 0x6ec1ff;      // cyan-white star
const COLOR_NODE_HOVER = 0xffae3d;     // warm amber
const COLOR_NODE_ACTIVE = 0xd6ff3a;    // volt yellow (brand)
// Thin white lines connecting orbs — bumped opacity so they actually
// read against the dimmed camera feed.
const COLOR_EDGE = 0xffffff;
const EDGE_OPACITY = 0.7;

// Spring-physics constants for the bloom-from-center entry animation.
// Stiffness pulls toward target; damping bleeds energy out of velocity.
// Tuned for ~1.2s settle with one tiny overshoot.
const SPRING_STIFFNESS = 0.06;
const SPRING_DAMPING = 0.82;
const SETTLE_EPSILON = 0.0008;     // distance² below which we snap + stop animating

// Ambient edges: every orb auto-connects to its K spatially-closest
// neighbors so the constellation reads as a luminous mesh, even when
// the topology agent has emitted few explicit edges. Pure visual layer
// — these are not stored in the graph data, just drawn.
const KNN_AMBIENT = 5;

// ── Label visibility (combined importance-tier + camera-distance fade) ──
//
// The 3D constellation gets dense fast; root + branch + leaf labels
// stacked together render as illegible word-soup (the cluster the user
// screenshotted). To keep the AR view readable, each label's target
// opacity is computed per-frame from two signals:
//
//   1. Importance tier sets the BASE distance at which the label fades.
//      Roots stay legible from far away; leaves only appear when the
//      camera is close enough that the orb is genuinely in focus.
//   2. Camera distance to the orb itself drives a soft fade across a
//      ~1.5-unit band — no popping, just a graceful resolve.
//
// Thresholds are "show distance" (full opacity at this camera-Z to orb
// distance or closer) and "fade distance" (zero opacity beyond this).
// Anything between linearly interpolates.
const LABEL_TIER_ROOT_SHOW = 12.0;   // roots ≥ 0.75 importance — almost always on
const LABEL_TIER_ROOT_FADE = 14.0;
const LABEL_TIER_BRANCH_SHOW = 5.5;  // branches 0.4..0.75
const LABEL_TIER_BRANCH_FADE = 8.0;
const LABEL_TIER_LEAF_SHOW = 3.0;    // leaves < 0.4 — only when zoomed in
const LABEL_TIER_LEAF_FADE = 5.0;
// Smoothing factor applied per frame. 0.12 ≈ ~6-frame half-life at 60
// fps; keeps fade pleasant without lagging the camera so far that the
// label visibility feels disconnected from where you're looking.
const LABEL_OPACITY_SMOOTHING = 0.12;

// Per-orb animation state stored on userData. Position is ABSOLUTE world.
interface OrbAnimState {
  target: THREE.Vector3;     // where the force layout wants this orb
  current: THREE.Vector3;    // where it actually is right now
  velocity: THREE.Vector3;   // spring velocity
  settled: boolean;
}

/**
 * Build a SHARED grayscale radial-gradient texture used as the orb's
 * halo. White → transparent so SpriteMaterial.color can tint it any
 * shade per node. AdditiveBlending makes overlapping halos accumulate
 * naturally — like stars in a constellation.
 */
function makeOrbTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  // Bright opaque core (the "dot") then soft falloff to transparent.
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.08, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.85)");
  g.addColorStop(0.4, "rgba(255,255,255,0.35)");
  g.addColorStop(0.7, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/**
 * Render the topic name INSIDE the orb sprite. Auto-wraps at the canvas
 * width and shrinks the font as needed so root topics ("Cybersecurity")
 * read clearly while small leaves (a 10-word decision) still fit.
 *
 * The returned sprite is meant to be stacked on the same world position
 * as the orb halo; importance-driven scaling is applied by the caller.
 */
function makeLabelSprite(rawLabel: string): THREE.Sprite {
  // Canvas is square so text can wrap to multiple lines and stay
  // centered in the orb halo.
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d")!;

  // Strip any [TAG] prefix the topology agent may have added — it's
  // useful metadata for doc generation but visually busy on the orb.
  const label = rawLabel.replace(/^\[[A-Z]+\]\s*/, "");

  // Auto-fit: try a sequence of font sizes from large→small until
  // the wrapped text fits inside the canvas.
  const fontStack = "'Space Grotesk', system-ui, sans-serif";
  const sizes = [62, 54, 48, 42, 36, 30, 26, 22];
  const padding = 36;        // canvas padding around text block
  const lineHeightMul = 1.15;
  const maxBoxW = canvas.width - padding * 2;
  const maxBoxH = canvas.height - padding * 2;

  let chosenSize = sizes[sizes.length - 1]!;
  let chosenLines: string[] = [label];
  for (const size of sizes) {
    ctx.font = `600 ${size}px ${fontStack}`;
    const lines = wrapText(ctx, label, maxBoxW);
    const blockH = lines.length * size * lineHeightMul;
    if (blockH <= maxBoxH) {
      chosenSize = size;
      chosenLines = lines;
      break;
    }
  }

  ctx.font = `600 ${chosenSize}px ${fontStack}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = "#ffffff";

  const blockH = chosenLines.length * chosenSize * lineHeightMul;
  const cx = canvas.width / 2;
  const startY = canvas.height / 2 - blockH / 2 + (chosenSize * lineHeightMul) / 2;
  for (let i = 0; i < chosenLines.length; i++) {
    ctx.fillText(chosenLines[i]!, cx, startY + i * chosenSize * lineHeightMul);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false, // labels always on top of orbs/lines
  });
  const sprite = new THREE.Sprite(mat);
  // Square sprite — caller scales it to match the orb halo size so
  // text appears INSIDE the orb's footprint.
  sprite.scale.set(1, 1, 1);
  return sprite;
}

/**
 * For each node, find its K spatially-closest siblings and emit those
 * as additional edges. Deduped (A↔B counts once). Used to densify the
 * constellation so it reads as a connected mesh of white lines, not
 * scattered orbs with sparse explicit edges.
 *
 * Distance is squared-euclidean (cheap, monotonic — no sqrt needed).
 * O(N²) is fine for our N (typical sessions <200 nodes).
 */
function computeKnnEdges(
  nodes: LayoutInput[],
  positions: Record<string, Vec3>,
  k: number,
): LayoutEdge[] {
  if (k <= 0 || nodes.length < 2) return [];
  const out: LayoutEdge[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    const p = positions[n._id];
    if (!p) continue;
    const dists: { id: string; d: number }[] = [];
    for (const m of nodes) {
      if (m._id === n._id) continue;
      const q = positions[m._id];
      if (!q) continue;
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const dz = p.z - q.z;
      dists.push({ id: m._id, d: dx * dx + dy * dy + dz * dz });
    }
    dists.sort((a, b) => a.d - b.d);
    for (let i = 0; i < Math.min(k, dists.length); i++) {
      const target = dists[i]!.id;
      // Direction-agnostic dedupe: sort the pair before keying so A→B
      // and B→A collapse into one entry.
      const key =
        n._id < target ? `${n._id}|${target}` : `${target}|${n._id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source_id: n._id, target_id: target });
    }
  }
  return out;
}

/**
 * Greedy word-wrap to fit a line within maxWidth at the ctx's current
 * font setting. Returns one array of lines.
 */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? current + " " + word : word;
    if (ctx.measureText(next).width <= maxWidth) {
      current = next;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length === 0 ? [""] : lines;
}

export function buildScene(
  container: HTMLElement,
  nodes: LayoutInput[],
  edges: LayoutEdge[],
  positions: Record<string, Vec3>,
  /**
   * Cache of last-known absolute positions for nodes that existed in a
   * previous scene rebuild. Orbs whose id appears here START at that
   * position (no bloom). Orbs whose id is MISSING start at (0,0,0)
   * and bloom outward — that's how new orbs born mid-session arrive.
   * Pass an empty Map for the very first mount to make EVERY orb
   * bloom from center.
   */
  knownPositions?: Map<string, THREE.Vector3>,
): SceneRefs {
  const w = container.clientWidth, h = container.clientHeight;
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  renderer.setSize(w, h);
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // Sprites with AdditiveBlending don't need scene lights — they're
  // pure emissive billboards. Keep one ambient for any non-sprite
  // accents added later.
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));

  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
  camera.position.set(0, 0, 5);

  const graphRoot = new THREE.Group();
  scene.add(graphRoot);

  // Shared white-gradient texture for all orb halos.
  const orbTexture = makeOrbTexture();
  // Invisible pick-proxy geometry shared across all nodes — used only
  // by projectNodeToScreen for fingertip-pick distance math. The
  // actual radius doesn't matter since pick distance is screen-space.
  const pickGeom = new THREE.SphereGeometry(PICK_RADIUS_MIN, 8, 8);
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });

  const nodeMeshes = new Map<string, THREE.Mesh>();
  const orbSprites = new Map<string, THREE.Sprite>();
  const labelSprites = new Map<string, THREE.Sprite>();

  for (const n of nodes) {
    const p = positions[n._id];
    if (!p) continue;

    // Importance drives orb size — root topics are bigger, leaves
    // smaller. Defaults to 0.5 (mid-tier branch) if not provided.
    const importance = n.importance ?? 0.5;
    const orbScale = orbScaleFor(importance);

    // Determine starting position. If we knew this orb in a previous
    // rebuild, START WHERE IT WAS (no jarring jump). Otherwise (new
    // node mid-session, or first mount) start at the center and bloom.
    const target = new THREE.Vector3(p.x, p.y, p.z);
    const knownStart = knownPositions?.get(n._id);
    const startPos = knownStart
      ? knownStart.clone()
      : new THREE.Vector3(0, 0, 0);
    const settled =
      knownStart != null && knownStart.distanceToSquared(target) < SETTLE_EPSILON;

    const animState: OrbAnimState = {
      target,
      current: startPos.clone(),
      velocity: new THREE.Vector3(),
      settled,
    };

    // Glow orb: tinted billboard with additive blend → soft halo.
    // Per-orb baseScale stored on userData so hover/active state can
    // pop the orb back to a known-good size.
    const orbMat = new THREE.SpriteMaterial({
      map: orbTexture,
      color: COLOR_NODE_BASE,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const orb = new THREE.Sprite(orbMat);
    orb.position.copy(startPos);
    orb.scale.set(orbScale, orbScale, 1);
    orb.userData.nodeId = n._id;
    orb.userData.anim = animState;
    orb.userData.baseScale = orbScale;
    orb.renderOrder = 0;
    graphRoot.add(orb);
    orbSprites.set(n._id, orb);

    // Invisible pick-proxy mesh — moves with the orb.
    const pickMesh = new THREE.Mesh(pickGeom, pickMat);
    pickMesh.position.copy(startPos);
    pickMesh.userData.nodeId = n._id;
    graphRoot.add(pickMesh);
    nodeMeshes.set(n._id, pickMesh);

    // Topic label — STACKED ON the orb (centered), sized to fit
    // INSIDE the orb's halo. Caller updates position in lockstep
    // with the orb during bloom animation.
    const label = makeLabelSprite(n.label);
    label.position.copy(startPos);
    // Label sprite is square (1×1 normalized); scale to ~75% of the
    // orb's halo so text reads INSIDE the orb's bright zone.
    const labelScale = orbScale * 0.85;
    label.scale.set(labelScale, labelScale, 1);
    label.userData.nodeId = n._id;
    label.userData.baseScale = labelScale;
    label.userData.importance = importance;
    // Smoothed opacity used by updateLabelVisibility() — starts hidden
    // so the bloom-from-center entry doesn't show 30 pre-positioned
    // labels stacked at the origin.
    label.userData.opacityCurrent = 0;
    label.renderOrder = 2; // above edge lines (1)
    graphRoot.add(label);
    labelSprites.set(n._id, label);
  }

  // Edges: ONE LineSegments object. Geometry is initialized from
  // current (possibly mid-bloom) orb positions so lines start
  // wherever their endpoints actually are RIGHT NOW. The RAF loop
  // calls updateEdgePositions() each frame to keep the lines glued
  // to the orbs as they spring outward.
  //
  // Two sources of edges combine into one render:
  //   1. Explicit edges from the topology agent (what was actually
  //      asserted in the conversation).
  //   2. KNN ambient edges — every orb to its K closest neighbors —
  //      so the constellation reads as a luminous mesh, not scattered
  //      sparks. Deduped against (1) and against itself.
  const knnEdges = computeKnnEdges(nodes, positions, KNN_AMBIENT);
  const edgeLineGeom = new THREE.BufferGeometry();
  const edgePairs: [string, string][] = [];
  const edgeVertices: number[] = [];
  const seenEdgeKeys = new Set<string>();
  const pushEdge = (sourceId: string, targetId: string) => {
    const key = sourceId < targetId
      ? `${sourceId}|${targetId}`
      : `${targetId}|${sourceId}`;
    if (seenEdgeKeys.has(key)) return;
    const a = orbSprites.get(sourceId);
    const b = orbSprites.get(targetId);
    if (!a || !b) return;
    seenEdgeKeys.add(key);
    edgePairs.push([sourceId, targetId]);
    edgeVertices.push(
      a.position.x, a.position.y, a.position.z,
      b.position.x, b.position.y, b.position.z,
    );
  };
  for (const e of edges) pushEdge(e.source_id, e.target_id);
  for (const e of knnEdges) pushEdge(e.source_id, e.target_id);
  edgeLineGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(edgeVertices, 3),
  );
  const edgeLineMat = new THREE.LineBasicMaterial({
    color: COLOR_EDGE,
    transparent: true,
    opacity: EDGE_OPACITY,
    // Force lines to render ON TOP of additive-blended orbs so they
    // actually read against bright clusters.
    depthTest: false,
    depthWrite: false,
  });
  const edgeLines = new THREE.LineSegments(edgeLineGeom, edgeLineMat);
  edgeLines.renderOrder = 1; // draw after orbs (which default to 0)
  edgeLines.userData.pairs = edgePairs;
  graphRoot.add(edgeLines);

  return {
    scene,
    camera,
    renderer,
    graphRoot,
    nodeMeshes,
    orbSprites,
    labelSprites,
    edgeLines,
    edgeLineGeom,
    edgeLineMat,
    orbTexture,
  };
}

/**
 * Tint an orb sprite for state changes. The glow halo texture is white;
 * SpriteMaterial.color tints it any shade. We also bump the scale on
 * interaction so hover/active orbs visibly pulse outward.
 */
export function setNodeColor(
  pickMesh: THREE.Mesh, state: "base" | "hover" | "active",
): void {
  const id = pickMesh.userData.nodeId as string | undefined;
  const root = pickMesh.parent;
  if (!root || !id) return;
  // Walk children and pick out the orb sprite (additive blend) AND
  // the label sprite (depthTest false). Both share userData.nodeId.
  let orb: THREE.Sprite | undefined;
  let label: THREE.Sprite | undefined;
  for (const c of root.children) {
    if (!(c instanceof THREE.Sprite)) continue;
    if (c.userData.nodeId !== id) continue;
    const m = c.material as THREE.SpriteMaterial;
    if (m.blending === THREE.AdditiveBlending) orb = c;
    else label = c;
  }
  if (!orb) return;
  const mat = orb.material as THREE.SpriteMaterial;
  const c =
    state === "active"
      ? COLOR_NODE_ACTIVE
      : state === "hover"
        ? COLOR_NODE_HOVER
        : COLOR_NODE_BASE;
  mat.color.setHex(c);
  // Hover/active orbs swell ~50% from THEIR base scale so high-
  // importance roots and tiny leaves both pop proportionally.
  const baseScale = (orb.userData.baseScale as number | undefined) ?? 0.18;
  const factor = state === "base" ? 1 : 1.5;
  orb.scale.set(baseScale * factor, baseScale * factor, 1);
  if (label) {
    const labelBase = (label.userData.baseScale as number | undefined) ?? baseScale * 0.85;
    label.scale.set(labelBase * factor, labelBase * factor, 1);
  }
}

export function projectNodeToScreen(
  mesh: THREE.Mesh, camera: THREE.PerspectiveCamera, w: number, h: number,
): { x: number; y: number } {
  const v = new THREE.Vector3();
  mesh.getWorldPosition(v);
  v.project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * w,
    y: (-v.y * 0.5 + 0.5) * h,
  };
}

/**
 * Step the bloom-from-center spring physics one frame. Each orb's
 * position eases toward its target with a slight overshoot. The orb,
 * its label sprite, and its invisible pick proxy all move together.
 *
 * Returns true if any orb is still in motion, false once everything
 * has settled (callers can use this to skip per-frame redraw of the
 * edge LineSegments after the constellation finishes blooming).
 */
export function updateAnimations(refs: SceneRefs): boolean {
  let stillAnimating = false;
  refs.orbSprites.forEach((orb, id) => {
    const anim = orb.userData.anim as OrbAnimState | undefined;
    if (!anim || anim.settled) return;

    // Spring step: velocity is pulled toward (target - current) and
    // bled by damping. No fixed dt — the loop runs at vsync (60-120fps);
    // tuning is per-frame, not per-second.
    const dx = anim.target.x - anim.current.x;
    const dy = anim.target.y - anim.current.y;
    const dz = anim.target.z - anim.current.z;
    anim.velocity.x = anim.velocity.x * SPRING_DAMPING + dx * SPRING_STIFFNESS;
    anim.velocity.y = anim.velocity.y * SPRING_DAMPING + dy * SPRING_STIFFNESS;
    anim.velocity.z = anim.velocity.z * SPRING_DAMPING + dz * SPRING_STIFFNESS;
    anim.current.x += anim.velocity.x;
    anim.current.y += anim.velocity.y;
    anim.current.z += anim.velocity.z;

    // Snap when both displacement AND velocity are small — otherwise
    // tiny end-of-spring residual oscillations keep us in the loop.
    const distSq = dx * dx + dy * dy + dz * dz;
    const velSq =
      anim.velocity.x * anim.velocity.x +
      anim.velocity.y * anim.velocity.y +
      anim.velocity.z * anim.velocity.z;
    if (distSq < SETTLE_EPSILON && velSq < SETTLE_EPSILON) {
      anim.current.copy(anim.target);
      anim.velocity.set(0, 0, 0);
      anim.settled = true;
    } else {
      stillAnimating = true;
    }

    // Apply to all three meshes that share this orb's identity.
    orb.position.copy(anim.current);
    const pick = refs.nodeMeshes.get(id);
    if (pick) pick.position.copy(anim.current);
    const label = refs.labelSprites.get(id);
    if (label) {
      // Label stacks ON the orb (text inside the halo), not offset.
      label.position.copy(anim.current);
    }
  });
  return stillAnimating;
}

/**
 * Rewrite the LineSegments position buffer from the orbs' CURRENT
 * (animated) positions. Called every frame while orbs are moving, so
 * connecting lines visibly track their endpoints as the constellation
 * blooms outward.
 */
export function updateEdgePositions(refs: SceneRefs): void {
  const pairs = refs.edgeLines.userData.pairs as [string, string][] | undefined;
  if (!pairs || pairs.length === 0) return;
  const posAttr = refs.edgeLineGeom.getAttribute("position");
  if (!posAttr) return;
  const arr = posAttr.array as Float32Array;
  let off = 0;
  for (const [aId, bId] of pairs) {
    const a = refs.orbSprites.get(aId);
    const b = refs.orbSprites.get(bId);
    if (!a || !b) {
      // Endpoint disappeared (rare — defensive). Collapse the segment
      // to a single point so it isn't visible.
      arr[off++] = 0; arr[off++] = 0; arr[off++] = 0;
      arr[off++] = 0; arr[off++] = 0; arr[off++] = 0;
      continue;
    }
    arr[off++] = a.position.x; arr[off++] = a.position.y; arr[off++] = a.position.z;
    arr[off++] = b.position.x; arr[off++] = b.position.y; arr[off++] = b.position.z;
  }
  posAttr.needsUpdate = true;
}

export interface LabelVisibilityOverrides {
  /** Currently-hovered orb id (pointer or mouse). Its label always
   *  resolves to full opacity so the user can read what they're
   *  pointing at, regardless of camera distance. */
  hoveredId?: string | null;
  /** Set of node ids with open context cards. Their labels stay
   *  pinned visible — without this, an open card would float next to
   *  a faded-out orb and the user couldn't tell which orb it belongs
   *  to. */
  pinnedIds?: Set<string> | null;
}

/**
 * Combined importance-tier + camera-distance label fade. Called every
 * frame from the RAF loop. Each label sprite's material.opacity eases
 * toward a target derived from its importance tier and how far the
 * camera is from the orb — with an override path that forces full
 * opacity for the hovered orb and any orb with an open context card.
 *
 * Result: roots stay legible from any angle; leaves only resolve when
 * you've zoomed close enough; AND whichever orbs the user is currently
 * interacting with — pointing at, or expanded — always read clearly,
 * even if the rest of their tier is faded out.
 */
export function updateLabelVisibility(
  refs: SceneRefs,
  overrides?: LabelVisibilityOverrides,
): void {
  const camPos = new THREE.Vector3();
  refs.camera.getWorldPosition(camPos);
  const orbPos = new THREE.Vector3();
  const hoveredId = overrides?.hoveredId ?? null;
  const pinnedIds = overrides?.pinnedIds ?? null;
  refs.labelSprites.forEach((label, id) => {
    const orb = refs.orbSprites.get(id);
    if (!orb) return;
    orb.getWorldPosition(orbPos);
    const dist = camPos.distanceTo(orbPos);
    const importance = (label.userData.importance as number | undefined) ?? 0.5;
    let showAt: number;
    let fadeAt: number;
    if (importance >= 0.75) {
      showAt = LABEL_TIER_ROOT_SHOW;
      fadeAt = LABEL_TIER_ROOT_FADE;
    } else if (importance >= 0.4) {
      showAt = LABEL_TIER_BRANCH_SHOW;
      fadeAt = LABEL_TIER_BRANCH_FADE;
    } else {
      showAt = LABEL_TIER_LEAF_SHOW;
      fadeAt = LABEL_TIER_LEAF_FADE;
    }
    // Linear ramp from showAt (1.0) to fadeAt (0.0).
    let target: number;
    if (dist <= showAt) target = 1;
    else if (dist >= fadeAt) target = 0;
    else target = 1 - (dist - showAt) / (fadeAt - showAt);

    // Interaction overrides — pinch-card and hover both pin the label
    // to full opacity. Applied AFTER tier/distance so they always win.
    if (id === hoveredId) target = 1;
    if (pinnedIds && pinnedIds.has(id)) target = 1;

    const cur = (label.userData.opacityCurrent as number | undefined) ?? 0;
    const next = cur + (target - cur) * LABEL_OPACITY_SMOOTHING;
    label.userData.opacityCurrent = next;
    const mat = label.material as THREE.SpriteMaterial;
    mat.opacity = next;
    // Small perf nicety: when fully transparent, skip rendering the
    // sprite entirely. Saves draw calls in dense leaf clusters.
    label.visible = next > 0.02;
  });
}

/**
 * Snapshot the orbs' current positions into a Map keyed by node._id.
 * ARStage uses this to preserve continuity across SceneEffect rebuilds:
 * existing orbs resume from where they were, only newly-added orbs
 * bloom from (0,0,0).
 */
export function captureCurrentPositions(refs: SceneRefs): Map<string, THREE.Vector3> {
  const out = new Map<string, THREE.Vector3>();
  refs.orbSprites.forEach((orb, id) => {
    out.set(id, orb.position.clone());
  });
  return out;
}

export function disposeScene(refs: SceneRefs): void {
  refs.renderer.dispose();
  refs.renderer.domElement.remove();
  // Per-orb sprite materials (color-tinted independently).
  refs.orbSprites.forEach((s) => {
    (s.material as THREE.SpriteMaterial).dispose();
  });
  // Label sprites — each has its own canvas texture.
  refs.labelSprites.forEach((s) => {
    const mat = s.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
  });
  // Pick-proxy meshes share geometry + material (created inline in
  // buildScene); dispose the pair via the first mesh we find.
  const first = refs.nodeMeshes.values().next().value;
  if (first) {
    first.geometry.dispose();
    (first.material as THREE.Material).dispose();
  }
  refs.edgeLineGeom.dispose();
  refs.edgeLineMat.dispose();
  refs.orbTexture.dispose();
}
