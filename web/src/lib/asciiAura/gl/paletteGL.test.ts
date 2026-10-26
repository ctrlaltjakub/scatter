/**
 * R5.4 — tests for the GL baseline-palette packing.
 *
 * The 2D path formats `rgba(r, g, b, alphaBase)` strings; the GL
 * path needs the same palette as a flat vec4 array (rgba, 0-1
 * floats) for a fragment-shader uniform. Entry order must match the
 * 2D path exactly (sorted accents, then the neutral entry when any
 * ungrouped node exists) because both index it with the same
 * per-cell hash.
 */
import { describe, test, expect } from 'vitest';
import { buildBaselinePaletteVec4, MAX_PALETTE } from './paletteGL';
import type { ResolvedTintNumeric } from './recordPacking';

const TINTS: Record<string, ResolvedTintNumeric> = {
  mauve: { r: 136 / 255, g: 57 / 255, b: 239 / 255, alphaBase: 0.2, alphaFocus: 0.55 },
  green: { r: 64 / 255, g: 160 / 255, b: 43 / 255, alphaBase: 0.2, alphaFocus: 0.55 },
};
const NEUTRAL = { r: 0, g: 0, b: 0, a: 0.06 };
const resolve = (accent: string | null): ResolvedTintNumeric =>
  TINTS[accent ?? ''] ?? { r: 0, g: 0, b: 0, alphaBase: 0.06, alphaFocus: 0.16 };

describe('buildBaselinePaletteVec4', () => {
  test('one vec4 per accent at alphaBase, in given (sorted) order', () => {
    const { data, count } = buildBaselinePaletteVec4(['green', 'mauve'], false, resolve, NEUTRAL);
    expect(count).toBe(2);
    expect(Array.from(data.slice(0, 4)).map((x) => +x.toFixed(6)))
      .toEqual([+(64 / 255).toFixed(6), +(160 / 255).toFixed(6), +(43 / 255).toFixed(6), 0.2]);
    expect(data[4]).toBeCloseTo(136 / 255, 6);
  });

  test('appends the neutral entry when ungrouped nodes exist (2D parity)', () => {
    const { data, count } = buildBaselinePaletteVec4(['mauve'], true, resolve, NEUTRAL);
    expect(count).toBe(2);
    expect(data[4]).toBe(0);
    expect(data[5]).toBe(0);
    expect(data[6]).toBe(0);
    expect(data[7]).toBeCloseTo(NEUTRAL.a, 6); // float32 storage
  });

  test('empty membership → just the neutral when ungrouped, else count 0', () => {
    expect(buildBaselinePaletteVec4([], true, resolve, NEUTRAL).count).toBe(1);
    expect(buildBaselinePaletteVec4([], false, resolve, NEUTRAL).count).toBe(0);
  });

  test('data array is sized for the uniform (MAX_PALETTE vec4s)', () => {
    const { data } = buildBaselinePaletteVec4(['mauve'], false, resolve, NEUTRAL);
    expect(data.length).toBe(MAX_PALETTE * 4);
  });
});
