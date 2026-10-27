/** Creation-time rectangle packing. No simulation or DOM work: existing cards
 * are obstacles, never moved to make an initial slot. */
export interface PlacementRect { id: string; x: number; y: number; width: number; height: number }
export interface PlacementRegion { x: number; y: number; width: number; height: number }
export interface PlacementOptions {
  gap: number;
  restGap: number;
  regions?: readonly PlacementRegion[];
  edges?: readonly { source: string; target: string }[];
}

function nearestFree(target: number, intervals: [number, number][]): number[] {
  intervals.sort((a, b) => a[0] - b[0]);
  let start = Infinity, end = -Infinity;
  for (const [lo, hi] of intervals) {
    if (lo < end - 1e-7) end = Math.max(end, hi);
    else {
      if (target > start + 1e-7 && target < end - 1e-7) return [start, end];
      start = lo; end = hi;
    }
  }
  return target > start + 1e-7 && target < end - 1e-7 ? [start, end] : [target];
}

export function placementOverlaps(a: Omit<PlacementRect, 'id'>, b: PlacementRect, gap: number): boolean {
  return a.x < b.x + b.width + gap - 1e-7 && a.x + a.width + gap > b.x + 1e-7
    && a.y < b.y + b.height + gap - 1e-7 && a.y + a.height + gap > b.y + 1e-7;
}

export function findNodePlacement(
  parent: PlacementRect,
  obstacles: readonly PlacementRect[],
  size: { width: number; height: number },
  options: PlacementOptions,
): { x: number; y: number } {
  const width = Math.max(1, size.width), height = Math.max(1, size.height);
  const gap = Math.max(0, options.gap), rest = Math.max(gap, options.restGap);
  const rects = obstacles.filter(r => Number.isFinite(r.x + r.y + r.width + r.height) && r.width > 0 && r.height > 0);
  const center = { x: parent.x + parent.width / 2, y: parent.y + parent.height / 2 };
  let origin = center;
  const regions = options.regions?.filter(r => r.width > 0 && r.height > 0);
  if (regions?.length) {
    const minX = Math.min(...regions.map(r => r.x)), minY = Math.min(...regions.map(r => r.y));
    const maxX = Math.max(...regions.map(r => r.x + r.width)), maxY = Math.max(...regions.map(r => r.y + r.height));
    origin = { x: parent.x + (minX + maxX) / 2 * parent.width, y: parent.y + (minY + maxY) / 2 * parent.height };
  }
  // Right → left → down → up. Image questions instead prefer the nearest edge
  // to the selected region. Tangential positions are solved exactly by merging
  // occupied intervals, so narrow usable gaps aren't missed by angle sampling.
  const sides = [
    { horizontal: true, positive: true, start: parent.x + parent.width + rest, distance: parent.x + parent.width - origin.x },
    { horizontal: true, positive: false, start: parent.x - width - rest, distance: origin.x - parent.x },
    { horizontal: false, positive: true, start: parent.y + parent.height + rest, distance: parent.y + parent.height - origin.y },
    { horizontal: false, positive: false, start: parent.y - height - rest, distance: origin.y - parent.y },
  ];
  const priority = sides.map((_, i) => i);
  if (regions?.length) priority.sort((a, b) => sides[a]!.distance - sides[b]!.distance);
  const candidates: { x: number; y: number; cost: number }[] = [];
  for (let side = 0; side < sides.length; side++) {
    const { horizontal, positive, start } = sides[side]!;
    const normalSize = horizontal ? width : height, tangentSize = horizontal ? height : width;
    const target = (horizontal ? origin.y : origin.x) - tangentSize / 2;
    const edgeOf = (r: PlacementRect) => (horizontal ? r.x : r.y)
      + (positive ? (horizontal ? r.width : r.height) + gap : -normalSize - gap);
    const edges = rects.map(edgeOf).filter(v => positive ? v > start : v < start)
      .sort((a, b) => positive ? a - b : b - a);
    // Bound work even in huge projects; an exterior line is always included,
    // regardless of this cap. It guarantees a checked, collision-free fallback.
    const exterior = edges.reduce((value, edge) => positive ? Math.max(value, edge) : Math.min(value, edge), start);
    const lines = [...new Set([start, ...edges.slice(0, 24), exterior])];
    for (const line of lines) {
      const intervals: [number, number][] = [];
      for (const r of rects) {
        const normal = horizontal ? r.x : r.y, extent = horizontal ? r.width : r.height;
        if (line + normalSize + gap <= normal + 1e-7 || line >= normal + extent + gap - 1e-7) continue;
        const tangent = horizontal ? r.y : r.x, length = horizontal ? r.height : r.width;
        intervals.push([tangent - tangentSize - gap, tangent + length + gap]);
      }
      for (const tangent of nearestFree(target, intervals)) {
        const x = horizontal ? line : tangent, y = horizontal ? tangent : line;
        const dx = x + width / 2 - center.x, dy = y + height / 2 - center.y;
        const actualSide = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 1) : (dy >= 0 ? 2 : 3);
        const gapX = Math.max(0, x - parent.x - parent.width, parent.x - x - width);
        const gapY = Math.max(0, y - parent.y - parent.height, parent.y - y - height);
        const cost = Math.abs(Math.hypot(gapX, gapY) - rest)
          + priority.indexOf(actualSide) * 400 + Math.abs(tangent - target) * .25;
        candidates.push({ x, y, cost });
      }
    }
  }
  candidates.sort((a, b) => a.cost - b.cost);
  // Crossings are a small tie-breaker, not a reason to put a child far away.
  // Only the best few candidates need this optional graph-aware calculation.
  const byId = options.edges?.length ? new Map(rects.map(r => [r.id, r])) : null;
  const shortlist = candidates.slice(0, 8);
  if (byId) for (const c of shortlist) {
    const target = { x: c.x + width / 2, y: c.y + height / 2 };
    for (const edge of options.edges ?? []) {
      if (edge.source === parent.id || edge.target === parent.id) continue;
      const a = byId.get(edge.source), b = byId.get(edge.target);
      if (!a || !b) continue;
      const ax = a.x + a.width / 2, ay = a.y + a.height / 2;
      const bx = b.x + b.width / 2, by = b.y + b.height / 2;
      const cross = (x: number, y: number, u: number, v: number) => x * v - y * u;
      const p = cross(target.x - origin.x, target.y - origin.y, ax - origin.x, ay - origin.y);
      const q = cross(target.x - origin.x, target.y - origin.y, bx - origin.x, by - origin.y);
      const r = cross(bx - ax, by - ay, origin.x - ax, origin.y - ay);
      const s = cross(bx - ax, by - ay, target.x - ax, target.y - ay);
      if (p * q < 0 && r * s < 0) c.cost += 30;
    }
  }
  shortlist.sort((a, b) => a.cost - b.cost);
  const best = [...shortlist, ...candidates.slice(8)]
    .find(c => !rects.some(r => placementOverlaps({ ...c, width, height }, r, gap)))!;
  return { x: best.x, y: best.y };
}
