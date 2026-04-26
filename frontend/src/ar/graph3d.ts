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
  nodeMeshes: Map<string, THREE.Mesh>;
  labelSprites: Map<string, THREE.Sprite>;
  edgeLines: THREE.LineSegments;
  edgeLineGeom: THREE.BufferGeometry;
  edgeLineMat: THREE.LineBasicMaterial;
  sphereGeom: THREE.BufferGeometry;
}

// Visual feel — tuned for the Phosphor Dark + volt-yellow brand.
const NODE_RADIUS = 0.14;
const COLOR_NODE_BASE = 0x6ec1ff;      // cyan glass
const COLOR_NODE_HOVER = 0xffae3d;     // warm amber
const COLOR_NODE_ACTIVE = 0xd6ff3a;    // volt yellow (brand)
// Thin white lines per spec — minimalist, lets the orbs breathe.
const COLOR_EDGE = 0xffffff;
const EDGE_OPACITY = 0.45;

/**
 * Render a node label onto a CanvasTexture so it can be displayed as a
 * billboard sprite that always faces the camera. Returns the sprite,
 * positioned slightly above the orb's surface.
 */
function makeLabelSprite(label: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d")!;
  ctx.font = "600 56px 'Space Grotesk', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // Soft shadow + bright text so labels read against any backdrop.
  ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
  ctx.shadowBlur = 14;
  ctx.fillStyle = "#ffffff";
  // Truncate long labels — graph nodes can be sentences.
  const maxChars = 28;
  const text =
    label.length > maxChars ? label.slice(0, maxChars - 1) + "…" : label;
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({
    map: tex,
    transparent: true,
    depthWrite: false,
    depthTest: true,
  });
  const sprite = new THREE.Sprite(mat);
  // Sprite size tuned so a 28-char label is readable at default camera
  // zoom but doesn't overpower the orb.
  sprite.scale.set(1.2, 0.3, 1);
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
  scene.add(new THREE.HemisphereLight(0x88aaff, 0x0a0d18, 0.7));
  const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
  keyLight.position.set(3, 5, 5);
  scene.add(keyLight);
  const fillLight = new THREE.PointLight(0x6ec1ff, 0.8, 8);
  fillLight.position.set(0, 0, 0);
  scene.add(fillLight);

  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
  camera.position.set(0, 0, 5);

  const graphRoot = new THREE.Group();
  scene.add(graphRoot);

  const nodeMeshes = new Map<string, THREE.Mesh>();
  const labelSprites = new Map<string, THREE.Sprite>();
  const sphereGeom = new THREE.SphereGeometry(NODE_RADIUS, 48, 48);
  for (const n of nodes) {
    const p = positions[n._id];
    if (!p) continue;
    const mat = new THREE.MeshPhysicalMaterial({
      color: COLOR_NODE_BASE,
      emissive: COLOR_NODE_BASE,
      emissiveIntensity: 0.55,
      roughness: 0.18,
      metalness: 0.05,
      clearcoat: 0.8,
      clearcoatRoughness: 0.15,
      iridescence: 0.35,
      iridescenceIOR: 1.4,
      transmission: 0.15,
      thickness: 0.4,
      ior: 1.45,
    });
    const mesh = new THREE.Mesh(sphereGeom, mat);
    mesh.position.set(p.x, p.y, p.z);
    mesh.userData.nodeId = n._id;
    graphRoot.add(mesh);
    nodeMeshes.set(n._id, mesh);

    // Topic label sprite floating slightly above the orb.
    const sprite = makeLabelSprite(n.label);
    sprite.position.set(p.x, p.y + NODE_RADIUS + 0.15, p.z);
    sprite.userData.nodeId = n._id;
    graphRoot.add(sprite);
    labelSprites.set(n._id, sprite);
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
    labelSprites,
    edgeLines,
    edgeLineGeom,
    edgeLineMat,
    sphereGeom,
  };
}

export function setNodeColor(
  mesh: THREE.Mesh, state: "base" | "hover" | "active",
): void {
  const mat = mesh.material as THREE.MeshPhysicalMaterial;
  const c = state === "active" ? COLOR_NODE_ACTIVE
          : state === "hover" ? COLOR_NODE_HOVER
          : COLOR_NODE_BASE;
  mat.color.setHex(c);
  mat.emissive.setHex(c);
  // Pop the glow on interaction so state change reads instantly.
  mat.emissiveIntensity = state === "base" ? 0.55 : 1.1;
  mat.iridescence = state === "base" ? 0.35 : 0.6;
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
  // Per-node materials (so hover/active state can vary independently).
  refs.nodeMeshes.forEach((m) => {
    (m.material as THREE.Material).dispose();
  });
  // Label sprites carry their own canvas-textured material per node.
  refs.labelSprites.forEach((s) => {
    const mat = s.material as THREE.SpriteMaterial;
    mat.map?.dispose();
    mat.dispose();
  });
  refs.edgeLineGeom.dispose();
  refs.edgeLineMat.dispose();
  refs.sphereGeom.dispose();
}
