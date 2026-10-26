import { describe, it, expect } from 'vitest';
import {
  pointSegDistSq,
  demoteStages,
  ARROW_DEMOTE_RADIUS_PX,
  ARROW_DEMOTE_MAX_STAGES,
  paintArrowDimming,
} from './arrowDim';
import type { Arrow } from '@/store/types';

describe('arrow clearing follows visibility', () => {
  const reference: Arrow = { id: 'ab', kind: 'dotted', fromNodeId: 'a', toNodeId: 'b', gravitates: true };
  const anchors = { ab: [{ x: 5, y: 15 }, { x: 95, y: 15 }] };
  const paint = (selection: string[], arrow: Arrow = reference) => {
    const data = new Uint8Array(10 * 3 * 4);
    paintArrowDimming(data, anchors, { arrows: { ab: arrow }, selection }, { x: 0, y: 0, zoom: 1 }, 10, 10, 3);
    return data;
  };
  it('leaves every cell untouched while a reference is hidden', () => {
    expect(paint([]).some(Boolean)).toBe(false);
    expect(paint(['other']).some(Boolean)).toBe(false);
  });
  it('clears along a reference only when either endpoint is focused', () => {
    for (const endpoint of ['a', 'b']) {
      const data = paint([endpoint]);
      expect(data[(1 * 10 + 5) * 4 + 1]).toBe(ARROW_DEMOTE_MAX_STAGES);
      expect([...data].filter((_, index) => index % 4 !== 1).some(Boolean)).toBe(false);
    }
  });
  it('clears automatically after promotion, but ignores stale chains for deleted arrows', () => {
    expect(paint([], { ...reference, kind: 'auto' }).some(Boolean)).toBe(true);
    const data = new Uint8Array(10 * 3 * 4);
    paintArrowDimming(data, anchors, { arrows: {}, selection: ['a'] }, { x: 0, y: 0, zoom: 1 }, 10, 10, 3);
    expect(data.some(Boolean)).toBe(false);
  });
});

describe('pointSegDistSq', () => {
  it('is 0 for a point lying on the segment', () => {
    expect(pointSegDistSq(5, 0, 0, 0, 10, 0)).toBe(0);
  });
  it('is the perpendicular distance² for a point beside the segment interior', () => {
    expect(pointSegDistSq(5, 3, 0, 0, 10, 0)).toBe(9);
  });
  it('clamps to the nearest endpoint when the projection falls outside', () => {
    expect(pointSegDistSq(15, 0, 0, 0, 10, 0)).toBe(25);
    expect(pointSegDistSq(-3, 4, 0, 0, 10, 0)).toBe(25);
  });
  it('handles a degenerate (zero-length) segment as point distance', () => {
    expect(pointSegDistSq(3, 4, 1, 1, 1, 1)).toBe((3 - 1) ** 2 + (4 - 1) ** 2);
  });
});

describe('demoteStages', () => {
  it('is the max at the centerline and 0 at/after the radius', () => {
    expect(demoteStages(0)).toBe(ARROW_DEMOTE_MAX_STAGES);
    expect(demoteStages(ARROW_DEMOTE_RADIUS_PX)).toBe(0);
    expect(demoteStages(ARROW_DEMOTE_RADIUS_PX + 5)).toBe(0);
  });
  it('decreases monotonically with distance (closer = lighter)', () => {
    let prev = Infinity;
    for (let d = 0; d <= ARROW_DEMOTE_RADIUS_PX; d += 1) {
      const v = demoteStages(d);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
  it('returns whole stages within [0, MAX]', () => {
    for (let d = 0; d <= ARROW_DEMOTE_RADIUS_PX + 5; d += 0.5) {
      const v = demoteStages(d);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(ARROW_DEMOTE_MAX_STAGES);
    }
  });
});
