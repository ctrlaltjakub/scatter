import { describe, it, expect } from 'vitest';
import { createShakeDetector } from './shakeDetect';

/** Feed a list of [x, y, t] samples; return the final push() result. */
function feed(det: ReturnType<typeof createShakeDetector>, samples: [number, number, number][]): boolean {
  let out = false;
  for (const [x, y, t] of samples) out = det.push(x, y, t);
  return out;
}

describe('createShakeDetector', () => {
  const opts = { minLegPx: 10, minReversals: 3, windowMs: 1000 };

  it('never trips on a straight monotonic drag', () => {
    const det = createShakeDetector(opts);
    const samples: [number, number, number][] = [];
    for (let i = 0; i <= 10; i++) samples.push([i * 25, 0, i * 16]);
    expect(feed(det, samples)).toBe(false);
  });

  it('trips after enough fast horizontal reversals', () => {
    const det = createShakeDetector(opts);
    // L, R, L, R legs of 60px each → 3 reversals by the last sample.
    const tripped = feed(det, [
      [100, 0, 0],
      [40, 0, 16],   // first leg left (60px), no reversal yet
      [130, 0, 32],  // reversal #1 (leg was 60 ≥ 10)
      [40, 0, 48],   // reversal #2
      [130, 0, 64],  // reversal #3 → trips
    ]);
    expect(tripped).toBe(true);
  });

  it('does not count tiny jitter below the minimum leg length', () => {
    const det = createShakeDetector(opts);
    // ±5px wiggles — each leg is under minLegPx (10), so no reversals count.
    const samples: [number, number, number][] = [];
    let x = 100;
    for (let i = 0; i < 12; i++) { x += i % 2 === 0 ? -5 : 5; samples.push([x, 0, i * 16]); }
    expect(feed(det, samples)).toBe(false);
  });

  it('expires reversals outside the time window (slow back-and-forth)', () => {
    const det = createShakeDetector(opts);
    // Reversals spaced 600ms apart — never 3 within the 1000ms window.
    const tripped = feed(det, [
      [100, 0, 0],
      [40, 0, 100],    // leg left
      [130, 0, 700],   // reversal #1 @700
      [40, 0, 1300],   // reversal #2 @1300 (#1 now outside [300,1300])
      [130, 0, 1900],  // reversal #3 @1900 (#1,#2 outside [900,1900])
    ]);
    expect(tripped).toBe(false);
  });

  it('also trips on a vertical shake', () => {
    const det = createShakeDetector(opts);
    const tripped = feed(det, [
      [0, 100, 0],
      [0, 40, 16],
      [0, 130, 32],
      [0, 40, 48],
      [0, 130, 64],
    ]);
    expect(tripped).toBe(true);
  });

  it('reset() clears state so a fresh gesture starts clean', () => {
    const det = createShakeDetector(opts);
    feed(det, [
      [100, 0, 0], [40, 0, 16], [130, 0, 32], [40, 0, 48], [130, 0, 64],
    ]);
    det.reset();
    // A straight drag after reset must not be tripped.
    expect(feed(det, [[0, 0, 80], [50, 0, 96], [100, 0, 112]])).toBe(false);
  });
});
