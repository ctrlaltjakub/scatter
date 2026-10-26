import { describe, it, expect } from 'vitest';
import {
  routePath,
  polylineLength,
  sampleAlongPolyline,
  type RouteRect,
} from './routePath';

const W = 100;
const H = 100;
const SRC: RouteRect = { x: -W / 2, y: -H / 2, width: W, height: H };
const TGT: RouteRect = { x: 1000 - W / 2, y: -H / 2, width: W, height: H };

function rectAt(cx: number, cy: number): RouteRect {
  return { x: cx - W / 2, y: cy - H / 2, width: W, height: H };
}

describe('routePath — straight-line cases', () => {
  it('returns source-center to target-center when nothing blocks', () => {
    const path = routePath(SRC, TGT, [], 40);
    expect(path).toHaveLength(2);
    expect(path[0]).toEqual({ x: 0, y: 0 });
    expect(path[1]).toEqual({ x: 1000, y: 0 });
  });

  it('still returns straight when an obstacle is well above the line', () => {
    const path = routePath(SRC, TGT, [{ rect: rectAt(500, -400), id: 'high' }], 40);
    expect(path).toHaveLength(2); // direct line is clear
  });
});

describe('routePath — obstacle avoidance', () => {
  it('routes around a single blocking obstacle on the line', () => {
    const path = routePath(SRC, TGT, [{ rect: rectAt(500, 0), id: 'mid' }], 40);
    // Should detour. Path has at least 3 points (source, ≥1 corner, target).
    expect(path.length).toBeGreaterThanOrEqual(3);
    // No point should be inside the obstacle's strict interior.
    const ob = rectAt(500, 0);
    for (const p of path) {
      const inside =
        p.x > ob.x && p.x < ob.x + ob.width && p.y > ob.y && p.y < ob.y + ob.height;
      expect(inside).toBe(false);
    }
  });

  it('detour length is reasonable (less than straight-through-obstacle ×2)', () => {
    const path = routePath(SRC, TGT, [{ rect: rectAt(500, 0), id: 'mid' }], 40);
    const length = polylineLength(path);
    // Direct distance is 1000. Detour should be modest.
    expect(length).toBeGreaterThan(1000); // longer than direct
    expect(length).toBeLessThan(1500); // but not absurdly so
  });

  it('picks the shorter side when offered both routes', () => {
    // Obstacle slightly below the line: rope should go ABOVE (shorter detour).
    const path = routePath(SRC, TGT, [{ rect: rectAt(500, 30), id: 'lower' }], 40);
    // All bend points should be above the line (y < 0 is the shorter side
    // when the obstacle is below).
    const bends = path.slice(1, -1);
    expect(bends.length).toBeGreaterThan(0);
    for (const b of bends) {
      expect(b.y).toBeLessThan(0); // chose the upper detour
    }
  });

  it('threads between two close obstacles forming a vertical gap', () => {
    // Two obstacles around the line, leaving a narrow gap at y=0.
    const above = rectAt(500, -120); // bottom edge at -70
    const below = rectAt(500, 120);  // top edge at 70
    const margin = 30;
    const path = routePath(
      SRC,
      TGT,
      [{ rect: above, id: 'a' }, { rect: below, id: 'b' }],
      margin,
    );
    // Path should NOT go far above above-obstacle nor far below below-obstacle.
    // Threading the gap means bends are within ±150 of the line.
    for (const p of path) {
      expect(Math.abs(p.y)).toBeLessThan(200);
    }
    // And the path is finite-length — much shorter than going all the way around.
    expect(polylineLength(path)).toBeLessThan(1500);
  });

  it('still routes when obstacles are closer than 2 × margin (tight pack)', () => {
    // Three obstacles stacked tightly around the source-target line: A
    // blocks the direct path, B is right below A (gap 20), C is right
    // above A (gap 20). With margin = 40, the inflated rects all overlap
    // — a margin-strict visibility graph would have NO valid path
    // between them. The original-rect visibility we use must still find
    // a route (around either A+C or A+B), and the path must not pass
    // through any obstacle's strict interior.
    const src: RouteRect = { x: 150, y: -50, width: 100, height: 100 };
    const tgt: RouteRect = { x: -250, y: -50, width: 100, height: 100 };
    const A: RouteRect = { x: -50, y: -50, width: 100, height: 100 };
    const B: RouteRect = { x: -50, y: 70, width: 100, height: 100 };
    const C: RouteRect = { x: -50, y: -170, width: 100, height: 100 };
    const margin = 40;
    const path = routePath(
      src,
      tgt,
      [{ rect: A, id: 'A' }, { rect: B, id: 'B' }, { rect: C, id: 'C' }],
      margin,
    );
    // Multi-bend path (not the direct-line fallback).
    expect(path.length).toBeGreaterThanOrEqual(3);
    for (const ob of [A, B, C]) {
      for (const p of path) {
        const inside =
          p.x > ob.x && p.x < ob.x + ob.width &&
          p.y > ob.y && p.y < ob.y + ob.height;
        expect(inside).toBe(false);
      }
    }
    // Detour cost is bounded — the path hugs corners through a tight gap
    // rather than going all the way around the whole stack.
    const directDist = Math.hypot(
      tgt.x + tgt.width / 2 - (src.x + src.width / 2),
      tgt.y + tgt.height / 2 - (src.y + src.height / 2),
    );
    expect(polylineLength(path)).toBeLessThan(directDist * 1.5);
  });
});

describe('polylineLength + sampleAlongPolyline', () => {
  it('polylineLength sums segment hypotenuses', () => {
    const len = polylineLength([
      { x: 0, y: 0 },
      { x: 3, y: 4 }, // 5
      { x: 3, y: 14 }, // 10
    ]);
    expect(len).toBeCloseTo(15, 5);
  });

  it('sampleAlongPolyline returns endpoints exactly', () => {
    const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }];
    const samples = sampleAlongPolyline(pts, 6);
    expect(samples).toHaveLength(6);
    expect(samples[0]).toEqual({ x: 0, y: 0 });
    expect(samples[5]).toEqual({ x: 100, y: 100 });
  });

  it('sampleAlongPolyline distributes samples uniformly along arc length', () => {
    // Straight 100-px segment, ask for 5 samples (4 segments of 25 each).
    const samples = sampleAlongPolyline(
      [{ x: 0, y: 0 }, { x: 100, y: 0 }],
      5,
    );
    expect(samples).toHaveLength(5);
    expect(samples[0]!.x).toBeCloseTo(0, 5);
    expect(samples[1]!.x).toBeCloseTo(25, 5);
    expect(samples[2]!.x).toBeCloseTo(50, 5);
    expect(samples[3]!.x).toBeCloseTo(75, 5);
    expect(samples[4]!.x).toBeCloseTo(100, 5);
  });

  it('sampleAlongPolyline handles a degenerate polyline (zero length)', () => {
    const samples = sampleAlongPolyline([{ x: 5, y: 5 }, { x: 5, y: 5 }], 4);
    expect(samples).toHaveLength(4);
    for (const s of samples) {
      expect(s.x).toBe(5);
      expect(s.y).toBe(5);
    }
  });
});
