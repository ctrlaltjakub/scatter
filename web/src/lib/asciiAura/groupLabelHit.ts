import type { Rect } from './sceneState';
import { hitTestAnimatedLabels } from './animatedLabelHit';
import type { GroupLabelTarget } from './groupLabels';

export interface HittableGroupLabel {
  groupId: string;
  target: GroupLabelTarget;
  rect: Rect;
  startedAt: number;
  clearedAt: number | null;
  cells: readonly unknown[];
}

/** Return the group represented by the visible ASCII cluster label at a point. */
export function hitTestGroupLabels(
  entries: Readonly<Record<string, HittableGroupLabel>>,
  x: number,
  y: number,
  now: number,
): GroupLabelTarget | null {
  const best = hitTestAnimatedLabels(entries, x, y, now, (entry) => entry.rect);
  return best?.target ?? null;
}
