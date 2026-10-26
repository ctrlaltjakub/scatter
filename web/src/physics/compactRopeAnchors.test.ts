import { describe, expect, it } from 'vitest';
import { compactRopeAnchors } from './compactRopeAnchors';

describe('compactRopeAnchors', () => {
  it('removes redundant points from a straight persisted rope', () => {
    const points = Array.from({ length: 97 }, (_, i) => ({ x: i * 25, y: 10 }));
    const compact = compactRopeAnchors(points, 25, 96)!;
    expect(compact.length).toBeLessThan(40);
    expect(compact[0]).toEqual(points[0]);
    expect(compact[compact.length - 1]).toEqual(points[points.length - 1]);
    expect(compact.every((point) => point.y === 10)).toBe(true);
  });

  it('preserves bends and never exceeds the configured cap', () => {
    const points = [
      { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 },
      { x: 200, y: 100 }, { x: 200, y: 200 }, { x: 500, y: 200 },
    ];
    const compact = compactRopeAnchors(points, 25, 8)!;
    expect(compact.length).toBeLessThanOrEqual(8);
    expect(compact.some((point) => point.x === 200 && point.y === 0)).toBe(true);
    expect(compact.some((point) => point.x === 200 && point.y === 200)).toBe(true);
  });
});
