import { describe, expect, test } from 'vitest';
import {
  waveStillActive,
  waveDensity,
  WAVE_DURATION_MS,
  WAVE_SPEED_PX_PER_S,
  UNFOCUS_DURATION_MS,
  UNFOCUS_START_RADIUS_PX,
  COLLAPSE_DURATION_MS,
  RIPPLE_WAVELENGTH_PX,
  RIPPLE_SIGMA_PX,
  MAX_WAVE_REACH_PX,
  type Wave,
} from './wave';

/**
 * Wave animation envelopes (R6 — water-like Gabor wavelet).
 *   - 'focus'/'spawn': crest expands outward; smooth +peak at the
 *     crest, soft signed troughs from the cosine carrier, Gaussian
 *     decay. Callers add to steady density and clamp to [0,1].
 *   - 'unfocus': same wavelet, crest drains INWARD (R₀ → 0).
 *   - 'collapse': aura radius shrinks linearly to 0; always ≥ 0.
 */

describe('waveStillActive', () => {
  test('focus active during [0, WAVE_DURATION_MS)', () => {
    const w: Wave = { kind: 'focus', t0: 1000 };
    expect(waveStillActive(w, 1000)).toBe(true);
    expect(waveStillActive(w, 1000 + WAVE_DURATION_MS - 1)).toBe(true);
    expect(waveStillActive(w, 1000 + WAVE_DURATION_MS)).toBe(false);
  });

  test('a wave stamped "in the future" is newborn, NOT expired (rAF clock skew)', () => {
    // t0 comes from performance.now() inside an input handler; the render
    // loop asks with its rAF timestamp, stamped at frame start — routinely a
    // few ms EARLIER than a t0 born in the same frame. Answering false here
    // made pruneExpired delete focus ripples before their first frame.
    expect(waveStillActive({ kind: 'focus', t0: 1003 }, 1000)).toBe(true);
    expect(waveStillActive({ kind: 'spawn', t0: 1030 }, 1000)).toBe(true);
    expect(waveStillActive({ kind: 'unfocus', t0: 1003 }, 1000)).toBe(true);
    expect(waveStillActive({ kind: 'collapse', t0: 1003, startRadius: 100 }, 1000)).toBe(true);
  });

  test('spawn shares the focus duration', () => {
    const w: Wave = { kind: 'spawn', t0: 0 };
    expect(waveStillActive(w, WAVE_DURATION_MS - 1)).toBe(true);
    expect(waveStillActive(w, WAVE_DURATION_MS)).toBe(false);
  });

  test('unfocus active during [0, UNFOCUS_DURATION_MS)', () => {
    const w: Wave = { kind: 'unfocus', t0: 0 };
    expect(waveStillActive(w, UNFOCUS_DURATION_MS - 1)).toBe(true);
    expect(waveStillActive(w, UNFOCUS_DURATION_MS)).toBe(false);
  });

  test('collapse active during [0, COLLAPSE_DURATION_MS)', () => {
    const w: Wave = { kind: 'collapse', t0: 500, startRadius: 100 };
    expect(waveStillActive(w, 500 + COLLAPSE_DURATION_MS - 1)).toBe(true);
    expect(waveStillActive(w, 500 + COLLAPSE_DURATION_MS)).toBe(false);
  });
});

describe('waveDensity — focus/spawn expanding ripple', () => {
  const w: Wave = { kind: 'focus', t0: 0 };
  const crestAt = (t: number) => WAVE_SPEED_PX_PER_S * (t / 1000);

  test('0 before start and after the deadline', () => {
    expect(waveDensity(50, w, -10)).toBe(0);
    expect(waveDensity(50, w, WAVE_DURATION_MS)).toBe(0);
    expect(waveDensity(50, w, WAVE_DURATION_MS + 100)).toBe(0);
  });

  test('positive peak exactly at the crest', () => {
    const t = 200;
    const crest = crestAt(t);
    const atCrest = waveDensity(crest, w, t);
    expect(atCrest).toBeGreaterThan(0);
    // Crest is the global max of the wavelet at this instant.
    for (let d = 0; d < crest + 3 * RIPPLE_SIGMA_PX; d += 3) {
      expect(waveDensity(d, w, t)).toBeLessThanOrEqual(atCrest + 1e-9);
    }
  });

  test('crest moves outward over time', () => {
    const early = crestAt(80);
    const late = crestAt(400);
    expect(late).toBeGreaterThan(early);
    expect(waveDensity(late, w, 400)).toBeGreaterThan(0);
  });

  test('first trough (half a wavelength out) is negative — the ripple dip', () => {
    const t = 200;
    const crest = crestAt(t);
    const trough = waveDensity(crest + RIPPLE_WAVELENGTH_PX / 2, w, t);
    expect(trough).toBeLessThan(0);
  });

  test('smooth (no kinks): finite-difference derivative is continuous near the crest', () => {
    const t = 200;
    const crest = crestAt(t);
    const h = 0.5;
    let prevSlope = (waveDensity(crest - 30 + h, w, t) - waveDensity(crest - 30 - h, w, t)) / (2 * h);
    for (let d = crest - 30; d <= crest + 30; d += 1) {
      const slope = (waveDensity(d + h, w, t) - waveDensity(d - h, w, t)) / (2 * h);
      // Triangle peaks had a slope JUMP of ~2×amp/PEAK_HALF at the
      // crest; the wavelet's slope changes gradually everywhere.
      expect(Math.abs(slope - prevSlope)).toBeLessThan(0.05);
      prevSlope = slope;
    }
  });

  test('envelope ≈ 0 beyond 3σ from the crest', () => {
    const t = 200;
    const crest = crestAt(t);
    expect(Math.abs(waveDensity(crest + 3 * RIPPLE_SIGMA_PX + 20, w, t))).toBeLessThan(0.02);
  });

  test('crest amplitude decays as the crest grows', () => {
    const early = waveDensity(crestAt(60), w, 60);
    const late = waveDensity(crestAt(450), w, 450);
    expect(early).toBeGreaterThan(late);
    expect(late).toBeGreaterThanOrEqual(0);
  });

  test('amplitude fades to ~0 at the deadline', () => {
    const tEnd = WAVE_DURATION_MS - 1;
    expect(Math.abs(waveDensity(crestAt(tEnd), w, tEnd))).toBeLessThan(0.02);
  });

  test('MAX_WAVE_REACH_PX bounds the contributing region', () => {
    // Nothing meaningful beyond the published reach, at any time.
    for (let t = 0; t < WAVE_DURATION_MS; t += 50) {
      expect(Math.abs(waveDensity(MAX_WAVE_REACH_PX + 5, w, t))).toBeLessThan(0.02);
    }
  });
});

describe('waveDensity — unfocus receding ripple', () => {
  const w: Wave = { kind: 'unfocus', t0: 0 };

  test('crest starts near R₀ and drains inward', () => {
    // Early: crest near the start radius. Late: crest near 0.
    const earlyCrest = UNFOCUS_START_RADIUS_PX * (1 - 0.1);
    const lateCrest = UNFOCUS_START_RADIUS_PX * (1 - 0.9);
    expect(waveDensity(earlyCrest, w, 0.1 * UNFOCUS_DURATION_MS)).toBeGreaterThan(0);
    expect(waveDensity(lateCrest, w, 0.9 * UNFOCUS_DURATION_MS)).toBeGreaterThan(0);
    expect(lateCrest).toBeLessThan(earlyCrest);
  });

  test('0 after its (shorter) deadline', () => {
    expect(waveDensity(10, w, UNFOCUS_DURATION_MS)).toBe(0);
  });
});

describe('waveDensity — collapse (unchanged)', () => {
  const w: Wave = { kind: 'collapse', t0: 0, startRadius: 100 };

  test('at t=0 behaves like a full steady aura', () => {
    expect(waveDensity(0, w, 0)).toBeCloseTo(1);
    expect(waveDensity(50, w, 0)).toBeCloseTo(0.5);
    expect(waveDensity(100, w, 0)).toBeCloseTo(0);
  });

  test('radius shrinks linearly', () => {
    const tHalf = COLLAPSE_DURATION_MS / 2;
    expect(waveDensity(25, w, tHalf)).toBeCloseTo(0.5, 1);
    expect(waveDensity(60, w, tHalf)).toBe(0);
  });

  test('never negative', () => {
    for (let t = 0; t < COLLAPSE_DURATION_MS; t += 25) {
      for (let d = 0; d < 200; d += 10) {
        expect(waveDensity(d, w, t)).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
