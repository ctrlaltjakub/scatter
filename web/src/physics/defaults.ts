import type { PhysicsConfig } from '@/store/types';

export const DEFAULT_PHYSICS_CONFIG: PhysicsConfig = {
  // All distance fields below are BORDER-TO-BORDER (rect-to-rect Minkowski),
  // not center-to-center. Tuned for "compact, lots of info on screen" —
  // tight gaps so the user can read several nodes at once, with enough
  // repulsion to prevent visible overlap once a node is resized larger.
  // Linked pairs are meant to sit close: the link spring is the dominant
  // force at short range, so linkedRepelStrength is small. Unlinked pairs
  // get NO soft repulsion by default (= 0) — when set, dragging one node
  // caused all nearby unrelated nodes within `repelRange` to be pushed
  // away too, and the push could chain through neighbours so that even
  // far-away unconnected nodes drifted. Hard overlap between unrelated
  // nodes is still resolved by rectCollide (a position-based pusher
  // that fires only on actual AABB overlap). Slider is still exposed
  // in Settings if you want to re-enable a "personal-space" force.
  // Performance note: pairwiseRepel has an `if (strength === 0) return;`
  // short-circuit, so setting this to 0 skips the entire O(N²) walk
  // for unlinked pairs every tick.
  linkedRepelStrength: -10,
  unlinkedRepelStrength: 0,
  // `repelRange` is kept AT/BELOW the hard floor (2 × collidePadding =
  // 62.5) so the small linked-pair repel never fires inside the resting
  // gap — otherwise it would nudge connected pairs a few px wider than the
  // floor (and drift them on release). With it at 50 (< the 62.5 floor),
  // linked nodes settle exactly at the floor; unlinked pairs already pack
  // to the floor via rectCollide alone.
  repelRange: 50,
  /** Equilibrium BORDER GAP between linked pairs (px). The border-distance
   *  link spring (rectLink) pulls them to this gap regardless of node sizes.
   *  Set EQUAL to the hard floor (2 × collidePadding = 62.5) so connected
   *  nodes pack right to the minimum: the spring's rest coincides with the
   *  collide floor, so a pair settles at exactly 62.5 with no standoff (the
   *  spring is zero there). Do NOT set below 2 × collidePadding, or the
   *  floor outranks the spring and the two fight every tick (jitter). */
  linkDistance: 62.5,
  linkStrength: 0.6,
  /** Extra px added to each rect during overlap resolution. Doubled gives
   *  the visible minimum gap between ANY pair (linked or not, pinned or
   *  not) — rectCollide is direct position mutation so this is a hard
   *  constraint that link springs and pairwise repulsion cannot override.
   *  31.25 → 62.5 px visible min gap. */
  collidePadding: 31.25,
  arrowAvoidPadding: 20,

  // Geometric arrow router. The rope's shape is recomputed every tick from
  // a visibility-graph + A* path between source and target around obstacle
  // corners (with `ropeMargin` clearance). Anchors are then sampled
  // uniformly along that path; `ropeMaxSegmentLength` controls the target
  // spacing (smaller = denser sampling = smoother bezier render). The
  // `ropeMaxAnchorCount` cap prevents a runaway anchor count for very long
  // routes. `ropeSmoothing` is purely visual: bezier control-point distance
  // for the rendered curve.
  ropeMaxSegmentLength: 25,
  ropeMaxAnchorCount: 96,
  ropeSmoothing: 0.25,
  /** Inflation (px) applied to obstacles when building the visibility
   *  graph — the visual clearance between rope and node bodies. */
  ropeMargin: 40,

  // Arrow-arrow repel: anchors from DIFFERENT arrows push each other off
  // so parallel routes don't pixel-overlap. Saturation separation is
  // `range`. NOTE: at the current tight floor (2 × collidePadding = 62.5
  // px) the inter-node gap barely clears the rope margins, so several
  // parallel ropes between the SAME close pair are cramped; `range` stays
  // small (10) to fit whatever space the gap leaves.
  arrowRepelStrength: 0.5,
  arrowRepelRange: 10,
  /** When TRUE, nodes the user is currently dragging are skipped by the
   *  rope router (ropes pass through them). Was the only behavior for a
   *  while; now it's an opt-in escape hatch. With the default (false),
   *  ropes route around dragging nodes the same way they route around
   *  any other node — the chain stays geometrically consistent during
   *  the drag instead of suddenly flipping topology on release. */
  ropeExemptDraggedNodes: 0,

  // d3-force solver knobs (still used for real-node forces).
  // Lower velocityDecay = less friction = nodes glide/settle with more
  // momentum (0.6 = lighter damping than the old 0.82).
  velocityDecay: 0.6,
  alphaDecay: 0.04,
};

/** Per-field display range + step for sliders. min <= default <= max. */
export interface FieldRange { min: number; max: number; step: number; }

export const PHYSICS_FIELD_RANGES: Record<keyof PhysicsConfig, FieldRange> = {
  linkedRepelStrength:        { min: -2000, max:    0,    step: 5 },
  unlinkedRepelStrength:      { min: -2000, max:    0,    step: 5 },
  repelRange:                 { min:    50, max: 2000,    step: 25 },
  linkDistance:               { min:     0, max:  800,    step: 5 },
  linkStrength:               { min:     0, max:    1,    step: 0.01 },
  collidePadding:             { min:     0, max:  100,    step: 1 },
  arrowAvoidPadding:          { min:     0, max:  100,    step: 1 },
  ropeMaxSegmentLength:       { min:     5, max:  300,    step: 5 },
  ropeMaxAnchorCount:         { min:     8, max:  256,    step: 1 },
  ropeSmoothing:              { min:     0, max:    0.5,  step: 0.01 },
  ropeMargin:                 { min:     0, max:  200,    step: 5 },
  arrowRepelStrength:         { min:     0, max:    1,    step: 0.01 },
  arrowRepelRange:            { min:     0, max:  300,    step: 5 },
  ropeExemptDraggedNodes:     { min:     0, max:    1,    step: 1 },
  velocityDecay:              { min:     0, max:    1,    step: 0.01 },
  alphaDecay:                 { min:  0.001, max:  0.2,   step: 0.001 },
};

/** Snap each numeric field into its declared range. Drops invalid keys. */
export function clampPhysicsConfig(input: Partial<PhysicsConfig>): PhysicsConfig {
  const out: PhysicsConfig = { ...DEFAULT_PHYSICS_CONFIG };
  for (const k of Object.keys(PHYSICS_FIELD_RANGES) as (keyof PhysicsConfig)[]) {
    const v = input[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const r = PHYSICS_FIELD_RANGES[k];
    out[k] = Math.max(r.min, Math.min(r.max, v));
  }
  return out;
}
