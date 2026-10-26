import { describe, expect, it, vi } from 'vitest';
import {
  ANNOTATION_FONTS,
  APP_FONT_EX_HEIGHT_RATIO,
  APP_FONT_ID,
  NODE_TEXT_FONTS,
  adjustedCanvasFontSize,
  ensureFontLoaded,
  fontFamilyFor,
  isKnownFontId,
  nearestTextSizePx,
  resolveAppFontFamily,
  TEXT_SIZE_OPTIONS_PX,
  textSizeLabel,
} from './imageEditFonts';

describe('imageEditFonts', () => {
  it('preserves the image editor list and orders distinct node fonts as requested', () => {
    expect(ANNOTATION_FONTS.map((f) => f.id))
      .toEqual([APP_FONT_ID, 'noto-sans', 'playfair', 'caveat', 'opendyslexic', 'press-start']);
    expect(NODE_TEXT_FONTS.map((f) => f.id).slice(0, 4))
      .toEqual([APP_FONT_ID, 'opendyslexic', 'monospace', 'arial']);
    expect(NODE_TEXT_FONTS.map((f) => f.id)).not.toContain('press-start');
    expect(new Set(NODE_TEXT_FONTS.map((f) => f.id)).size).toBe(NODE_TEXT_FONTS.length);
    expect(new Set(NODE_TEXT_FONTS.map((f) => f.label)).size).toBe(NODE_TEXT_FONTS.length);
  });

  it('includes the promised families', () => {
    const ids = NODE_TEXT_FONTS.map((f) => f.id);
    expect(ids).toContain(APP_FONT_ID);
    expect(ids).not.toContain('press-start');
    expect(ids).toContain('opendyslexic');
    expect(ids).toContain('noto-sans');
    expect(ids).toContain('playfair');
    expect(ids).toContain('caveat');
    for (const id of ['comic-sans', 'inter', 'roboto', 'open-sans', 'lato', 'merriweather', 'georgia']) {
      expect(ids).toContain(id);
      expect(isKnownFontId(id)).toBe(true);
    }
    expect(isKnownFontId('not-a-font')).toBe(false);
  });

  it('resolveAppFontFamily never returns an empty string', () => {
    expect(resolveAppFontFamily().length).toBeGreaterThan(0);
  });

  it('fontFamilyFor maps ids to concrete families and falls back for unknowns', () => {
    expect(fontFamilyFor('caveat')).toContain('Caveat');
    expect(fontFamilyFor('press-start')).toContain('Press Start 2P');
    // App font + unknown ids resolve to the runtime body stack (non-empty).
    expect(fontFamilyFor(APP_FONT_ID).length).toBeGreaterThan(0);
    expect(fontFamilyFor('does-not-exist').length).toBeGreaterThan(0);
  });

  it('uses the measured Atkinson x-height as the reading-size reference', () => {
    expect(APP_FONT_EX_HEIGHT_RATIO).toBeCloseTo(0.4959, 3);
  });

  it('scales canvas annotations by the actual loaded family ex-height and caches it', async () => {
    let measuredEx = 56;
    const measure = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return { height: this.style.height === '1ex' ? measuredEx : 0 } as DOMRect;
    });
    const oldFonts = Object.getOwnPropertyDescriptor(document, 'fonts');
    const load = vi.fn(async () => []);
    Object.defineProperty(document, 'fonts', { configurable: true, value: { load } });
    try {
      const family = '"Font Size Test", sans-serif';
      expect(adjustedCanvasFontSize(100, resolveAppFontFamily())).toBe(100);
      expect(adjustedCanvasFontSize(100, family)).toBe(100); // no layout during React render
      await ensureFontLoaded(family);
      expect(adjustedCanvasFontSize(100, family)).toBeCloseTo(88.57, 1);
      measuredEx = 40;
      expect(adjustedCanvasFontSize(100, family)).toBeCloseTo(88.57, 1); // cached
      await ensureFontLoaded(family);
      expect(load).toHaveBeenCalledWith(`400 24px ${family}`, 'x');
      expect(adjustedCanvasFontSize(100, family)).toBeCloseTo(88.57, 1);
    } finally {
      measure.mockRestore();
      if (oldFonts) Object.defineProperty(document, 'fonts', oldFonts);
      else Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('every font carries a non-empty description', () => {
    for (const f of NODE_TEXT_FONTS) expect(f.description.length).toBeGreaterThan(8);
  });

  it('text-size helpers: label is px÷10, snapping picks the nearest preset', () => {
    expect(textSizeLabel(100)).toBe('10');
    expect(textSizeLabel(25)).toBe('2.5');
    expect(nearestTextSizePx(33)).toBe(30);
    expect(nearestTextSizePx(1)).toBe(TEXT_SIZE_OPTIONS_PX[0]);
    expect(nearestTextSizePx(9999)).toBe(TEXT_SIZE_OPTIONS_PX[TEXT_SIZE_OPTIONS_PX.length - 1]);
  });

  it('ensureFontLoaded is safe where the Font Loading API is missing (jsdom)', async () => {
    await expect(ensureFontLoaded('"Caveat", cursive', 'Привет')).resolves.toBeUndefined();
  });
});
