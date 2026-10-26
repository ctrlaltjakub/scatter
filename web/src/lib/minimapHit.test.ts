import { describe, it, expect } from 'vitest';
import { hitTestRects } from './minimapHit';

const r = (id: string, x: number, y: number, w: number, h: number) => ({ id, x, y, w, h });

describe('hitTestRects', () => {
  it('returns the id of the rect under the point', () => {
    expect(hitTestRects([r('a', 0, 0, 10, 10), r('b', 20, 0, 10, 10)], 25, 5)).toBe('b');
  });

  it('returns null on a miss', () => {
    expect(hitTestRects([r('a', 0, 0, 10, 10)], 50, 50)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(hitTestRects([], 5, 5)).toBeNull();
  });

  it('picks the topmost (last-drawn) rect when rects overlap', () => {
    expect(hitTestRects([r('under', 0, 0, 10, 10), r('over', 5, 5, 10, 10)], 7, 7)).toBe('over');
  });

  it('is edge-inclusive on all four edges', () => {
    const list = [r('a', 10, 10, 10, 10)];
    expect(hitTestRects(list, 10, 15)).toBe('a'); // left
    expect(hitTestRects(list, 20, 15)).toBe('a'); // right
    expect(hitTestRects(list, 15, 10)).toBe('a'); // top
    expect(hitTestRects(list, 15, 20)).toBe('a'); // bottom
  });
});
