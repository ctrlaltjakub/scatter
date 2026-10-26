/* -------------------------------------------------------------------------
 * Geometric arrow router — visibility graph + A*.
 *
 * For a (source, target, obstacles) triple, returns a taut polyline of
 * waypoints that goes from source's center through obstacle corners (with
 * a margin) to target's center, optimal in total length. Replaces the
 * pure-physics rope settling — the geometric approach has no local
 * minima, hugs corners predictably, and handles "rope must thread between
 * close obstacles to reach target" cleanly.
 *
 * The router itself returns rect-CENTER-anchored endpoints; the consumer
 * is responsible for snapping the first/last waypoint to the rect border
 * (via rectBorderToward + the adjacent waypoint as direction hint).
 *
 * Performance: per-call cost is O(C² × O) where C is candidate vertices
 * (~4 per nearby obstacle + 2 endpoints) and O is obstacle count for
 * line-of-sight checks. Typical cases (handful of obstacles) are well
 * under 1ms.
 * ------------------------------------------------------------------------*/
import { fastHypot } from './perfMath';

export interface RouteRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RoutePoint {
  x: number;
  y: number;
}

/** A "tight gap" between two obstacles — the space their inflated rects
 *  share. The router adds 2 midline waypoints per gap (entry and exit)
 *  so single ropes pass through the geometric center. tick() then
 *  detects which ropes use which gaps and assigns lane offsets so that
 *  multiple ropes through the same gap distribute evenly across its
 *  perpendicular extent. */
export interface GapInfo {
  /** Stable key: sorted obstacle ID pair. */
  key: string;
  orientation: 'vertical' | 'horizontal';
  /** Perpendicular midline position (y for vertical, x for horizontal). */
  perpMid: number;
  /** Perpendicular extent — the gap's "thickness" (distance between the
   *  facing obstacle edges). Lane offsets fit within this. */
  perpExtent: number;
  /** Entry/exit waypoint coordinates along the gap's main axis. */
  entry: RoutePoint;
  exit: RoutePoint;
}

interface InflatedRect {
  /** id used to skip self-intersection checks; empty string for auxiliary rects */
  id: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Inflate a rect by `margin` on each side. Used to keep the route a
 *  comfortable visual distance from obstacle borders. */
function inflateRect(r: RouteRect, margin: number, id = ''): InflatedRect {
  return {
    id,
    left: r.x - margin,
    right: r.x + r.width + margin,
    top: r.y - margin,
    bottom: r.y + r.height + margin,
  };
}

/** Slab test — does the line segment (a, b) cross the rect's interior?
 *  We use STRICTLY-INSIDE semantics: touching the boundary doesn't count.
 *  An eps shrinks the rect very slightly so that segments grazing a corner
 *  (e.g., one whose own endpoint is the corner) don't register as crossing
 *  the rect they themselves came from. */
function segmentCrossesRectStrict(
  a: RoutePoint,
  b: RoutePoint,
  rect: InflatedRect,
): boolean {
  const eps = 0.5;
  const left = rect.left + eps;
  const right = rect.right - eps;
  const top = rect.top + eps;
  const bottom = rect.bottom - eps;
  if (right <= left || bottom <= top) return false; // degenerate rect
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let tIn = 0;
  let tOut = 1;
  if (Math.abs(dx) < 1e-9) {
    if (a.x <= left || a.x >= right) return false;
  } else {
    const t1 = (left - a.x) / dx;
    const t2 = (right - a.x) / dx;
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    if (lo > tIn) tIn = lo;
    if (hi < tOut) tOut = hi;
    if (tIn >= tOut) return false;
  }
  if (Math.abs(dy) < 1e-9) {
    if (a.y <= top || a.y >= bottom) return false;
  } else {
    const t1 = (top - a.y) / dy;
    const t2 = (bottom - a.y) / dy;
    const lo = Math.min(t1, t2);
    const hi = Math.max(t1, t2);
    if (lo > tIn) tIn = lo;
    if (hi < tOut) tOut = hi;
    if (tIn >= tOut) return false;
  }
  return tIn < tOut && tOut > 0 && tIn < 1;
}

/** Visible to each other? Yes iff the open segment `a → b` doesn't cross
 *  any obstacle's strict interior. Source and target rects (passed in as
 *  exempt) don't block visibility — endpoints live ON their borders. */
function visible(
  a: RoutePoint,
  b: RoutePoint,
  obstacles: InflatedRect[],
): boolean {
  for (const ob of obstacles) {
    if (segmentCrossesRectStrict(a, b, ob)) return false;
  }
  return true;
}

/** A* on the visibility graph, returning indices into `vertices` from
 *  start (index 0) to end (index 1). Empty array if unreachable. */
function aStar(
  vertices: RoutePoint[],
  edges: Map<number, { to: number; cost: number }[]>,
  startIdx: number,
  endIdx: number,
): number[] {
  const N = vertices.length;
  const gScore = new Array(N).fill(Infinity);
  const fScore = new Array(N).fill(Infinity);
  const cameFrom = new Array(N).fill(-1);
  gScore[startIdx] = 0;
  const endP = vertices[endIdx]!;
  fScore[startIdx] = fastHypot(
    vertices[startIdx]!.x - endP.x,
    vertices[startIdx]!.y - endP.y,
  );
  const open = new Set<number>([startIdx]);
  while (open.size > 0) {
    let cur = -1;
    let best = Infinity;
    for (const i of open) {
      if (fScore[i] < best) { best = fScore[i]; cur = i; }
    }
    if (cur === -1) break;
    if (cur === endIdx) {
      const path: number[] = [];
      let n = cur;
      while (n !== -1) { path.unshift(n); n = cameFrom[n]; }
      return path;
    }
    open.delete(cur);
    for (const { to, cost } of edges.get(cur) ?? []) {
      const tentative = gScore[cur] + cost;
      if (tentative < gScore[to]) {
        cameFrom[to] = cur;
        gScore[to] = tentative;
        fScore[to] = tentative + fastHypot(
          vertices[to]!.x - endP.x,
          vertices[to]!.y - endP.y,
        );
        open.add(to);
      }
    }
  }
  return [];
}

/** Detect all tight gaps between obstacle pairs. Two obstacles form a
 *  gap when their inflated rects overlap AND their original rects don't
 *  overlap on exactly one axis (the gap's "along" axis). Output is
 *  stable across calls (depends only on obstacle ids/positions and
 *  margin), so consumers like the rope sim can pass the same result to
 *  multiple per-arrow `routePath` calls without recomputing. */
export function computeGaps(
  obstacles: { rect: RouteRect; id: string }[],
  margin: number,
): GapInfo[] {
  const out: GapInfo[] = [];
  for (let oi = 0; oi < obstacles.length; oi++) {
    const A = obstacles[oi]!.rect;
    const aId = obstacles[oi]!.id;
    const aL = A.x - margin, aR = A.x + A.width + margin;
    const aT = A.y - margin, aB = A.y + A.height + margin;
    for (let oj = oi + 1; oj < obstacles.length; oj++) {
      const B = obstacles[oj]!.rect;
      const bId = obstacles[oj]!.id;
      const bL = B.x - margin, bR = B.x + B.width + margin;
      const bT = B.y - margin, bB = B.y + B.height + margin;
      // Inflated rects must overlap.
      if (aR <= bL || bR <= aL) continue;
      if (aB <= bT || bB <= aT) continue;
      // Determine gap orientation from ORIGINAL rect overlaps.
      const xOlapL = Math.max(A.x, B.x);
      const xOlapR = Math.min(A.x + A.width, B.x + B.width);
      const yOlapT = Math.max(A.y, B.y);
      const yOlapB = Math.min(A.y + A.height, B.y + B.height);
      const xHasOlap = xOlapR > xOlapL;
      const yHasOlap = yOlapB > yOlapT;
      const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
      if (xHasOlap && !yHasOlap) {
        const aBy = A.y + A.height;
        const bBy = B.y + B.height;
        const gapTop = aBy < B.y ? aBy : bBy;
        const gapBot = aBy < B.y ? B.y : A.y;
        const midY = (gapTop + gapBot) / 2;
        out.push({
          key, orientation: 'vertical',
          perpMid: midY, perpExtent: gapBot - gapTop,
          entry: { x: xOlapL, y: midY },
          exit: { x: xOlapR, y: midY },
        });
      } else if (yHasOlap && !xHasOlap) {
        const aRx = A.x + A.width;
        const bRx = B.x + B.width;
        const gapLeft = aRx < B.x ? aRx : bRx;
        const gapRight = aRx < B.x ? B.x : A.x;
        const midX = (gapLeft + gapRight) / 2;
        out.push({
          key, orientation: 'horizontal',
          perpMid: midX, perpExtent: gapRight - gapLeft,
          entry: { x: midX, y: yOlapT },
          exit: { x: midX, y: yOlapB },
        });
      }
      // else: rects intersect or corner-touch — no proper midline gap.
    }
  }
  return out;
}

/** Compute a taut polyline from source to target avoiding obstacles.
 *
 * Returns the route as a list of points starting at `srcRect`'s center
 * and ending at `tgtRect`'s center; intermediate points are corners of
 * obstacles inflated by `margin` (visual clearance). Caller snaps the
 * first and last point to source/target borders (using rectBorderToward
 * + the adjacent waypoint).
 *
 * Visibility is checked against the ORIGINAL (un-inflated) rects, so
 * that tight gaps between nodes — narrower than `2 × margin` — remain
 * navigable. The margin acts as a SOFT preference: the route's bend
 * points sit at margin distance from obstacle corners when there's room,
 * but if obstacles are too close to maintain that clearance the rope is
 * still allowed to thread the gap (visually it'll touch the obstacle
 * borders rather than disappear).
 *
 * If no obstacle is in the way, returns `[srcCenter, tgtCenter]` (a
 * straight line). If the graph is disconnected (e.g., target enclosed),
 * also falls back to that straight line — better a wrong straight line
 * than a missing arrow. */
export function routePath(
  srcRect: RouteRect,
  tgtRect: RouteRect,
  obstacles: { rect: RouteRect; id: string }[],
  margin: number,
  precomputedGaps?: GapInfo[],
): RoutePoint[] {
  const srcCenter: RoutePoint = {
    x: srcRect.x + srcRect.width / 2,
    y: srcRect.y + srcRect.height / 2,
  };
  const tgtCenter: RoutePoint = {
    x: tgtRect.x + tgtRect.width / 2,
    y: tgtRect.y + tgtRect.height / 2,
  };

  // Visibility blockers are the ORIGINAL rects (margin = 0).
  const blockers: InflatedRect[] = obstacles.map((o) => inflateRect(o.rect, 0, o.id));

  // Fast path — nothing blocks the line of sight.
  if (visible(srcCenter, tgtCenter, blockers)) {
    return [srcCenter, tgtCenter];
  }

  // Vertices: src, tgt, then 4 INFLATED corners (full margin clearance,
  // for wide-gap routing) + 4 MIN-MARGIN corners (smaller clearance, for
  // tight-gap routing) per obstacle, PLUS gap-midline waypoints for any
  // pair of obstacles whose inflated rects overlap (= a "tight gap"). A*
  // picks whichever set yields the cheaper path. To prefer the
  // full-margin route whenever both are viable, edges that ENTER a
  // min-margin vertex carry a flat cost penalty.
  //
  // Why gap midpoints exist: a corner-only graph only knows positions at
  // (one obstacle's edge + margin) — that's CLOSE to that obstacle and
  // potentially far from the obstacle bounding the other side of the
  // gap, so single ropes through tight gaps end up hugging one node.
  // Midline vertices live equidistant from BOTH bounding obstacles, so
  // single-rope routing is symmetric (centered in the gap) and
  // multi-rope spreading via anchor-anchor repel happens around the
  // midline rather than one node's edge.
  const MIN_MARGIN = 25; // tight-route clearance — rope still keeps a clear visual buffer
  const MIN_MARGIN_PENALTY = margin * 2;
  const vertices: RoutePoint[] = [srcCenter, tgtCenter];
  const isMinMargin: boolean[] = [false, false]; // src, tgt
  for (const o of obstacles) {
    const r = o.rect;
    const m = margin;
    // Inflated (full margin clearance).
    vertices.push({ x: r.x - m,             y: r.y - m });            isMinMargin.push(false);
    vertices.push({ x: r.x + r.width + m,   y: r.y - m });            isMinMargin.push(false);
    vertices.push({ x: r.x + r.width + m,   y: r.y + r.height + m }); isMinMargin.push(false);
    vertices.push({ x: r.x - m,             y: r.y + r.height + m }); isMinMargin.push(false);
    // Min-margin (corner-hugging with a thin visible buffer).
    vertices.push({ x: r.x - MIN_MARGIN,             y: r.y - MIN_MARGIN });             isMinMargin.push(true);
    vertices.push({ x: r.x + r.width + MIN_MARGIN,   y: r.y - MIN_MARGIN });             isMinMargin.push(true);
    vertices.push({ x: r.x + r.width + MIN_MARGIN,   y: r.y + r.height + MIN_MARGIN });  isMinMargin.push(true);
    vertices.push({ x: r.x - MIN_MARGIN,             y: r.y + r.height + MIN_MARGIN });  isMinMargin.push(true);
  }
  // Gap-midline waypoints. For each pair of obstacles whose inflated
  // rects overlap (= they form a tight gap), add 2 vertices on the
  // midline of that gap — at the entry and exit of the gap region.
  const gaps = precomputedGaps ?? computeGaps(obstacles, margin);
  for (const gap of gaps) {
    vertices.push({ ...gap.entry }); isMinMargin.push(false);
    vertices.push({ ...gap.exit });  isMinMargin.push(false);
  }

  // Edges between every visible pair (visibility uses original rects).
  // A vertex that happens to fall inside another obstacle's original
  // rect (rare — happens with tightly-overlapping obstacles) will simply
  // have no outgoing edges that pass the visibility test, and A* skips
  // it gracefully.
  //
  // Orthogonal preference: add a penalty proportional to `min(|dx|,
  // |dy|)` so axis-aligned edges (one of dx/dy is 0) cost just `dist`
  // while 45° diagonals cost up to `dist * (1 + ORTHO_PENALTY/sqrt(2))`.
  // This makes A* prefer L-shaped paths over diagonal shortcuts through
  // open space — diagonals are still possible, just penalized enough
  // that an L-shape with the same Manhattan length wins. Without this
  // the router cuts diagonally toward obstacle corners and the
  // resulting rope doesn't run parallel to the obstacle's edges.
  const ORTHO_PENALTY = 0;
  const edges = new Map<number, { to: number; cost: number }[]>();
  for (let i = 0; i < vertices.length; i++) edges.set(i, []);
  for (let i = 0; i < vertices.length; i++) {
    for (let j = i + 1; j < vertices.length; j++) {
      const a = vertices[i]!;
      const b = vertices[j]!;
      if (!visible(a, b, blockers)) continue;
      const adx = Math.abs(b.x - a.x);
      const ady = Math.abs(b.y - a.y);
      const dist = fastHypot(adx, ady);
      const orthoPenalty = ORTHO_PENALTY * Math.min(adx, ady);
      const baseCost = dist + orthoPenalty;
      // Penalty added to cost of arriving at a min-margin vertex.
      edges.get(i)!.push({ to: j, cost: baseCost + (isMinMargin[j] ? MIN_MARGIN_PENALTY : 0) });
      edges.get(j)!.push({ to: i, cost: baseCost + (isMinMargin[i] ? MIN_MARGIN_PENALTY : 0) });
    }
  }

  const path = aStar(vertices, edges, 0, 1);
  if (path.length < 2) {
    // Disconnected — fall back to direct line. The downstream layer just
    // renders whatever we return; better a wrong straight line than a
    // missing arrow.
    return [srcCenter, tgtCenter];
  }
  return path.map((idx) => vertices[idx]!);
}

/** Total arc length of a polyline. */
export function polylineLength(pts: RoutePoint[]): number {
  let total = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    total += fastHypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
  }
  return total;
}

/** Sample `n` points uniformly along a polyline by arc length. The first
 *  sample is at the start, the last is at the end; intermediate samples
 *  are linearly interpolated between adjacent waypoints. */
export function sampleAlongPolyline(pts: RoutePoint[], n: number): RoutePoint[] {
  if (n < 2 || pts.length < 2) return pts.length === 0 ? [] : pts.slice();
  const total = polylineLength(pts);
  if (total < 0.0001) {
    return new Array(n).fill(0).map(() => ({ x: pts[0]!.x, y: pts[0]!.y }));
  }
  const out: RoutePoint[] = [];
  const step = total / (n - 1);
  let segIdx = 0;
  let segStart = 0; // arc length at start of current segment
  let segEnd = fastHypot(pts[1]!.x - pts[0]!.x, pts[1]!.y - pts[0]!.y);
  for (let i = 0; i < n; i++) {
    const target = i === n - 1 ? total : i * step;
    while (target > segEnd && segIdx < pts.length - 2) {
      segIdx++;
      segStart = segEnd;
      segEnd += fastHypot(
        pts[segIdx + 1]!.x - pts[segIdx]!.x,
        pts[segIdx + 1]!.y - pts[segIdx]!.y,
      );
    }
    const segLen = segEnd - segStart;
    const t = segLen < 0.0001 ? 0 : (target - segStart) / segLen;
    const a = pts[segIdx]!;
    const b = pts[segIdx + 1]!;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}
