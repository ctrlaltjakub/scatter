import { describe, expect, test } from 'vitest';
import { CHAT_RAY_GLSL, CHAT_RAY_MAX_ROW, chatRayGlyph, chatRayRow, isChatRayCell, shouldUseChatRay } from './chatRays';

describe('chat ray ring', () => {
  test.each([0.08, 0.5, 1, 2.5])('stays one row thick and outside the card at zoom %s', (zoom) => {
    const cell = 12;
    const rect = { x: 21.3, y: 42.7, w: 520 * zoom, h: 710 * zoom };
    const left = Math.ceil(rect.x / cell - 0.5) - 1;
    const right = Math.floor((rect.x + rect.w) / cell - 0.5) + 1;
    const top = Math.ceil(rect.y / cell - 0.5) - 1;
    const bottom = Math.floor((rect.y + rect.h) / cell - 0.5) + 1;
    let count = 0;
    for (let row = top - 2; row <= bottom + 2; row++) {
      for (let col = left - 2; col <= right + 2; col++) {
        const ray = isChatRayCell(col, row, rect, cell);
        if (ray) {
          count++;
          expect(col <= left || col >= right || row <= top || row >= bottom).toBe(true);
        }
        if (col < left || col > right || row < top || row > bottom) expect(ray).toBe(false);
      }
    }
    expect(count).toBe(2 * (right - left + bottom - top));
  });

  test('works when the node is partially offscreen', () => {
    const rect = { x: -20, y: -30, w: 100, h: 100 };
    expect(isChatRayCell(8, 0, rect, 10)).toBe(true);
    expect(isChatRayCell(0, 7, rect, 10)).toBe(true);
    expect(isChatRayCell(0, 0, rect, 10)).toBe(false);
  });

  test('uses the closest row even when the card partially overlaps a cell', () => {
    const rect = { x: 27, y: 27, w: 46, h: 46 };
    expect(isChatRayCell(2, 4, rect, 10)).toBe(true);
    expect(isChatRayCell(4, 2, rect, 10)).toBe(true);
    expect(isChatRayCell(7, 4, rect, 10)).toBe(true);
    expect(isChatRayCell(4, 7, rect, 10)).toBe(true);
    expect(isChatRayCell(1, 4, rect, 10)).toBe(false);
    expect(isChatRayCell(4, 8, rect, 10)).toBe(false);
  });

  test('uses outward rays rather than a tangential frame on all sides and corners', () => {
    const rect = { x: 100, y: 200, w: 400, h: 600 };
    expect(chatRayGlyph(300, 180, rect)).toBe('|');
    expect(chatRayGlyph(300, 820, rect)).toBe('|');
    expect(chatRayGlyph(80, 500, rect)).toBe('_');
    expect(chatRayGlyph(520, 500, rect)).toBe('_');
    expect(chatRayGlyph(80, 180, rect)).toBe('\\');
    expect(chatRayGlyph(520, 820, rect)).toBe('\\');
    expect(chatRayGlyph(520, 180, rect)).toBe('/');
    expect(chatRayGlyph(80, 820, rect)).toBe('/');
  });
});

describe('gradually thinning chat rays', () => {
  test('numbers the rows outward from each side and corner', () => {
    const rect = { x: 27, y: 27, w: 46, h: 46 };
    expect(chatRayRow(4, 4, rect, 10)).toBe(0);
    for (let n = 1; n <= 8; n++) {
      for (const [col, row] of [[3 - n, 4], [6 + n, 4], [4, 3 - n], [4, 6 + n], [3 - n, 3 - n], [6 + n, 6 + n]]) {
        expect(chatRayRow(col!, row!, rect, 10)).toBe(n);
      }
    }
  });

  test.each([[1, 0.5], [2, 0.33], [3, 0.1]])('row %s has approximately %s randomized ray coverage', (n, coverage) => {
    let count = 0;
    const samples = 40_000;
    for (let i = 0; i < samples; i++) {
      if (shouldUseChatRay(i % 200, Math.floor(i / 200), 43210, n)) count++;
    }
    expect(count / samples).toBeCloseTo(coverage, 2);
  });

  test.each([4, 5, 8, 12, 24])('leaves row %s entirely as normal aura glyphs', (n) => {
    for (let i = 0; i < 1000; i++) {
      expect(shouldUseChatRay(i % 100, Math.floor(i / 100), 43210, n)).toBe(false);
    }
  });

  test('is deterministic, varies between nodes, and is not an alternating pattern', () => {
    const sample = (seed: number) => Array.from({ length: 200 }, (_, col) => shouldUseChatRay(col, 10, seed, 2));
    const first = sample(43210);
    expect(sample(43210)).toEqual(first);
    expect(sample(12345)).not.toEqual(first);
    expect(first.some((on, i) => i > 0 && on && first[i - 1])).toBe(true);
    expect(first.some((on, i) => i > 0 && !on && !first[i - 1])).toBe(true);
    expect(shouldUseChatRay(10, 10, 43210, 0)).toBe(false);
  });

  test('GPU sampling uses the same seed mixing and row percentages', () => {
    expect(CHAT_RAY_MAX_ROW).toBe(3);
    expect(CHAT_RAY_GLSL).toContain(`if (rayRow < 1 || rayRow > ${CHAT_RAY_MAX_ROW}) return false;`);
    expect(CHAT_RAY_GLSL).toContain(`^ ${0xa24baed5}u`);
    expect(CHAT_RAY_GLSL).toContain('uint[3](50u, 33u, 10u)');
    expect(CHAT_RAY_GLSL).toContain('return h % 100u < CHAT_RAY_PERCENTAGES[rayRow - 1];');
  });
});
