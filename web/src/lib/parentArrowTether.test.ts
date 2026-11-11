import { describe, expect, it } from 'vitest';
import { createTetherMotion, stepTetherMotion, tetherCurve, tetherPath } from './parentArrowTether';

const origin = { x: 0, y: 0 };
describe('loose parent arrow', () => {
  it('bends behind sideways movement, reverses when the grip reverses, then relaxes', () => {
    const m = createTetherMotion(origin);
    const curve = () => tetherCurve(m, m.grip, { x: 500, y: m.grip.y }, 1);
    stepTetherMotion(m, { x: 0, y: 180 }, 65);
    expect(curve()[1].y).toBeLessThan(m.grip.y - 20);
    expect(curve()[2].y).toBeLessThan(m.grip.y - 12);
    stepTetherMotion(m, { x: 0, y: -100 }, 95);
    expect(curve()[1].y).toBeGreaterThan(m.grip.y + 15);
    stepTetherMotion(m, { x: 0, y: -100 }, 1600);
    expect(curve()[1].y).toBeCloseTo(-100, 3);
    expect(curve()[2].y).toBeCloseTo(-100, 3);
  });
  it('responds consistently at different frame rates and settles after a suspended tab', () => {
    const fast = createTetherMotion(origin), slow = createTetherMotion(origin), p = { x: 140, y: 110 };
    for (let i = 0; i < 24; i++) stepTetherMotion(fast, p, 1000 / 120);
    for (let i = 0; i < 6; i++) stepTetherMotion(slow, p, 1000 / 30);
    for (const key of ['grip', 'near', 'far'] as const) for (const axis of ['x', 'y'] as const)
      expect(fast[key][axis]).toBeCloseTo(slow[key][axis], 8);
    stepTetherMotion(fast, p, 60_000);
    expect(fast.grip).toEqual(p);
    expect(tetherCurve(fast, origin, { x: 90, y: 0 }, 1)).toEqual([origin, { x: 30, y: 0 }, { x: 60, y: 0 }, { x: 90, y: 0 }]);
  });
  it('keeps bends proportional on short tethers and consistent in screen pixels across zoom levels', () => {
    const m = createTetherMotion(origin);
    stepTetherMotion(m, { x: 0, y: 2000 }, 35);
    const whole = tetherCurve(m, origin, { x: 600, y: 0 }, 1);
    for (const zoom of [.18, 2.4]) {
      const scaled = tetherCurve(m, origin, { x: 600 / zoom, y: 0 }, zoom);
      expect(scaled[1].y * zoom).toBeCloseTo(whole[1].y, 8);
    }
    const short = tetherCurve(m, origin, { x: 1, y: 0 }, 1);
    expect(Math.abs(short[1].y)).toBeLessThanOrEqual(.36);
    expect(tetherCurve(m, origin, origin, 1)).toEqual([origin, origin, origin, origin]);
  });
  it('releases the original routed shape without a jump when the transition becomes one cubic', () => {
    const saved = [origin, { x: 5, y: -5 }, { x: 15, y: 5 }, { x: 30, y: 10 }, { x: 40, y: 15 }, { x: 55, y: -5 }, { x: 60, y: 0 }];
    const target = [origin, { x: 0, y: 60 }, { x: 60, y: 60 }, { x: 60, y: 0 }] as const;
    expect(tetherPath(target, saved, 0)).toBe('M 0 0 C 5 -5, 15 5, 30 10 C 40 15, 55 -5, 60 0');
    const coords = tetherPath(target, saved, 1 - 1e-9).match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number);
    // Controls and midpoint of the same target cubic split exactly in half.
    [0, 0, 0, 30, 15, 45, 30, 45, 45, 45, 60, 30, 60, 0].forEach((n, i) => expect(coords[i]).toBeCloseTo(n, 6));
    expect(tetherPath(target, saved, 1)).toBe('M 0 0 C 0 60, 60 60, 60 0');
  });
});
