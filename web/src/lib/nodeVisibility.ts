import type { ScatterNode } from '@/store/types';
import { nodeWidth, nodeRenderedH } from '@/lib/nodeSize';
import { getLiveViewport } from '@/store/useLiveViewportStore';
import { getLivePosition } from '@/store/useLivePositionsStore';

/**
 * Is a node "clearly visible — no pan needed"?
 *
 * This mirrors the exact "already in view" test the camera-pan code uses in
 * `Canvas.tsx` (`computeTarget`): a node is fully visible when its screen rect
 * sits inside the viewport, inset by a small margin and (when open) by the
 * left sidebar strip. Keeping the math identical means "fully visible" here and
 * "requestPanTo won't move" there agree — so the arrow-click rule can rely on
 * it to choose between "go to the parent" and "re-center this child".
 *
 * Canvas imports these constants so focus-fit and visibility use the same inset.
 */
export const FIT_MARGIN_PX = 20 / 3;
export const SIDEBAR_WIDTH = 240;

export interface Viewport { x: number; y: number; zoom: number; }
export interface BBox { minX: number; minY: number; maxX: number; maxY: number; }

/**
 * Pure geometry: does `bbox` (world coords) project fully inside the margined
 * viewport window? `leftInsetPx` reserves the open sidebar's strip on the left.
 */
export function bboxFullyVisible(args: {
  bbox: BBox;
  viewport: Viewport;
  containerW: number;
  containerH: number;
  marginPx?: number;
  leftInsetPx?: number;
}): boolean {
  const M = args.marginPx ?? FIT_MARGIN_PX;
  const mLeft = M + (args.leftInsetPx ?? 0);
  const { x: vx, y: vy, zoom } = args.viewport;
  const left = args.bbox.minX * zoom + vx;
  const right = args.bbox.maxX * zoom + vx;
  const top = args.bbox.minY * zoom + vy;
  const bottom = args.bbox.maxY * zoom + vy;
  return (
    left >= mLeft &&
    right <= args.containerW - M &&
    top >= M &&
    bottom <= args.containerH - M
  );
}

/**
 * Pure geometry: does `bbox` (world coords) project to a screen rect that
 * OVERLAPS the viewport window at all? The mirror of {@link bboxFullyVisible} —
 * containment becomes intersection. `marginPx` shrinks the window (positive →
 * a node barely poking in counts as hidden); default 0 (any overlap = visible).
 */
export function bboxIntersectsViewport(args: {
  bbox: BBox;
  viewport: Viewport;
  containerW: number;
  containerH: number;
  marginPx?: number;
}): boolean {
  const M = args.marginPx ?? 0;
  const { x: vx, y: vy, zoom } = args.viewport;
  const left = args.bbox.minX * zoom + vx;
  const right = args.bbox.maxX * zoom + vx;
  const top = args.bbox.minY * zoom + vy;
  const bottom = args.bbox.maxY * zoom + vy;
  return (
    right > M &&
    left < args.containerW - M &&
    bottom > M &&
    top < args.containerH - M
  );
}

/** Pixel size of the canvas viewport, read from the `.canvas-host` element
 *  (the same host the minimap measures), falling back to the window. */
function canvasHostSize(): { w: number; h: number } {
  if (typeof document !== 'undefined') {
    const host = document.querySelector('.canvas-host') as HTMLElement | null;
    if (host && host.clientWidth > 0 && host.clientHeight > 0) {
      return { w: host.clientWidth, h: host.clientHeight };
    }
  }
  if (typeof window !== 'undefined') return { w: window.innerWidth, h: window.innerHeight };
  return { w: 0, h: 0 };
}

/** Left inset to reserve for the project sidebar: its width when open, else 0.
 *  The sidebar floats over the canvas-host, so an on-screen node in the left
 *  strip isn't "clearly visible". Detected via the `.collapsed` class the
 *  Sidebar toggles — matching Canvas's `sidebarCollapsed ? 0 : SIDEBAR_WIDTH`. */
export function currentSidebarInsetPx(): number {
  if (typeof document === 'undefined') return 0;
  const el = document.querySelector('.sidebar');
  if (!el || el.classList.contains('collapsed')) return 0;
  return SIDEBAR_WIDTH;
}

/**
 * Live-state wrapper around {@link bboxFullyVisible}: reads the current camera
 * (live viewport store), the node's live position (physics) with a fallback to
 * its committed position, its rendered size, and the viewport pixel size.
 */
export function isNodeFullyVisible(node: ScatterNode): boolean {
  const vp = getLiveViewport();
  const lp = getLivePosition(node.id);
  const x = lp?.x ?? node.position.x;
  const y = lp?.y ?? node.position.y;
  const bbox: BBox = { minX: x, minY: y, maxX: x + nodeWidth(node), maxY: y + nodeRenderedH(node) };
  const { w, h } = canvasHostSize();
  return bboxFullyVisible({
    bbox,
    viewport: vp,
    containerW: w,
    containerH: h,
    leftInsetPx: currentSidebarInsetPx(),
  });
}

/**
 * Live-state wrapper around {@link bboxIntersectsViewport}: true when ANY part
 * of the node's screen rect is on screen. Unlike {@link isNodeFullyVisible} this
 * ignores the sidebar inset — it answers "is this node off-screen entirely?",
 * which is what the arrow header-label uses to decide whether to name the
 * (unseen) parent end of an arrow instead of the child end.
 */
export function isNodePartiallyVisible(node: ScatterNode): boolean {
  const vp = getLiveViewport();
  const lp = getLivePosition(node.id);
  const x = lp?.x ?? node.position.x;
  const y = lp?.y ?? node.position.y;
  const bbox: BBox = { minX: x, minY: y, maxX: x + nodeWidth(node), maxY: y + nodeRenderedH(node) };
  const { w, h } = canvasHostSize();
  return bboxIntersectsViewport({ bbox, viewport: vp, containerW: w, containerH: h });
}
