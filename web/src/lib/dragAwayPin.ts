/**
 * Auto-pin a node that the user drags well clear of a directly connected
 * parent or child.
 *
 * The trigger is the CHANGE in parent↔child distance across one drag gesture —
 * not the absolute distance. Dragging the child in a loop back to where it
 * started does nothing; pulling it >160 graph-pixels FARTHER than where the
 * drag began signals "I'm placing this here on purpose", so it gets pinned
 * (`frozen`) on release. Pure + threshold-parameterized so it's unit-testable
 * without the canvas; the Canvas drag handlers supply the measured distances.
 */

/** Default drag-away threshold, in graph/world pixels (zoom-independent). */
export const DRAG_AWAY_PIN_PX = 160;
/** Excess separation over which the armed icon reaches its maximum intensity. */
export const PIN_ARM_RAMP_PX = 320;

interface Rect { x: number; y: number; w: number; h: number; }

interface ArrowRelation {
  kind: string;
  fromNodeId: string;
  toNodeId: string;
}

/** Direct automatic-arrow relatives in project arrow order. Manual arrows do
 * not express the generated parent/child hierarchy, so they are excluded. */
export function directAutoRelativeIds(
  nodeId: string,
  arrows: readonly ArrowRelation[],
): string[] {
  const ids = new Set<string>();
  for (const arrow of arrows) {
    if (arrow.kind !== 'auto') continue;
    if (arrow.toNodeId === nodeId) ids.add(arrow.fromNodeId);
    else if (arrow.fromNodeId === nodeId) ids.add(arrow.toNodeId);
  }
  return [...ids];
}

/** Distance between the centers of two node rects (world coords). Matches the
 *  center-to-center convention used by spawn placement in `generate.ts`. */
export function centerDistance(a: Rect, b: Rect): number {
  const acx = a.x + a.w / 2;
  const acy = a.y + a.h / 2;
  const bcx = b.x + b.w / 2;
  const bcy = b.y + b.h / 2;
  return Math.hypot(acx - bcx, acy - bcy);
}

export function shouldPinOnDragAway(args: {
  distStart: number;
  distEnd: number;
  threshold?: number;
  /** The current drag already shook a pinned node loose. Suppress every
   *  arm/pin decision until pointer-up so the same gesture cannot re-pin it. */
  suppressed?: boolean;
}): boolean {
  if (args.suppressed) return false;
  const threshold = args.threshold ?? DRAG_AWAY_PIN_PX;
  return args.distEnd - args.distStart > threshold;
}

/** A deliberate pull away from any one direct relative is sufficient. */
export function shouldPinOnDragAwayFromAny(args: {
  distances: readonly { distStart: number; distEnd: number }[];
  threshold?: number;
  suppressed?: boolean;
}): boolean {
  return dragAwayExcessFromAny(args) > 0;
}

/** Maximum distance beyond the pin threshold across all direct relatives. */
export function dragAwayExcessFromAny(args: {
  distances: readonly { distStart: number; distEnd: number }[];
  threshold?: number;
  suppressed?: boolean;
}): number {
  if (args.suppressed) return 0;
  const threshold = args.threshold ?? DRAG_AWAY_PIN_PX;
  return args.distances.reduce(
    (max, { distStart, distEnd }) => Math.max(max, distEnd - distStart - threshold),
    0,
  );
}

/** Normalize excess separation to the icon's capped animation ramp. */
export function pinArmStrength(excessPx: number): number {
  return Math.max(0, Math.min(1, excessPx / PIN_ARM_RAMP_PX));
}
