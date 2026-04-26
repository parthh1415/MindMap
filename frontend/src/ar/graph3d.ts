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

// Visual feel — tuned to match the user's reference: tiny bright dots
// with soft halos in a constellation/galaxy aesthetic.
const ORB_SCALE = 0.14;          // sprite world-size (the halo)
const PICK_RADIUS = 0.04;         // invisible pick mesh radius for hand pointer
const COLOR_NODE_BASE = 0x6ec1ff;      // cyan-white star
const COLOR_NODE_HOVER = 0xffae3d;     // warm amber
const COLOR_NODE_ACTIVE = 0xd6ff3a;    // volt yellow (brand)
// Thin white lines per spec — minimalist, lets the orbs breathe.
const COLOR_EDGE = 0xffffff;
const EDGE_OPACITY = 0.35;

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
 * Render a small white label sprite to float beside the orb.
 * Smaller than before (0.4 wide) — these are subtle annotations, not
 * the dominant visual.
 */
function makeLabelSprite(label: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "500 44px 'Space Grotesk', system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  // Strong drop-shadow so labels read on any backdrop.
  ctx.shadowColor = "rgba(0, 0, 0, 0.95)";
  ctx.shadowBlur = 12;
  ctx.fillStyle = "#ffffff";
  const maxChars = 24;
  const text =
    label.length > maxChars ? label.slice(0, maxChars - 1) + "…" : label;
  ctx.fillText(text, 16, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: false, // labels always on top
  });
  const sprite = new THREE.Sprite(mat);
  // Aspect ratio matches canvas (~5.3 wide). Width 0.55 gives readable
  // text at default zoom without crowding the field.
  sprite.scale.set(0.55, 0.103, 1);
  return sprite;
}

export function buildScene(
  container: HTMLElement,
  nodes: LayoutInput[],
  edges: LayoutEdge[],
  positions: Record<string, Vec3>,
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
  // by projectNodeToScreen for fingertip-pick distance math.
  const pickGeom = new THREE.SphereGeometry(PICK_RADIUS, 8, 8);
  const pickMat = new THREE.MeshBasicMaterial({ visible: false });

  const nodeMeshes = new Map<string, THREE.Mesh>();
  const orbSprites = new Map<string, THREE.Sprite>();
  const labelSprites = new Map<string, THREE.Sprite>();

  for (const n of nodes) {
    const p = positions[n._id];
    if (!p) continue;

    // Glow orb: tinted billboard with additive blend → soft halo.
    const orbMat = new THREE.SpriteMaterial({
      map: orbTexture,
      color: COLOR_NODE_BASE,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const orb = new THREE.Sprite(orbMat);
    orb.position.set(p.x, p.y, p.z);
    orb.scale.set(ORB_SCALE, ORB_SCALE, 1);
    orb.userData.nodeId = n._id;
    graphRoot.add(orb);
    orbSprites.set(n._id, orb);

    // Invisible pick-proxy mesh at the orb's center — projectNodeToScreen
    // uses Mesh.getWorldPosition which works for any Object3D, but the
    // existing pointer-pick API is typed Map<string, Mesh>. Tiny
    // invisible sphere keeps the type and gives a consistent pick target.
    const pickMesh = new THREE.Mesh(pickGeom, pickMat);
    pickMesh.position.set(p.x, p.y, p.z);
    pickMesh.userData.nodeId = n._id;
    graphRoot.add(pickMesh);
    nodeMeshes.set(n._id, pickMesh);

    // Topic label floating to the upper-right of the orb (matches
    // reference imagery — label "leans away" from the dot).
    const label = makeLabelSprite(n.label);
    label.position.set(p.x + 0.18, p.y + 0.12, p.z);
    label.userData.nodeId = n._id;
    graphRoot.add(label);
    labelSprites.set(n._id, label);
  }

  // Edges as ONE LineSegments object — single draw call for all
  // connections, thin (1px) white lines per the spec.
  const edgeLineGeom = new THREE.BufferGeometry();
  const edgeVertices: number[] = [];
  for (const e of edges) {
    const a = positions[e.source_id];
    const b = positions[e.target_id];
    if (!a || !b) continue;
    edgeVertices.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  edgeLineGeom.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(edgeVertices, 3),
  );
  const edgeLineMat = new THREE.LineBasicMaterial({
    color: COLOR_EDGE,
    transparent: true,
    opacity: EDGE_OPACITY,
  });
  const edgeLines = new THREE.LineSegments(edgeLineGeom, edgeLineMat);
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
  // pickMesh.parent is the graphRoot — find the matching sprite by id.
  // (We can't reach orbSprites directly from here; ARStage threads it
  // via setNodeColor's caller. Trade-off: we look it up via parent.)
  const root = pickMesh.parent;
  if (!root || !id) return;
  const orb = root.children.find(
    (c) => c instanceof THREE.Sprite && c.userData.nodeId === id,
  ) as THREE.Sprite | undefined;
  if (!orb) return;
  const mat = orb.material as THREE.SpriteMaterial;
  const c =
    state === "active"
      ? COLOR_NODE_ACTIVE
      : state === "hover"
        ? COLOR_NODE_HOVER
        : COLOR_NODE_BASE;
  mat.color.setHex(c);
  // Visual feedback: hover/active orbs swell ~60% so they read
  // immediately even though the base orb is intentionally tiny.
  const s = state === "base" ? ORB_SCALE : ORB_SCALE * 1.6;
  orb.scale.set(s, s, 1);
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
