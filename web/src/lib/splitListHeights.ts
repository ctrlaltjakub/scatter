/**
 * Share a fixed vertical budget between two stacked, independently-scrollable
 * lists (the sidebar's Projects + Groups). Pure math — no DOM, unit-testable.
 *
 * `natA` / `natB` are each list's natural (unclamped) content height; `usable`
 * is the height available for both. Returns the height cap to apply to each:
 *   - both fit            → each keeps its natural height (no scrolling)
 *   - one short, one long → the short one keeps its height, the long one takes
 *                           the rest (only it scrolls)
 *   - both long           → split evenly, both scroll
 */
export function splitListHeights(
  usable: number,
  natA: number,
  natB: number,
): { a: number; b: number } {
  if (usable <= 0) return { a: 0, b: 0 };
  if (natA + natB <= usable) return { a: natA, b: natB };
  const half = usable / 2;
  if (natA <= half) return { a: natA, b: usable - natA };
  if (natB <= half) return { a: usable - natB, b: natB };
  return { a: half, b: half };
}
