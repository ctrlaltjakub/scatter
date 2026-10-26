import { configuredPrompt } from './configuredPrompt';
import { languageInfo, type GenerationLanguage } from './languages';

/** Use the captured version language, never a live preference during a request. */
export function generationLanguagePrompt(language?: GenerationLanguage): string {
  const info = languageInfo(language);
  return configuredPrompt('generationLanguage', { language: info.name, locale: info.locale,
    direction: info.id === 'ar' ? 'right-to-left' : 'left-to-right' });
}
