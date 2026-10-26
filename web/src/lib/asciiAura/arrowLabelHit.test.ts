import { describe, expect, it } from 'vitest';
import { STATUS_DELETE_MS_PER_CHAR } from './statusText';
import { hitTestArrowLabels } from './arrowLabelHit';

function entry(over: Record<string, unknown> = {}) {
  return {
    text: 'AB',
    targetNodeId: 'child',
    hitRect: { x: 10, y: 20, w: 50, h: 18 },
    startedAt: 1000,
    clearedAt: null,
    cells: [{}, {}],
    accents: [null, null],
    ...over,
  };
}

describe('hitTestArrowLabels', () => {
  it('hits the whole label rectangle, including gaps between glyphs', () => {
    const entries = { a: entry() };
    expect(hitTestArrowLabels(entries, 35, 29, 1100)).toBe('child');
    expect(hitTestArrowLabels(entries, 9.99, 29, 1100)).toBeNull();
    expect(hitTestArrowLabels(entries, 60, 29, 1100)).toBeNull();
  });

  it('only hits while at least one animated glyph is visible', () => {
    const typing = { a: entry() };
    expect(hitTestArrowLabels(typing, 35, 29, 999)).toBeNull();
    expect(hitTestArrowLabels(typing, 35, 29, 1000)).toBe('child');

    const deleting = { a: entry({ clearedAt: 2000 }) };
    expect(hitTestArrowLabels(deleting, 35, 29, 2000)).toBe('child');
    expect(hitTestArrowLabels(deleting, 35, 29, 2000 + STATUS_DELETE_MS_PER_CHAR)).toBeNull();
  });

  it('prefers an active label over a disappearing label in an overlapping box', () => {
    const entries = {
      old: entry({ targetNodeId: 'old', clearedAt: 2000 }),
      live: entry({ targetNodeId: 'live', startedAt: 1500 }),
    };
    expect(hitTestArrowLabels(entries, 35, 29, 2000)).toBe('live');
  });
});
