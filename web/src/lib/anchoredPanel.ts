/**
 * Geometry + click-away rules for the group color panel, which is portaled to
 * document.body so the sidebar's scrolling groups list can't clip it. The
 * panel is position:fixed and follows its anchor row via an rAF loop in
 * GroupColorEditor; this module holds the pure logic.
 */

export interface AnchoredPanelInput {
  /** The anchor row's viewport rect (getBoundingClientRect subset). */
  anchor: { left: number; top: number; bottom: number; width: number };
  /** Panel offsetHeight. */
  panelH: number;
  /** window.innerHeight. */
  viewportH: number;
  /** The scroll area's visible band — when the anchor row leaves it, the
   *  panel hides rather than float next to nothing. */
  clip?: { top: number; bottom: number };
  /** Space between row and panel (matches the old margin-top). */
  gap?: number;
  /** Breathing room kept from the viewport edges. */
  margin?: number;
}

export interface AnchoredPanelPos {
  left: number;
  top: number;
  width: number;
  visible: boolean;
}

/**
 * Prefer opening just below the anchor; clamp upward so the panel never
 * overflows the viewport bottom (never flip fully above — that would cover
 * the rename input), and never above the top margin.
 */
export function computeAnchoredPanelPos(i: AnchoredPanelInput): AnchoredPanelPos {
  const gap = i.gap ?? 4;
  const margin = i.margin ?? 8;
  let top = i.anchor.bottom + gap;
  top = Math.min(top, i.viewportH - margin - i.panelH);
  top = Math.max(top, margin);
  const visible = i.clip
    ? !(i.anchor.bottom < i.clip.top || i.anchor.top > i.clip.bottom)
    : true;
  return { left: i.anchor.left, top, width: i.anchor.width, visible };
}

/**
 * Click-away test for a row's inline rename: true only for pointer-downs
 * OUTSIDE both the row and the (portaled) color panel. The panel lives under
 * document.body, so a plain `row.contains(target)` would treat a swatch
 * click as "outside" and commit/close the editor before the pick lands.
 */
export function isClickAwayFromRow(row: HTMLElement | null, target: EventTarget | null): boolean {
  if (!row) return false;
  const t = target as Element | null;
  if (t?.closest?.('.group-color-editor')) return false;
  return !row.contains(t as Node);
}
