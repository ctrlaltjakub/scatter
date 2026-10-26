export interface RopePoint { x: number; y: number }

function pointSegmentDistanceSq(p: RopePoint, a: RopePoint, b: RopePoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = dx * dx + dy * dy;
  if (denom <= 1e-9) {
    const px = p.x - a.x;
    const py = p.y - a.y;
    return px * px + py * py;
  }
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / denom));
  const px = p.x - (a.x + dx * t);
  const py = p.y - (a.y + dy * t);
  return px * px + py * py;
}

function simplify(points: readonly RopePoint[], tolerance: number): RopePoint[] {
  if (points.length <= 2) return points.map((p) => ({ x: p.x, y: p.y }));
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  const toleranceSq = tolerance * tolerance;
  while (stack.length > 0) {
    const [start, end] = stack.pop()!;
    let bestIndex = -1;
    let bestDistanceSq = toleranceSq;
    for (let i = start + 1; i < end; i++) {
      const distanceSq = pointSegmentDistanceSq(points[i]!, points[start]!, points[end]!);
      if (distanceSq > bestDistanceSq) {
        bestDistanceSq = distanceSq;
        bestIndex = i;
      }
    }
    if (bestIndex >= 0) {
      keep[bestIndex] = 1;
      stack.push([start, bestIndex], [bestIndex, end]);
    }
  }
  const result: RopePoint[] = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push({ x: points[i]!.x, y: points[i]!.y });
  }
  return result;
}

function samplePolyline(points: readonly RopePoint[], count: number): RopePoint[] {
  if (points.length <= 1 || count <= 1) return points.slice(0, 1).map((p) => ({ ...p }));
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1]! + Math.hypot(
      points[i]!.x - points[i - 1]!.x,
      points[i]!.y - points[i - 1]!.y,
    ));
  }
  const total = cumulative[cumulative.length - 1]!;
  if (total <= 1e-9) return Array.from({ length: count }, () => ({ ...points[0]! }));
  const result: RopePoint[] = [];
  let segment = 1;
  for (let i = 0; i < count; i++) {
    const distance = total * i / (count - 1);
    while (segment < cumulative.length - 1 && cumulative[segment]! < distance) segment++;
    const a = points[segment - 1]!;
    const b = points[segment]!;
    const from = cumulative[segment - 1]!;
    const length = Math.max(1e-9, cumulative[segment]! - from);
    const t = (distance - from) / length;
    result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return result;
}

/**
 * Remove redundant nearly-collinear control points while preserving the
 * visible route within 0.75 canvas pixels. Long straight runs retain sparse
 * support points, so bezier rendering and collision broad-phase stay stable.
 */
export function compactRopeAnchors(
  points: readonly RopePoint[] | undefined,
  maxSegmentLength: number,
  maxAnchorCount: number,
): RopePoint[] | undefined {
  if (!points || points.length < 2) return undefined;
  const simplified = simplify(points, 0.75);
  const maxStraightSpan = Math.max(60, maxSegmentLength * 3);
  const dense: RopePoint[] = [{ ...simplified[0]! }];
  for (let i = 1; i < simplified.length; i++) {
    const a = simplified[i - 1]!;
    const b = simplified[i]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const pieces = Math.max(1, Math.ceil(length / maxStraightSpan));
    for (let j = 1; j <= pieces; j++) {
      const t = j / pieces;
      dense.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  if (dense.length > maxAnchorCount) {
    // When the hard cap wins, prefer exact route bends over uniformly sampled
    // points that could round a corner into an obstacle.
    const essentialCount = Math.max(4, simplified.length);
    if (essentialCount <= maxAnchorCount) {
      return essentialCount === simplified.length
        ? simplified
        : samplePolyline(simplified, essentialCount);
    }
    return samplePolyline(simplified, maxAnchorCount);
  }
  if (dense.length >= 4) return dense;
  return samplePolyline(dense, 4);
}
