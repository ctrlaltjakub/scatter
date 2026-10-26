/** Stable generation-language IDs. Missing metadata in older projects means English. */
export const LANGUAGES = [
  { id: 'en', code: 'EN', name: 'English', native: 'English', locale: 'en-US', script: 'latin', sample: 'Clear explanations make complex ideas easier to understand.' },
  { id: 'zh', code: 'ZH', name: 'Chinese (Simplified)', native: '简体中文', locale: 'zh-CN', script: 'chinese', sample: '清晰的解释让复杂的概念更容易理解。' },
  { id: 'es', code: 'ES', name: 'Spanish', native: 'Español', locale: 'es-419', script: 'latin', sample: 'Las explicaciones claras facilitan la comprensión de ideas complejas.' },
  { id: 'fr', code: 'FR', name: 'French', native: 'Français', locale: 'fr-FR', script: 'latin', sample: 'Les explications claires facilitent la compréhension des idées complexes.' },
  { id: 'de', code: 'DE', name: 'German', native: 'Deutsch', locale: 'de-DE', script: 'latin', sample: 'Klare Erklärungen machen komplexe Zusammenhänge verständlicher.' },
  { id: 'pt', code: 'PT', name: 'Portuguese (Brazil)', native: 'Português brasileiro', locale: 'pt-BR', script: 'latin', sample: 'Explicações claras facilitam a compreensão de ideias complexas.' },
  { id: 'it', code: 'IT', name: 'Italian', native: 'Italiano', locale: 'it-IT', script: 'latin', sample: 'Le spiegazioni chiare rendono più comprensibili le idee complesse.' },
  { id: 'ja', code: 'JA', name: 'Japanese', native: '日本語', locale: 'ja-JP', script: 'japanese', sample: '明確な説明は複雑な考えを理解しやすくします。' },
  { id: 'ru', code: 'RU', name: 'Russian', native: 'Русский', locale: 'ru-RU', script: 'cyrillic', sample: 'Ясные объяснения помогают понять сложные идеи.' },
  { id: 'ko', code: 'KO', name: 'Korean', native: '한국어', locale: 'ko-KR', script: 'korean', sample: '명확한 설명은 복잡한 개념을 이해하는 데 도움이 됩니다.' },
  { id: 'nl', code: 'NL', name: 'Dutch', native: 'Nederlands', locale: 'nl-NL', script: 'latin', sample: 'Duidelijke uitleg maakt ingewikkelde ideeën begrijpelijker.' },
  { id: 'pl', code: 'PL', name: 'Polish', native: 'Polski', locale: 'pl-PL', script: 'latin', sample: 'Jasne wyjaśnienia pomagają zrozumieć złożone zagadnienia.' },
  { id: 'id', code: 'ID', name: 'Indonesian', native: 'Bahasa Indonesia', locale: 'id-ID', script: 'latin', sample: 'Penjelasan yang jelas membantu memahami gagasan yang rumit.' },
  { id: 'sv', code: 'SV', name: 'Swedish', native: 'Svenska', locale: 'sv-SE', script: 'latin', sample: 'Tydliga förklaringar gör komplexa idéer lättare att förstå.' },
  { id: 'ar', code: 'AR', name: 'Arabic (Modern Standard)', native: 'العربية الفصحى', locale: 'ar', script: 'arabic', sample: 'تساعد التفسيرات الواضحة على فهم الأفكار المعقدة.' },
  { id: 'hi', code: 'HI', name: 'Hindi', native: 'हिन्दी', locale: 'hi-IN', script: 'devanagari', sample: 'स्पष्ट व्याख्याएँ जटिल विचारों को समझने में मदद करती हैं।' },
  { id: 'tr', code: 'TR', name: 'Turkish', native: 'Türkçe', locale: 'tr-TR', script: 'latin', sample: 'Açık açıklamalar karmaşık fikirleri anlamayı kolaylaştırır.' },
  { id: 'vi', code: 'VI', name: 'Vietnamese', native: 'Tiếng Việt', locale: 'vi-VN', script: 'latin', sample: 'Những lời giải thích rõ ràng giúp hiểu các ý tưởng phức tạp.' },
  { id: 'cs', code: 'CS', name: 'Czech', native: 'Čeština', locale: 'cs-CZ', script: 'latin', sample: 'Jasná vysvětlení usnadňují porozumění složitým myšlenkám.' },
  { id: 'uk', code: 'UK', name: 'Ukrainian', native: 'Українська', locale: 'uk-UA', script: 'cyrillic', sample: 'Зрозумілі пояснення допомагають осягнути складні ідеї.' },
] as const;

export type GenerationLanguage = typeof LANGUAGES[number]['id'];
export type WritingScript = typeof LANGUAGES[number]['script'];
export function normalizeLanguage(value: unknown): GenerationLanguage {
  return LANGUAGES.some(language => language.id === value) ? value as GenerationLanguage : 'en';
}
export const languageInfo = (value?: unknown) => LANGUAGES.find(language => language.id === normalizeLanguage(value))!;
/** Compact footer label; the picker retains the exact regional/script variant. */
export const languageLabel = (value?: unknown) => languageInfo(value).name.replace(/\s+\(.+\)$/, '');
export const languageDirection = (value?: unknown) => normalizeLanguage(value) === 'ar' ? 'rtl' as const : 'ltr' as const;

/** Keep foreign quotations/code intact; language identifies the surrounding explanation. */
export const versionLanguage = (version?: { language?: GenerationLanguage } | null) => normalizeLanguage(version?.language);

// Articles are grouped only where standalone forms are unambiguous enough for
// a reading aid. Do not apply English's "a" rule to Polish/Czech/Portuguese.
export const READING_ARTICLES: Partial<Record<GenerationLanguage, ReadonlySet<string>>> = {
  en: new Set(['a', 'an', 'the']), de: new Set(['der', 'die', 'das', 'dem', 'den', 'des', 'ein', 'eine', 'einer', 'einem', 'einen', 'eines']),
  fr: new Set(['le', 'la', 'les', 'un', 'une', 'des']), es: new Set(['el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas']),
  it: new Set(['il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una']), nl: new Set(['de', 'het', 'een']),
};
