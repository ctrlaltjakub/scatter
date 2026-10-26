/* -------------------------------------------------------------------------
 * Geometric arrow router (replaces the previous Verlet-physics rope).
 *
 * Each arrow's chain of anchors is recomputed every tick from a taut-
 * polyline computed by `routePath` (visibility graph + A*). The polyline
 * goes from source-center through obstacle corners (with margin) to
 * target-center; the first and last points are then snapped to the
 * source/target rect borders using rectBorderToward. Anchors are sampled
 * uniformly along the arc length of this polyline — so the anchor density
 * is consistent regardless of how many bends the route has.
 *
 * Why we abandoned Verlet physics here: pure-physics rope settling has
 * inherent local-minima problems (anchors get stuck on the wrong side of
 * an obstacle, ropes wrap past the destination, jitter on transients).
 * The geometric router has none of these — paths are globally optimal,
 * stable across small node motions, and naturally hug obstacle corners
 * the way a real taut string would.
 *
 * "Instant snap": when a node moves enough that the optimal route
 * changes topology (e.g., shortest side flips from above to below an
 * obstacle), the new polyline replaces the old one immediately. Visually
 * this is a sudden snap; that's the user's chosen trade-off in exchange
 * for predictability.
 *
 * What's still here:
 *   - Anchor-anchor repel between DIFFERENT arrows (post-process), so
 *     parallel routes through the same gap don't overlap pixel-for-pixel.
 *   - Drag handle: while the user is shaping an arrow, the cursor acts as
 *     a forced waypoint and obstacle avoidance is suspended for that arrow.
 *   - Endpoint pinning to source/target borders via rectBorderToward.
 *
 * What's gone (no longer needed):
 *   - Verlet integration, distance constraint, soft node repel, segment-
 *     rect collision, hard-anchor-rect collision, chain-side bias,
 *     ropeDamp, ropeIterations, chainTension, minSegmentLength.
 * ------------------------------------------------------------------------*/

import { computeGaps, polylineLength, routePath, sampleAlongPolyline, type GapInfo, type RoutePoint } from './routePath';
import { fastHypot } from './perfMath';
import { SpatialHash } from './spatialHash';
import { compactRopeAnchors } from './compactRopeAnchors';
import { sourcePortCenter, sourcePortForTarget, sourcePortToward, type SourcePort } from './sourcePort';

export interface RopeAnchor {
  arrowId: string;
  index: number;
  x: number;
  y: number;
  /** Legacy Verlet "previous-tick position". Kept on the type for downstream
   *  compatibility (snapshot serialization etc.); always set equal to x/y
   *  since this sim no longer uses implicit velocity. */
  px: number;
  py: number;
}

export interface RopeRealNode {
  id: string;
  /** Top-left x of the rendered card. */
  x: number;
  /** Top-left y of the rendered card. */
  y: number;
  width: number;
  height: number;
  /**
   * True if the user is currently dragging this node. Dragging rects are
   * "invisible" to obstacle avoidance — arrows pass through them while
   * the user is moving the body, so they don't snap into pretzel shapes
   * mid-drag. Cleared automatically on drag-end.
   */
  dragging?: boolean;
}

export interface RopeLink {
  arrowId: string;
  sourceId: string;
  targetId: string;
  sourcePort?: SourcePort;
}

export interface RopeConfig {
  /** Target spacing (px) between adjacent anchors when sampling along the
   *  routed polyline. Smaller = smoother bezier, more anchors. */
  maxSegmentLength: number;
  /** Hard cap on anchors per chain. */
  maxAnchorCount: number;
  /** Inflation (px) applied to every obstacle when building the visibility
   *  graph. The rope's bends sit at obstacle corners + margin, so this is
   *  the visual "clearance" between rope and node bodies. */
  margin: number;
  /** Push between rope anchors of DIFFERENT arrows. 0..1, fraction of
   *  (range - dist) closed per pass. Applied as a single post-pass so
   *  parallel routes through the same gap visibly separate. */
  arrowRepelStrength: number;
  /** Distance at which arrow-arrow repel falls off to zero. */
  arrowRepelRange: number;
  /** When true, nodes flagged as `dragging` are skipped by the router so
   *  ropes pass through them. When false (default), dragging nodes are
   *  treated as ordinary obstacles. */
  exemptDraggedNodes: boolean;
}

/** Floor on chain length — a rope ALWAYS keeps at least this many anchors
 *  for smooth bezier rendering (3 control points minimum produce visible
 *  curvature). */
const MIN_ANCHOR_COUNT = 4;

/**
 * State for "the user is dragging this arrow". While set, the dragged
 * arrow's chain is routed through the cursor as a forced waypoint and
 * obstacle avoidance is suspended for that chain.
 */
export interface DraggedAnchor {
  arrowId: string;
  /** Anchor index closest to the cursor at drag-start. Kept for API
   *  compatibility; not strictly used by the geometric router (the cursor
   *  itself is the waypoint), but the user-facing semantics are the same. */
  anchorIndex: number;
  x: number;
  y: number;
}

/**
 * Owns one chain per arrow. Each chain is a series of anchor "particles"
 * with persistent state — positions evolve via Verlet integration under
 * smoothing + obstacle-repel forces (force-directed edge routing). A*
 * runs ONLY at chain creation / explicit re-route events, never every
 * tick. This avoids topology-flip jitter that comes from re-routing on
 * every frame.
 *
 * Forces per tick on each interior anchor:
 *   - Smoothing: pull toward midpoint of neighbours (Laplacian)
 *   - Obstacle repel: push out of every non-endpoint node body within
 *     ~margin distance
 *   - Tangent-aware inter-arrow repel (post-pass): lane separation
 *     between parallel rope segments, no-op at crossings
 *
 * Then a safety re-projection pushes any interior anchor that ended up
 * inside `margin` of a non-endpoint node back out.
 */
export class VerletRopeSim {
  private chains = new Map<string, RopeAnchor[]>();
  private linksByArrow = new Map<string, RopeLink>();
  private dragged: DraggedAnchor | null = null;
  /** Arrows that have been routed at least once via A*. Chains not in
   *  this set get an initial route on their first tick (so a freshly
   *  created arrow appears with the right shape immediately). */
  private routed = new Set<string>();
  /** Position of source/target rects at the time of each chain's most
   *  recent A* route. When the current rect drifts more than
   *  RECT_DRIFT_REROUTE_THRESHOLD from these the chain auto-reroutes —
   *  this is what makes the rope re-pick its topology when a node
   *  drag moves an endpoint a significant distance. */
  private lastRoutedSrc = new Map<string, { x: number; y: number; w: number; h: number }>();
  private lastRoutedTgt = new Map<string, { x: number; y: number; w: number; h: number }>();
  /** Number of ticks since each chain was last A*-routed. ropePullLink
   *  reads this via `tickssSinceRoute()` and skips the rope-tension
   *  pull on chains that were just routed — a fresh reroute can change
   *  chain length by hundreds of pixels in one tick, and ropePullLink
   *  amplifies that into a velocity correction strong enough to mash
   *  endpoint nodes through their rectCollide neighbours. */
  private ticksSinceRouteByArrow = new Map<string, number>();
  /** Last tick's Phase-B net delta per anchor. Used by the anti-
   *  oscillation damper: if this tick's delta opposes the previous,
   *  halve it to break a steady oscillation. */
  private lastPhaseBDelta = new WeakMap<RopeAnchor, { x: number; y: number }>();
  /** Only arrows affected by a recent geometry change keep running the
   *  relaxation solver. Unrelated saved ropes remain exact, inert obstacles. */
  private activeTicksByArrow = new Map<string, number>();
  private lastRealRects = new Map<string, RopeRealNode>();
  private hasRealRectBaseline = false;

  private activate(arrowId: string, ticks = 8): void {
    this.activeTicksByArrow.set(
      arrowId,
      Math.max(ticks, this.activeTicksByArrow.get(arrowId) ?? 0),
    );
  }

  hasChain(arrowId: string): boolean {
    return this.chains.has(arrowId);
  }

  /** Image layout changes affect this rope only; they never wake node forces. */
  setSourcePort(arrowId: string, sourcePort?: SourcePort): void {
    const link = this.linksByArrow.get(arrowId);
    if (!link) return;
    this.linksByArrow.set(arrowId, { ...link, sourcePort });
    this.markForReroute(arrowId);
  }

  /**
   * Create the chain for an arrow. The chain is seeded with either the
   * persisted anchor positions (so a freshly-loaded project doesn't flash
   * a straight line before the worker emits its first tick) or a straight
   * line between border ports. Persisted anchors remain settled until an
   * actual geometry/configuration change calls for a fresh route.
   *
   * Idempotent — silently returns if the chain already exists.
   */
  ensureChain(
    link: RopeLink,
    srcRect: RopeRealNode,
    tgtRect: RopeRealNode,
    _minSegLen: number,
    maxSegLen: number,
    maxCount: number,
    initialAnchors?: { x: number; y: number }[],
  ): void {
    if (this.chains.has(link.arrowId)) return;
    let anchors: RopeAnchor[];
    if (initialAnchors && initialAnchors.length >= 2) {
      const compact = compactRopeAnchors(initialAnchors, maxSegLen, maxCount) ?? initialAnchors;
      anchors = compact.map((p, i) => ({
        arrowId: link.arrowId, index: i,
        x: p.x, y: p.y, px: p.x, py: p.y,
      }));
    } else {
      const tgtCenter = { x: tgtRect.x + tgtRect.width / 2, y: tgtRect.y + tgtRect.height / 2 };
      const srcCenter = link.sourcePort ? sourcePortCenter(link.sourcePort, srcRect, tgtCenter)
        : { x: srcRect.x + srcRect.width / 2, y: srcRect.y + srcRect.height / 2 };
      const srcEnd = link.sourcePort ? sourcePortToward(link.sourcePort, srcRect, tgtCenter) : rectBorderToward(srcRect, tgtCenter);
      const tgtEnd = rectBorderToward(tgtRect, srcCenter);
      const portDist = fastHypot(tgtEnd.x - srcEnd.x, tgtEnd.y - srcEnd.y);
      const desiredSegments = Math.max(1, Math.round(portDist / Math.max(1, maxSegLen)));
      const N = Math.max(MIN_ANCHOR_COUNT, Math.min(maxCount, desiredSegments + 1));
      anchors = [];
      for (let i = 0; i < N; i++) {
        const t = i / (N - 1);
        const x = srcEnd.x + (tgtEnd.x - srcEnd.x) * t;
        const y = srcEnd.y + (tgtEnd.y - srcEnd.y) * t;
        anchors.push({ arrowId: link.arrowId, index: i, x, y, px: x, py: y });
      }
    }
    this.chains.set(link.arrowId, anchors);
    this.linksByArrow.set(link.arrowId, link);
    // A persisted chain is already the last accepted route for this arrow.
    // Treat it as settled instead of throwing the shape away on the first
    // worker tick and running A* for every arrow in a restored project.
    // A later endpoint drag, real size change, or piercing check still marks
    // the chain for a fresh route in the normal way.
    if (initialAnchors && initialAnchors.length >= 2) {
      this.routed.add(link.arrowId);
      this.ticksSinceRouteByArrow.set(link.arrowId, 1);
      this.lastRoutedSrc.set(link.arrowId, {
        x: srcRect.x, y: srcRect.y, w: srcRect.width, h: srcRect.height,
      });
      this.lastRoutedTgt.set(link.arrowId, {
        x: tgtRect.x, y: tgtRect.y, w: tgtRect.width, h: tgtRect.height,
      });
    } else {
      this.activate(link.arrowId);
    }
  }

  removeChain(arrowId: string): void {
    this.chains.delete(arrowId);
    this.linksByArrow.delete(arrowId);
    this.routed.delete(arrowId);
    this.lastRoutedSrc.delete(arrowId);
    this.lastRoutedTgt.delete(arrowId);
    this.activeTicksByArrow.delete(arrowId);
  }

  /** Mark a chain as needing a fresh A* route on the next tick. Worker
   *  calls this on events that should re-shape an arrow (drag-end on a
   *  connected node, add-link, remove-nodes, etc.). */
  markForReroute(arrowId: string): void {
    this.routed.delete(arrowId);
    this.activate(arrowId);
  }

  /** Physics-setting changes can alter every route's clearance/density. */
  markAllForReroute(): void {
    for (const arrowId of this.chains.keys()) this.markForReroute(arrowId);
  }

  /** Mostly for tests. */
  getChain(arrowId: string): readonly RopeAnchor[] | undefined {
    return this.chains.get(arrowId);
  }

  /** Snapshot for the worker output message. */
  snapshot(): Record<string, { x: number; y: number }[]> {
    const out: Record<string, { x: number; y: number }[]> = {};
    for (const [arrowId, chain] of this.chains.entries()) {
      out[arrowId] = chain.map((a) => ({ x: a.x, y: a.y }));
    }
    return out;
  }

  /** Drop chains that reference arrows no longer present. */
  prune(activeArrowIds: Set<string>): void {
    for (const id of Array.from(this.chains.keys())) {
      if (!activeArrowIds.has(id)) this.removeChain(id);
    }
  }

  /** Begin an arrow drag gesture. Picks the closest interior anchor to
   *  (x, y) — used only for index reporting; the cursor itself becomes the
   *  forced waypoint while the drag is active. */
  startAnchorDrag(arrowId: string, x: number, y: number): void {
    const chain = this.chains.get(arrowId);
    if (!chain || chain.length < 3) return;
    let bestI = 1;
    let bestD = Infinity;
    for (let i = 1; i < chain.length - 1; i++) {
      const a = chain[i]!;
      const d = (a.x - x) * (a.x - x) + (a.y - y) * (a.y - y);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    this.dragged = { arrowId, anchorIndex: bestI, x, y };
    this.activate(arrowId);
  }

  /** Update the dragged arrow's cursor waypoint. No-op if no drag. */
  moveDraggedAnchor(arrowId: string, x: number, y: number): void {
    if (!this.dragged || this.dragged.arrowId !== arrowId) return;
    this.dragged.x = x;
    this.dragged.y = y;
    this.activate(arrowId);
  }

  /** End an arrow drag gesture. The released chain is flagged for a
   *  fresh A* route on the next tick so it returns to its
   *  obstacle-avoiding shape instead of staying at the 3-point cursor
   *  configuration. */
  endAnchorDrag(arrowId: string): void {
    if (!this.dragged || this.dragged.arrowId !== arrowId) return;
    this.dragged = null;
    this.routed.delete(arrowId);
    this.activate(arrowId);
  }

  /** For consumers (ropePullLink) that should skip a dragged arrow's pull. */
  getDraggedArrowId(): string | null {
    return this.dragged?.arrowId ?? null;
  }

  /**
   * Run A* routing for every chain that's flagged as needing a fresh
   * route (newly created, or markForReroute() was called). Handles
   * lane assignment across arrows sharing a gap, then resamples
   * anchors uniformly along the resulting polyline. Anchor count is
   * fixed for the chain's subsequent lifetime so that per-tick
   * dynamics don't cause topology flips.
   */
  private rerouteFlagged(reals: Map<string, RopeRealNode>, cfg: RopeConfig): void {
    let hasFlaggedChain = false;
    for (const arrowId of this.chains.keys()) {
      if (!this.routed.has(arrowId)) {
        hasFlaggedChain = true;
        break;
      }
    }
    // computeGaps + visibility-graph setup is intentionally expensive and is
    // needed only for an actual A* reroute, not for ordinary relaxation ticks.
    if (!hasFlaggedChain) return;
    const realsArr = Array.from(reals.values());
    const globalObstacles: { rect: RopeRealNode; id: string }[] = [];
    for (const r of realsArr) {
      if (cfg.exemptDraggedNodes && r.dragging) continue;
      globalObstacles.push({ rect: r, id: r.id });
    }
    const gaps = computeGaps(globalObstacles, cfg.margin);
    const midpointToGap = new Map<string, { gapKey: string; isEntry: boolean }>();
    const gapByKey = new Map<string, GapInfo>();
    const coordKey = (x: number, y: number) => `${x.toFixed(2)},${y.toFixed(2)}`;
    for (const g of gaps) {
      gapByKey.set(g.key, g);
      midpointToGap.set(coordKey(g.entry.x, g.entry.y), { gapKey: g.key, isEntry: true });
      midpointToGap.set(coordKey(g.exit.x, g.exit.y),   { gapKey: g.key, isEntry: false });
    }

    interface Routed {
      arrowId: string;
      chain: RopeAnchor[];
      polyline: RoutePoint[];
      gapUsage: Map<string, { entryIdx?: number; exitIdx?: number }>;
    }
    const routedChains: Routed[] = [];

    for (const [arrowId, chain] of this.chains.entries()) {
      if (this.routed.has(arrowId)) continue;
      const link = this.linksByArrow.get(arrowId);
      if (!link) continue;
      const src = reals.get(link.sourceId);
      const tgt = reals.get(link.targetId);
      if (!src || !tgt) continue;

      const obstacles = globalObstacles.filter(
        (o) => o.id !== link.sourceId && o.id !== link.targetId,
      );
      const port = link.sourcePort && sourcePortForTarget(link.sourcePort, src, { x: tgt.x + tgt.width / 2, y: tgt.y + tgt.height / 2 });
      const source = port ? { ...sourcePortCenter(port, src), width: 0, height: 0 } : src;
      const polyline = routePath(source, tgt, obstacles, cfg.margin, gaps);

      const gapUsage = new Map<string, { entryIdx?: number; exitIdx?: number }>();
      for (let i = 1; i < polyline.length - 1; i++) {
        const wp = polyline[i]!;
        const m = midpointToGap.get(coordKey(wp.x, wp.y));
        if (!m) continue;
        const u = gapUsage.get(m.gapKey) ?? {};
        if (m.isEntry) u.entryIdx = i; else u.exitIdx = i;
        gapUsage.set(m.gapKey, u);
      }
      if (polyline.length >= 2) {
        polyline[0] = port ? sourcePortToward(port, src, polyline[1]!) : rectBorderToward(src, polyline[1]!);
        polyline[polyline.length - 1] = rectBorderToward(tgt, polyline[polyline.length - 2]!);
      }
      routedChains.push({ arrowId, chain, polyline, gapUsage });
    }

    // Lane assignment across arrows sharing a gap.
    const gapUsers = new Map<string, string[]>();
    for (const r of routedChains) {
      for (const gapKey of r.gapUsage.keys()) {
        const arr = gapUsers.get(gapKey) ?? [];
        arr.push(r.arrowId);
        gapUsers.set(gapKey, arr);
      }
    }
    for (const arr of gapUsers.values()) arr.sort();
    for (const r of routedChains) {
      for (const [gapKey, idxs] of r.gapUsage) {
        const users = gapUsers.get(gapKey)!;
        const N = users.length;
        if (N <= 1) continue;
        const laneIdx = users.indexOf(r.arrowId);
        const gap = gapByKey.get(gapKey)!;
        const offsetFrac = (laneIdx + 1) / (N + 1) - 0.5;
        const offset = offsetFrac * gap.perpExtent;
        if (gap.orientation === 'vertical') {
          if (idxs.entryIdx != null) r.polyline[idxs.entryIdx]!.y = gap.perpMid + offset;
          if (idxs.exitIdx != null)  r.polyline[idxs.exitIdx]!.y  = gap.perpMid + offset;
        } else {
          if (idxs.entryIdx != null) r.polyline[idxs.entryIdx]!.x = gap.perpMid + offset;
          if (idxs.exitIdx != null)  r.polyline[idxs.exitIdx]!.x  = gap.perpMid + offset;
        }
      }
    }

    // Resample anchors uniformly along the routed polyline.
    for (const r of routedChains) {
      const { arrowId, chain, polyline } = r;
      const length = polylineLength(polyline);
      let totalTurn = 0;
      for (let i = 1; i < polyline.length - 1; i++) {
        const prev = polyline[i - 1]!;
        const curr = polyline[i]!;
        const next = polyline[i + 1]!;
        const v1x = curr.x - prev.x, v1y = curr.y - prev.y;
        const v2x = next.x - curr.x, v2y = next.y - curr.y;
        const cross = v1x * v2y - v1y * v2x;
        const dot = v1x * v2x + v1y * v2y;
        totalTurn += Math.abs(Math.atan2(cross, dot));
      }
      const baseSegments = Math.max(1, Math.round(length / Math.max(1, cfg.maxSegmentLength)));
      const curvatureBonus = Math.round((totalTurn / (Math.PI / 2)) * 4);
      const N = Math.max(
        MIN_ANCHOR_COUNT,
        Math.min(cfg.maxAnchorCount, baseSegments + curvatureBonus + 1),
      );

      const uniformSamples = sampleAlongPolyline(polyline, N);
      const samples = compactRopeAnchors(
        uniformSamples,
        cfg.maxSegmentLength,
        cfg.maxAnchorCount,
      ) ?? uniformSamples;
      while (chain.length > samples.length) chain.pop();
      while (chain.length < samples.length) {
        const i = chain.length;
        const s = samples[i]!;
        chain.push({ arrowId, index: i, x: s.x, y: s.y, px: s.x, py: s.y });
      }
      for (let i = 0; i < samples.length; i++) {
        const a = chain[i]!;
        const s = samples[i]!;
        a.x = s.x; a.y = s.y;
        a.px = s.x; a.py = s.y; // start at rest
        a.index = i;
      }
      this.routed.add(arrowId);
      this.activate(arrowId);
      this.ticksSinceRouteByArrow.set(arrowId, 0);
      const link = this.linksByArrow.get(arrowId)!;
      const src = reals.get(link.sourceId)!;
      const tgt = reals.get(link.targetId)!;
      this.lastRoutedSrc.set(arrowId, { x: src.x, y: src.y, w: src.width, h: src.height });
      this.lastRoutedTgt.set(arrowId, { x: tgt.x, y: tgt.y, w: tgt.width, h: tgt.height });
    }
  }

  /** Ticks since the named arrow's chain was last A*-routed, or
   *  Infinity if never routed. Used by ropePullLink to skip the rope-
   *  tension pull when a chain has just changed shape. */
  ticksSinceRoute(arrowId: string): number {
    return this.ticksSinceRouteByArrow.get(arrowId) ?? Infinity;
  }

  /** Inspect every chain's current shape and flag for reroute if it
   *  has developed a foldback (consecutive segments forming a > 120°
   *  reversal) or any anchor is inside an obstacle. These are the
   *  signs that the FDER dynamics have failed to maintain a valid
   *  rope shape — typically because a node moved through the chain's
   *  path. Cheap O(N) check per chain. */
  private markBrokenChainsForReroute(
    realsArr: readonly RopeRealNode[],
    nodeGrid: SpatialHash<number>,
    activeArrowIds: ReadonlySet<string>,
  ): void {
    const FOLD_COS = -0.5; // ≥ 120° between consecutive segments
    const candidates: number[] = [];
    const seen = new Int32Array(realsArr.length);
    let queryId = 0;
    for (const [arrowId, chain] of this.chains) {
      if (!activeArrowIds.has(arrowId)) continue;
      if (!this.routed.has(arrowId)) continue;
      if (chain.length < 3) continue;
      let broken = false;
      // Foldback check.
      for (let i = 1; i < chain.length - 1; i++) {
        const a = chain[i - 1]!, b = chain[i]!, c = chain[i + 1]!;
        const v1x = b.x - a.x, v1y = b.y - a.y;
        const v2x = c.x - b.x, v2y = c.y - b.y;
        const m1 = fastHypot(v1x, v1y), m2 = fastHypot(v2x, v2y);
        if (m1 < 0.01 || m2 < 0.01) continue;
        const cos = (v1x * v2x + v1y * v2y) / (m1 * m2);
        if (cos < FOLD_COS) { broken = true; break; }
      }
      // Anchor-inside-obstacle and segment-crosses-obstacle checks
      // against every non-endpoint node. Only DEEP piercings (> 5 px)
      // trigger re-route — tiny corner nicks let dynamics smooth them
      // out across a few ticks instead of firing a reroute every tick
      // (which would reset adjacent anchors and prevent convergence).
      const PIERCE_REROUTE_THRESHOLD = 5;
      if (!broken) {
        const link = this.linksByArrow.get(arrowId);
        if (link) {
          for (let i = 0; i < chain.length - 1; i++) {
            const a = chain[i]!, b = chain[i + 1]!;
            candidates.length = 0;
            nodeGrid.query(
              Math.min(a.x, b.x), Math.min(a.y, b.y),
              Math.max(a.x, b.x), Math.max(a.y, b.y),
              candidates,
            );
            queryId++;
            for (const nodeIndex of candidates) {
              if (seen[nodeIndex] === queryId) continue;
              seen[nodeIndex] = queryId;
              const r = realsArr[nodeIndex]!;
              if (r.id === link.sourceId || r.id === link.targetId) continue;
              if (segmentRectDepth(a, b, r) > PIERCE_REROUTE_THRESHOLD) {
                broken = true; break;
              }
            }
            if (broken) break;
          }
        }
      }
      if (broken) this.routed.delete(arrowId);
    }
  }

  /**
   * Find the small set of ropes affected by node movement. Incident arrows
   * are always active. A non-incident rope is activated only when the old or
   * new node rectangle overlaps its clearance corridor. Static ropes still
   * participate as collision obstacles, but are not themselves integrated.
   */
  private collectActiveArrows(
    reals: Map<string, RopeRealNode>,
    cfg: RopeConfig,
  ): Set<string> {
    const active = new Set<string>();
    for (const [arrowId, ticks] of this.activeTicksByArrow) {
      if (ticks > 0 && this.chains.has(arrowId)) active.add(arrowId);
    }
    if (this.dragged) active.add(this.dragged.arrowId);

    const movedIds = new Set<string>();
    const changedRects: RopeRealNode[] = [];
    for (const r of reals.values()) {
      const prev = this.lastRealRects.get(r.id);
      const changed = this.hasRealRectBaseline && (!prev
        || Math.abs(prev.x - r.x) > 0.25
        || Math.abs(prev.y - r.y) > 0.25
        || Math.abs(prev.width - r.width) > 0.25
        || Math.abs(prev.height - r.height) > 0.25
        || !!prev.dragging !== !!r.dragging);
      if (changed) {
        movedIds.add(r.id);
        changedRects.push(r);
        if (prev) changedRects.push(prev);
      }
    }

    if (movedIds.size > 0) {
      const segmentGrid = new SpatialHash<string>(128);
      for (const [arrowId, chain] of this.chains) {
        for (let i = 0; i + 1 < chain.length; i++) {
          const a = chain[i]!, b = chain[i + 1]!;
          segmentGrid.insert(
            arrowId,
            Math.min(a.x, b.x), Math.min(a.y, b.y),
            Math.max(a.x, b.x), Math.max(a.y, b.y),
          );
        }
      }
      const nearby: string[] = [];
      const clearance = cfg.margin + 16;
      for (const rect of changedRects) {
        nearby.length = 0;
        segmentGrid.query(
          rect.x - clearance, rect.y - clearance,
          rect.x + rect.width + clearance,
          rect.y + rect.height + clearance,
          nearby,
        );
        for (const arrowId of nearby) {
          active.add(arrowId);
          this.activate(arrowId);
        }
      }
      for (const [arrowId, link] of this.linksByArrow) {
        if (movedIds.has(link.sourceId) || movedIds.has(link.targetId)) {
          active.add(arrowId);
          this.activate(arrowId);
        }
      }
    }

    this.lastRealRects.clear();
    for (const [id, r] of reals) this.lastRealRects.set(id, { ...r });
    this.hasRealRectBaseline = true;
    return active;
  }

  /**
   * Per-tick rope dynamics. Two phases:
   *   1. Re-route any chains flagged as not-yet-routed (newly created
   *      or markForReroute()'d).
   *   2. Force-directed integration on each chain: smoothing + obstacle
   *      repel → Verlet step. Endpoints snap to source/target rect
   *      borders each tick (so the rope visually follows when a node
   *      moves). Inter-arrow tangent-aware repel runs as a post-pass.
   *      Final re-projection nudges any anchor that ended up inside
   *      `margin` of a non-endpoint node back out.
   */
  tick(reals: Map<string, RopeRealNode>, cfg: RopeConfig): void {
    // Bump the "ticks since route" counter for every chain BEFORE any
    // potential reroute resets it.
    for (const [arrowId, n] of this.ticksSinceRouteByArrow) {
      this.ticksSinceRouteByArrow.set(arrowId, n + 1);
    }
    const realsArr = Array.from(reals.values());
    const activeArrowIds = this.collectActiveArrows(reals, cfg);
    if (activeArrowIds.size === 0) return;
    // Broad-phase node index shared by piercing validation and every
    // segment-vs-rect collision pass. A card normally occupies only a few
    // cells, so a rope segment now sees nearby cards instead of all cards in
    // the project. Exact collision functions below remain unchanged.
    const nodeGrid = new SpatialHash<number>(512);
    for (let i = 0; i < realsArr.length; i++) {
      const r = realsArr[i]!;
      nodeGrid.insert(i, r.x, r.y, r.x + r.width, r.y + r.height);
    }
    this.markBrokenChainsForReroute(realsArr, nodeGrid, activeArrowIds);
    this.rerouteFlagged(reals, cfg);

    const draggedId = this.dragged?.arrowId ?? null;

    // ---- Phase A: per-chain force application + Verlet integration ----
    for (const [arrowId, chain] of this.chains.entries()) {
      if (!activeArrowIds.has(arrowId)) continue;
      const link = this.linksByArrow.get(arrowId);
      if (!link || chain.length < 2) continue;
      const src = reals.get(link.sourceId);
      const tgt = reals.get(link.targetId);
      if (!src || !tgt) continue;

      // Mid-arrow drag → 3-point straight chain through cursor.
      const port = link.sourcePort && sourcePortForTarget(link.sourcePort, src, { x: tgt.x + tgt.width / 2, y: tgt.y + tgt.height / 2 });
      if (this.dragged && this.dragged.arrowId === arrowId) {
        const srcC = { x: src.x + src.width / 2, y: src.y + src.height / 2 };
        const tgtC = { x: tgt.x + tgt.width / 2, y: tgt.y + tgt.height / 2 };
        const srcAt = port ? sourcePortToward(port, src, this.dragged) : rectBorderToward(src, srcC);
        const tgtAt = rectBorderToward(tgt, tgtC);
        // Use 3 anchors for the dragged shape: src-border, cursor, tgt-border.
        while (chain.length > 3) chain.pop();
        while (chain.length < 3) chain.push({ arrowId, index: chain.length, x: 0, y: 0, px: 0, py: 0 });
        chain[0]!.x = srcAt.x; chain[0]!.y = srcAt.y;
        chain[0]!.px = srcAt.x; chain[0]!.py = srcAt.y;
        chain[1]!.x = this.dragged.x; chain[1]!.y = this.dragged.y;
        chain[1]!.px = this.dragged.x; chain[1]!.py = this.dragged.y;
        chain[2]!.x = tgtAt.x; chain[2]!.y = tgtAt.y;
        chain[2]!.px = tgtAt.x; chain[2]!.py = tgtAt.y;
        // After drag-end the worker will markForReroute() to restore
        // proper routing.
        continue;
      }

      // Endpoint update: snap first/last anchor to source/target border.
      // Use the immediately-adjacent interior anchor as direction hint.
      const srcHint = chain[1]!;
      const tgtHint = chain[chain.length - 2]!;
      const srcAttach = port ? sourcePortToward(port, src, srcHint) : rectBorderToward(src, srcHint);
      const tgtAttach = rectBorderToward(tgt, tgtHint);
      chain[0]!.x = srcAttach.x; chain[0]!.y = srcAttach.y;
      chain[0]!.px = srcAttach.x; chain[0]!.py = srcAttach.y;
      const last = chain[chain.length - 1]!;
      last.x = tgtAttach.x; last.y = tgtAttach.y;
      last.px = tgtAttach.x; last.py = tgtAttach.y;

      if (chain.length < 3) continue; // no interior to integrate

      // Force accumulators per interior anchor.
      const accumX = new Float64Array(chain.length);
      const accumY = new Float64Array(chain.length);

      // Two substeps per tick: each substep applies Laplacian smoothing
      // (pull each anchor toward midpoint of its neighbours) and a
      // Verlet integration step. Substepping lets the chain settle
      // more thoroughly per tick — single-step at high SMOOTH leaves
      // chains visibly oscillating during dynamic drags; multiple
      // smaller steps converge cleaner.
      const SMOOTH = 0.18;
      const DAMPING = 0.4;
      const SUBSTEPS = 2;
      for (let step = 0; step < SUBSTEPS; step++) {
        // Compute smoothing accel for every interior anchor of THIS chain
        // (zero out reused buffer each substep).
        for (let i = 1; i < chain.length - 1; i++) {
          const a = chain[i]!, p = chain[i - 1]!, n = chain[i + 1]!;
          accumX[i] = SMOOTH * ((p.x + n.x) / 2 - a.x);
          accumY[i] = SMOOTH * ((p.y + n.y) / 2 - a.y);
        }
        for (let i = 1; i < chain.length - 1; i++) {
          const a = chain[i]!;
          const vx = (a.x - a.px) * DAMPING;
          const vy = (a.y - a.py) * DAMPING;
          a.px = a.x; a.py = a.y;
          a.x = a.x + vx + accumX[i]!;
          a.y = a.y + vy + accumY[i]!;
        }
      }
    }

    // === Stage B — segment-based ("fat capsule") collision ===
    //
    // Each chain segment is treated as a thick CAPSULE of width
    // ROPE_WIDTH. We iteratively push:
    //   1. Each segment AWAY from non-endpoint node rects, by at
    //      least cfg.margin + half-rope-width clearance.
    //   2. Each pair of segments from DIFFERENT chains apart, so
    //      two ropes don't overlap (separation = ROPE_WIDTH).
    // Pushes distribute to each segment's two anchors based on
    // WHERE along the segment the closest point is (t ∈ [0,1]).
    // Endpoint anchors (first/last of each chain) are exempt — they
    // stay pinned to source/target rect borders by Phase A.
    //
    // 3 passes of each is enough for visible convergence without
    // ping-pong. No "oscillation midpoint" needed — segment forces
    // are smooth and bounded.
    const ROPE_WIDTH = 16;
    const halfRope = ROPE_WIDTH / 2;
    const rectClearance = cfg.margin + halfRope;
    const segClearance = ROPE_WIDTH; // capsule-capsule separation
    // Different push strengths per interaction. Rect push is GENTLE so
    // that a segment squeezed between two close rects (e.g. G.bottom &
    // Y.top with only 25 px between them) doesn't overshoot from one
    // into the other; the two pushes balance smoothly at the gap
    // midpoint over a few ticks. Segment-segment push is FIRMER so
    // parallel ropes don't visibly overlap.
    // Smaller per-iter fractions paired with MANY iterations: lets
    // the chain settle to its actual equilibrium WITHIN one tick,
    // instead of carrying the unresolved residual into the next tick
    // (which is what produced the persistent 2-tick bistable
    // oscillation visible in arrow_F_U's trace).
    const PUSH_FRAC_RECT = 0.06;
    const PUSH_FRAC_SEG  = 0.10;
    const PUSH_FRAC_HARD = 0.20;
    // Hard exclusion zone — segment NEVER inside this distance of a
    // rect. Strong push to escape if inside.
    const hardRectClear = halfRope + 2;
    // Per-tick anchor displacement cap. Without this, an interior
    // anchor squeezed by multiple obstacles can swing 20+ px per tick
    // (segment-vs-rect pushes from G, segment-vs-segment pushes from
    // a nearby rope, smoothing pulls back) producing visible shaking.
    // Capping at ~8 px keeps each tick's motion smooth.
    const MAX_DISPLACEMENT_PER_TICK = 8;

    // Remember anchor positions at start of Phase B so we can clamp
    // each anchor's TOTAL Phase-B displacement at the end.
    const phaseBStart = new Map<RopeAnchor, { x: number; y: number }>();
    for (const [arrowId, chain] of this.chains.entries()) {
      if (arrowId === draggedId) continue;
      if (!activeArrowIds.has(arrowId)) continue;
      for (let i = 1; i < chain.length - 1; i++) {
        const a = chain[i]!;
        phaseBStart.set(a, { x: a.x, y: a.y });
      }
    }

    // Iterate to per-tick convergence: each iter applies SMALL push
    // fractions, then we check max displacement across all anchors.
    // Bail out when motion < CONV_THRESHOLD (chain is at equilibrium
    // for the current obstacle/neighbor configuration). This stops
    // the bistable oscillation where competing constraints alternate
    // every tick: at equilibrium NEITHER constraint has anything to
    // push against, so no shake.
    const CONV_THRESHOLD = 0.3;
    const MAX_ITERS = 18;
    // PERF #12: segList structure (which arrow, which chain, which
    // segment-idx) is invariant across iters within a single tick — no
    // chain changes shape mid-tick (Phase B mutates anchor x/y only,
    // never chain.length or composition). Build once, reuse for all
    // iters of Phase B.2 below.
    const segList: { arrowId: string; chain: RopeAnchor[]; segIdx: number }[] = [];
    for (const [arrowId, chain] of this.chains.entries()) {
      if (arrowId === draggedId) continue;
      if (chain.length < 2) continue;
      for (let i = 0; i < chain.length - 1; i++) {
        segList.push({ arrowId, chain, segIdx: i });
      }
    }
    const rectCandidates: number[] = [];
    const rectSeen = new Int32Array(realsArr.length);
    let rectQueryId = 0;
    const segCandidates: number[] = [];
    const segSeen = new Int32Array(segList.length);
    let segQueryId = 0;
    for (let pass = 0; pass < MAX_ITERS; pass++) {
      // Snapshot pre-iter positions for the convergence check at end.
      const preIterPos = new Map<RopeAnchor, { x: number; y: number }>();
      for (const [arrowId, chain] of this.chains.entries()) {
        if (arrowId === draggedId) continue;
        if (!activeArrowIds.has(arrowId)) continue;
        for (let i = 1; i < chain.length - 1; i++) {
          const a = chain[i]!;
          preIterPos.set(a, { x: a.x, y: a.y });
        }
      }
      // --- B.1: segment-vs-rect (each segment away from non-endpoint nodes) ---
      for (const [arrowId, chain] of this.chains.entries()) {
        if (arrowId === draggedId) continue;
        if (!activeArrowIds.has(arrowId)) continue;
        if (chain.length < 2) continue;
        const link = this.linksByArrow.get(arrowId);
        if (!link) continue;
        for (let i = 0; i < chain.length - 1; i++) {
          const a = chain[i]!, b = chain[i + 1]!;
          // Segment bbox inflated by rectClearance — any rect not
          // overlapping this can't be within the active range.
          const segMinX = Math.min(a.x, b.x) - rectClearance;
          const segMaxX = Math.max(a.x, b.x) + rectClearance;
          const segMinY = Math.min(a.y, b.y) - rectClearance;
          const segMaxY = Math.max(a.y, b.y) + rectClearance;
          rectCandidates.length = 0;
          nodeGrid.query(segMinX, segMinY, segMaxX, segMaxY, rectCandidates);
          rectQueryId++;
          for (const nodeIndex of rectCandidates) {
            if (rectSeen[nodeIndex] === rectQueryId) continue;
            rectSeen[nodeIndex] = rectQueryId;
            const r = realsArr[nodeIndex]!;
            if (r.id === link.sourceId || r.id === link.targetId) continue;
            if (cfg.exemptDraggedNodes && r.dragging) continue;
            // Bbox reject before the more expensive sampling.
            if (r.x + r.width < segMinX || r.x > segMaxX) continue;
            if (r.y + r.height < segMinY || r.y > segMaxY) continue;
            const cp = closestPointOnSegmentToRect(a, b, r);
            if (cp.dist >= rectClearance) continue;
            const overshoot = rectClearance - cp.dist;
            let nx: number, ny: number;
            if (cp.dist < 0.01) {
              // Closest point is inside the rect — push toward nearest face.
              const dL = cp.sx - r.x, dR = (r.x + r.width) - cp.sx;
              const dT = cp.sy - r.y, dB = (r.y + r.height) - cp.sy;
              const minD = Math.min(dL, dR, dT, dB);
              if (minD === dL) { nx = -1; ny = 0; }
              else if (minD === dR) { nx = 1; ny = 0; }
              else if (minD === dT) { nx = 0; ny = -1; }
              else { nx = 0; ny = 1; }
            } else {
              nx = (cp.sx - cp.cx) / cp.dist;
              ny = (cp.sy - cp.cy) / cp.dist;
            }
            // Three-tier push:
            //   - PIERCING (segment sample inside rect): strong push
            //     proportional to penetration depth — segment never
            //     rests inside the rect.
            //   - In [hardRectClear, soft]: medium push (PUSH_FRAC_HARD).
            //   - In [soft, rectClearance]: gentle push (PUSH_FRAC_RECT).
            let push: number;
            if (cp.dist < 0.01) {
              // closestPointOnSegmentToRect returns sx,sy = sample point
              // INSIDE rect and cx,cy = nearest face. The geometric
              // distance from sample to face IS the penetration depth.
              const depth = fastHypot(cp.sx - cp.cx, cp.sy - cp.cy);
              push = (depth + hardRectClear) * 0.5;
            } else if (cp.dist < hardRectClear) {
              push = (hardRectClear - cp.dist) * PUSH_FRAC_HARD;
            } else {
              push = (rectClearance - cp.dist) * PUSH_FRAC_RECT;
            }
            const tA = 1 - cp.t, tB = cp.t;
            // Skip endpoint anchors — they're pinned by Phase A.
            const isFirstSeg = i === 0;
            const isLastSeg = i === chain.length - 2;
            if (!isFirstSeg) { a.x += nx * push * tA; a.y += ny * push * tA; }
            if (!isLastSeg)  { b.x += nx * push * tB; b.y += ny * push * tB; }
          }
        }
      }

      // --- B.2: segment-vs-segment (different chains push apart) ---
      // Walk all (arrowId, segmentIdx) pairs. For each (A, B) where A
      // and B belong to different arrows, find capsule-capsule
      // distance and push the segments apart if < ROPE_WIDTH.
      // segList was hoisted above the iter loop — see PERF #12.
      const segmentGrid = new SpatialHash<number>(96);
      for (let i = 0; i < segList.length; i++) {
        const s = segList[i]!;
        const a = s.chain[s.segIdx]!, b = s.chain[s.segIdx + 1]!;
        segmentGrid.insert(
          i,
          Math.min(a.x, b.x), Math.min(a.y, b.y),
          Math.max(a.x, b.x), Math.max(a.y, b.y),
        );
      }
      for (let i = 0; i < segList.length; i++) {
        const sA = segList[i]!;
        const activeA = activeArrowIds.has(sA.arrowId);
        if (!activeA) continue;
        const aA = sA.chain[sA.segIdx]!, bA = sA.chain[sA.segIdx + 1]!;
        const aMinX = Math.min(aA.x, bA.x), aMaxX = Math.max(aA.x, bA.x);
        const aMinY = Math.min(aA.y, bA.y), aMaxY = Math.max(aA.y, bA.y);
        segCandidates.length = 0;
        segmentGrid.query(
          aMinX - segClearance, aMinY - segClearance,
          aMaxX + segClearance, aMaxY + segClearance,
          segCandidates,
        );
        segQueryId++;
        for (const j of segCandidates) {
          if (j === i || segSeen[j] === segQueryId) continue;
          segSeen[j] = segQueryId;
          const sB = segList[j]!;
          if (sA.arrowId === sB.arrowId) continue;
          const activeB = activeArrowIds.has(sB.arrowId);
          if (activeB && j < i) continue; // active-active pair: process once
          const aB = sB.chain[sB.segIdx]!, bB = sB.chain[sB.segIdx + 1]!;
          // Quick bbox reject.
          const bMinX = Math.min(aB.x, bB.x), bMaxX = Math.max(aB.x, bB.x);
          const bMinY = Math.min(aB.y, bB.y), bMaxY = Math.max(aB.y, bB.y);
          if (aMaxX + segClearance < bMinX || bMaxX + segClearance < aMinX) continue;
          if (aMaxY + segClearance < bMinY || bMaxY + segClearance < aMinY) continue;
          const cp = closestPointsBetweenSegments(aA, bA, aB, bB);
          if (cp.dist >= segClearance) continue;
          // Tangent-aware: if segments are crossing (perpendicular),
          // don't push — it just creates wiggle at crossing.
          const tan1x = bA.x - aA.x, tan1y = bA.y - aA.y;
          const tan2x = bB.x - aB.x, tan2y = bB.y - aB.y;
          const m1 = fastHypot(tan1x, tan1y), m2 = fastHypot(tan2x, tan2y);
          if (m1 > 0 && m2 > 0) {
            const absDot = Math.abs((tan1x * tan2x + tan1y * tan2y) / (m1 * m2));
            // < 0.5 = more than 60 degrees off-parallel = crossing
            if (absDot < 0.5) continue;
          }
          // Push direction from B's closest point toward A's.
          let nx: number, ny: number;
          if (cp.dist < 0.01) {
            // Coincident — pick a deterministic direction perpendicular
            // to A's tangent.
            const len = fastHypot(tan1x, tan1y) || 1;
            nx = -tan1y / len; ny = tan1x / len;
          } else {
            nx = (cp.px - cp.qx) / cp.dist;
            ny = (cp.py - cp.qy) / cp.dist;
          }
          const overshoot = segClearance - cp.dist;
          // Each segment gets half the push, then each anchor in the
          // segment gets a share based on its closest-point parameter.
          const push = overshoot * PUSH_FRAC_SEG * 0.5;
          const tA_s = 1 - cp.s, tA_e = cp.s;
          const tB_s = 1 - cp.t, tB_e = cp.t;
          const isAFirstSeg = sA.segIdx === 0;
          const isALastSeg = sA.segIdx === sA.chain.length - 2;
          const isBFirstSeg = sB.segIdx === 0;
          const isBLastSeg = sB.segIdx === sB.chain.length - 2;
          if (!isAFirstSeg) { aA.x += nx * push * tA_s; aA.y += ny * push * tA_s; }
          if (!isALastSeg)  { bA.x += nx * push * tA_e; bA.y += ny * push * tA_e; }
          if (activeB && !isBFirstSeg) { aB.x -= nx * push * tB_s; aB.y -= ny * push * tB_s; }
          if (activeB && !isBLastSeg)  { bB.x -= nx * push * tB_e; bB.y -= ny * push * tB_e; }
        }
      }
      // Convergence check: if no anchor moved more than CONV_THRESHOLD
      // this iter, we're at equilibrium and can stop iterating.
      let maxDelta = 0;
      for (const [a, p] of preIterPos) {
        const d = fastHypot(a.x - p.x, a.y - p.y);
        if (d > maxDelta) maxDelta = d;
      }
      if (maxDelta < CONV_THRESHOLD) break;
    }

    // --- B.2.5: spread sibling endpoints. Two ropes sharing a source
    // (or target) attach to the SAME point on the rect by default
    // (rectBorderToward returns the same point for similar hint
    // directions). Detect endpoint pairs too close and slide them
    // along the rect's border tangentially.
    {
      const SIBLING_MIN_GAP = 12;
      const epsByNode = new Map<string, { arrowId: string; anchor: RopeAnchor; rect: RopeRealNode; isSource: boolean }[]>();
      for (const [arrowId, chain] of this.chains.entries()) {
        if (arrowId === draggedId) continue;
        if (chain.length < 2) continue;
        const link = this.linksByArrow.get(arrowId);
        if (!link) continue;
        const src = reals.get(link.sourceId);
        const tgt = reals.get(link.targetId);
        if (src && !link.sourcePort) {
          if (!epsByNode.has(link.sourceId)) epsByNode.set(link.sourceId, []);
          epsByNode.get(link.sourceId)!.push({ arrowId, anchor: chain[0]!, rect: src, isSource: true });
        }
        if (tgt) {
          if (!epsByNode.has(link.targetId)) epsByNode.set(link.targetId, []);
          epsByNode.get(link.targetId)!.push({ arrowId, anchor: chain[chain.length - 1]!, rect: tgt, isSource: false });
        }
      }
      for (const [, eps] of epsByNode) {
        if (eps.length < 2) continue;
        for (let i = 0; i < eps.length; i++) {
          for (let j = i + 1; j < eps.length; j++) {
            const activeA = activeArrowIds.has(eps[i]!.arrowId);
            const activeB = activeArrowIds.has(eps[j]!.arrowId);
            if (!activeA && !activeB) continue;
            const ea = eps[i]!.anchor, eb = eps[j]!.anchor;
            const dx = eb.x - ea.x, dy = eb.y - ea.y;
            const dist = fastHypot(dx, dy);
            if (dist >= SIBLING_MIN_GAP) continue;
            // Determine the rect-border face the anchors share. Use
            // the rect from eps[i] (siblings share a rect on this
            // node by construction).
            const r = eps[i]!.rect;
            // Find the average position and which face it's on.
            const avgX = (ea.x + eb.x) / 2, avgY = (ea.y + eb.y) / 2;
            const dL = Math.abs(avgX - r.x), dR = Math.abs(avgX - (r.x + r.width));
            const dT = Math.abs(avgY - r.y), dB = Math.abs(avgY - (r.y + r.height));
            const minD = Math.min(dL, dR, dT, dB);
            // Tangent direction along the chosen face.
            let tx: number, ty: number;
            if (minD === dL || minD === dR) { tx = 0; ty = 1; }
            else                            { tx = 1; ty = 0; }
            // Project current separation onto the tangent direction;
            // amplify so they separate to SIBLING_MIN_GAP.
            const projAB = dx * tx + dy * ty; // signed scalar
            const needed = (SIBLING_MIN_GAP - dist) * 0.6;
            const sign = projAB >= 0 ? 1 : -1;
            // Stable tie-breaker for projAB=0: use anchor id ordering.
            const dir = Math.abs(projAB) > 0.01 ? sign : (eps[i]!.anchor.arrowId < eps[j]!.anchor.arrowId ? 1 : -1);
            if (activeA) { ea.x -= tx * needed * dir; ea.y -= ty * needed * dir; }
            if (activeB) { eb.x += tx * needed * dir; eb.y += ty * needed * dir; }
            // Snap both back to the rect border so they stay attached.
            const pa = closestPointOnRect(r, ea);
            const pb = closestPointOnRect(r, eb);
            if (activeA) { ea.x = pa.x; ea.y = pa.y; ea.px = pa.x; ea.py = pa.y; }
            if (activeB) { eb.x = pb.x; eb.y = pb.y; eb.px = pb.x; eb.py = pb.y; }
          }
        }
      }
    }

    // (B.3 endpoint re-snap removed — sibling-endpoint spreading
    // above does the right thing; rectBorderToward here would
    // collapse siblings back onto the same border point.)

    // --- B.3.4: anti-oscillation damping.
    // If this tick's net Phase-B displacement OPPOSES the previous
    // tick's displacement for the same anchor (dot product < 0), the
    // anchor is oscillating. Halve the current displacement to break
    // the cycle. After a few ticks of damping the anchor settles.
    for (const [anchor, start] of phaseBStart) {
      const dx = anchor.x - start.x, dy = anchor.y - start.y;
      const prev = this.lastPhaseBDelta.get(anchor);
      if (prev) {
        const dot = dx * prev.x + dy * prev.y;
        if (dot < 0) {
          anchor.x = start.x + dx * 0.5;
          anchor.y = start.y + dy * 0.5;
        }
      }
      this.lastPhaseBDelta.set(anchor, { x: anchor.x - start.x, y: anchor.y - start.y });
    }

    // --- B.3.5: cap per-anchor total Phase-B displacement.
    // An interior anchor in a squeeze (e.g. between Q and F) gets
    // pushed by multiple obstacles + sibling repel each pass. Without
    // a cap the total displacement per tick can reach 20+ px, which
    // looks like shaking when ticks alternate push directions as the
    // user drags neighbours close. Cap at MAX_DISPLACEMENT_PER_TICK.
    for (const [anchor, start] of phaseBStart) {
      const dx = anchor.x - start.x, dy = anchor.y - start.y;
      const d = fastHypot(dx, dy);
      if (d > MAX_DISPLACEMENT_PER_TICK) {
        const scale = MAX_DISPLACEMENT_PER_TICK / d;
        anchor.x = start.x + dx * scale;
        anchor.y = start.y + dy * scale;
      }
    }

    // --- B.4: sync px = x for all interior anchors.
    // Phase B's pushes modify position directly but DON'T touch px,
    // so the next Verlet step in Phase A reads a fake velocity equal
    // to the total Phase-B push from the previous tick. That velocity
    // then carries forward each tick, amplifying any oscillation
    // between segment-segment repel and chain smoothing — the visible
    // shaking when two nodes are squeezed close. Zeroing px here
    // makes Phase B's pushes positional only (no implicit velocity).
    for (const [arrowId, chain] of this.chains.entries()) {
      if (arrowId === draggedId) continue;
      if (!activeArrowIds.has(arrowId)) continue;
      for (let i = 1; i < chain.length - 1; i++) {
        const a = chain[i]!;
        a.px = a.x; a.py = a.y;
      }
    }
    for (const arrowId of activeArrowIds) {
      const remaining = (this.activeTicksByArrow.get(arrowId) ?? 1) - 1;
      if (remaining > 0) this.activeTicksByArrow.set(arrowId, remaining);
      else this.activeTicksByArrow.delete(arrowId);
    }
  }
}

/** Closest point on a rect's border to `point`. For points outside the
 *  rect, this is the perpendicular projection onto the closest face (or
 *  the corner if the point is in a corner Voronoi region). For points
 *  inside, it's the nearest face. Used to re-attach endpoints after the
 *  repel pass nudges them off the border. */
/** Closest point on segment a→b to rect r. Returns the parameter t in
 *  [0,1] along the segment, the segment point (sx, sy), the closest
 *  rect-border point (cx, cy), and the distance. For segment points
 *  inside the rect, dist is 0 and (cx, cy) is the nearest face. */
function closestPointOnSegmentToRect(
  a: { x: number; y: number },
  b: { x: number; y: number },
  r: { x: number; y: number; width: number; height: number },
): { t: number; sx: number; sy: number; cx: number; cy: number; dist: number } {
  const left = r.x, right = r.x + r.width;
  const top = r.y, bottom = r.y + r.height;
  // Sample along segment, find min distance to rect AND track the
  // deepest inside-rect point (any segment-point inside the rect is
  // a piercing that needs hard push, regardless of the segment's
  // overall min distance).
  const len = fastHypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(8, Math.ceil(len / 4));
  let bestT = 0, bestD = Infinity, bestSX = a.x, bestSY = a.y, bestCX = a.x, bestCY = a.y;
  let deepestT = -1, deepestDepth = 0, deepestSX = 0, deepestSY = 0;
  let deepestFaceX = 0, deepestFaceY = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const sx = a.x + (b.x - a.x) * t;
    const sy = a.y + (b.y - a.y) * t;
    if (sx > left && sx < right && sy > top && sy < bottom) {
      // INSIDE rect — track deepest sample (max distance to nearest face).
      const dL = sx - left, dR = right - sx, dT = sy - top, dB = bottom - sy;
      const depth = Math.min(dL, dR, dT, dB);
      if (depth > deepestDepth) {
        deepestDepth = depth; deepestT = t; deepestSX = sx; deepestSY = sy;
        // Closest face is direction we push toward.
        if (depth === dL)      { deepestFaceX = left; deepestFaceY = sy; }
        else if (depth === dR) { deepestFaceX = right; deepestFaceY = sy; }
        else if (depth === dT) { deepestFaceX = sx; deepestFaceY = top; }
        else                   { deepestFaceX = sx; deepestFaceY = bottom; }
      }
      continue;
    }
    const cx = Math.max(left, Math.min(sx, right));
    const cy = Math.max(top, Math.min(sy, bottom));
    const d = fastHypot(sx - cx, sy - cy);
    if (d < bestD) { bestD = d; bestT = t; bestSX = sx; bestSY = sy; bestCX = cx; bestCY = cy; }
  }
  // If any sample was inside the rect, prefer that — segment is piercing,
  // and pushing the piercing point out is more important than the
  // grazing min-distance.
  if (deepestT >= 0) {
    return { t: deepestT, sx: deepestSX, sy: deepestSY, cx: deepestFaceX, cy: deepestFaceY, dist: 0 };
  }
  return { t: bestT, sx: bestSX, sy: bestSY, cx: bestCX, cy: bestCY, dist: bestD };
}

/** Closest points between two line segments. Robust Eberly-style:
 *  compute unbounded-line optimum first, then clamp s to [0,1] AND
 *  re-project the clamped point onto B (and vice versa for t). The
 *  naive "clamp both independently" returns the wrong corner of the
 *  s-t unit square when both optimal values fall outside [0,1] in
 *  the same direction — it gives the endpoint-to-endpoint distance
 *  rather than the perpendicular distance in the overlap region. */
function closestPointsBetweenSegments(
  a1: { x: number; y: number }, a2: { x: number; y: number },
  b1: { x: number; y: number }, b2: { x: number; y: number },
): { s: number; t: number; px: number; py: number; qx: number; qy: number; dist: number } {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y;
  const wx = a1.x - b1.x, wy = a1.y - b1.y;
  const A = d1x * d1x + d1y * d1y;
  const B = d1x * d2x + d1y * d2y;
  const C = d2x * d2x + d2y * d2y;
  const D = d1x * wx + d1y * wy;
  const E = d2x * wx + d2y * wy;
  const denom = A * C - B * B;
  let s: number, t: number;
  if (denom < 1e-9 * A * C || A < 1e-9 || C < 1e-9) {
    // Parallel (or degenerate). Anchor s at 0 and find best t.
    s = 0;
    t = C > 1e-9 ? E / C : 0;
  } else {
    s = (B * E - C * D) / denom;
    t = (A * E - B * D) / denom;
  }
  // Clamp s first; if it moves, re-project t given the new s.
  if (s < 0) {
    s = 0;
    t = C > 1e-9 ? E / C : 0;
  } else if (s > 1) {
    s = 1;
    t = C > 1e-9 ? (E + B) / C : 0;
  }
  // Now clamp t; if it moves, re-project s given the new t.
  if (t < 0) {
    t = 0;
    s = A > 1e-9 ? Math.max(0, Math.min(1, -D / A)) : 0;
  } else if (t > 1) {
    t = 1;
    s = A > 1e-9 ? Math.max(0, Math.min(1, (B - D) / A)) : 0;
  }
  const px = a1.x + s * d1x, py = a1.y + s * d1y;
  const qx = b1.x + t * d2x, qy = b1.y + t * d2y;
  return { s, t, px, py, qx, qy, dist: fastHypot(px - qx, py - qy) };
}

/** Max depth (px) that segment a→b penetrates rect r's interior. 0
 *  means the segment merely grazes or stays outside. Used to detect
 *  "rope cutting through a node" bugs that per-anchor clearance can't
 *  see (e.g. anchor above + anchor below → segment cuts straight
 *  through the node body). */
function segmentRectDepth(
  a: { x: number; y: number },
  b: { x: number; y: number },
  r: { x: number; y: number; width: number; height: number },
): number {
  const left = r.x, right = r.x + r.width;
  const top = r.y, bottom = r.y + r.height;
  // Sample along the segment to test interior membership. With node
  // rects ~250 px tall, every 10 px of segment length is enough to
  // catch the smallest crossings without much CPU.
  const len = fastHypot(b.x - a.x, b.y - a.y);
  const steps = Math.max(4, Math.ceil(len / 10));
  let maxDepth = 0;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > left && x < right && y > top && y < bottom) {
      const depth = Math.min(x - left, right - x, y - top, bottom - y);
      if (depth > maxDepth) maxDepth = depth;
    }
  }
  return maxDepth;
}

function closestPointOnRect(
  rect: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number },
): { x: number; y: number } {
  const left = rect.x;
  const right = rect.x + rect.width;
  const top = rect.y;
  const bottom = rect.y + rect.height;
  const cx = Math.max(left, Math.min(point.x, right));
  const cy = Math.max(top, Math.min(point.y, bottom));
  if (cx === point.x && cy === point.y) {
    const dL = point.x - left;
    const dR = right - point.x;
    const dT = point.y - top;
    const dB = bottom - point.y;
    const minD = Math.min(dL, dR, dT, dB);
    if (minD === dL) return { x: left, y: point.y };
    if (minD === dR) return { x: right, y: point.y };
    if (minD === dT) return { x: point.x, y: top };
    return { x: point.x, y: bottom };
  }
  return { x: cx, y: cy };
}

/**
 * Pick a "where is the rope going" direction hint for an endpoint pin.
 * Prefer the supplied `hint` (typically chain[1] / chain[N-2]); fall back
 * to `fallback` when `hint` is null or coincides with `selfCenter` (which
 * would make the ray-from-center math degenerate).
 *
 * Kept exported for tests / consumers that draw initial straight lines.
 */
export function pickHint(
  hint: { x: number; y: number } | null | undefined,
  selfCenter: { x: number; y: number },
  fallback: { x: number; y: number },
): { x: number; y: number } {
  if (!hint) return fallback;
  const dx = hint.x - selfCenter.x;
  const dy = hint.y - selfCenter.y;
  if (dx * dx + dy * dy < 1) return fallback;
  return hint;
}

/**
 * Point on the rect's BORDER along the ray from the rect's center toward
 * `target`. Used to position the rope's pinned endpoints so the rendered
 * arrow looks like the line from one node's center to the other, clipped
 * at the borders.
 *
 * Math: the rect's AABB has half-extents (halfW, halfH) around its center.
 * The ray center + t * (target - center) hits the border at the smaller
 * of `halfW / |dx|` and `halfH / |dy|` — whichever axis the ray crosses
 * first.
 */
export function rectBorderToward(
  rect: { x: number; y: number; width: number; height: number },
  target: { x: number; y: number },
): { x: number; y: number } {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = target.x - cx;
  const dy = target.y - cy;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return { x: cx, y: cy };
  const halfW = rect.width / 2;
  const halfH = rect.height / 2;
  const tx = Math.abs(dx) > 1e-9 ? halfW / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > 1e-9 ? halfH / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: cx + t * dx, y: cy + t * dy };
}
