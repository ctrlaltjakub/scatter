import { describe, expect, test } from 'vitest';
import { generateWordmarkPattern } from './sidebarWordmark';

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('generateWordmarkPattern', () => {
  test('obeys the repeated-colour rules for every multi-colour pattern', () => {
    for (let paletteSize = 2; paletteSize <= 8; paletteSize += 1) {
      const palette = Array.from({ length: paletteSize }, (_, index) => `color-${index}`);
      for (let seed = 0; seed < 250; seed += 1) {
        const pattern = generateWordmarkPattern(palette, seeded(seed));
        expect(pattern).toHaveLength(7);
        expect(pattern.every(({ color }) => palette.includes(color))).toBe(true);

        const runs: Array<{ start: number; length: number }> = [];
        let start = 0;
        for (let index = 1; index <= pattern.length; index += 1) {
          if (index < pattern.length && pattern[index]!.color === pattern[start]!.color) continue;
          runs.push({ start, length: index - start });
          start = index;
        }

        expect(Math.max(...runs.map(({ length }) => length))).toBeLessThanOrEqual(2);
        const pairs = runs.filter(({ length }) => length === 2);
        expect(pairs).toHaveLength(Math.min(pairs.length, 2));
        for (let index = 1; index < pairs.length; index += 1) {
          const previous = pairs[index - 1]!;
          const current = pairs[index]!;
          expect(current.start - (previous.start + previous.length)).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  test('uses one hue with a slight independent brightness variation when only one colour exists', () => {
    const pattern = generateWordmarkPattern(['#123456', '#123456'], seeded(7));

    expect(pattern).toHaveLength(7);
    expect(pattern.every(({ color }) => color === '#123456')).toBe(true);
    expect(pattern.every(({ brightness }) => brightness >= 0.92 && brightness <= 1.08)).toBe(true);
    expect(new Set(pattern.map(({ brightness }) => brightness)).size).toBeGreaterThan(1);
  });

  test('falls back to the ordinary text colour when no palette is available', () => {
    expect(generateWordmarkPattern([], seeded(1))).toEqual(
      Array.from({ length: 7 }, () => ({ color: 'var(--text)', brightness: 1 })),
    );
  });
});
