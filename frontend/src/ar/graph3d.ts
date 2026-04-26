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
    .force("link", forceLink(simLinks).id((d: SimNode) => d.id).distance(1.0))
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
  edgeMeshes: THREE.Mesh[];
  arrowHelpers: THREE.ArrowHelper[];
  sphereGeom: THREE.BufferGeometry;
  edgeMat: THREE.Material;
}

const NODE_RADIUS = 0.08;
const EDGE_RADIUS = 0.012;
const COLOR_NODE_BASE = 0x4a7bff;      // bluish
const COLOR_NODE_HOVER = 0xffae3d;     // warm
const COLOR_NODE_ACTIVE = 0x40d97a;    // green
const COLOR_EDGE = 0x6a7282;

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
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const dir = new THREE.DirectionalLight(0xffffff, 0.8);
  dir.position.set(3, 5, 5);
  scene.add(dir);

  const camera = new THREE.PerspectiveCamera(50, w / h, 0.1, 100);
  camera.position.set(0, 0, 5);

  const graphRoot = new THREE.Group();
  scene.add(graphRoot);

  const nodeMeshes = new Map<string, THREE.Mesh>();
  const sphereGeom = new THREE.SphereGeometry(NODE_RADIUS, 24, 24);
  for (const n of nodes) {
    const p = positions[n._id];
    if (!p) continue;
    const mat = new THREE.MeshStandardMaterial({
      color: COLOR_NODE_BASE, emissive: COLOR_NODE_BASE, emissiveIntensity: 0.2,
      roughness: 0.4, metalness: 0.1,
    });
    const mesh = new THREE.Mesh(sphereGeom, mat);
    mesh.position.set(p.x, p.y, p.z);
    mesh.userData.nodeId = n._id;
    graphRoot.add(mesh);
    nodeMeshes.set(n._id, mesh);
  }

  const edgeMeshes: THREE.Mesh[] = [];
  const arrowHelpers: THREE.ArrowHelper[] = [];
  const edgeMat = new THREE.MeshStandardMaterial({ color: COLOR_EDGE, roughness: 0.6 });
  for (const e of edges) {
    const a = positions[e.source_id], b = positions[e.target_id];
    if (!a || !b) continue;
    const av = new THREE.Vector3(a.x, a.y, a.z);
    const bv = new THREE.Vector3(b.x, b.y, b.z);
    const len = av.distanceTo(bv);
    const cyl = new THREE.CylinderGeometry(EDGE_RADIUS, EDGE_RADIUS, len, 8);
    const mesh = new THREE.Mesh(cyl, edgeMat);
    const mid = av.clone().add(bv).multiplyScalar(0.5);
    mesh.position.copy(mid);
    const dirVec = bv.clone().sub(av).normalize();
    const up = new THREE.Vector3(0, 1, 0);
    mesh.quaternion.setFromUnitVectors(up, dirVec);
    graphRoot.add(mesh);
    edgeMeshes.push(mesh);
  }

  return { scene, camera, renderer, graphRoot, nodeMeshes, edgeMeshes, arrowHelpers, sphereGeom, edgeMat };
}

export function setNodeColor(
  mesh: THREE.Mesh, state: "base" | "hover" | "active",
): void {
  const mat = mesh.material as THREE.MeshStandardMaterial;
  const c = state === "active" ? COLOR_NODE_ACTIVE
          : state === "hover" ? COLOR_NODE_HOVER
          : COLOR_NODE_BASE;
  mat.color.setHex(c);
  mat.emissive.setHex(c);
  mat.emissiveIntensity = state === "base" ? 0.2 : 0.5;
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
  refs.nodeMeshes.forEach((m) => {
    // geometry is shared (refs.sphereGeom) — dispose once below
    (m.material as THREE.Material).dispose();
  });
  refs.edgeMeshes.forEach((m) => {
    m.geometry.dispose();
    // material is shared (refs.edgeMat) — dispose once below
  });
  refs.sphereGeom.dispose();
  refs.edgeMat.dispose();
}
