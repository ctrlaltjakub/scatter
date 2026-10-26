import { afterEach, describe, expect, test } from 'vitest';
import {
  resolveAuraTint,
  resolveAuraTintParts,
  resolveAuraTintNumeric,
  clearAuraTintCache,
} from './auraTint';

const FB = { baseline: 'BASE', aura: 'AURA' };

afterEach(() => {
  clearAuraTintCache();
  document.documentElement.removeAttribute('style');
});

describe('resolveAuraTintParts — minified colour formats from the prod CSS', () => {
  // The production CSS minifier re-serialises rgba(213,213,213,0.6) as hsla()
  // and rgba(213,213,213,1) as #hex. The fallback parser must accept those, or
  // ungrouped/neutral glyphs fall back to BLACK (the prod "very dark" bug).
  test('parses an hsla() baseline + hex aura into the right rgb + alphas', () => {
    const parts = resolveAuraTintParts(null, { baseline: 'hsla(0,0%,84%,.6)', aura: '#d5d5d5' });
    expect(parts.rgb).toBe('214, 214, 214'); // hsl L=84% → 214, NOT 0,0,0
    expect(parts.alphaBase).toBe(0.6);
    expect(parts.alphaFocus).toBe(1);
  });
  test('still parses plain rgba()', () => {
    const parts = resolveAuraTintParts(null, { baseline: 'rgba(213, 213, 213, 0.6)', aura: 'rgba(213, 213, 213, 1)' });
    expect(parts.rgb).toBe('213, 213, 213');
    expect(parts.alphaBase).toBe(0.6);
  });
});

describe('resolveAuraTint', () => {
  test('null accent returns the baseline fallback when unfocused', () => {
    expect(resolveAuraTint(null, false, FB)).toBe('BASE');
  });

  test('null accent returns the aura fallback when focused', () => {
    expect(resolveAuraTint(null, true, FB)).toBe('AURA');
  });

  test('reads --ctp-{accent} as an RGB tuple and emits unfocused rgba', () => {
    document.documentElement.style.setProperty('--ctp-mauve', '136 57 239');
    expect(resolveAuraTint('mauve', false, FB)).toBe('rgba(136, 57, 239, 0.6)');
  });

  test('focused variant bumps alpha', () => {
    document.documentElement.style.setProperty('--ctp-mauve', '136 57 239');
    expect(resolveAuraTint('mauve', true, FB)).toBe('rgba(136, 57, 239, 1)');
  });

  test('missing --ctp-{accent} falls back to the supplied colors', () => {
    // No setProperty — var stays empty.
    expect(resolveAuraTint('flamingo', false, FB)).toBe('BASE');
    expect(resolveAuraTint('flamingo', true, FB)).toBe('AURA');
  });

  test('malformed --ctp-{accent} (non-numeric) falls back', () => {
    document.documentElement.style.setProperty('--ctp-red', 'oops');
    expect(resolveAuraTint('red', false, FB)).toBe('BASE');
  });

  test('caches repeated lookups for the same (accent, focused) key', () => {
    document.documentElement.style.setProperty('--ctp-green', '64 160 43');
    const first = resolveAuraTint('green', false, FB);
    // Mutate the underlying var; cached call should NOT see the change.
    document.documentElement.style.setProperty('--ctp-green', '0 0 0');
    const second = resolveAuraTint('green', false, FB);
    expect(second).toBe(first);
  });

  test('clearAuraTintCache forces a re-read on the next call', () => {
    document.documentElement.style.setProperty('--ctp-blue', '30 102 245');
    const a = resolveAuraTint('blue', false, FB);
    expect(a).toBe('rgba(30, 102, 245, 0.6)');
    document.documentElement.style.setProperty('--ctp-blue', '1 2 3');
    clearAuraTintCache();
    const b = resolveAuraTint('blue', false, FB);
    expect(b).toBe('rgba(1, 2, 3, 0.6)');
  });

  test('parses a #hex accent directly (custom colors, no --ctp var)', () => {
    expect(resolveAuraTint('#8839ef', false, FB)).toBe('rgba(136, 57, 239, 0.6)');
    expect(resolveAuraTint('#8839ef', true, FB)).toBe('rgba(136, 57, 239, 1)');
  });
});

describe('resolveAuraTintParts (E.10)', () => {
  const PARSED_FB = {
    baseline: 'rgba(0, 0, 0, 0.10)',
    aura:     'rgba(0, 0, 0, 0.22)',
  };

  test('null accent parses fallback rgba strings into parts', () => {
    const p = resolveAuraTintParts(null, PARSED_FB);
    expect(p.rgb).toBe('0, 0, 0');
    expect(p.alphaBase).toBeCloseTo(0.10);
    expect(p.alphaFocus).toBeCloseTo(0.22);
  });

  test('null accent + unparsable fallback uses safe defaults', () => {
    const FBBad = { baseline: 'BASE', aura: 'AURA' };
    const p = resolveAuraTintParts(null, FBBad);
    expect(p.rgb).toBe('0, 0, 0');
    expect(p.alphaBase).toBeCloseTo(0.6);
    expect(p.alphaFocus).toBeCloseTo(1);
  });

  test('valid accent emits parts with UNFOCUSED + FOCUSED alphas', () => {
    document.documentElement.style.setProperty('--ctp-mauve', '136 57 239');
    const p = resolveAuraTintParts('mauve', PARSED_FB);
    expect(p.rgb).toBe('136, 57, 239');
    expect(p.alphaBase).toBeCloseTo(0.6);
    expect(p.alphaFocus).toBeCloseTo(1);
  });

  test('missing --ctp-{accent} returns the fallback parts', () => {
    const p = resolveAuraTintParts('flamingo', PARSED_FB);
    expect(p.rgb).toBe('0, 0, 0');
    expect(p.alphaBase).toBeCloseTo(0.10);
    expect(p.alphaFocus).toBeCloseTo(0.22);
  });

  test('parts results are cached per accent', () => {
    document.documentElement.style.setProperty('--ctp-green', '64 160 43');
    const first = resolveAuraTintParts('green', PARSED_FB);
    document.documentElement.style.setProperty('--ctp-green', '0 0 0');
    const second = resolveAuraTintParts('green', PARSED_FB);
    expect(second).toBe(first);
  });

  test('parses a #hex accent into parts', () => {
    const p = resolveAuraTintParts('#179299', PARSED_FB);
    expect(p.rgb).toBe('23, 146, 153');
    expect(p.alphaBase).toBeCloseTo(0.6);
    expect(p.alphaFocus).toBeCloseTo(1);
  });

  test('uses the dark-theme alpha tiers for named and custom group colors', () => {
    document.documentElement.style.setProperty('--ascii-alpha-unfocused', '0.35');
    document.documentElement.style.setProperty('--ascii-alpha-focused', '0.6');
    document.documentElement.style.setProperty('--ctp-mauve', '136 57 239');
    const named = resolveAuraTintParts('mauve', PARSED_FB);
    const custom = resolveAuraTintParts('#179299', PARSED_FB);
    expect(named.alphaBase).toBeCloseTo(0.35);
    expect(named.alphaFocus).toBeCloseTo(0.6);
    expect(custom.alphaBase).toBeCloseTo(0.35);
    expect(custom.alphaFocus).toBeCloseTo(0.6);
  });

  test('refreshes a cached restoration hex color when the theme alpha changes', () => {
    document.documentElement.style.setProperty('--ascii-alpha-unfocused', '0.6');
    document.documentElement.style.setProperty('--ascii-alpha-focused', '1');
    const light = resolveAuraTintParts('#179299', PARSED_FB);
    expect(light.alphaBase).toBeCloseTo(0.6);
    expect(light.alphaFocus).toBeCloseTo(1);

    document.documentElement.style.setProperty('--ascii-alpha-unfocused', '0.35');
    document.documentElement.style.setProperty('--ascii-alpha-focused', '0.6');
    const dark = resolveAuraTintParts('#179299', PARSED_FB);
    expect(dark).not.toBe(light);
    expect(dark.alphaBase).toBeCloseTo(0.35);
    expect(dark.alphaFocus).toBeCloseTo(0.6);
  });
});

describe('resolveAuraTintNumeric (R5 — GL renderer)', () => {
  const PARSED_FB = {
    baseline: 'rgba(0, 0, 0, 0.10)',
    aura:     'rgba(0, 0, 0, 0.22)',
  };

  test('valid accent: rgb scaled to [0,1] floats + standard alpha tiers', () => {
    document.documentElement.style.setProperty('--ctp-mauve', '136 57 239');
    const t = resolveAuraTintNumeric('mauve', PARSED_FB);
    expect(t.r).toBeCloseTo(136 / 255, 6);
    expect(t.g).toBeCloseTo(57 / 255, 6);
    expect(t.b).toBeCloseTo(239 / 255, 6);
    expect(t.alphaBase).toBeCloseTo(0.6);
    expect(t.alphaFocus).toBeCloseTo(1);
  });

  test('null accent: parsed fallback rgb + the fallback alphas', () => {
    const t = resolveAuraTintNumeric(null, PARSED_FB);
    expect(t.r).toBe(0);
    expect(t.alphaBase).toBeCloseTo(0.10);
    expect(t.alphaFocus).toBeCloseTo(0.22);
  });

  test('missing --ctp var falls back like the string variant', () => {
    const t = resolveAuraTintNumeric('flamingo', PARSED_FB);
    expect(t.r).toBe(0);
    expect(t.alphaBase).toBeCloseTo(0.10);
  });

  test('parses a #hex accent into [0,1] floats', () => {
    const t = resolveAuraTintNumeric('#ffffff', PARSED_FB);
    expect(t.r).toBeCloseTo(1, 6);
    expect(t.g).toBeCloseTo(1, 6);
    expect(t.b).toBeCloseTo(1, 6);
  });
});
