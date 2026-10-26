/** A node's rectangle in minimap coordinates (CSS px within the canvas). */
export interface MiniRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Which node is under the pointer on the minimap? The list is in draw
 * order (last = painted on top), so scan backward: on overlap the rect
 * the user actually sees wins. Edge-inclusive; null on a miss.
 */
export function hitTestRects(list: readonly MiniRect[], px: number, py: number): string | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const r = list[i]!;
    if (px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h) return r.id;
  }
  return null;
}
