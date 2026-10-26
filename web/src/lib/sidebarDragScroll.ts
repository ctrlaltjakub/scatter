const EDGE_FRACTION = 0.2;
const MIN_EDGE_PX = 18;
const MAX_EDGE_PX = 48;
const MAX_STEP_PX = 12;

interface SidebarDragScrollInput {
  pointerY: number;
  viewportTop: number;
  viewportBottom: number;
  scrollTop: number;
  maxScrollTop: number;
}

/**
 * Returns one animation-frame scroll step, clamped to the list's range as it
 * existed before dragging began. The fixed range is important: a transformed
 * sortable row can otherwise enlarge its own scrollable overflow indefinitely.
 */
export function sidebarDragScrollStep({
  pointerY,
  viewportTop,
  viewportBottom,
  scrollTop,
  maxScrollTop,
}: SidebarDragScrollInput): number {
  if (maxScrollTop <= 0 || viewportBottom <= viewportTop) return 0;

  const current = Math.min(maxScrollTop, Math.max(0, scrollTop));
  const height = viewportBottom - viewportTop;
  const edge = Math.min(MAX_EDGE_PX, Math.max(MIN_EDGE_PX, height * EDGE_FRACTION));

  let direction = 0;
  let strength = 0;
  if (pointerY < viewportTop + edge) {
    direction = -1;
    strength = Math.min(1, (viewportTop + edge - pointerY) / edge);
  } else if (pointerY > viewportBottom - edge) {
    direction = 1;
    strength = Math.min(1, (pointerY - (viewportBottom - edge)) / edge);
  }
  if (direction === 0) return 0;

  const speed = Math.max(1, Math.ceil(MAX_STEP_PX * strength));
  const next = Math.min(maxScrollTop, Math.max(0, current + direction * speed));
  return next - current;
}
