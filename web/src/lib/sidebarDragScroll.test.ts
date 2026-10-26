import { describe, expect, it } from 'vitest';
import { sidebarDragScrollStep } from './sidebarDragScroll';

const base = {
  viewportTop: 100,
  viewportBottom: 300,
  scrollTop: 50,
  maxScrollTop: 200,
};

describe('sidebarDragScrollStep', () => {
  it('does not scroll a list that had no overflow before dragging', () => {
    expect(sidebarDragScrollStep({
      ...base,
      pointerY: 299,
      scrollTop: 0,
      maxScrollTop: 0,
    })).toBe(0);
  });

  it('scrolls toward an edge but not in the middle', () => {
    expect(sidebarDragScrollStep({ ...base, pointerY: 110 })).toBeLessThan(0);
    expect(sidebarDragScrollStep({ ...base, pointerY: 290 })).toBeGreaterThan(0);
    expect(sidebarDragScrollStep({ ...base, pointerY: 200 })).toBe(0);
  });

  it('stops exactly at the original beginning and end', () => {
    expect(sidebarDragScrollStep({
      ...base,
      pointerY: 80,
      scrollTop: 0,
    })).toBe(0);
    expect(sidebarDragScrollStep({
      ...base,
      pointerY: 320,
      scrollTop: 200,
    })).toBe(0);
    expect(sidebarDragScrollStep({
      ...base,
      pointerY: 320,
      scrollTop: 197,
    })).toBe(3);
  });

  it('ignores overflow manufactured after dragging begins', () => {
    expect(sidebarDragScrollStep({
      ...base,
      pointerY: 320,
      scrollTop: 200,
      maxScrollTop: 200,
    })).toBe(0);
  });
});
