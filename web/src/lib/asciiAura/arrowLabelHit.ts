import type { Rect } from './sceneState';
import { hitTestAnimatedLabels } from './animatedLabelHit';

export interface HittableArrowLabel {
  arrowId?: string;
  targetNodeId: string;
  hitRect: Rect;
  startedAt: number;
  clearedAt: number | null;
  cells: readonly unknown[];
}

export function hitTestArrowLabelEntry(
  entries: Readonly<Record<string, HittableArrowLabel>>,
  x: number, y: number, now: number,
): HittableArrowLabel | null {
  return hitTestAnimatedLabels(entries, x, y, now, (entry) => entry.hitRect);
}

/**
 * Return the destination of the visible ASCII label under a screen-space point.
 * The full wrapped box is interactive, while animation visibility follows the
 * same per-glyph gate as the renderer. Active labels beat deleting remnants.
 */
export function hitTestArrowLabels(
  entries: Readonly<Record<string, HittableArrowLabel>>,
  x: number,
  y: number,
  now: number,
): string | null {
  const best = hitTestAnimatedLabels(entries, x, y, now, (entry) => entry.hitRect);
  return best?.targetNodeId ?? null;
}
