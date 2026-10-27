import { describe, expect, it } from 'vitest';
import { findNodePlacement, placementOverlaps, type PlacementRect } from './nodePlacement';

const parent: PlacementRect = { id: 'parent', x: 0, y: 0, width: 624, height: 390 };
const options = { gap: 50, restGap: 62.5 };
const child = { width: 624, height: 780 };
const place = (obstacles: PlacementRect[], size = child) => ({ ...findNodePlacement(parent, obstacles, size, options), ...size });

describe('measured rectangle placement', () => {
  it('matches the physics rest gap, not a top-left circle radius', () => {
    expect(place([parent])).toEqual({ x: 686.5, y: -195, ...child });
    const wide = { ...parent, width: 1500 };
    expect(findNodePlacement(wide, [wide], child, options)).toEqual({ x: 1562.5, y: -195 });
  });

  it('uses directly left before a right-hand diagonal when the right slot is blocked', () => {
    const obstacles = [parent, { id: 'obstacle', x: 720, y: 500, width: 624, height: 390 }];
    const result = place(obstacles);
    for (const obstacle of obstacles) expect(placementOverlaps(result, obstacle, options.gap)).toBe(false);
    expect(result).toEqual({ x: -686.5, y: -195, ...child });
  });

  it('prefers directly right even when another direction would be closer', () => {
    const size = { width: 1200, height: 100 };
    expect(place([parent], size)).toEqual({ x: 686.5, y: 145, ...size });
  });

  it.each([false, true])('uses nearby space above or below without quadrant bias (mirror: %s)', mirror => {
    const obstacles = [parent,
      { id: 'right', x: 686.5, y: -195, width: 1400, height: 780 },
      { id: 'left', x: -1462.5, y: -195, width: 1400, height: 780 },
      { id: 'below', x: 0, y: 452.5, width: 624, height: 780 },
    ].map(r => mirror ? { ...r, y: parent.height - r.y - r.height } : r);
    const result = place(obstacles);
    expect(result).toEqual({ x: 0, y: mirror ? 452.5 : -842.5, ...child });
    for (const obstacle of obstacles) expect(placementOverlaps(result, obstacle, options.gap)).toBe(false);
  });

  it('uses an exact available gap that angular sampling could miss', () => {
    const size = { width: 624, height: 400 };
    const obstacles = [parent,
      { id: 'above', x: -2000, y: -1000, width: 4000, height: 1000 },
      { id: 'below', x: -2000, y: 500, width: 4000, height: 1000 },
      { id: 'left', x: -2000, y: 0, width: 2000, height: 500 },
    ];
    expect(place(obstacles, size)).toEqual({ x: 686.5, y: 50, ...size });
  });

  it('honours custom collision padding when it exceeds the spring distance', () => {
    const result = findNodePlacement(parent, [parent], child, { gap: 300, restGap: 20 });
    expect(result.x).toBe(924);
    expect(placementOverlaps({ ...result, ...child }, parent, 300)).toBe(false);
  });

  it('uses the same direct-slot preference for image-region questions', () => {
    const result = findNodePlacement(parent, [parent], child, {
      ...options, regions: [{ x: 0, y: .45, width: .1, height: .1 }],
    });
    expect(result).toEqual({ x: 686.5, y: -195 });
    expect(placementOverlaps({ ...result, ...child }, parent, options.gap)).toBe(false);
  });

  it('always checks its fallback, even beyond the old search radius', () => {
    const obstacles = [parent, { id: 'giant', x: -5000, y: -5000, width: 10000, height: 10000 }];
    const result = place(obstacles);
    for (const obstacle of obstacles) expect(placementOverlaps(result, obstacle, options.gap)).toBe(false);
  });

  it('treats an earlier pending child as an obstacle for a rapid second child', () => {
    const first = { id: 'first', ...place([parent]) };
    const second = place([parent, first]);
    expect(placementOverlaps(second, first, options.gap)).toBe(false);
    expect(place([first, parent])).toEqual(second);
  });

  it('bounds the search in a large project without sacrificing a valid fallback', () => {
    const obstacles = Array.from({ length: 2000 }, (_, i) => ({ id: `n${i}`, x: i % 50 * 750 - 15000,
      y: Math.floor(i / 50) * 900 - 15000, width: 624, height: 780 }));
    const result = place([parent, ...obstacles]);
    expect(Number.isFinite(result.x + result.y)).toBe(true);
    for (const obstacle of obstacles) expect(placementOverlaps(result, obstacle, options.gap)).toBe(false);
  });
});
