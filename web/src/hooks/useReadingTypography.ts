'use client';
import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '@/store/useSettingsStore';
import { fallbackReadingFamily, readingCharacters, readingFontStyle, resolveReadingFamily } from '@/lib/readingFonts';
import { languageInfo, normalizeLanguage, type GenerationLanguage } from '@/lib/languages';
import { fontFamilyFor } from '@/lib/imageEditFonts';

/** One family for an entire version/answer, never a per-letter replacement. */
export function useReadingTypography(language: GenerationLanguage | undefined, text: string) {
  const id = useSettingsStore(state => state.nodeFontId);
  const custom = useSettingsStore(state => state.customNodeFonts.find(font => font.id === id));
  const normalized = normalizeLanguage(language);
  const characters = useMemo(() => readingCharacters(languageInfo(normalized).sample + text).sort((a,b) => a-b).map(code => String.fromCodePoint(code)).join(''), [text, normalized]);
  const key = `${id}:${normalized}:${characters}`;
  const [resolved, setResolved] = useState<{ key: string; family: string }>();
  useEffect(() => {
    let cancelled = false;
    void resolveReadingFamily(id, normalized, characters, custom).then(family => {
      if (!cancelled) setResolved({ key, family });
    });
    return () => { cancelled = true; };
  }, [id, normalized, characters, custom, key]);
  const family = resolved?.key === key ? resolved.family
    : languageInfo(normalized).script === 'latin' && id === 'app' ? fontFamilyFor(id) : fallbackReadingFamily(normalized, text);
  return readingFontStyle(family, normalized);
}
