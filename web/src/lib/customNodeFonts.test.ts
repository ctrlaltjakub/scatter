import { describe, expect, it } from 'vitest';
import { customFontFixture as font } from '@/test/customFontFixture';
import { appendCustomNodeFont, customFontFamily, fontFormat, MAX_CUSTOM_FONT_BYTES, normalizeCustomNodeFonts } from './customNodeFonts';
import { normalizeSettings } from '@/opfs/settingsIO';
import { DEFAULT_SETTINGS } from '@/store/types';

describe('portable custom node fonts', () => {
  it('retains bytes and font choice through settings normalization', () => {
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, customNodeFonts: [font], nodeFontId: font.id }))
      .toMatchObject({ customNodeFonts: [font], nodeFontId: font.id });
    expect(normalizeSettings({ providers: [] }).customNodeFonts).toEqual([]);
    expect(normalizeSettings({ ...DEFAULT_SETTINGS, nodeFontId: font.id }).nodeFontId).toBe('app');
  });
  it('rejects unsafe ids, URLs, damaged headers, invalid base64 and oversized data', () => {
    for (const patch of [
      { id: 'x";color:red' }, { data: 'https://example.test/font.woff2' },
      { data: btoa('not a font at all') }, { data: '!!!!'.repeat(4) },
      { data: font.data.slice(0, -1) }, { data: 'A'.repeat(Math.ceil(MAX_CUSTOM_FONT_BYTES / 3) * 4 + 4) },
    ]) expect(normalizeCustomNodeFonts([{ ...font, ...patch }])).toEqual([]);
    expect(customFontFamily('"unsafe')).toBeNull();
    expect(customFontFamily(font.id)).toMatch(/^ScatterCustomFont_[a-f0-9]{64}$/);
  });
  it('derives size and format from the file, deduplicates, and clamps names', () => {
    expect(normalizeCustomNodeFonts([{ ...font, byteLength: -1, format: 'evil', name: 'A'.repeat(100) }, font]))
      .toEqual([{ ...font, name: 'A'.repeat(80) }]);
    expect(appendCustomNodeFont([font], { ...font, name: 'Renamed duplicate' })).toEqual([font]);
  });
  it('bounds count and total size even if state changed during upload', () => {
    const large = { ...font, byteLength: MAX_CUSTOM_FONT_BYTES };
    expect(() => appendCustomNodeFont(Array.from({ length: 20 }, () => font), { ...font, id: 'other', data: 'other' })).toThrow('20 custom fonts');
    expect(() => appendCustomNodeFont([large, large], { ...font, id: 'other', data: 'other' })).toThrow('20 MB in total');
  });
  it.each([
    ['\x00\x01\x00\x00', 'ttf'], ['OTTO', 'otf'], ['wOFF', 'woff'], ['wOF2', 'woff2'], ['ttcf', null],
  ])('recognizes the %s file signature', (signature, expected) => {
    expect(fontFormat(Uint8Array.from(signature + '\0'.repeat(8), char => char.charCodeAt(0)))).toBe(expected);
  });
});
