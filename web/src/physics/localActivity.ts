import type { PhysicsConfig } from '@/store/types';
import type { SimLink, SimNode } from './forces';

export const LAYOUT_ALPHA_MIN = 0.005;

/** Local cooling for node physics. d3's shared alpha only schedules ticks;
 * reheating it for one drag must not restart every spring in the project.
 * Movable nodes share activity through structural links, collisions and
 * enabled repulsion. Stationary pins are boundaries, not conduits. */
export function localActivity(
  links: SimLink[],
  cfg: PhysicsConfig,
  dragging: ReadonlySet<string>,
  isLinked: (a: string, b: string) => boolean,
) {
  let nodes: SimNode[] = [];
  let parents = new Int32Array(0);
  let seeds = new Float64Array(0);
  let heat = new Float64Array(0);
  let movable = new Uint8Array(0);
  const indices = new Map<string, number>();
  function root(i: number): number {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]!]!;
      i = parents[i]!;
    }
    return i;
  }
  function connect(i: number, j: number) {
    if (movable[i] && movable[j]) parents[root(j)] = root(i);
    // A pin explicitly moved/resized/unpinned can wake its neighbors. A
    // stationary pin must never inherit activity from a moving neighbor.
    else if (movable[i]) seeds[i] = Math.max(seeds[i]!, nodes[j]!.layoutAlpha ?? 0);
    else if (movable[j]) seeds[j] = Math.max(seeds[j]!, nodes[i]!.layoutAlpha ?? 0);
  }
  function force() {
    let active = false;
    heat.fill(0);
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i]!;
      const alpha = (n.layoutAlpha ?? 0) * (1 - cfg.alphaDecay);
      n.layoutAlpha = alpha >= LAYOUT_ALPHA_MIN ? alpha : 0;
      if (!n.layoutAlpha) { n.vx = 0; n.vy = 0; }
      else active = true;
      // Use this tick's pointer position when finding contacts, rather than
      // the previous tick's position (d3 applies fx/fy after all forces).
      if (n.fx != null) n.x = n.fx;
      if (n.fy != null) n.y = n.fy;
      parents[i] = i;
      seeds[i] = n.layoutAlpha;
      movable[i] = (n.fx == null && n.fy == null) || dragging.has(n.id) ? 1 : 0;
    }
    if (!active) return;
    if (cfg.linkStrength !== 0) for (const l of links) {
      if (l.kind !== 'auto') continue;
      const i = indices.get(typeof l.source === 'string' ? l.source : l.source.id);
      const j = indices.get(typeof l.target === 'string' ? l.target : l.target.id);
      if (i != null && j != null) connect(i, j);
    }
    const padding = 2 * cfg.collidePadding;
    const repel = cfg.repelRange > 0 && (cfg.linkedRepelStrength !== 0 || cfg.unlinkedRepelStrength !== 0);
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      for (let j = i + 1; j < nodes.length; j++) {
        if (!movable[i] && !movable[j]) continue;
        const b = nodes[j]!;
        const gapX = Math.max(a.x! - b.x! - (b.width ?? 420), b.x! - a.x! - (a.width ?? 420));
        const gapY = Math.max(a.y! - b.y! - (b.height ?? 120), b.y! - a.y! - (a.height ?? 120));
        if (gapX < padding && gapY < padding) { connect(i, j); continue; }
        if (!repel || gapX >= cfg.repelRange || gapY >= cfg.repelRange) continue;
        const strength = isLinked(a.id, b.id) ? cfg.linkedRepelStrength : cfg.unlinkedRepelStrength;
        if (strength !== 0 && Math.max(0, gapX) ** 2 + Math.max(0, gapY) ** 2 < cfg.repelRange ** 2) connect(i, j);
      }
    }
    for (let i = 0; i < nodes.length; i++) heat[root(i)] = Math.max(heat[root(i)]!, seeds[i]!);
    for (let i = 0; i < nodes.length; i++) nodes[i]!.layoutAlpha = heat[root(i)]!;
  }
  force.initialize = (value: SimNode[]) => {
    nodes = value;
    parents = new Int32Array(nodes.length);
    seeds = new Float64Array(nodes.length);
    heat = new Float64Array(nodes.length);
    movable = new Uint8Array(nodes.length);
    indices.clear();
    nodes.forEach((n, i) => indices.set(n.id, i));
  };
  return force;
}
