/**
 * Chain-aware wall computation for "X can move up to here, but no further"
 * questions.
 *
 * Both resize (clientside, NodeView) and drag (worker, physicsWorker) need
 * to clamp a moving rect against pinned obstacles AND against unpinned
 * nodes that are themselves blocked by pinned ones downstream:
 *
 *   A   B(unpinned)   C(pinned)
 *   ┌─┐  ┌─┐           ┌─┐
 *   └─┘  └─┘           └─┘
 *
 *   A wants to grow / drag right. B can be pushed, but only as far as
 *   C — so the effective wall for A's right edge is `C.left − B.width`.
 *
 * Each wall function walks the chain from far-side first toward the
 * active rect, accumulating constraints. Pinned nodes set a hard wall;
 * unpinned nodes propagate `max(naturalEdge, wallBehind − width)` (the
 * larger of "where it currently sits" and "where it would be if pushed
 * flush against whatever is behind it"). A chain of unpinned nodes with
 * NO pinned at the end never produces a constraint — they can be pushed
 * indefinitely.
 *
 * Filter convention (per direction): only nodes whose perpendicular axis
 * overlaps `start`'s perpendicular axis AND whose FAR edge extends past
 * `start`'s near edge in the growth direction. So for "rightward" we
 * include any node whose right edge is past `start.right` — fully to
 * the right OR overlapping `start`'s right portion. The wall-walk
 * formula handles overlapping nodes correctly via
 * `max(facingEdge, wallBehind − size)`. Without this broader filter,
 * a node that briefly overlaps the active rect (e.g., during a fast
 * drag) would drop out of the candidate set and the wall would jump
 * past it — letting the user push through.
 */

export type RectInfo = { x: number; y: number; w: number; h: number; pinned: boolean };

/**
 * IMPORTANT — chain propagation through unpinned candidates is NOT used.
 *
 * The original design propagated the wall through chains of unpinned
 * obstacles ("flush against whatever is behind it") on the theory that a
 * dragged node compresses any unpinned chain against the pinned anchor.
 * In practice this creates a self-reinforcing cascade during sideways
 * drags: the chain wall pushes the dragged node perpendicular to the
 * user's motion, the node's new position brings MORE unpinned obstacles
 * into the candidate set, the wall propagates further, and so on. The
 * node ends up hundreds of pixels off the cursor.
 *
 * Instead we now only treat PINNED obstacles as walls. Unpinned
 * obstacles get pushed out of the way by `rectCollide` during the force
 * phase — the chain clamp is purely there to prevent teleporting into
 * pinned bodies. Unpinned propagation that the OLD code did is now
 * skipped (the unpinned branches still iterate so the `n.h` width still
 * "uses up" intermediate space when nested pinneds appear behind, but
 * we no longer mutate the wall from unpinned-only chains).
 */

/** Upper bound on `start.right` after considering the rightward chain. */
export function wallRight(
  start: { x: number; y: number; w: number; h: number },
  others: RectInfo[],
): number {
  const candidates = others.filter((n) =>
    n.y + n.h > start.y && n.y < start.y + start.h && n.x + n.w > start.x + start.w,
  );
  candidates.sort((a, b) => b.x - a.x); // rightmost first
  let wall = Infinity;
  for (const n of candidates) {
    if (!n.pinned) continue;
    wall = Math.min(wall, n.x);
  }
  return wall;
}

/** Lower bound on `start.left` after considering the leftward chain. */
export function wallLeft(
  start: { x: number; y: number; w: number; h: number },
  others: RectInfo[],
): number {
  const candidates = others.filter((n) =>
    n.y + n.h > start.y && n.y < start.y + start.h && n.x < start.x,
  );
  candidates.sort((a, b) => a.x - b.x); // leftmost first
  let wall = -Infinity;
  for (const n of candidates) {
    if (!n.pinned) continue;
    const right = n.x + n.w;
    wall = Math.max(wall, right);
  }
  return wall;
}

/** Upper bound on `start.bottom` after considering the downward chain. */
export function wallBottom(
  start: { x: number; y: number; w: number; h: number },
  others: RectInfo[],
): number {
  const candidates = others.filter((n) =>
    n.x + n.w > start.x && n.x < start.x + start.w && n.y + n.h > start.y + start.h,
  );
  candidates.sort((a, b) => b.y - a.y);
  let wall = Infinity;
  for (const n of candidates) {
    if (!n.pinned) continue;
    wall = Math.min(wall, n.y);
  }
  return wall;
}

/** Lower bound on `start.top` after considering the upward chain. */
export function wallTop(
  start: { x: number; y: number; w: number; h: number },
  others: RectInfo[],
): number {
  const candidates = others.filter((n) =>
    n.x + n.w > start.x && n.x < start.x + start.w && n.y < start.y,
  );
  candidates.sort((a, b) => a.y - b.y);
  let wall = -Infinity;
  for (const n of candidates) {
    if (!n.pinned) continue;
    const bottom = n.y + n.h;
    wall = Math.max(wall, bottom);
  }
  return wall;
}

export type ResizeCorner = 'tl' | 'tr' | 'bl' | 'br';

/**
 * Clamp a proposed resize-rect against the per-axis pinned walls, reserving
 * `gap` px of clearance before each wall. The opposite corner stays anchored:
 * a left/top corner that hits a wall keeps its far edge fixed (recomputing
 * width/height from the anchor), a right/bottom corner just loses width/height.
 *
 * `gap` should equal the physics rest gap (2 × collidePadding). Stopping the
 * resize that far short means rectCollide / the worker's drag-clamp find no
 * overlap on the next tick, so the resized node isn't shoved back off the pin.
 */
export function clampResizeAgainstChain(
  proposed: { x: number; y: number; w: number; h: number },
  start: { x: number; y: number; w: number; h: number },
  mode: ResizeCorner,
  others: RectInfo[],
  gap = 0,
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = proposed;
  const anchorRight = start.x + start.w;
  const anchorBottom = start.y + start.h;

  if (mode === 'br' || mode === 'tr') {
    const right = wallRight(start, others) - gap;
    if (x + w > right) w = Math.max(0, right - x);
  }
  if (mode === 'bl' || mode === 'tl') {
    const left = wallLeft(start, others) + gap;
    if (x < left) {
      x = left;
      w = anchorRight - left;
    }
  }
  if (mode === 'br' || mode === 'bl') {
    const bottom = wallBottom(start, others) - gap;
    if (y + h > bottom) h = Math.max(0, bottom - y);
  }
  if (mode === 'tr' || mode === 'tl') {
    const top = wallTop(start, others) + gap;
    if (y < top) {
      y = top;
      h = anchorBottom - top;
    }
  }
  return { x, y, w, h };
}

/**
 * Largest aspect-locked media WIDTH that keeps the growing edges `gap` px clear
 * of every pinned wall. Media nodes resize width-driven with a fixed ratio, so
 * a wall on EITHER axis caps the width:
 *   - horizontal wall → direct width cap
 *   - vertical wall   → height room ÷ ratio (minus the constant chrome)
 *
 * `ratio` = naturalHeight / naturalWidth (body height per unit width).
 * `chromeH` = renderedHeight − bodyHeight (header/footer, constant per resize).
 * Returns Infinity when no pinned wall constrains the active growth direction.
 */
export function maxMediaWidthAgainstChain(
  start: { x: number; y: number; w: number; h: number },
  mode: ResizeCorner,
  ratio: number,
  chromeH: number,
  others: RectInfo[],
  gap = 0,
): number {
  const anchorRight = start.x + start.w;
  const anchorBottom = start.y + start.h;
  let maxW = Infinity;

  // Horizontal: which way does the width grow?
  if (mode === 'br' || mode === 'tr') {            // grow right; left edge fixed at start.x
    const right = wallRight(start, others) - gap;
    if (Number.isFinite(right)) maxW = Math.min(maxW, right - start.x);
  } else {                                          // bl / tl: grow left; right edge fixed
    const left = wallLeft(start, others) + gap;
    if (Number.isFinite(left)) maxW = Math.min(maxW, anchorRight - left);
  }

  // Vertical: renderedH = w·ratio + chromeH → convert the height room to a width.
  if (ratio > 0) {
    if (mode === 'br' || mode === 'bl') {           // grow down; top edge fixed at start.y
      const bottom = wallBottom(start, others) - gap;
      if (Number.isFinite(bottom)) maxW = Math.min(maxW, (bottom - start.y - chromeH) / ratio);
    } else {                                        // tr / tl: grow up; bottom edge fixed
      const top = wallTop(start, others) + gap;
      if (Number.isFinite(top)) maxW = Math.min(maxW, (anchorBottom - top - chromeH) / ratio);
    }
  }
  return maxW;
}
