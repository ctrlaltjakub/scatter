import { Buffer } from 'buffer';
import { fontFamilyFor, ensureReadingFontLoaded, APP_FONT_EX_HEIGHT_RATIO } from './imageEditFonts';
import { isCustomFontId, type CustomNodeFont } from './customNodeFonts';
import { languageInfo, type GenerationLanguage } from './languages';
import type { CSSProperties } from 'react';

export const LANGUAGE_FONTS = {
  latin: 'Noto Sans', cyrillic: 'Noto Sans', chinese: 'Noto Sans SC', japanese: 'Noto Sans JP',
  korean: 'Noto Sans KR', arabic: 'Noto Sans Arabic', devanagari: 'Noto Sans Devanagari',
} as const;
const coverage = new Map<string, Promise<ReadonlySet<number>>>();
const declaredRanges = new Map<string, string[]>();

/** Decode once, only when a custom font is selected. Never upload font bytes. */
function customCoverage(font: CustomNodeFont): Promise<ReadonlySet<number>> {
  let pending = coverage.get(font.id);
  if (!pending) {
    pending = import('fontkit').then(({ create }) => {
      const parsed = create(Buffer.from(font.data, 'base64'));
      return new Set('characterSet' in parsed ? parsed.characterSet : []);
    });
    coverage.set(font.id, pending);
    pending.catch(() => coverage.delete(font.id));
  }
  return pending;
}

export function readingCharacters(text: string): number[] {
  return [...new Set([...text.normalize('NFC')].filter(char => /[\p{L}\p{N}\p{M}]/u.test(char)).map(char => char.codePointAt(0)!))];
}

function rangesContain(ranges: string, code: number): boolean {
  return ranges.split(',').some(range => {
    const parts = range.trim().replace(/^U\+/i, '').split('-');
    const start = Number.parseInt(parts[0]!.replace(/\?/g, '0'), 16);
    const end = Number.parseInt((parts[1] ?? parts[0]!).replace(/\?/g, 'f'), 16);
    return code >= start && code <= end;
  });
}

/** Bundled fonts declare their script coverage in their @font-face subsets.
 * Unknown OS fonts are trusted for basic Latin only; other scripts receive the
 * same bundled, predictable fallback on Linux, Windows and macOS. */
export function declaredFontSupports(family: string, characters: readonly number[]): boolean {
  if (typeof document === 'undefined') return false;
  const primary = family.split(',')[0]!.trim().replace(/^["']|["']$/g, '');
  const cached = declaredRanges.get(primary);
  if (cached) return characters.every(code => cached.some(range => rangesContain(range, code)));
  const ranges: string[] = [];
  const collect = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      if (rule.type === 5) {
        const style = (rule as CSSFontFaceRule).style;
        if (style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '') === primary) {
          ranges.push(style.getPropertyValue('unicode-range') || 'U+0-10FFFF');
        }
      } else if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules);
    }
  };
  for (const sheet of Array.from(document.styleSheets)) {
    try { collect(sheet.cssRules); } catch { /* Cross-origin CSS is not readable. */ }
  }
  if (ranges.length) declaredRanges.set(primary, ranges);
  return ranges.length ? characters.every(code => ranges.some(range => rangesContain(range, code)))
    : characters.every(code => code <= 0x024f);
}

export function fallbackReadingFamily(language?: GenerationLanguage, text = ''): string {
  let script = languageInfo(language).script;
  // A manually written/legacy English-labelled node may contain another script.
  // Choose one face for that whole block too, rather than leaving those glyphs
  // to a per-character system fallback.
  if (script === 'latin' || script === 'cyrillic') {
    if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text)) script = 'japanese';
    else if (/\p{Script=Hangul}/u.test(text)) script = 'korean';
    else if (/\p{Script=Han}/u.test(text)) script = 'chinese';
    else if (/\p{Script=Arabic}/u.test(text)) script = 'arabic';
    else if (/\p{Script=Devanagari}/u.test(text)) script = 'devanagari';
  }
  return `"${LANGUAGE_FONTS[script]}", sans-serif`;
}

export function readingFontStyle(family: string, language?: GenerationLanguage): CSSProperties {
  const latinMetrics = ['latin', 'cyrillic'].includes(languageInfo(language).script)
    && !/Noto Sans (?:SC|JP|KR|Arabic|Devanagari)/.test(family);
  return { '--sc-node-font-family': family,
    '--sc-node-font-size-adjust': latinMetrics ? String(APP_FONT_EX_HEIGHT_RATIO) : 'none',
    fontFamily: family, fontSizeAdjust: latinMetrics ? String(APP_FONT_EX_HEIGHT_RATIO) : 'none',
  } as CSSProperties;
}

export async function resolveReadingFamily(id: string, language: GenerationLanguage, text: string, custom?: CustomNodeFont): Promise<string> {
  await ensureReadingFontLoaded(id);
  const family = fontFamilyFor(id);
  const chars = readingCharacters(languageInfo(language).sample + text);
  const supported = isCustomFontId(id)
    ? !!custom && await customCoverage(custom).then(set => chars.every(code => set.has(code))).catch(() => false)
    : declaredFontSupports(family, chars);
  const result = supported ? family : fallbackReadingFamily(language, text);
  if (typeof document !== 'undefined' && document.fonts?.load) {
    await Promise.all([document.fonts.load(`400 14px ${result}`, text || languageInfo(language).sample),
      document.fonts.load(`700 14px ${result}`, text || languageInfo(language).sample)]).catch(() => {});
  }
  return result;
}
