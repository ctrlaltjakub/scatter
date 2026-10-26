import type { Rect } from './sceneState';
import { isCharShown } from './statusText';

export interface HittableAnimatedLabel {
  startedAt: number;
  clearedAt: number | null;
  cells: readonly unknown[];
}

/**
 * Pick the visible animated label under a screen-space point. The complete
 * label rectangle is interactive, including spaces and wrapped-line gaps.
 * A live label wins over a deleting remnant when their boxes overlap.
 */
export function hitTestAnimatedLabels<T extends HittableAnimatedLabel>(
  entries: Readonly<Record<string, T>>,
  x: number,
  y: number,
  now: number,
  rectOf: (entry: T) => Rect,
): T | null {
  let best: T | null = null;

  for (const entry of Object.values(entries)) {
    const rect = rectOf(entry);
    if (x < rect.x || x >= rect.x + rect.w || y < rect.y || y >= rect.y + rect.h) continue;

    const total = entry.cells.length;
    let anyVisible = false;
    for (let k = 0; k < total; k++) {
      if (isCharShown(k, total, entry.startedAt, entry.clearedAt, now)) {
        anyVisible = true;
        break;
      }
    }
    if (!anyVisible) continue;

    const entryActive = entry.clearedAt == null;
    const bestActive = best?.clearedAt == null;
    if (!best || (entryActive && !bestActive) || (entryActive === bestActive && entry.startedAt > best.startedAt)) {
      best = entry;
    }
  }

  return best;
}
