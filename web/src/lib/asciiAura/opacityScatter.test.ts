import { describe, expect, it } from 'vitest';
import { auraAreaFraction, auraOpacityTier } from './opacityScatter';

function cellHash(x: number, y: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

describe('stable aura opacity scatter', () => {
  it.each([
    ['unfocused', 640, 900, 200], ['focused', 640, 900, 300],
    ['wide', 1600, 120, 300], ['restoration orb', 0, 0, 300],
  ] as const)('keeps 10/50/40 overall with exponential concentration near the origin: %s', (_name, w, h, r) => {
    const counts = { 1: 0, 0.75: 0, 0.5: 0 };
    const inner: number[] = [], outer: number[] = [];
    for (let y = -r; y < h + r; y += 3) for (let x = -r; x < w + r; x += 3) {
      const distance = Math.hypot(Math.max(-x, 0, x - w), Math.max(-y, 0, y - h));
      if (distance <= 0 || distance >= r) continue;
      const area = auraAreaFraction(distance, w, h, r);
      const tier = auraOpacityTier(cellHash(x + r, y + r), area) as keyof typeof counts;
      counts[tier]++;
      if (area < 0.25) inner.push(tier);
      if (area > 0.75) outer.push(tier);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(counts[1] / total).toBeCloseTo(0.1, 2);
    expect(counts[0.75] / total).toBeCloseTo(0.5, 2);
    expect(counts[0.5] / total).toBeCloseTo(0.4, 2);
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    expect(mean(inner) - mean(outer)).toBeGreaterThan(0.16);
    // The previous linear bias put only 40% of full-opacity cells in the
    // inner quarter. The exponential curve concentrates more than 60% there.
    expect(inner.filter(tier => tier === 1).length / counts[1]).toBeGreaterThan(0.6);
    expect(outer.filter(tier => tier === 1).length / counts[1]).toBeLessThan(0.05);
    // All three tiers remain scattered throughout, not solid concentric rings.
    expect(new Set(inner).size).toBe(3);
    expect(new Set(outer).size).toBe(3);
  });

  it('is deterministic and every cell becomes no brighter farther from the node', () => {
    for (let i = 0; i < 5000; i++) {
      const h = cellHash(i, i * 7);
      expect(auraOpacityTier(h, 0.5)).toBe(auraOpacityTier(h, 0.5));
      expect(auraOpacityTier(h, 0)).toBeGreaterThanOrEqual(auraOpacityTier(h, 0.5));
      expect(auraOpacityTier(h, 0.5)).toBeGreaterThanOrEqual(auraOpacityTier(h, 1));
    }
  });

  it('handles point orbs, boundary cells and expired collapse footprints', () => {
    expect(auraAreaFraction(150, 0, 0, 300)).toBe(0.25);
    expect(auraAreaFraction(-1, 640, 300, 200)).toBe(0);
    expect(auraAreaFraction(500, 640, 300, 200)).toBe(1);
    expect(auraAreaFraction(0, 0, 0, 0)).toBe(1);
  });
});
