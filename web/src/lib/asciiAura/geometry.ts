/**
 * Shortest distance from a point to the border of an axis-aligned
 * rectangle. Returns 0 when the point is inside (or exactly on) the
 * border. Used per-cell by the aura layer to figure out how close a
 * grid cell is to a node — which feeds the density ramp.
 */
export function distanceToRectBorder(
  px: number,
  py: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
): number {
  const dx = Math.max(rx - px, 0, px - (rx + rw));
  const dy = Math.max(ry - py, 0, py - (ry + rh));
  if (dx === 0 && dy === 0) return 0;
  if (dx === 0) return dy;
  if (dy === 0) return dx;
  return Math.sqrt(dx * dx + dy * dy);
}
