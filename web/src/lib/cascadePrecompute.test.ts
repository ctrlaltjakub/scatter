/**
 * Tests for the cascade precomputation.
 *
 * The HEADLINE test the user requested is `isFullyPromoted` —
 * captures the visible bug they reported: when scrolling between
 * bullets, non-active bullets transition to a state that's LOWER
 * than their final, then the cascade's runtime measure-correct
 * loop iterates them up. That second-event "expand back" is
 * exactly what users see.
 *
 * The fix is to make the precomputation produce FULLY-PROMOTED
 * states: any single-step promotion of any non-active bullet must
 * make the total exceed `avail`. If a promotion would still fit,
 * the precomputation is under-filling → measure-correct will
 * snap it later → user sees the bounce.
 *
 * If `isFullyPromoted` fails for any test case, the precomputation
 * is wrong — the visible bug WILL occur for that case.
 */
import { describe, expect, test } from 'vitest';
import {
  computeCascadeAtActiveIdx,
  computeAllCascadeStates,
  createLazyCascadeStates,
  heightAtPerBullet,
  type PerBulletLabs,
} from './cascadePrecompute';
import { maxMode, type Mode } from './bulletLayout';
import type { Bullet } from './bulletParse';

function makeBullets(childCounts: number[]): Bullet[] {
  return childCounts.map((n, i) => ({
    title: `B${i + 1}`,
    children: Array.from({ length: n }, (_, j) => ({ name: `c${j + 1}`, desc: 'd' })),
  }));
}

/**
 * Symmetric labs: every bullet has the same M0/M1/M_max heights,
 * regardless of child count. Useful baseline; real labs vary.
 */
function symmetricLabs(
  bullets: Bullet[],
  values: { m0: number; m1: number; full: number },
): PerBulletLabs {
  return {
    m0: bullets.map(() => values.m0),
    m1: bullets.map(() => values.m1),
    full: bullets.map(() => values.full),
  };
}

/**
 * Compute total height of a modes array using the given labs.
 * Mirrors what AdaptiveBullets' totalAt does.
 */
function totalAt(bullets: Bullet[], modes: Mode[], labs: PerBulletLabs): number {
  let s = 0;
  for (let i = 0; i < modes.length; i++) {
    s += heightAtPerBullet(bullets[i]!, modes[i] ?? 0, i, labs);
  }
  return s;
}

/**
 * THE BUG CATCHER. A state is "fully promoted" if no single-step
 * promotion of any non-active, not-yet-maxed bullet would still
 * fit within avail. (When total already > avail — the degenerate
 * case where active alone overflows — every promotion would fail
 * to fit, so the invariant is vacuously satisfied.)
 *
 * If a state ISN'T fully promoted, the cascade's measure-correct
 * loop at runtime will catch the unused space and promote — and
 * the user sees the post-animation snap.
 */
function isFullyPromoted(
  bullets: Bullet[],
  modes: Mode[],
  activeIdx: number | null,
  avail: number,
  labs: PerBulletLabs,
): boolean {
  const total = totalAt(bullets, modes, labs);
  for (let i = 0; i < bullets.length; i++) {
    if (i === activeIdx) continue;
    const b = bullets[i]!;
    const cur = modes[i] ?? 0;
    if (cur >= maxMode(b)) continue;
    const next = heightAtPerBullet(b, cur + 1, i, labs);
    const here = heightAtPerBullet(b, cur, i, labs);
    const delta = next - here;
    // If promoting this bullet would still fit, the precompute
    // left room on the table → measure-correct would promote at
    // runtime → user sees the snap.
    if (total + delta <= avail) {
      return false;
    }
  }
  return true;
}

describe('computeCascadeAtActiveIdx — fully-promoted invariant', () => {
  test('symmetric bullets, generous avail → fully-promoted', () => {
    const bullets = makeBullets([3, 3, 3, 3]);
    const labs = symmetricLabs(bullets, { m0: 20, m1: 40, full: 80 });
    // avail = 300: should let active at full (80) + 3 others at M_max
    // height (80) each = 320 → not all max. Some at lower.
    const avail = 300;
    const modes = computeCascadeAtActiveIdx(bullets, 0, avail, labs);
    expect(modes[0]).toBe(maxMode(bullets[0]!));
    expect(isFullyPromoted(bullets, modes, 0, avail, labs)).toBe(true);
  });

  test('asymmetric bullets, scrolling A→B → fully-promoted at B', () => {
    // Bullet 0 has 5 children (tallest); B1 has 2; B2,B3 have 3.
    // When user scrolls from active=0 (b0 tall at Mmax) to active=1
    // (b1 short at Mmax), there's MORE room for non-active bullets.
    // The precompute must use that room — leaving any unused space
    // is the bug that produces the snap.
    const bullets = makeBullets([5, 2, 3, 3]);
    const labs: PerBulletLabs = {
      m0: [22, 22, 22, 22],
      m1: [42, 42, 42, 42],
      full: [22 + 5 * 20, 22 + 2 * 20, 22 + 3 * 20, 22 + 3 * 20],
    };
    const avail = 250;
    const modesB = computeCascadeAtActiveIdx(bullets, 1, avail, labs);
    expect(modesB[1]).toBe(maxMode(bullets[1]!));
    expect(isFullyPromoted(bullets, modesB, 1, avail, labs)).toBe(true);
  });

  test('tight fit forces non-uniform allocation, still fully-promoted', () => {
    // Designed so target=1 uniform JUST fits, target=2 uniform doesn't.
    // Some bullets get promoted to M2 individually but not all.
    const bullets = makeBullets([4, 4, 4, 4]);
    const labs: PerBulletLabs = {
      m0: [20, 20, 20, 20],
      m1: [40, 40, 40, 40],
      full: [100, 100, 100, 100],
    };
    // hAt(b, 2) = 40 + (4-1)*20/4 + (40-20) = 60. Mmax=5 = full=100.
    // Active at maxMode=100. Avail 220.
    //   target=1: [100, 40, 40, 40] = 220 → fits exactly.
    //   target=2: [100, 60, 60, 60] = 280 → no.
    //   Greedy at target=2: from [100,40,40,40]=220. promote? delta 60-40=20. 220+20=240. No.
    //   Result: [100, 1, 1, 1].
    const avail = 220;
    const modes = computeCascadeAtActiveIdx(bullets, 0, avail, labs);
    expect(modes[0]).toBe(maxMode(bullets[0]!));
    expect(isFullyPromoted(bullets, modes, 0, avail, labs)).toBe(true);
  });

  test('USER BUG: under-fill scenario produces fully-promoted state', () => {
    // This is the scenario closest to what the user described.
    // A heavily asymmetric body where the previous greedy could
    // leave space on the table without the iterative-promote phase.
    //
    // Setup: bullet 0 is huge (5 children), bullets 1-3 are smaller.
    // User scrolls from active=0 to active=1.
    //
    // Before the fix: greedy at target=1 promotes some bullets to
    // M1 but not all (delta sum exhausts avail for some bullets).
    // Remaining bullets stay at M0. The cascade's measure-correct
    // at runtime then promotes those remaining bullets — that's
    // the visible bounce.
    //
    // After the fix: iterative-promote phase fills all remaining
    // room, leaving no work for measure-correct.
    const bullets = makeBullets([5, 2, 3, 3]);
    const labs: PerBulletLabs = {
      m0: [25, 22, 24, 24],
      m1: [50, 44, 48, 48],
      full: [25 + 5 * 22, 22 + 2 * 22, 24 + 3 * 22, 24 + 3 * 22], // 135, 66, 90, 90
    };
    const avail = 260;
    const modesAfterScroll = computeCascadeAtActiveIdx(bullets, 1, avail, labs);
    expect(modesAfterScroll[1]).toBe(maxMode(bullets[1]!));
    // The headline assertion: NO single-step promotion of any
    // remaining-collapsable bullet would still fit. If this
    // fails, the user WILL see the snap for this scenario.
    expect(isFullyPromoted(bullets, modesAfterScroll, 1, avail, labs)).toBe(true);
  });

  test('null active (no L1 forced) produces fully-promoted state', () => {
    const bullets = makeBullets([3, 3, 3]);
    const labs = symmetricLabs(bullets, { m0: 22, m1: 44, full: 88 });
    const avail = 200;
    const modes = computeCascadeAtActiveIdx(bullets, null, avail, labs);
    expect(isFullyPromoted(bullets, modes, null, avail, labs)).toBe(true);
  });

  test('tiny avail (only titles fit) — fully-promoted at M0', () => {
    const bullets = makeBullets([3, 3, 3]);
    const labs = symmetricLabs(bullets, { m0: 22, m1: 44, full: 88 });
    // Active at full (88) + 2 others can't even afford M0=22 each?
    // 88 + 22*2 = 132. avail=130 → too tight even for M0 for some.
    const avail = 130;
    const modes = computeCascadeAtActiveIdx(bullets, 0, avail, labs);
    expect(modes[0]).toBe(maxMode(bullets[0]!));
    // The fully-promoted check still applies: even at tight fits,
    // no further promotion should be possible.
    expect(isFullyPromoted(bullets, modes, 0, avail, labs)).toBe(true);
  });

  test('top-down promotion: no lower bullet gets promoted above higher bullet', () => {
    // The divine cascade promotes bullets top-to-bottom. The user
    // sees a lower bullet at M1 while top stays at M0 → BUG.
    // This test catches that pattern: for any two non-active
    // bullets i < j, modes[i] must be ≥ modes[j] (unless i is
    // active or j is active, then they can differ).
    //
    // Note: if all bullets have IDENTICAL deltas, top-down is
    // naturally satisfied. The bug shows up with ASYMMETRIC
    // bullets where the greedy phase (now removed) would have
    // picked smaller-delta bullets first.
    const bullets = makeBullets([5, 3, 3, 3, 3]);
    // b0 is heavier (5 children) so its M0→M1 delta is largest
    // (longer title due to more wrapping in real data; here we
    // simulate by giving b0 a larger inline-add).
    const labs: PerBulletLabs = {
      m0: [30, 22, 22, 22, 22], // b0 has taller title
      m1: [70, 44, 44, 44, 44], // b0 has bigger inline-add (delta=40 vs 22)
      full: [30 + 5 * 22, 22 + 3 * 22, 22 + 3 * 22, 22 + 3 * 22, 22 + 3 * 22],
    };
    const avail = 200;
    const modes = computeCascadeAtActiveIdx(bullets, null, avail, labs);
    // STRICT TOP-DOWN: for every pair of non-active bullets where
    // i < j, modes[i] must be >= modes[j]. No lower bullet at
    // higher mode than a top bullet.
    for (let i = 0; i < bullets.length - 1; i++) {
      for (let j = i + 1; j < bullets.length; j++) {
        expect(modes[i]!).toBeGreaterThanOrEqual(modes[j]!);
      }
    }
  });

  test('top-down with active bullet skipped from the ordering', () => {
    // When activeIdx is set, the top-down rule applies to the
    // NON-ACTIVE bullets only. Active stays at Mmax regardless
    // of position.
    const bullets = makeBullets([3, 3, 5, 3, 3]); // b2 is heavy
    const labs: PerBulletLabs = {
      m0: [22, 22, 30, 22, 22],
      m1: [44, 44, 70, 44, 44],
      full: [22 + 3 * 22, 22 + 3 * 22, 30 + 5 * 22, 22 + 3 * 22, 22 + 3 * 22],
    };
    const avail = 240;
    const modes = computeCascadeAtActiveIdx(bullets, 2, avail, labs);
    expect(modes[2]).toBe(maxMode(bullets[2]!));
    // Top-down among non-active (indices 0, 1, 3, 4): modes[0] ≥ modes[1] ≥ modes[3] ≥ modes[4]
    const nonActiveIdxs = [0, 1, 3, 4];
    for (let a = 0; a < nonActiveIdxs.length - 1; a++) {
      for (let b = a + 1; b < nonActiveIdxs.length; b++) {
        const iA = nonActiveIdxs[a]!;
        const iB = nonActiveIdxs[b]!;
        expect(modes[iA]!).toBeGreaterThanOrEqual(modes[iB]!);
      }
    }
  });

  test('overflow at minimum: best-effort still fully-promoted up to maxMode', () => {
    // avail too small even for [Mmax(active) + others at M0]. Output
    // may exceed avail in this degenerate case — but fully-promoted
    // (in the "any promotion would still overflow" sense) should
    // hold. Active stays at Mmax (it's locked by the cascade contract).
    const bullets = makeBullets([3, 3, 3]);
    const labs = symmetricLabs(bullets, { m0: 22, m1: 44, full: 88 });
    const avail = 50; // way too small
    const modes = computeCascadeAtActiveIdx(bullets, 0, avail, labs);
    expect(modes[0]).toBe(maxMode(bullets[0]!));
    // Non-active bullets stay at 0 (can't promote, even M0→M1 of
    // 22 px on top of active 88 already overflows). isFullyPromoted
    // should be vacuously true since the state already overflows
    // — but we check that the cascade didn't try to promote into
    // an even-worse overflow.
    for (let i = 1; i < bullets.length; i++) {
      expect(modes[i]).toBe(0);
    }
  });
});

describe('createLazyCascadeStates — same values as the eager Map, computed on demand', () => {
  const CASES: Array<{ counts: number[]; avail: number; labs: { m0: number; m1: number; full: number } }> = [
    { counts: [3, 5, 2, 4], avail: 300, labs: { m0: 28, m1: 50, full: 140 } },
    { counts: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10], avail: 500, labs: { m0: 28, m1: 50, full: 260 } },
    { counts: [1, 0, 7], avail: 90, labs: { m0: 28, m1: 44, full: 180 } },
  ];

  test('get(idx) equals computeAllCascadeStates for every possible activeIdx', () => {
    for (const c of CASES) {
      const bullets = makeBullets(c.counts);
      const labs = symmetricLabs(bullets, c.labs);
      const eager = computeAllCascadeStates(bullets, c.avail, labs);
      const lazy = createLazyCascadeStates(bullets, c.avail, labs);
      const idxs: Array<number | null> = [null, ...bullets.map((_, i) => i)];
      for (const idx of idxs) {
        expect(lazy.get(idx), `activeIdx=${idx} counts=${c.counts.join(',')}`)
          .toEqual(eager.get(idx));
      }
    }
  });

  test('out-of-range indices return undefined (Map.get parity)', () => {
    const bullets = makeBullets([2, 3]);
    const labs = symmetricLabs(bullets, { m0: 28, m1: 50, full: 120 });
    const lazy = createLazyCascadeStates(bullets, 200, labs);
    expect(lazy.get(2)).toBeUndefined();
    expect(lazy.get(-1)).toBeUndefined();
  });

  test('repeated get returns the cached array (no recompute, stable identity)', () => {
    const bullets = makeBullets([3, 4, 2]);
    const labs = symmetricLabs(bullets, { m0: 28, m1: 50, full: 140 });
    const lazy = createLazyCascadeStates(bullets, 300, labs);
    expect(lazy.get(1)).toBe(lazy.get(1));
    expect(lazy.get(null)).toBe(lazy.get(null));
  });
});
