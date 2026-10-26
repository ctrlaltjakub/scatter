import type { ImageRegion } from '@/store/types';
import type { PortPoint, SourcePort } from '@/physics/sourcePort';
import { normalizedImageRegions } from './imageRegions';
import { connectedImageRegions, imageRegionConnectionPath } from './imageRegionConnections';

/** Computed only when a selection or bitmap size changes, never per frame.
 * The same rounded contours drive the visible frame and the worker endpoint. */
export function imageRegionFrame(regions: readonly ImageRegion[], rect: {
  x: number; y: number; width: number; height: number;
}): { path: string; connectionPath: string; port: SourcePort } | null {
  const valid = normalizedImageRegions(regions);
  if (!valid.length || rect.width <= 0 || rect.height <= 0) return null;
  const groups = connectedImageRegions(valid);
  if (groups.length > 1) {
    const frames = groups.map(group => imageRegionFrame(group, rect)!);
    const ports = frames.map(frame => frame.port);
    return {
      path: frames.map(frame => frame.path).join(''),
      connectionPath: imageRegionConnectionPath(ports),
      port: { center: ports[0]!.center, contours: ports.flatMap(port => port.contours), components: ports },
    };
  }
  const xs = [...new Set(valid.flatMap((r) => [r.x, r.x + r.width]))].sort((a, b) => a - b);
  const ys = [...new Set(valid.flatMap((r) => [r.y, r.y + r.height]))].sort((a, b) => a - b);
  const occupied = ys.slice(1).map((y, j) => xs.slice(1).map((x, i) => valid.some((r) => (
    (x + xs[i]!) / 2 > r.x && (x + xs[i]!) / 2 < r.x + r.width
    && (y + ys[j]!) / 2 > r.y && (y + ys[j]!) / 2 < r.y + r.height
  ))));
  const edges = new Map<string, { a: PortPoint; b: PortPoint }[]>();
  const key = (p: PortPoint) => `${p.x},${p.y}`;
  const edge = (a: PortPoint, b: PortPoint) => {
    const list = edges.get(key(a)) ?? [];
    list.push({ a, b }); edges.set(key(a), list);
  };
  occupied.forEach((row, j) => row.forEach((inside, i) => {
    if (!inside) return;
    const x = xs[i]!, y = ys[j]!, right = xs[i + 1]!, bottom = ys[j + 1]!;
    if (!occupied[j - 1]?.[i]) edge({ x, y }, { x: right, y });
    if (!row[i + 1]) edge({ x: right, y }, { x: right, y: bottom });
    if (!occupied[j + 1]?.[i]) edge({ x: right, y: bottom }, { x, y: bottom });
    if (!row[i - 1]) edge({ x, y: bottom }, { x, y });
  }));
  const contours: PortPoint[][] = [];
  while (edges.size) {
    const start = edges.values().next().value![0]!.a as PortPoint;
    const polygon: PortPoint[] = [];
    let point = start;
    do {
      const list = edges.get(key(point));
      if (!list?.length) break;
      const next = list.pop()!;
      if (!list.length) edges.delete(key(point));
      polygon.push({ x: rect.x + point.x * rect.width, y: rect.y + point.y * rect.height });
      point = next.b;
    } while (key(point) !== key(start));
    // Remove grid subdivisions along straight edges before rounding corners.
    const corners = polygon.filter((p, i) => {
      const a = polygon[(i + polygon.length - 1) % polygon.length]!;
      const b = polygon[(i + 1) % polygon.length]!;
      return Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) > 1e-8;
    });
    if (corners.length < 3) continue;
    const rounded: PortPoint[] = [];
    corners.forEach((p, i) => {
      const a = corners[(i + corners.length - 1) % corners.length]!;
      const b = corners[(i + 1) % corners.length]!;
      const before = Math.hypot(a.x - p.x, a.y - p.y), after = Math.hypot(b.x - p.x, b.y - p.y);
      const radius = Math.min(8, before / 2, after / 2);
      const entry = { x: p.x + (a.x - p.x) * radius / before, y: p.y + (a.y - p.y) * radius / before };
      const exit = { x: p.x + (b.x - p.x) * radius / after, y: p.y + (b.y - p.y) * radius / after };
      // Four quadratic samples are subpixel-accurate at this small radius;
      // sharing them makes arrow/frame intersections exact at every zoom.
      for (let n = 0; n <= 4; n++) {
        const t = n / 4, u = 1 - t;
        rounded.push({ x: u * u * entry.x + 2 * u * t * p.x + t * t * exit.x,
          y: u * u * entry.y + 2 * u * t * p.y + t * t * exit.y });
      }
    });
    contours.push(rounded);
  }
  if (!contours.length) return null;
  const left = xs[0]!, top = ys[0]!, right = xs.at(-1)!, bottom = ys.at(-1)!;
  const center = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const inside = valid.some((r) => center.x > r.x && center.x < r.x + r.width && center.y > r.y && center.y < r.y + r.height);
  const origin = inside ? center : valid.map((r) => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 }))
    .reduce((a, b) => Math.hypot(a.x - center.x, a.y - center.y) <= Math.hypot(b.x - center.x, b.y - center.y) ? a : b);
  return { path: contours.map((points) => points.map((p, i) => `${i ? 'L' : 'M'}${p.x},${p.y}`).join('') + 'Z').join(''),
    connectionPath: '',
    port: { center: { x: rect.x + origin.x * rect.width, y: rect.y + origin.y * rect.height }, contours } };
}
