/**
 * Math for the floating side panel's "follow the active section" motion.
 *
 * As the user scrolls / expands bullets, the panel's top edge tries to
 * track the top of the currently-expanded section. The hard constraint —
 * higher priority than the tracking — is that the panel's LOWER edge must
 * never drop below the node's lower border. When the two conflict, the
 * panel slides up so its bottom sits exactly on the node bottom (even if
 * that means its top rides above the node top, for panels taller than the
 * node).
 *
 * Everything is in CSS pixels in the node's local (world) space, so the
 * caller is responsible for dividing any post-zoom getBoundingClientRect
 * reads by the viewport zoom before passing them in. `offsetHeight` and
 * ResizeObserver heights are already zoom-independent layout pixels.
 *
 * The pure functions here are unit-tested (panelFollow.test.ts); the
 * rAF/DOM glue that feeds them lives in NodeSidePanel and is verified by
 * eye in the running app.
 */

export interface PanelOffsetInput {
  /** Active section's top minus the node's top, CSS px. Always ≥ 0 in
   *  practice (sections live inside the body, below the node top). */
  sectionTopWithinNode: number;
  /** Node card border-box height, CSS px (excludes the follow-up bar,
   *  which is absolutely positioned outside the card). */
  nodeHeight: number;
  /** Panel border-box height, CSS px. */
  panelHeight: number;
  /** Which edge wins when the panel is taller than the node. The sources
   *  panel keeps the legacy bottom priority; the left action panel opts into
   *  top priority so its controls never begin above the card. */
  edgePriority?: 'bottom' | 'top';
}

/**
 * Target vertical offset (CSS px) to add to the node's top so the panel
 * tracks the active section — clamped so the panel bottom never passes
 * the node bottom (the clamp is the highest-priority rule).
 */
export function computePanelTargetOffset(opts: PanelOffsetInput): number {
  const { sectionTopWithinNode, nodeHeight, panelHeight, edgePriority = 'bottom' } = opts;
  // Largest offset that still keeps the panel's bottom on the node's
  // bottom border. May be negative when the panel is taller than the
  // node — in which case the priority rule pulls the top above the node
  // top so the bottom still lines up.
  const maxOffset = nodeHeight - panelHeight;
  const bottomClamped = Math.min(sectionTopWithinNode, maxOffset);
  return edgePriority === 'top' ? Math.max(0, bottomClamped) : bottomClamped;
}

// ─── Trapezoidal follow motion ──────────────────────────────────────────
// The panel doesn't snap and it doesn't ease-out-only — it travels SLOWLY
// with a SHORT acceleration ramp at the start and a SHORT deceleration at
// the end, cruising at a low constant speed in between. That's a
// trapezoidal velocity profile, implemented as a speed-capped,
// acceleration-limited motion that decelerates in time to stop exactly on
// the target (classic kinematic "arrive").

export interface PanelMotionParams {
  /** Cruise speed cap, CSS px per frame (at 60fps). The "slow travel"
   *  knob — lower = slower glide. */
  maxSpeed: number;
  /** Acceleration magnitude, CSS px per frame². Governs how SHORT the
   *  start ramp and the end braking are — higher = crisper, shorter
   *  ramps; the cruise then dominates the trip. */
  accel: number;
}

export interface PanelMotionState {
  /** Current offset, CSS px. */
  pos: number;
  /** Current velocity, CSS px per frame (signed). */
  vel: number;
}

/** Tuned for a quick cruise with long, gentle ease-in / ease-out ramps:
 *  a high speed cap so travel doesn't feel sluggish, and a small accel so
 *  the start ramp and end braking stretch over many frames (~50 frames to
 *  reach the cap). Units are per-frame at 60fps (the rAF loop's cadence). */
export const PANEL_MOTION: PanelMotionParams = {
  maxSpeed: 15,
  accel: 0.3,
};

/** Below these thresholds the motion is "arrived" and snaps to rest so it
 *  doesn't crawl the last sub-pixel forever. */
const SETTLE_DIST = 0.25;
const SETTLE_VEL = 0.5;

/**
 * Advance the motion one frame toward `target`. Velocity is ramped toward
 * a desired speed (capped at `maxSpeed`, but reduced near the target so we
 * can brake to zero exactly on it) by at most `accel` per frame, giving
 * the short-accel / slow-cruise / short-decel profile. Carries velocity,
 * so a moving target re-aims smoothly. Never overshoots.
 */
export function stepPanelMotion(
  state: PanelMotionState,
  target: number,
  p: PanelMotionParams,
): PanelMotionState {
  const dist = target - state.pos;
  const absDist = Math.abs(dist);

  // Arrived: close enough and slow enough → rest exactly on target.
  if (absDist <= SETTLE_DIST && Math.abs(state.vel) <= SETTLE_VEL) {
    return { pos: target, vel: 0 };
  }

  const dir = dist >= 0 ? 1 : -1;
  // Speed from which we could still decelerate to a stop right at the
  // target under our accel (v² = 2·a·d). Min with maxSpeed → cruise far
  // out, brake on approach. This is the short deceleration ramp.
  const brakeSpeed = Math.sqrt(2 * p.accel * absDist);
  const desiredSpeed = Math.min(p.maxSpeed, brakeSpeed);
  const desiredVel = dir * desiredSpeed;

  // Ramp the current velocity toward the desired velocity, limited by
  // `accel` per frame. This is the short acceleration ramp at the start.
  const dv = desiredVel - state.vel;
  const clampedDv = Math.max(-p.accel, Math.min(p.accel, dv));
  let vel = state.vel + clampedDv;
  let pos = state.pos + vel;

  // Guard against overshooting the target on the final step.
  if ((target - pos) * dir < 0) {
    pos = target;
    vel = 0;
  }
  return { pos, vel };
}
