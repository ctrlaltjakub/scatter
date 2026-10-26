import type { ImageRegion } from '@/store/types';

export const EMPTY_IMAGE_REGIONS: readonly ImageRegion[] = Object.freeze([]);
const clamp = (n: number) => Math.max(0, Math.min(1, n));

/** Coordinates refer to the displayed bitmap, not screen pixels: resizing,
 * canvas zoom and opening the editor cannot move a selection. */
export function normalizedImageRegions(regions: readonly ImageRegion[]): ImageRegion[] {
  return regions.flatMap((r) => {
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) return [];
    if (r.x >= 0 && r.y >= 0 && r.width > 0 && r.height > 0
      && r.x + r.width <= 1 && r.y + r.height <= 1) return [{ ...r }];
    const x = clamp(Math.min(r.x, r.x + r.width));
    const y = clamp(Math.min(r.y, r.y + r.height));
    const width = clamp(Math.max(r.x, r.x + r.width)) - x;
    const height = clamp(Math.max(r.y, r.y + r.height)) - y;
    return width > 0 && height > 0 ? [{ x, y, width, height }] : [];
  });
}

export function imageRegionFromDrag(a: { x: number; y: number }, b: { x: number; y: number }): ImageRegion {
  const x = clamp(Math.min(a.x, b.x));
  const y = clamp(Math.min(a.y, b.y));
  return { x, y, width: clamp(Math.max(a.x, b.x)) - x, height: clamp(Math.max(a.y, b.y)) - y };
}

export function imageRegionBounds(regions: readonly ImageRegion[]): ImageRegion | null {
  const valid = normalizedImageRegions(regions);
  if (!valid.length) return null;
  const x = Math.min(...valid.map((r) => r.x));
  const y = Math.min(...valid.map((r) => r.y));
  return { x, y,
    width: Math.max(...valid.map((r) => r.x + r.width)) - x,
    height: Math.max(...valid.map((r) => r.y + r.height)) - y };
}

/** Fill once (no darker overlaps); draw only the union's outside edges,
 * including concave corners and holes, rather than every source rectangle. */
export function imageRegionPaths(regions: readonly ImageRegion[]): { fill: string; outline: string } {
  const valid = normalizedImageRegions(regions);
  const fill = valid.map((r) => `M${r.x},${r.y}h${r.width}v${r.height}h${-r.width}Z`).join('');
  const xs = [...new Set(valid.flatMap((r) => [r.x, r.x + r.width]))].sort((a, b) => a - b);
  const ys = [...new Set(valid.flatMap((r) => [r.y, r.y + r.height]))].sort((a, b) => a - b);
  const occupied = ys.slice(1).map((y, j) => xs.slice(1).map((x, i) => valid.some((r) => (
    (x + xs[i]!) / 2 > r.x && (x + xs[i]!) / 2 < r.x + r.width
    && (y + ys[j]!) / 2 > r.y && (y + ys[j]!) / 2 < r.y + r.height
  ))));
  const edges: string[] = [];
  occupied.forEach((row, j) => row.forEach((inside, i) => {
    if (!inside) return;
    const x = xs[i]!, y = ys[j]!, right = xs[i + 1]!, bottom = ys[j + 1]!;
    if (!occupied[j - 1]?.[i]) edges.push(`M${x},${y}H${right}`);
    if (!occupied[j + 1]?.[i]) edges.push(`M${x},${bottom}H${right}`);
    if (!row[i - 1]) edges.push(`M${x},${y}V${bottom}`);
    if (!row[i + 1]) edges.push(`M${right},${y}V${bottom}`);
  }));
  return { fill, outline: edges.join('') };
}

export function imageRegionsDescription(regions: readonly ImageRegion[]): string {
  return normalizedImageRegions(regions).map((r, i) => (
    `${i + 1}: left ${(r.x * 100).toFixed(2)}%, top ${(r.y * 100).toFixed(2)}%, width ${(r.width * 100).toFixed(2)}%, height ${(r.height * 100).toFixed(2)}%`
  )).join('; ');
}
