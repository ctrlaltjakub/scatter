import { describe, it, expect } from 'vitest';
import {
  DEFAULT_ACCENTS, isHexColor, isDefaultAccent, colorToCss, hexToRgb, randomGroupColor,
  GROUP_PALETTE, hexToHsl, hslToHex, mutedAccentHex,
} from './groupColor';

const lightOf = (hex: string) => hexToHsl(hex)!.l;

describe('groupColor', () => {
  it('isHexColor accepts #rgb / #rrggbb and rejects others', () => {
    expect(isHexColor('#fff')).toBe(true);
    expect(isHexColor('#8839ef')).toBe(true);
    expect(isHexColor('#8839EF')).toBe(true);
    expect(isHexColor('mauve')).toBe(false);
    expect(isHexColor('#12')).toBe(false);
    expect(isHexColor('8839ef')).toBe(false);
  });

  it('isDefaultAccent recognizes the 14 built-ins only', () => {
    expect(isDefaultAccent('mauve')).toBe(true);
    expect(isDefaultAccent('#8839ef')).toBe(false);
    expect(isDefaultAccent('chartreuse')).toBe(false);
    expect(DEFAULT_ACCENTS).toHaveLength(14);
  });

  it('colorToCss wraps accents in var() and passes hex through', () => {
    expect(colorToCss('mauve')).toBe('var(--mauve)');
    expect(colorToCss('#a3c1ff')).toBe('#a3c1ff');
  });

  it('hexToRgb parses both shorthand and full hex; null otherwise', () => {
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255]);
    expect(hexToRgb('#8839ef')).toEqual([136, 57, 239]);
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('mauve')).toBeNull();
  });

  it('randomGroupColor returns a default accent and prefers an unused one', () => {
    const c = randomGroupColor([]);
    expect(DEFAULT_ACCENTS).toContain(c);

    // With all-but-one in use, it must return the only free accent.
    const allButLast = DEFAULT_ACCENTS.slice(0, -1);
    const last = DEFAULT_ACCENTS[DEFAULT_ACCENTS.length - 1]!;
    expect(randomGroupColor(allButLast)).toBe(last);
  });

  it('randomGroupColor still returns an accent when all are taken', () => {
    const c = randomGroupColor([...DEFAULT_ACCENTS]);
    expect(DEFAULT_ACCENTS).toContain(c);
  });
});

describe('hexToHsl / hslToHex', () => {
  it('converts primary colors', () => {
    expect(hexToHsl('#ff0000')).toMatchObject({ h: 0 });
    expect(hexToHsl('#00ff00')!.h).toBeCloseTo(120, 0);
    expect(hexToHsl('#0000ff')!.h).toBeCloseTo(240, 0);
  });
  it('reports ~zero saturation for greys', () => {
    expect(hexToHsl('#666666')!.s).toBeLessThan(0.02);
  });
  it('round-trips a palette color within a small tolerance', () => {
    for (const hex of ['#1b9e77', '#377eb8', '#e7298a']) {
      const back = hslToHex(hexToHsl(hex)!);
      const a = hexToRgb(hex)!;
      const b = hexToRgb(back)!;
      for (let i = 0; i < 3; i++) expect(Math.abs(a[i]! - b[i]!)).toBeLessThanOrEqual(2);
    }
  });
  it('hslToHex normalizes hue and clamps to valid hex', () => {
    expect(isHexColor(hslToHex({ h: 400, s: 0.5, l: 0.5 }))).toBe(true);
    expect(isHexColor(hslToHex({ h: -30, s: 0.9, l: 0.2 }))).toBe(true);
  });
});

describe('GROUP_PALETTE', () => {
  it('is all valid, mode-safe hexes (mid lightness)', () => {
    expect(GROUP_PALETTE.length).toBeGreaterThanOrEqual(8);
    for (const c of GROUP_PALETTE) {
      expect(isHexColor(c)).toBe(true);
      const l = lightOf(c);
      expect(l).toBeGreaterThan(0.30);
      expect(l).toBeLessThan(0.70);
    }
  });
});

describe('mutedAccentHex', () => {
  it('allows arrows to request a brighter dark-only contrast floor', () => {
    const darkArrow = mutedAccentHex('#377eb8', 33, 0, 20, 'dark', 0.58);
    expect(lightOf(darkArrow)).toBeCloseTo(0.58, 2);

    const normalLight = mutedAccentHex('#377eb8', 33, 0, 20, 'light');
    const lightWithDarkFloor = mutedAccentHex('#377eb8', 33, 0, 20, 'light', 0.9);
    expect(lightOf(lightWithDarkFloor)).toBeCloseTo(lightOf(normalLight), 4);
  });
});
