import { describe, it, expect } from 'vitest';
import { assignGroupHue, assignGroupColorHex, GROUP_C, GROUP_L, HUE_MARGIN, hexToHue } from './groupColorAssign';
import { oklchToHex } from './oklch';

const distance = (a: number, b: number) => {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return Math.min(d, 360 - d);
};
const first = () => 0;
const crowded = Array.from({ length: 36 }, (_, i) => i * 10);

describe('hue-only group assignment', () => {
  it('spreads first-generation groups through opposite and quarter turns', () => {
    expect(assignGroupHue({ rng: first })).toBe(0);
    expect(assignGroupHue({ firstGenHues: [0], used: [0], rng: first })).toBe(180);
    expect(assignGroupHue({ firstGenHues: [0, 180], used: [0, 180], rng: first })).toBe(90);
  });

  it('fits sixteen hues with the existing 22-degree separation', () => {
    const used: number[] = [];
    for (let i = 0; i < 16; i++) {
      const hue = assignGroupHue({ firstGenHues: used, used, rng: first });
      expect(used.every((other) => distance(hue, other) >= HUE_MARGIN)).toBe(true);
      used.push(hue);
    }
  });

  it('keeps the project hue reserved even when group hues must be recycled', () => {
    for (const used of [[220], crowded]) {
      for (const relative of [null, 40]) {
        const hue = assignGroupHue({ firstGenHues: used, used, blocked: [40], relative, rng: first });
        expect(distance(hue, 40)).toBeGreaterThanOrEqual(HUE_MARGIN);
      }
    }
  });

  it('still returns a valid hue if even reserved ranges cover the wheel', () => {
    for (const relative of [null, 100]) {
      const hue = assignGroupHue({ used: crowded, blocked: crowded, relative, rng: first });
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it('keeps children near their parent while giving them separate hues', () => {
    const hue = assignGroupHue({ relative: 100, used: [100], rng: first });
    expect(distance(hue, 100)).toBeGreaterThanOrEqual(HUE_MARGIN);
    expect(distance(hue, 100)).toBeLessThan(2 * HUE_MARGIN);
  });

  it('puts the next child on the opposite side from a nearby sibling', () => {
    const hue = assignGroupHue({ relative: 100, siblings: [108], used: [100, 108], rng: first });
    expect(hue).toBeLessThan(100);
    expect(distance(hue, 108)).toBeGreaterThan(distance(hue, 100));
  });

  it('stays closer to its own family when a free in-family hue exists', () => {
    const hue = assignGroupHue({
      relative: 100, familyAnchor: 100, otherAnchors: [160],
      siblings: [96], used: [100], rng: first,
    });
    expect(distance(hue, 100)).toBeLessThanOrEqual(distance(hue, 160));
  });

  it('treats zero degrees as a real parent/family hue', () => {
    const hue = assignGroupHue({
      relative: 0, familyAnchor: 0, otherAnchors: [100],
      siblings: [30], used: [0, 30], rng: first,
    });
    expect(distance(hue, 0)).toBeGreaterThanOrEqual(HUE_MARGIN);
    expect(distance(hue, 0)).toBeLessThan(distance(hue, 100));
  });

  it('uses the fixed 0.22 target at every hierarchy depth, including exhaustion', () => {
    expect(GROUP_C).toBe(0.22);
    const used: number[] = [];
    for (let depth = 0; depth < 80; depth++) {
      const input = { used, relative: used.at(-1), rng: first };
      const hue = assignGroupHue(input);
      // sRGB clipping means decoded hex chroma is not an exact target check.
      expect(assignGroupColorHex(input)).toBe(oklchToHex(GROUP_L, 0.22, hue));
      used.push(hue);
    }
  });

  it('reads saved custom/legacy hues independently of their intensity', () => {
    for (const c of [0.04, 0.125]) {
      // 8-bit rounding is more visible in low-chroma legacy colors.
      expect(distance(hexToHue(oklchToHex(GROUP_L, c, 100)), 100)).toBeLessThan(1);
    }
  });
});
