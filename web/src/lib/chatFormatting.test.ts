import { afterEach, describe, expect, it } from 'vitest';
import { chatFormattingPrompt } from './chatFormatting';
import { chatSystemPrompt } from './chat/context';
import { buildMessages } from './promptBuilder';
import { diagnosticPlan } from './modelDiagnostics';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { LANGUAGES } from './languages';

afterEach(() => useSettingsStore.setState({ ...DEFAULT_SETTINGS }));

describe('chat instructions in both formatting modes', () => {
  const instructions = 'Use examples: 東京, العربية, हिन्दी, café. Preserve `x_y` and {formatting}.';
  it.each([false, true])('includes instructions exactly once with chunking %s, including custom templates', chunked => {
    for (const detached of [false, true]) for (const placeholder of [false, true]) {
      const template = `FORMAT${placeholder ? '\n{normalInstructions}' : ''}`;
      const result = chatFormattingPrompt(chunked, `  ${instructions}  `,
        { chatNormal: template, chatChunking: template, answerNormal: template }, detached);
      expect(result.split(instructions)).toHaveLength(2);
      expect(result).not.toContain('{normalInstructions}');
      expect(chatFormattingPrompt(chunked, '   ')).not.toContain('{normalInstructions}');
    }
  });
  it.each(LANGUAGES.map(language => language.id))('keeps instructions in %s chat, answer rewrites and capability checks', generationLanguage => {
    useSettingsStore.setState({ ...DEFAULT_SETTINGS, generationLanguage, normalChatInstructions: instructions,
      providers: [{ id: 'fixture', preset: 'custom', apiKey: '', baseUrl: 'http://localhost:1234/v1', enabledModels: ['test'] }],
      activeModelRef: { providerId: 'fixture', model: 'test' } });
    const plan = diagnosticPlan(useSettingsStore.getState(), 'main');
    for (const informationChunking of [false, true]) {
      expect(chatSystemPrompt(informationChunking, instructions, false).split(instructions)).toHaveLength(2);
      for (const variant of [
        { kind: 'answer' as const, instruction: 'Rewrite', previousBody: 'Text', informationChunking },
        { kind: 'modify-selection' as const, mode: 'answer' as const, instruction: 'Rewrite', markedBody: 'Text', selectedText: 'Text', informationChunking },
      ]) expect(buildMessages({ variant, context: { parent: null, grandparent: null } })[0]!.content.split(instructions)).toHaveLength(2);
      expect(plan.find(job => job.test.id === `chat-${informationChunking}`)?.test.messages[0]?.content).toContain(instructions);
    }
  });
});
