/**
 * Pure decision math for camera edge-pan during a node drag — no DOM, unit-testable.
 *
 * The camera follows a dragged node toward a canvas edge, BUT only when the node
 * is actually moving toward that edge — not merely sitting near it. Without the
 * direction gate the camera chases the edge even while the user drags the node
 * back toward the middle, fighting them. The geometry (which edge, how hard) is
 * unchanged from the original inline version; the `dxMove`/`dyMove` sign checks
 * are the only addition.
 */
export interface EdgePanInput {
  /** Dragged node's screen-space edges (CSS px from the canvas top-left). */
  screenLeft: number;
  screenRight: number;
  screenTop: number;
  /** Canvas viewport size in CSS px. */
  cw: number;
  ch: number;
  /** Distance from an edge at which panning starts. */
  margin: number;
  /** Pan strength per px of overshoot past the margin. */
  rate: number;
  /** Node movement this frame in canvas px; sign = drag direction. */
  dxMove: number;
  dyMove: number;
}

export function computeEdgePan(i: EdgePanInput): { panX: number; panY: number } {
  const { screenLeft, screenRight, screenTop, cw, ch, margin, rate, dxMove, dyMove } = i;
  let panX = 0;
  let panY = 0;

  if (screenLeft < margin && dxMove < 0) panX = (margin - screenLeft) * rate;
  else if (screenRight > cw - margin && dxMove > 0) panX = ((cw - margin) - screenRight) * rate;

  // Vertical-down pan triggers from the node's HEADER (top edge) reaching the
  // lower margin, not its bottom edge — for tall nodes the bottom-edge trigger
  // fires far too early. (Preserved from the original geometry.)
  if (screenTop < margin && dyMove < 0) panY = (margin - screenTop) * rate;
  else if (screenTop > ch - margin && dyMove > 0) panY = ((ch - margin) - screenTop) * rate;

  return { panX, panY };
}
