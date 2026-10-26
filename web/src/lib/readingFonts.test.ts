import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { declaredFontSupports, fallbackReadingFamily, readingCharacters, resolveReadingFamily } from './readingFonts';
import type { CustomNodeFont } from './customNodeFonts';

vi.mock('./imageEditFonts', () => ({ APP_FONT_EX_HEIGHT_RATIO: .496,
  fontFamilyFor: (id: string) => id.startsWith('custom-font-') ? 'Custom Test' : 'Declared Test',
  ensureReadingFontLoaded: vi.fn(async () => {}),
}));
afterEach(() => document.head.querySelectorAll('[data-font-test]').forEach(e => e.remove()));

describe('whole-block reading font fallback', () => {
  it('requires every used letter, not only a representative glyph', () => {
    const style = document.createElement('style'); style.dataset.fontTest = '';
    style.textContent = '@font-face { font-family: "Declared Test"; src:url(dummy); unicode-range:U+0000-00FF; }';
    document.head.append(style);
    // jsdom drops unicode-range descriptors; browsers expose them on CSSOM.
    const face = style.sheet!.cssRules[0] as CSSFontFaceRule;
    const read = face.style.getPropertyValue.bind(face.style);
    vi.spyOn(face.style, 'getPropertyValue').mockImplementation(name => name === 'unicode-range' ? 'U+0000-00FF' : read(name));
    expect(declaredFontSupports('Declared Test', readingCharacters('Text'))).toBe(true);
    expect(declaredFontSupports('Declared Test', readingCharacters('Text ą'))).toBe(false);
  });
  it('reads actual custom-font coverage and selects one family for the complete text', async () => {
    const bytes = readFileSync('node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2');
    const font: CustomNodeFont = { id: 'custom-font-' + 'a'.repeat(64), name: 'Test', fileName: 'test.woff2', format: 'woff2', data: bytes.toString('base64'), byteLength: bytes.length };
    expect(await resolveReadingFamily(font.id, 'en', 'English text', font)).toBe('Custom Test');
    expect(await resolveReadingFamily(font.id, 'ar', 'نص عربي and Latin', font)).toBe('"Noto Sans Arabic", sans-serif');
    expect(await resolveReadingFamily(font.id, 'ja', '日本語とEnglish', font)).toBe('"Noto Sans JP", sans-serif');
    expect(await resolveReadingFamily(font.id, 'pl', 'Zażółć gęślą jaźń', font)).toBe('"Noto Sans", sans-serif');
  });
  it('uses a script-specific family even in manually pasted, English-labelled text', () => {
    expect(fallbackReadingFamily('en', 'العربية')).toContain('Arabic');
    expect(fallbackReadingFamily('en', '日本語')).toContain('SC');
    expect(fallbackReadingFamily('hi')).toContain('Devanagari');
  });
});
