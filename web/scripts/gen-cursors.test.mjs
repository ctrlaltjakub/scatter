// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { CURSORS, CURSOR_DENSITIES, cursorPng, generateCursorCss } from './gen-cursors.mjs';

describe('pre-antialiased cursor assets', () => {
  it.each(Object.entries(CURSORS))('keeps %s at its existing logical size at every density', async (_name, cursor) => {
    for (const density of CURSOR_DENSITIES) {
      const png = await cursorPng(cursor, density);
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      expect(info.width).toBe(Math.round(cursor.viewW * 0.8) * density);
      expect(info.height).toBe(19 * density);
      expect(info.channels).toBe(4);
      // The widest term cursor at 4x still fits Chromium's 128px image cap.
      expect(Math.max(info.width, info.height)).toBeLessThanOrEqual(128);
      const alpha = Array.from(data).filter((_, index) => index % 4 === 3);
      expect(alpha).toContain(0);
      expect(alpha.some(value => value > 0 && value < 255)).toBe(true);
      expect(new Set(alpha).size).toBeGreaterThanOrEqual(8);
    }
  });

  it('ships pixel-identical assets, unchanged hotspots and native fallbacks', async () => {
    const css = await generateCursorCss();
    const shipped = readFileSync(new URL('../src/app/cursors.css', import.meta.url), 'utf8');
    const pngPattern = /data:image\/png;base64,([A-Za-z0-9+/=]+)/g;
    const expectedPngs = [...shipped.matchAll(pngPattern)];
    const actualPngs = [...css.matchAll(pngPattern)];
    // libvips upgrades may change PNG compression without changing a single
    // displayed pixel. Keep the shipped cursors and compare decoded RGBA, while
    // still requiring byte-identical SVGs, CSS geometry, hotspots and fallbacks.
    expect(shipped.replace(pngPattern, 'PNG')).toBe(css.replace(pngPattern, 'PNG'));
    expect(actualPngs).toHaveLength(expectedPngs.length);
    for (let i = 0; i < expectedPngs.length; i++) {
      const expected = await sharp(Buffer.from(expectedPngs[i][1], 'base64')).raw().toBuffer({ resolveWithObject: true });
      const actual = await sharp(Buffer.from(actualPngs[i][1], 'base64')).raw().toBuffer({ resolveWithObject: true });
      expect(actual.info).toEqual(expected.info);
      expect(actual.data).toEqual(expected.data);
    }
    expect(css).toContain('@supports (cursor: image-set(');
    for (const [name, cursor] of Object.entries(CURSORS)) {
      const declarations = css.split('\n').filter(line => line.trim().startsWith(`--cur-${name}:`));
      expect(declarations).toHaveLength(2);
      expect(declarations[0]).toContain('url("data:image/svg+xml,');
      expect(declarations[1]).toContain('image-set(url("data:image/png;base64,');
      for (const density of CURSOR_DENSITIES) expect(declarations[1]).toContain(` ${density}x`);
      for (const declaration of declarations) {
        expect(declaration).toMatch(new RegExp(` ${Math.round(cursor.hotspot[0] * 0.8)} ${Math.round(cursor.hotspot[1] * 0.8)}, ${cursor.fallback};$`));
      }
    }
  });
});
