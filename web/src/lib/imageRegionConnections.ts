import type { ImageRegion } from '@/store/types';
import { closestPointOnPort, type PortPoint, type SourcePort } from '@/physics/sourcePort';

/** Touching/overlapping rectangles are one selection island, including corner
 * contacts. Holes in an island must never become extra chain nodes. */
export function connectedImageRegions(regions: readonly ImageRegion[]): ImageRegion[][] {
  const remaining = new Set(regions);
  const groups: ImageRegion[][] = [];
  while (remaining.size) {
    const group = [remaining.values().next().value!];
    remaining.delete(group[0]!);
    for (let i = 0; i < group.length; i++) {
      const a = group[i]!;
      for (const b of remaining) {
        if (a.x <= b.x + b.width + 1e-9 && b.x <= a.x + a.width + 1e-9
          && a.y <= b.y + b.height + 1e-9 && b.y <= a.y + a.height + 1e-9) {
          group.push(b);
          remaining.delete(b);
        }
      }
    }
    groups.push(group);
  }
  return groups.sort((a, b) => Math.min(...a.map(r => r.x)) - Math.min(...b.map(r => r.x))
    || Math.min(...a.map(r => r.y)) - Math.min(...b.map(r => r.y)));
}

interface Link { from: PortPoint; to: PortPoint; length: number }
function shortestLink(a: SourcePort, b: SourcePort): Link {
  let best: Link = { from: a.center, to: b.center, length: Infinity };
  const consider = (from: PortPoint, to: PortPoint) => {
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (length < best.length - 1e-8) best = { from, to, length };
  };
  // For equally short parallel-edge links, prefer the middle of the facing
  // edges rather than whichever corner happened to be traced first.
  const from = closestPointOnPort(a, b.center), to = closestPointOnPort(b, a.center);
  consider(from, closestPointOnPort(b, from));
  consider(closestPointOnPort(a, to), to);
  for (const contour of a.contours) for (const point of contour) consider(point, closestPointOnPort(b, point));
  for (const contour of b.contours) for (const point of contour) consider(closestPointOnPort(a, point), point);
  return best;
}

/** A short open chain, not an all-to-all graph. Try nearest-neighbour routes
 * from each island, then uncross/shorten them (2-opt). Geometry is cached by
 * imageAtlasFrame, so none of this runs per animation frame or camera move. */
export function imageRegionConnectionPath(ports: readonly SourcePort[]): string {
  if (ports.length < 2) return '';
  const links: Link[][] = ports.map(() => []);
  for (let i = 0; i < ports.length; i++) for (let j = i + 1; j < ports.length; j++) {
    const link = shortestLink(ports[i]!, ports[j]!);
    links[i]![j] = link;
    links[j]![i] = { from: link.to, to: link.from, length: link.length };
  }
  const length = (order: number[]) => order.slice(1).reduce((sum, to, i) => sum + links[order[i]!]![to]!.length, 0);
  let best: number[] = [], bestLength = Infinity;
  for (let start = 0; start < Math.min(ports.length, 32); start++) {
    const remaining = new Set(ports.map((_, i) => i));
    const order = [start];
    remaining.delete(start);
    while (remaining.size) {
      const last = order.at(-1)!;
      const next = [...remaining].reduce((a, b) => links[last]![a]!.length <= links[last]![b]!.length ? a : b);
      order.push(next); remaining.delete(next);
    }
    const total = length(order);
    if (total < bestLength) { best = order; bestLength = total; }
  }
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let i = 0; i < best.length - 1; i++) for (let j = i + 1; j < best.length; j++) {
      const before = (i > 0 ? links[best[i - 1]!]![best[i]!]!.length : 0)
        + (j + 1 < best.length ? links[best[j]!]![best[j + 1]!]!.length : 0);
      const after = (i > 0 ? links[best[i - 1]!]![best[j]!]!.length : 0)
        + (j + 1 < best.length ? links[best[i]!]![best[j + 1]!]!.length : 0);
      if (after < before - 1e-6) {
        best.splice(i, j - i + 1, ...best.slice(i, j + 1).reverse());
        improved = true;
      }
    }
    if (!improved) break;
  }
  return best.slice(1).map((to, i) => {
    const link = links[best[i]!]![to]!;
    return `M${link.from.x},${link.from.y}L${link.to.x},${link.to.y}`;
  }).join('');
}
