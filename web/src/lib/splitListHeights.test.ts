import { describe, it, expect } from 'vitest';
import { splitListHeights } from './splitListHeights';

describe('splitListHeights — shares a fixed height between two stacked lists', () => {
  it('gives both their natural height when they both fit', () => {
    expect(splitListHeights(500, 50, 100)).toEqual({ a: 50, b: 100 });
  });

  it('lets a short first list keep its height and donates the rest to the long one', () => {
    expect(splitListHeights(400, 50, 600)).toEqual({ a: 50, b: 350 });
  });

  it('is symmetric — a short second list donates to the long first one', () => {
    expect(splitListHeights(400, 600, 50)).toEqual({ a: 350, b: 50 });
  });

  it('splits evenly when both lists overflow their half', () => {
    expect(splitListHeights(400, 600, 600)).toEqual({ a: 200, b: 200 });
  });

  it('treats a list exactly at half as "fits" and still splits the remainder fairly', () => {
    expect(splitListHeights(400, 200, 600)).toEqual({ a: 200, b: 200 });
  });

  it('never returns negative caps for a zero/negative budget', () => {
    expect(splitListHeights(0, 50, 50)).toEqual({ a: 0, b: 0 });
    expect(splitListHeights(-10, 50, 50)).toEqual({ a: 0, b: 0 });
  });
});
