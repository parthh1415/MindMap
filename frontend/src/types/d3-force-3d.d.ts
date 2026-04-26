// Minimal ambient types for d3-force-3d (no @types package on npm).
// Mirrors the parts of the d3-force API used in src/ar/graph3d.ts plus
// the `numDimensions` argument that's unique to the 3D fork.
declare module "d3-force-3d" {
  export interface SimulationNodeDatum {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLinkDatum<N extends SimulationNodeDatum> {
    source: N | string | number;
    target: N | string | number;
    index?: number;
  }

  export interface Force<N extends SimulationNodeDatum, L> {
    (alpha: number): void;
    initialize?(nodes: N[]): void;
  }

  export interface Simulation<N extends SimulationNodeDatum, L> {
    nodes(): N[];
    nodes(nodes: N[]): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaTarget(target: number): this;
    alphaDecay(decay: number): this;
    alphaMin(min: number): this;
    velocityDecay(decay: number): this;
    force(name: string): Force<N, L> | undefined;
    force(name: string, force: Force<N, L> | null): this;
    find(x: number, y: number, z?: number, radius?: number): N | undefined;
    on(typenames: string, listener: ((this: Simulation<N, L>) => void) | null): this;
    tick(iterations?: number): this;
    restart(): this;
    stop(): this;
  }

  export function forceSimulation<N extends SimulationNodeDatum, L = unknown>(
    nodes?: N[],
    numDimensions?: 1 | 2 | 3,
  ): Simulation<N, L>;

  export interface ForceManyBody<N extends SimulationNodeDatum> extends Force<N, unknown> {
    strength(): ((d: N, i: number, nodes: N[]) => number);
    strength(strength: number | ((d: N, i: number, nodes: N[]) => number)): this;
    distanceMin(min: number): this;
    distanceMax(max: number): this;
    theta(theta: number): this;
  }

  export function forceManyBody<N extends SimulationNodeDatum>(): ForceManyBody<N>;

  export interface ForceLink<N extends SimulationNodeDatum, L extends SimulationLinkDatum<N>>
    extends Force<N, L> {
    links(): L[];
    links(links: L[]): this;
    id(): (d: N) => string | number;
    id(fn: (d: N) => string | number): this;
    distance(distance: number | ((link: L, i: number, links: L[]) => number)): this;
    strength(strength: number | ((link: L, i: number, links: L[]) => number)): this;
    iterations(iterations: number): this;
  }

  export function forceLink<
    N extends SimulationNodeDatum,
    L extends SimulationLinkDatum<N> = SimulationLinkDatum<N>,
  >(links?: L[]): ForceLink<N, L>;

  export interface ForceCenter<N extends SimulationNodeDatum> extends Force<N, unknown> {
    x(x: number): this;
    y(y: number): this;
    z(z: number): this;
  }

  export function forceCenter<N extends SimulationNodeDatum>(
    x?: number,
    y?: number,
    z?: number,
  ): ForceCenter<N>;
}
