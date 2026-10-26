import { describe, expect, test } from 'vitest';
import { computeModes, computeMinHeight, computeInitHeight, type Heights } from './bulletLayout';
import type { Bullet } from './bulletParse';

const h: Heights = { title: 28, inline: 22, described: 22 };

function makeBullets(childCounts: number[]): Bullet[] {
  return childCounts.map((n, i) => ({
    title: `B${i + 1}`,
    children: Array.from({ length: n }, (_, j) => ({ name: `c${j + 1}`, desc: 'd' })),
  }));
}

describe('computeModes', () => {
  test('uniform target when everyone fits', () => {
    const bullets = makeBullets([4, 4, 3, 3, 3]);
    // All M2 = 72*5 = 360; available 376 ≥ 360 ⇒ everyone at M2.
    const modes = computeModes(bullets, null, 376, h);
    expect(modes).toEqual([2, 2, 2, 2, 2]);
  });

  test('cascade Y when target cannot fit all', () => {
    const bullets = makeBullets([4, 4, 3, 3, 3]);
    // available 358: M2 all = 360 > 358; expect top-priority cascade.
    // From M1 baseline 250, upgrade top-down by 22 each until budget runs out.
    // 250 → 272 → 294 → 316 → 338 → 360 (last not affordable).
    const modes = computeModes(bullets, null, 358, h);
    expect(modes).toEqual([2, 2, 2, 2, 1]);
  });

  test('active bullet locked at max; others demote uniformly', () => {
    const bullets = makeBullets([4, 4, 3, 3, 3]);
    // Active bullet 0: max=5, height=28+4*22=116.
    // Available 316 = 116 (active) + 200 (4 others at M1=50). No room
    // for any upgrade, so all non-active stay at M1.
    const modes = computeModes(bullets, 0, 316, h);
    expect(modes[0]).toBe(5);
    expect(modes.slice(1)).toEqual([1, 1, 1, 1]);
  });

  test('active bullet with spare room cascades top-first to non-active', () => {
    const bullets = makeBullets([4, 4, 3, 3, 3]);
    // Available 356 = active 116 + 240 slack. M1 all = 200. One bullet
    // can upgrade to M2 (delta 22), 240-200=40 ≥ 22; second can't (40-22=18 < 22).
    const modes = computeModes(bullets, 0, 356, h);
    expect(modes[0]).toBe(5);
    expect(modes.slice(1)).toEqual([2, 1, 1, 1]);
  });

  test('free-upgrade sweep promotes M_N → M_{N+1} when delta ≤ 0', () => {
    // For 3-child bullets, M_N=3 has height 28+44+22=94; M_{N+1}=4 has 28+66=94 (delta 0).
    // Target loop will stop at 3 if 4 doesn't fit; sweep then promotes.
    const bullets = makeBullets([3, 3, 3]);
    const available = 3 * 94; // exactly fits all at M3 = M_{N+1} after sweep.
    const modes = computeModes(bullets, null, available, h);
    expect(modes).toEqual([4, 4, 4]);
  });

  test('returns empty array for no bullets', () => {
    expect(computeModes([], null, 200, h)).toEqual([]);
  });
});

describe('computeMinHeight', () => {
  test('max(full_i) + sum of M0 for others + padding', () => {
    const bullets = makeBullets([4, 4, 3, 3, 3]);
    // max full = bullet 1 (4 children): 28 + 4*22 = 116.
    // others at M0: 4 * 28 = 112.
    // padding 24, free-text 0.
    expect(computeMinHeight(bullets, 0, h, 24)).toBe(116 + 112 + 24);
  });

  test('includes free text height', () => {
    const bullets = makeBullets([3]);
    // full B0 = 28 + 3*22 = 94. No others. padding 24, free text 40.
    expect(computeMinHeight(bullets, 40, h, 24)).toBe(94 + 0 + 24 + 40);
  });

  test('no bullets → just free text + padding', () => {
    expect(computeMinHeight([], 40, h, 24)).toBe(40 + 24);
  });
});

describe('computeInitHeight', () => {
  test('all-M1 size = sum of (title + inline) + free text + padding', () => {
    const bullets = makeBullets([4, 3, 3]);
    // Each M1 = 28 + 22 = 50. 3 bullets = 150. padding 24. free text 30.
    expect(computeInitHeight(bullets, 30, h, 24)).toBe(150 + 24 + 30);
  });

  test('zero-child bullet collapses all modes to title only', () => {
    const bullets = makeBullets([0]);
    // With N=0, M1 == M_{N+1} == title-only (no children to render inline).
    expect(computeInitHeight(bullets, 0, h, 0)).toBe(28);
  });
});
