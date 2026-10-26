import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';
import type { VerletRopeSim } from './verletRope';
import { fastHypot } from './perfMath';

/* -------------------------------------------------------------------------
 * Pure d3-force functions for the scatter physics worker.
 *
 * After the Verlet rope rewrite, this module only contains forces that act
 * on REAL nodes — pairwise repel, rect collision, arrow keep-out, and a
 * couple of geometry helpers. Rope/anchor physics moved to verletRope.ts.
 *
 * These are pure (no side effects beyond mutating the supplied SimNode
 * array) so they can be exercised by unit tests without spinning up a Worker.
 * -------------------------------------------------------------------------*/

export interface SimNode extends SimulationNodeDatum {
  id: string;
  frozen?: boolean;
  width?: number;
  height?: number;
  /** Worker-only activity; undefined keeps standalone forces using d3 alpha. */
  layoutAlpha?: number;
}

/** A collision can create a new contact within a solver pass. Carry activity
 * to the newly touched movable node immediately; never through a fixed pin. */
function pairActivity(a: SimNode, b: SimNode, alpha: number): number {
  const local = Math.max(a.layoutAlpha ?? alpha, b.layoutAlpha ?? alpha);
  if (a.layoutAlpha != null && a.fx == null && a.fy == null) a.layoutAlpha = local;
  if (b.layoutAlpha != null && b.fx == null && b.fy == null) b.layoutAlpha = local;
  return local;
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode;
  target: string | SimNode;
  kind: 'auto' | 'dotted';
  gravitates: boolean;
  arrowId: string;
}

export type EdgeKey = string;
export function edgeKey(a: string, b: string): EdgeKey {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Resolve a SimLink endpoint id whether it's still a string or already a node. */
function endpointId(end: string | SimNode): string {
  return typeof end === 'string' ? end : end.id;
}

/**
 * Position-based rectangle collision force. d3-force's built-in forceCollide
 * is circular; our nodes are tall rectangles, so circular collision either
 * wastes space or lets nodes touch on the diagonals. This force directly
 * resolves rectangle overlaps each tick by pushing nodes apart along the axis
 * of least overlap. Treats node positions as TOP-LEFT anchors (matching
 * React's `translate3d(position.x, position.y)`).
 */
export function rectCollide(defaultWidth: number, defaultHeight: number, padding: number = 0) {
  let nodes: SimNode[] = [];
  function force() {
    // 6 passes (was 2): when a node is being dragged through a stack of
    // unpinned obstacles, each pass resolves overlap/2 (halving it). With
    // 2 passes ~75% of incoming overlap is resolved per tick, but a fast
    // drag can add 20-30px of new overlap per tick — faster than 2 passes
    // can clear, so visible overlap accumulates. 6 passes resolves
    // ~98.5% per tick, which keeps cascades visually tight even on fast
    // descents through chains.
    for (let pass = 0; pass < 6; pass++) {
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i]!;
        if (a.x == null || a.y == null) continue;
        const aW = a.width ?? defaultWidth;
        const aH = a.height ?? defaultHeight;
        const aLeft = a.x - padding;
        const aRight = a.x + aW + padding;
        const aTop = a.y - padding;
        const aBottom = a.y + aH + padding;
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j]!;
          if (b.x == null || b.y == null) continue;
          if (a.layoutAlpha === 0 && b.layoutAlpha === 0) continue;
          const bW = b.width ?? defaultWidth;
          const bH = b.height ?? defaultHeight;
          const bLeft = b.x - padding;
          const bRight = b.x + bW + padding;
          const bTop = b.y - padding;
          const bBottom = b.y + bH + padding;
          const overlapX = Math.min(aRight, bRight) - Math.max(aLeft, bLeft);
          const overlapY = Math.min(aBottom, bBottom) - Math.max(aTop, bTop);
          if (overlapX > 0 && overlapY > 0) {
            if (pairActivity(a, b, 1) === 0) continue;
            const aCx = (aLeft + aRight) / 2;
            const aCy = (aTop + aBottom) / 2;
            const bCx = (bLeft + bRight) / 2;
            const bCy = (bTop + bBottom) / 2;
            if (overlapX < overlapY) {
              const push = overlapX / 2;
              const dir = bCx >= aCx ? 1 : -1;
              if (a.fx == null) a.x! -= dir * push;
              if (b.fx == null) b.x! += dir * push;
            } else {
              const push = overlapY / 2;
              const dir = bCy >= aCy ? 1 : -1;
              if (a.fy == null) a.y! -= dir * push;
              if (b.fy == null) b.y! += dir * push;
            }
          }
        }
      }
    }
  }
  force.initialize = (n: SimNode[]) => { nodes = n; };
  return force;
}

/**
 * Push real nodes away from arrow lines they're not endpoints of, so arrows
 * don't visually pierce unrelated nodes. Operates on rendered (center-anchored)
 * coordinates derived from the top-left positions plus per-node sizes.
 */
export function arrowAvoid(linkSet: SimLink[], padding: number = 30) {
  let nodes: SimNode[] = [];
  function force() {
    for (const link of linkSet) {
      const sourceId = endpointId(link.source);
      const targetId = endpointId(link.target);
      const a = nodes.find(n => n.id === sourceId);
      const b = nodes.find(n => n.id === targetId);
      if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null) continue;
      const aW = a.width ?? 420;
      const aH = a.height ?? 120;
      const bW = b.width ?? 420;
      const bH = b.height ?? 120;
      const ax = a.x + aW / 2;
      const ay = a.y + aH / 2;
      const bx = b.x + bW / 2;
      const by = b.y + bH / 2;
      const dx = bx - ax, dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1) continue;

      for (const n of nodes) {
        if (n.id === sourceId || n.id === targetId) continue;
        if (n.x == null || n.y == null) continue;
        if (n.fx != null && n.fy != null) continue;
        const nW = n.width ?? 420;
        const nH = n.height ?? 120;
        const nCx = n.x + nW / 2;
        const nCy = n.y + nH / 2;
        const t = Math.max(0, Math.min(1, ((nCx - ax) * dx + (nCy - ay) * dy) / lenSq));
        const closestX = ax + t * dx;
        const closestY = ay + t * dy;
        const vx = nCx - closestX;
        const vy = nCy - closestY;
        const dist = Math.sqrt(vx * vx + vy * vy);
        const keepOut = Math.min(nW, nH) / 2 + padding;
        if (dist < keepOut) {
          if (dist < 0.001) {
            const segLen = Math.sqrt(lenSq);
            const pushX = -dy / segLen;
            const pushY = dx / segLen;
            const amount = keepOut;
            n.x = closestX + pushX * amount - nW / 2;
            n.y = closestY + pushY * amount - nH / 2;
          } else {
            const amount = keepOut - dist;
            n.x += (vx / dist) * amount;
            n.y += (vy / dist) * amount;
          }
        }
      }
    }
  }
  force.initialize = (n: SimNode[]) => { nodes = n; };
  return force;
}

/**
 * Linear-zone pairwise repulsion between real nodes.
 *
 * Inside `range` the force falls off linearly to zero. Magnitude uses the
 * BORDER-TO-BORDER (rect-to-rect AABB) distance, NOT center-to-center —
 * so a small node feels the same proximity to a 100×100 neighbor as it
 * does to a 600×400 neighbor when their borders are equally close. This
 * matters because users can resize nodes; with center-to-center distance
 * a freshly-resized large node would silently stop pushing its
 * neighbors away once their CENTERS were past `range`, even though
 * their borders were practically touching.
 *
 * Direction is still center-to-center (the natural "away" axis); only
 * the magnitude formula changed.
 *
 * Sign convention: `strength` is supplied negative for repulsion. With
 * the unit vector u pointing from a → b, the per-tick velocity gain is
 *   a.v += -u * (-strength * alpha * falloff)
 *   b.v += +u * (-strength * alpha * falloff)
 * i.e. the pair flies apart along (a → b) when strength is negative.
 */
/**
 * Spring force between linked pairs whose REST LENGTH is in border-to-border
 * distance, not center-to-center. d3-force's built-in `forceLink` uses
 * center-to-center, which means resizing a node larger silently shrinks the
 * visible gap to its linked neighbors (because the spring keeps reeling them
 * back to a fixed center distance). With this force, the gap stays the same
 * regardless of node size — the spring's equilibrium is "borders ARE
 * `targetBorderDistance` apart," size-invariant.
 *
 * Direction: still along the line joining the two centers (the natural
 * "away/toward" axis for two rectangles).
 *
 * Magnitude: Hooke's law on `borderDist - targetBorderDistance`. Positive
 * error (too far) ⇒ pull together; negative error (overlapping or too close)
 * ⇒ push apart. Pinned endpoints (fx/fy set) don't move.
 */
export function rectLink(
  links: SimLink[],
  targetBorderDistance: number,
  strength: number,
  defaultWidth: number = 420,
  defaultHeight: number = 120,
) {
  let nodes: SimNode[] = [];
  // PERF #2: id → SimNode map built ONCE per force initialization
  // (every `rebuild()` in physicsWorker recreates the force, so each
  // call to `initialize` gets a fresh node set). Replaces the previous
  // `nodes.find(...)` call inside the per-link loop — that was O(N) per
  // lookup × 2 lookups per link, blowing up to O(E × N) per tick.
  const nodeById = new Map<string, SimNode>();
  function force(alpha: number) {
    // PERF #15: same idea — strength=0 means each iteration just
    // mutates by 0. Skip the whole link walk.
    if (strength === 0) return;
    for (const link of links) {
      const sourceId = typeof link.source === 'string' ? link.source : (link.source as SimNode).id;
      const targetId = typeof link.target === 'string' ? link.target : (link.target as SimNode).id;
      const a = nodeById.get(sourceId);
      const b = nodeById.get(targetId);
      if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null) continue;
      if (a.layoutAlpha === 0 && b.layoutAlpha === 0) continue;
      const aW = a.width ?? defaultWidth;
      const aH = a.height ?? defaultHeight;
      const bW = b.width ?? defaultWidth;
      const bH = b.height ?? defaultHeight;
      const aLeft = a.x, aRight = a.x + aW, aTop = a.y, aBottom = a.y + aH;
      const bLeft = b.x, bRight = b.x + bW, bTop = b.y, bBottom = b.y + bH;
      const gapX = Math.max(0, Math.max(aLeft - bRight, bLeft - aRight));
      const gapY = Math.max(0, Math.max(aTop - bBottom, bTop - aBottom));
      const borderDist = fastHypot(gapX, gapY);
      const aCx = a.x + aW / 2, aCy = a.y + aH / 2;
      const bCx = b.x + bW / 2, bCy = b.y + bH / 2;
      const dxC = bCx - aCx, dyC = bCy - aCy;
      const distC = fastHypot(dxC, dyC);
      if (distC < 0.001) continue;
      const ux = dxC / distC, uy = dyC / distC;
      // Positive error = too far apart, pull together. Negative = too close, push apart.
      const error = borderDist - targetBorderDistance;
      const correction = error * strength * pairActivity(a, b, alpha);
      if (a.fx == null) a.vx = (a.vx ?? 0) + ux * correction;
      if (a.fy == null) a.vy = (a.vy ?? 0) + uy * correction;
      if (b.fx == null) b.vx = (b.vx ?? 0) - ux * correction;
      if (b.fy == null) b.vy = (b.vy ?? 0) - uy * correction;
    }
  }
  force.initialize = (n: SimNode[]) => {
    nodes = n;
    nodeById.clear();
    for (const node of n) nodeById.set(node.id, node);
  };
  return force;
}

/**
 * Hard cap on per-tick velocity magnitude per axis. Last-resort safety net
 * against runaway force interactions (e.g. a stuck node-padding fight, an
 * arrow keep-out pumping into a tight corner). Should NEVER fire in normal
 * operation — if it does, the underlying force is misbehaving and that
 * deserves investigation, not a tighter cap. Pinned nodes are skipped by
 * d3 at integration time, so user drags are unaffected.
 *
 * Register LAST in the simulation so it sees the velocity values produced
 * by every other force.
 */
export function velocityCap(maxAbsPerAxis: number) {
  let nodes: SimNode[] = [];
  function force() {
    for (const n of nodes) {
      if (n.vx != null && Math.abs(n.vx) > maxAbsPerAxis) {
        n.vx = Math.sign(n.vx) * maxAbsPerAxis;
      }
      if (n.vy != null && Math.abs(n.vy) > maxAbsPerAxis) {
        n.vy = Math.sign(n.vy) * maxAbsPerAxis;
      }
    }
  }
  force.initialize = (n: SimNode[]) => { nodes = n; };
  return force;
}

/**
 * Experimental: replaces `rectLink` for auto-arrow links. The pull on each
 * node is along the direction the rope leaves that node (i.e. toward
 * `chain[1]` for the source, `chain[N-2]` for the target), with magnitude
 * proportional to (rope path length − target). When the rope is straight,
 * tangent ≈ centerline, so behavior matches `rectLink`. When the rope
 * bends around an obstacle, the pull on each node follows the curve —
 * the arrow acts like a real rope bending around a pulley.
 *
 * Pinned nodes (fx/fy set) ignore the pull, same as other forces.
 */
export function ropePullLink(
  links: SimLink[],
  ropeSim: VerletRopeSim,
  targetPathLength: number,
  strength: number,
) {
  let nodes: SimNode[] = [];
  function force(alpha: number) {
    const draggedArrowId = ropeSim.getDraggedArrowId();
    for (const link of links) {
      // While the user is dragging this arrow, don't pull its endpoint
      // nodes — drag is for shaping the arrow, not yanking the nodes.
      if (link.arrowId === draggedArrowId) continue;
      // Skip the pull for chains that were just re-routed. A fresh
      // A* can change chain length by hundreds of pixels in one tick
      // and ropePullLink amplifies that into a velocity spike that
      // mashes endpoint nodes through neighbours. 5 ticks at default
      // velocityDecay is enough for the chain to settle.
      if (ropeSim.ticksSinceRoute(link.arrowId) < 5) continue;
      const chain = ropeSim.getChain(link.arrowId);
      if (!chain || chain.length < 2) continue;
      const a = nodes.find((n) => n.id === endpointId(link.source));
      const b = nodes.find((n) => n.id === endpointId(link.target));
      if (!a || !b || a.x == null || a.y == null || b.x == null || b.y == null) continue;
      let pathLen = 0;
      for (let i = 0; i < chain.length - 1; i++) {
        pathLen += fastHypot(chain[i + 1]!.x - chain[i]!.x, chain[i + 1]!.y - chain[i]!.y);
      }
      const error = pathLen - targetPathLength;
      const correction = error * strength * alpha;
      const c0 = chain[0]!;
      const c1 = chain[1]!;
      const dxA = c1.x - c0.x;
      const dyA = c1.y - c0.y;
      const lenA = fastHypot(dxA, dyA);
      if (lenA > 0.01) {
        const ux = dxA / lenA;
        const uy = dyA / lenA;
        if (a.fx == null) a.vx = (a.vx ?? 0) + ux * correction;
        if (a.fy == null) a.vy = (a.vy ?? 0) + uy * correction;
      }
      const cN1 = chain[chain.length - 1]!;
      const cN2 = chain[chain.length - 2]!;
      const dxB = cN2.x - cN1.x;
      const dyB = cN2.y - cN1.y;
      const lenB = fastHypot(dxB, dyB);
      if (lenB > 0.01) {
        const ux = dxB / lenB;
        const uy = dyB / lenB;
        if (b.fx == null) b.vx = (b.vx ?? 0) + ux * correction;
        if (b.fy == null) b.vy = (b.vy ?? 0) + uy * correction;
      }
    }
  }
  force.initialize = (n: SimNode[]) => { nodes = n; };
  return force;
}

export function pairwiseRepel(
  strength: number,
  range: number,
  pairFilter: (a: string, b: string) => boolean,
) {
  let nodes: SimNode[] = [];
  function force(alpha: number) {
    if (range <= 0) return;
    // PERF #15: skip O(N²) loop when there's nothing to apply. Dev
    // sliders can drag a strength to 0; the old code still walked
    // every pair multiplying by 0.
    if (strength === 0) return;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]!;
      if (a.x == null || a.y == null) continue;
      const aW = a.width ?? 420;
      const aH = a.height ?? 120;
      const aLeft = a.x;
      const aRight = a.x + aW;
      const aTop = a.y;
      const aBottom = a.y + aH;
      const aCx = a.x + aW / 2;
      const aCy = a.y + aH / 2;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]!;
        if (b.x == null || b.y == null) continue;
        if (a.layoutAlpha === 0 && b.layoutAlpha === 0) continue;
        if (!pairFilter(a.id, b.id)) continue;
        const bW = b.width ?? 420;
        const bH = b.height ?? 120;
        const bLeft = b.x;
        const bRight = b.x + bW;
        const bTop = b.y;
        const bBottom = b.y + bH;
        const bCx = b.x + bW / 2;
        const bCy = b.y + bH / 2;
        // Rect-to-rect (border-to-border) Euclidean distance. Per axis,
        // gap = max(0, max(aMin - bMax, bMin - aMax)) — zero whenever the
        // intervals overlap on that axis. Combine via hypot. When both
        // axes overlap (rectangles intersect), borderDist = 0.
        const gapX = Math.max(0, Math.max(aLeft - bRight, bLeft - aRight));
        const gapY = Math.max(0, Math.max(aTop - bBottom, bTop - aBottom));
        const borderDist = fastHypot(gapX, gapY);
        if (borderDist >= range) continue;
        const dxC = bCx - aCx;
        const dyC = bCy - aCy;
        const distC = fastHypot(dxC, dyC);
        const ux = distC < 0.001 ? 1 : dxC / distC;
        const uy = distC < 0.001 ? 0 : dyC / distC;
        const falloff = 1 - borderDist / range;
        const mag = -strength * pairActivity(a, b, alpha) * falloff;
        if (a.fx == null) a.vx = (a.vx ?? 0) - ux * mag;
        if (a.fy == null) a.vy = (a.vy ?? 0) - uy * mag;
        if (b.fx == null) b.vx = (b.vx ?? 0) + ux * mag;
        if (b.fy == null) b.vy = (b.vy ?? 0) + uy * mag;
      }
    }
  }
  force.initialize = (n: SimNode[]) => { nodes = n; };
  return force;
}
