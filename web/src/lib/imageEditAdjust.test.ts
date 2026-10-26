import { describe, expect, it } from 'vitest';
import { applyAdjustments } from './imageEditAdjust';
import { NEUTRAL_ADJUSTMENTS, type Adjustments } from './imageEditElements';

const adj = (patch: Partial<Adjustments>): Adjustments => ({ ...NEUTRAL_ADJUSTMENTS, ...patch });

/** Two pixels: a saturated tone and near-extremes, RGBA. */
function pixels(): Uint8ClampedArray {
  return new Uint8ClampedArray([200, 100, 50, 255, 250, 10, 5, 255]);
}

describe('applyAdjustments', () => {
  it('all-neutral is the identity', () => {
    const data = pixels();
    applyAdjustments(data, adj({}));
    expect(Array.from(data)).toEqual(Array.from(pixels()));
  });

  it('positive warmth raises R and lowers B, leaving G and alpha alone', () => {
    const data = pixels();
    applyAdjustments(data, adj({ warmth: 30 }));
    expect(data[0]).toBe(230); // R up
    expect(data[1]).toBe(100); // G untouched
    expect(data[2]).toBe(20);  // B down
    expect(data[3]).toBe(255); // alpha untouched
  });

  it('negative warmth cools (R down, B up)', () => {
    const data = pixels();
    applyAdjustments(data, adj({ warmth: -30 }));
    expect(data[0]).toBe(170);
    expect(data[2]).toBe(80);
  });

  it('warmth clamps at 0 and 255 instead of wrapping', () => {
    const data = pixels();
    applyAdjustments(data, adj({ warmth: 100 }));
    expect(data[4]).toBe(255); // 250 + 100 clamps high
    expect(data[6]).toBe(0);   // 5 − 100 clamps low
  });

  it('saturation −100 lands every channel on the pixel luma (grayscale)', () => {
    const data = pixels();
    applyAdjustments(data, adj({ saturation: -100 }));
    // luma = .213·200 + .715·100 + .072·50 = 117.7 → 118 after rounding
    expect(data[0]).toBe(118);
    expect(data[1]).toBe(118);
    expect(data[2]).toBe(118);
  });

  it('saturation leaves pure gray untouched', () => {
    const data = new Uint8ClampedArray([128, 128, 128, 255]);
    applyAdjustments(data, adj({ saturation: 100 }));
    expect(Array.from(data)).toEqual([128, 128, 128, 255]);
  });

  it('contrast +100 doubles the distance from mid-gray (clamped)', () => {
    const data = pixels();
    applyAdjustments(data, adj({ contrast: 100 }));
    expect(data[0]).toBe(255); // (200−128)·2+128 = 272 → clamp
    expect(data[1]).toBe(72);  // (100−128)·2+128
    expect(data[2]).toBe(0);   // (50−128)·2+128 = −28 → clamp
  });

  it('contrast −100 flattens everything to mid-gray', () => {
    const data = pixels();
    applyAdjustments(data, adj({ contrast: -100 }));
    expect([data[0], data[1], data[2]]).toEqual([128, 128, 128]);
  });

  it('hue 120° pushes pure red toward green', () => {
    const data = new Uint8ClampedArray([255, 0, 0, 255]);
    applyAdjustments(data, adj({ hue: 120 }));
    expect(data[1]!).toBeGreaterThan(data[0]!);
    expect(data[1]!).toBeGreaterThan(data[2]!);
  });

  it('a full 360° hue turn is (nearly) the identity', () => {
    const data = pixels();
    applyAdjustments(data, adj({ hue: 360 }));
    const orig = pixels();
    for (let i = 0; i < data.length; i++) {
      expect(Math.abs(data[i]! - orig[i]!)).toBeLessThanOrEqual(1);
    }
  });
});
