import { describe, it, expect } from 'vitest';
import { oklchToHex, hexToOklch } from './oklch';

const rgb = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const close = (a: string, b: string, tol = 2) => {
  const A = rgb(a), B = rgb(b);
  for (let i = 0; i < 3; i++) if (Math.abs(A[i]! - B[i]!) > tol) return false;
  return true;
};

describe('oklch converters', () => {
  it('oklchToHex always returns a valid #rrggbb (gamut-clamped)', () => {
    for (const [L, C, H] of [[0.7462, 0.125, 0], [0.7462, 0.125, 264], [0.5, 0.3, 140], [0, 0, 0], [1, 0, 0]]) {
      expect(oklchToHex(L!, C!, H!)).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it('maps black and white', () => {
    expect(close(oklchToHex(0, 0, 0), '#000000')).toBe(true);
    expect(close(oklchToHex(1, 0, 0), '#ffffff')).toBe(true);
  });

  it('maps sRGB red within tolerance', () => {
    // sRGB #ff0000 ≈ oklch(0.6280, 0.2577, 29.23)
    expect(close(oklchToHex(0.6280, 0.2577, 29.23), '#ff0000', 3)).toBe(true);
    const r = hexToOklch('#ff0000');
    expect(r.l).toBeCloseTo(0.628, 2);
    expect(r.c).toBeCloseTo(0.258, 2);
    expect(r.h).toBeCloseTo(29.2, 0);
  });

  it('round-trips in-gamut colors hex -> oklch -> hex', () => {
    for (const hex of ['#1b9e77', '#377eb8', '#7570b3', '#888888', '#c0d9af']) {
      const { l, c, h } = hexToOklch(hex);
      expect(close(oklchToHex(l, c, h), hex, 2)).toBe(true);
    }
  });

  it('reports near-zero chroma for greys', () => {
    expect(hexToOklch('#777777').c).toBeLessThan(0.005);
  });
});
