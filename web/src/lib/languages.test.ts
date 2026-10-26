import { describe, expect, it, beforeEach, vi } from 'vitest';
import { LANGUAGES, languageDirection, languageInfo, normalizeLanguage, versionLanguage } from './languages';
import { generationLanguagePrompt } from './generationLanguage';
import { splitSentences } from './bulletParse';
import { buildClusters, trimToWord } from './readingClusters';
import { previewRequest, termPreviewFingerprint, reusableTermPreviews } from './termPreviewCore';
import { stringHash } from './stringHash';
import { DEFAULT_SETTINGS, type NodeVersion } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { modelDiagnosticCases } from './modelDiagnosticsCases';
import { tokenizeOverviewText } from './overviewHeader';
import { applyTermSelection } from './termMarking';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => {}), loadSettings: vi.fn() }));
beforeEach(() => useSettingsStore.setState({ ...DEFAULT_SETTINGS }));

describe('generation languages', () => {
  it('has twenty stable language IDs and treats all legacy content as English', () => {
    expect(LANGUAGES).toHaveLength(20);
    expect(new Set(LANGUAGES.map(l => l.id)).size).toBe(20);
    expect(versionLanguage({})).toBe('en');
    expect(normalizeLanguage('invalid')).toBe('en');
    expect(languageDirection('ar')).toBe('rtl');
    expect(languageInfo('pt').locale).toBe('pt-BR');
    expect(languageInfo('zh').locale).toBe('zh-CN');
  });
  it.each(LANGUAGES)('splits sentences and produces a nonempty reading sequence in $name', language => {
    const text = language.sample + ' ' + language.sample;
    expect(splitSentences(text)).toEqual([language.sample, language.sample]);
    expect(splitSentences(`**${language.sample}** ⟦1⟧ ${language.sample}`)).toEqual([
      `**${language.sample}** ⟦1⟧`, language.sample,
    ]);
    const clusters = buildClusters(text, [{ start: 0, end: text.length, kind: 'text' }], language.id);
    expect(clusters.length).toBeGreaterThan(2);
    expect(clusters.every(c => c.end > c.start && c.end <= text.length)).toBe(true);
    const prompt = generationLanguagePrompt(language.id);
    expect(prompt).toContain(`${language.name} (${language.locale})`);
    expect(prompt).toContain('Do not translate JSON keys');
    const check = modelDiagnosticCases({ ...DEFAULT_SETTINGS, generationLanguage: language.id }).find(c => c.id === 'generation-language')!;
    expect(check.requests).toBe(1);
    expect(check.messages[0]?.content).toContain(language.name);
  });
  it('handles sentence endings without spaces and Arabic/Hindi punctuation', () => {
    expect(splitSentences('最初の文。次の文！')).toEqual(['最初の文。', '次の文！']);
    expect(splitSentences('هل هذا واضح؟ نعم، هذا واضح.')).toHaveLength(2);
    expect(splitSentences('यह स्पष्ट है। अगला वाक्य।')).toHaveLength(2);
  });
  it('does not apply English articles to Polish or split combining marks and surrogate pairs', () => {
    const text = 'a kot';
    const segments = [{ start: 0, end: text.length, kind: 'text' as const }];
    expect(buildClusters(text, segments, 'pl')).toHaveLength(2);
    expect(buildClusters(text, segments, 'en')).toHaveLength(1);
    expect(trimToWord('(𠮷)', 0, 4)).toEqual({ start: 1, end: 3 });
    expect(trimToWord('पानी।', 0, 5)).toEqual({ start: 0, end: 4 });
  });
  it('keeps legacy preview fingerprints and separates languages', () => {
    const v: NodeVersion = { header: 'Topic', body: 'A [[term]].', generatedBy: 'root', contentType: 'encyclopedic', createdAt: 1 };
    const old = JSON.stringify([v.header, v.body, v.contentType, v.generatedBy]);
    const fingerprint = `${old.length}:${stringHash(old)}`;
    expect(termPreviewFingerprint(v)).toBe(fingerprint);
    expect(termPreviewFingerprint({ ...v, language: 'en' })).toBe(fingerprint);
    expect(termPreviewFingerprint({ ...v, language: 'pl' })).not.toBe(fingerprint);
    expect(reusableTermPreviews({ ...v, language: 'pl' }, [{ ...v, termPreviews: { fingerprint, entries: { term: 'English preview.' } } }])).toBeUndefined();
    useSettingsStore.setState({ generationLanguage: 'ar' });
    expect(previewRequest({ ...v, language: 'pl' }, ['term']).system).toContain('Polish (pl-PL)');
  });
  it('does not break script shaping in overview titles or mark inside a Hindi word', () => {
    for (const text of ['العربية', '日本語', 'स्पष्ट', '한국어']) {
      expect(tokenizeOverviewText(text).map(part => part.text).join('')).toBe(text);
    }
    expect(applyTermSelection('यह जलप्रवाह है।', '{"terms":["जल"]}')).toBe('यह जलप्रवाह है।');
    expect(applyTermSelection('水の循環です。', '{"terms":["循環"]}')).toBe('水の[[循環]]です。');
  });
});
