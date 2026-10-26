import { describe, expect, test } from 'vitest';
import { RAMP, densityToStage, pickGlyph } from './ramp';

/**
 * The density ramp maps an aura-density value in [0, 1] to a glyph from
 * the 9-stage restricted alphabet (s/S/c/C/t/T/r/R + punctuation).
 * Multi-glyph stages pick by a stable per-cell seed so adjacent cells
 * at the same density show varied letters without shimmering between
 * frames.
 */

describe('RAMP', () => {
  test('has 9 stages', () => {
    expect(RAMP).toHaveLength(9);
  });

  test('every stage is a non-empty array of single-character strings', () => {
    for (const stage of RAMP) {
      expect(stage.length).toBeGreaterThanOrEqual(1);
      for (const g of stage) {
        expect(typeof g).toBe('string');
        expect(g).toHaveLength(1);
      }
    }
  });

  test('stage 0 is the baseline dot', () => {
    expect(RAMP[0]).toEqual(['.']);
  });

  test('stage 8 (densest) is "#"', () => {
    expect(RAMP[8]).toEqual(['#']);
  });

  test('every letter in the ramp comes from {s,S,c,C,t,T,r,R}', () => {
    const allowed = new Set('sScCtTrR'.split(''));
    for (const stage of RAMP) {
      for (const g of stage) {
        if (/[a-z]/i.test(g)) {
          expect(allowed.has(g)).toBe(true);
        }
      }
    }
  });
});

describe('densityToStage', () => {
  test('density 0 → stage 0', () => {
    expect(densityToStage(0)).toBe(0);
  });

  test('negative density clamps to stage 0', () => {
    expect(densityToStage(-0.5)).toBe(0);
  });

  test('density 1 → stage 8 (last)', () => {
    expect(densityToStage(1)).toBe(8);
  });

  test('density > 1 clamps to last stage', () => {
    expect(densityToStage(2.7)).toBe(8);
  });

  test('density 0.5 maps to a middle stage', () => {
    const s = densityToStage(0.5);
    expect(s).toBeGreaterThanOrEqual(4);
    expect(s).toBeLessThanOrEqual(5);
  });

  test('strictly monotonic across the [0,1] range', () => {
    let prev = densityToStage(0);
    for (let i = 1; i <= 100; i++) {
      const s = densityToStage(i / 100);
      expect(s).toBeGreaterThanOrEqual(prev);
      prev = s;
    }
  });
});

describe('pickGlyph', () => {
  test('single-glyph stage returns its glyph regardless of seed', () => {
    expect(pickGlyph(0, 0)).toBe('.');
    expect(pickGlyph(0, 0.4)).toBe('.');
    expect(pickGlyph(0, 0.99)).toBe('.');
  });

  test('multi-glyph stage: seed 0 returns first member', () => {
    // stage 1 is [',', '`']
    const stage1 = RAMP[1]!;
    expect(pickGlyph(1, 0)).toBe(stage1[0]);
  });

  test('multi-glyph stage: seed 0.999 returns last member', () => {
    const stage1 = RAMP[1]!;
    expect(pickGlyph(1, 0.999)).toBe(stage1[stage1.length - 1]);
  });

  test('same (stage, seed) → same glyph (deterministic)', () => {
    expect(pickGlyph(5, 0.42)).toBe(pickGlyph(5, 0.42));
  });

  test('all returned glyphs are length-1 strings for every stage', () => {
    for (let s = 0; s < RAMP.length; s++) {
      for (const seed of [0, 0.25, 0.5, 0.75, 0.999]) {
        const g = pickGlyph(s, seed);
        expect(g).toHaveLength(1);
      }
    }
  });
});
