/**
 * Precompute the converged cascade state for a single activeIdx,
 * given per-bullet measured heights at the current width.
 *
 * Used by AdaptiveBullets' `cascadeStates` precomputation. The
 * algorithm mirrors the cascade's runtime behavior (seed +
 * measure-correct loop) but runs entirely in JS using known
 * per-bullet heights — so it converges in one synchronous call
 * instead of multiple React renders.
 *
 * The output state must satisfy two invariants:
 *   1. `totalAt(modes) <= avail` (fits the available height)
 *   2. NO further single-step promotion of any non-active bullet
 *      would still fit. ("Fully promoted")
 *
 * Invariant 2 is what eliminates the post-animation cascade
 * chatter. If a non-active bullet could fit at a higher mode but
 * the precomputation leaves it at a lower one, measure-correct
 * (which still runs at runtime) will promote it after the
 * animation completes — causing the visible "collapse too much
 * then expand back" bounce the user reports.
 */
import { heightOf, maxMode, type Heights, type Mode } from './bulletLayout';
import type { Bullet } from './bulletParse';

export interface PerBulletLabs {
  m0: number[];
  m1: number[];
  full: number[];
}

/**
 * Compute per-bullet height at a given mode using the labs as
 * pivots. M0/M1/M_max are direct lookups; intermediate modes
 * (M_2..M_N) interpolate using the same formula `heightOf` uses
 * but with per-bullet inputs:
 *   title_i      = m0[i]
 *   inline-add_i = m1[i] - m0[i]
 *   described_i  = (full[i] - m0[i]) / N_i
 *   heightAt_i(m) = title_i + (m-1)*described_i + inline-add_i
 *
 * Exported for tests; AdaptiveBullets calls it indirectly via
 * `computeCascadeAtActiveIdx`.
 */
export function heightAtPerBullet(
  bullet: Bullet,
  m: Mode,
  i: number,
  labs: PerBulletLabs,
): number {
  const N_i = bullet.children.length;
  const m0i = labs.m0[i] ?? 0;
  const m1i = labs.m1[i] ?? 0;
  const fulli = labs.full[i] ?? 0;
  if (m <= 0) return m0i;
  if (m >= N_i + 1) return fulli;
  if (m === 1) return m1i;
  const inlineAdd = m1i - m0i;
  const describedPer = N_i > 0 ? (fulli - m0i) / N_i : 0;
  return m0i + (m - 1) * describedPer + inlineAdd;
}

/**
 * Compute the converged modes array for a given activeIdx.
 *
 * Phases:
 *   1. **Seed**: active bullet at maxMode, others at 0.
 *   2. **Uniform-first lift**: try to lift all non-active bullets
 *      to successively higher modes (target=1, 2, …). Commit if
 *      the lifted state fits; otherwise drop to greedy and break.
 *   3. **Greedy at last target**: try each non-active bullet
 *      individually, promoting to the target mode if the delta
 *      still fits. Single pass.
 *   4. **Free-upgrade sweep**: promote any bullet whose next-mode
 *      delta is ≤ 0 (the M_N → M_{N+1} jump is height-neutral for
 *      bullets with N children).
 *   5. **Iterative promote** (CRITICAL — the fix for the bouncy
 *      transition): repeatedly pick the lowest-mode non-active
 *      bullet and try to promote it by one step. Stops when no
 *      further single-step promotion fits. Mirrors the cascade's
 *      measure-correct underflow branch — without this phase, the
 *      seed can leave "spare room" that the cascade's runtime
 *      iteration then fills with a visible snap.
 *
 * @returns array of modes (one per bullet); length === bullets.length
 */
export function computeCascadeAtActiveIdx(
  bullets: Bullet[],
  activeI: number | null,
  avail: number,
  labs: PerBulletLabs,
): Mode[] {
  const N = bullets.length;
  const modes: Mode[] = new Array(N).fill(0);
  if (activeI !== null && activeI >= 0 && activeI < N) {
    modes[activeI] = maxMode(bullets[activeI]!);
  }
  if (N === 0) return modes;

  const hAt = (i: number, m: Mode): number =>
    heightAtPerBullet(bullets[i]!, m, i, labs);
  const totalAt = (m: Mode[]): number => {
    let s = 0;
    for (let i = 0; i < m.length; i++) s += hAt(i, m[i] ?? 0);
    return s;
  };

  // Phase 2: Uniform-first lift. Only commit when the ENTIRE
  // tentative (every non-active at `target`) fits. If it doesn't,
  // stop here — DO NOT do the i-greedy fallback that
  // `lib/bulletLayout.ts:computeModes` does. The greedy fallback
  // is order-dependent and can leave a HIGHER bullet at the
  // lower mode while a lower bullet got promoted — the divine
  // cascade only ends up top-down because its runtime measure-
  // correct fixes the greedy's mess. Our precompute doesn't have
  // that recovery; we need strict top-down from the start, so
  // we let Phase 5 (iterative-promote) do all the non-uniform
  // promotion in strict top-down order.
  for (let target = 1; target < 100; target++) {
    const tentative = modes.slice();
    let anyChange = false;
    for (let i = 0; i < N; i++) {
      if (i === activeI) continue;
      const desired = Math.min(target, maxMode(bullets[i]!));
      if (desired > (tentative[i] ?? 0)) {
        tentative[i] = desired;
        anyChange = true;
      }
    }
    if (!anyChange) break;
    if (totalAt(tentative) <= avail) {
      for (let i = 0; i < N; i++) modes[i] = tentative[i] ?? 0;
    } else {
      break;
    }
  }

  // Phase 5: Iterative top-down promote. Pick the non-active
  // bullet with the LOWEST current mode (tie-broken by lowest
  // index). If promoting it by one step fits within avail,
  // promote. If it does NOT fit, BREAK — DO NOT skip and try
  // other bullets. The break preserves the divine top-down
  // invariant: bullets are promoted strictly from the top, and
  // if bullet K can't be promoted then bullets K+1, K+2, … are
  // also not promoted (preventing the "random lower bullet at
  // higher mode" bug the user reported).
  let iterProgress = true;
  let iterSafety = 100;
  while (iterProgress && iterSafety-- > 0) {
    iterProgress = false;
    let lowest = Infinity;
    let pickIdx = -1;
    for (let i = 0; i < N; i++) {
      if (i === activeI) continue;
      const cur = modes[i] ?? 0;
      if (cur >= maxMode(bullets[i]!)) continue;
      if (cur < lowest) { lowest = cur; pickIdx = i; }
    }
    if (pickIdx === -1) break;
    const cur = modes[pickIdx] ?? 0;
    const delta = hAt(pickIdx, cur + 1) - hAt(pickIdx, cur);
    if (totalAt(modes) + delta > avail) break;
    modes[pickIdx] = cur + 1;
    iterProgress = true;
  }

  // Phase 6: Free-upgrade sweep (delta ≤ 0 promotions). MUST run
  // AFTER iterative-promote — that phase may move bullets into
  // M_N, from which the M_N → M_{N+1} jump is height-neutral for
  // bullets with N children. Running the sweep first (as the
  // original design did) would miss these because bullets weren't
  // at M_N yet.
  //
  // The sweep iterates until stable — a single bullet's free
  // upgrade might enable another's (e.g., one promotion frees a
  // pixel of slack that lets another bullet's near-zero delta
  // squeeze in).
  let sweepProg = true;
  let sweepSafety = 100;
  while (sweepProg && sweepSafety-- > 0) {
    sweepProg = false;
    for (let i = 0; i < N; i++) {
      const b = bullets[i]!;
      const cur = modes[i] ?? 0;
      const max = maxMode(b);
      if (cur >= max) continue;
      const delta = hAt(i, cur + 1) - hAt(i, cur);
      if (delta <= 0 && totalAt(modes) + delta <= avail) {
        modes[i] = cur + 1;
        sweepProg = true;
      }
    }
  }

  return modes;
}

/**
 * Convenience: precompute the full Map<activeIdx, Mode[]> for
 * every possible active bullet. Used by AdaptiveBullets to build
 * the lookup table that the cascade seed branch reads from.
 */
export function computeAllCascadeStates(
  bullets: Bullet[],
  avail: number,
  labs: PerBulletLabs,
): Map<number | null, Mode[]> {
  const out = new Map<number | null, Mode[]>();
  out.set(null, computeCascadeAtActiveIdx(bullets, null, avail, labs));
  for (let i = 0; i < bullets.length; i++) {
    out.set(i, computeCascadeAtActiveIdx(bullets, i, avail, labs));
  }
  return out;
}

/** The Map-compatible read surface AdaptiveBullets consumes. */
export interface CascadeStatesLookup {
  get(activeIdx: number | null): Mode[] | undefined;
}

/**
 * Lazy variant of `computeAllCascadeStates`: identical values, but each
 * activeIdx's converged state is computed on FIRST `get` and cached, instead
 * of all N+2 states eagerly. The cascade seed reads exactly one entry per
 * frame, so during a streaming pass (inputs change every frame → the whole
 * table is rebuilt every frame) this cuts the precompute cost by ~N×.
 * Out-of-range indices return undefined, matching Map.get on the eager table.
 */
export function createLazyCascadeStates(
  bullets: Bullet[],
  avail: number,
  labs: PerBulletLabs,
): CascadeStatesLookup {
  const cache = new Map<number | null, Mode[]>();
  return {
    get(activeIdx) {
      if (activeIdx !== null && (activeIdx < 0 || activeIdx >= bullets.length)) return undefined;
      let state = cache.get(activeIdx);
      if (!state) {
        state = computeCascadeAtActiveIdx(bullets, activeIdx, avail, labs);
        cache.set(activeIdx, state);
      }
      return state;
    },
  };
}
