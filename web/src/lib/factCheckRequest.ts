import type { FactCheckUnit, NodeVersion, Settings } from '@/store/types';
import type { ChatMessage } from './promptBuilder';
import { effectivePrompt, substitute } from './promptDefaults';
import { languageInfo, versionLanguage } from './languages';

/** One bounded server search, shared by production and explicit diagnostics. */
export const FACT_CHECK_SEARCH_POLICY = { required: true, toolChoice: 'auto', maxToolCalls: 1,
  maxResults: 5, maxTotalResults: 10, maxCharacters: 5000 } as const;

export function factCheckMessages(version: NodeVersion, unit: FactCheckUnit, custom: Settings['customPrompts']): ChatMessage[] {
  const clean = version.body.replace(/\[\[|\]\]/g, '').replace(/\*\*/g, '').replace(/⟦\d+⟧/g, '').trim();
  const user = substitute(effectivePrompt('taskFactCheckUnit', custom), {
    nodeHeader: version.chat?.question ?? version.header,
    nodeBody: version.chat ? `Paired user question: ${version.chat.question}\n\nSelected assistant answer:\n${clean}` : clean,
    sectionTitle: unit.sectionTitle ?? 'Opening prose', unitId: unit.id, unitText: unit.text,
  });
  const contract = substitute(effectivePrompt('factCheckContract', custom), { unitId: unit.id });
  const language = languageInfo(versionLanguage(version));
  const languagePrompt = substitute(effectivePrompt('generationLanguage', custom), {
    language: language.name, locale: language.locale, direction: language.id === 'ar' ? 'right-to-left' : 'left-to-right',
  });
  return [{ role: 'system', content: contract + '\n\n' + languagePrompt }, { role: 'user', content: `${user}\n\n${contract}` }];
}
