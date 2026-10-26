import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROMPT_CATALOG, PROMPT_KEYS, PROMPT_GROUP_ORDER } from './promptCatalog';
import { DEFAULT_PROMPTS, effectivePrompt, substitute } from './promptDefaults';
import { configuredPrompt } from './configuredPrompt';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS, type NodeVersion } from '@/store/types';
import { chatSystemPrompt } from './chat/context';
import { buildMessages } from './promptBuilder';
import { termSelectionPrompt } from './termSelectionPrompt';
import { previewRequest } from './termPreviewCore';
import { formatSourceEvidenceBlock } from './sourceRetrieval';
import { selectedImageEditPrompt } from './imageRegionInput';
import { buildSelectedTextImagePrompt } from './imageGeneration';

vi.mock('@/opfs/settingsIO', () => ({ saveSettings: vi.fn(async () => undefined), loadSettings: vi.fn() }));
const context = { parent: null, grandparent: null };
beforeEach(() => useSettingsStore.setState({ ...DEFAULT_SETTINGS, customPrompts: undefined }));

describe('prompt catalog and request wiring', () => {
  it.each(['nodeWebSearch', 'chatWebSearch'] as const)('specifies Markdown citations instead of cite tags for %s', (key) => {
    expect(configuredPrompt(key)).toContain('[source](https://exact-returned-url)');
    expect(configuredPrompt(key)).toContain('Do not wrap citations in HTML/XML tags');
    expect(configuredPrompt(key)).toContain('including escaped tags');
  });
  it('provides unique labels, descriptions, help and defaults for every key', () => {
    expect(PROMPT_KEYS.length).toBeGreaterThan(70);
    expect(new Set(PROMPT_KEYS.map(key => PROMPT_CATALOG[key].label)).size).toBe(PROMPT_KEYS.length);
    for (const key of PROMPT_KEYS) {
      const entry = PROMPT_CATALOG[key];
      expect(entry.description.trim()).not.toBe('');
      expect(entry.help.trim()).not.toBe('');
      expect(`${entry.label} ${entry.description} ${entry.help}`).not.toMatch(/\bScatter\b/);
      expect(PROMPT_GROUP_ORDER).toContain(entry.group);
      expect(DEFAULT_PROMPTS[key]).toBe(entry.text);
      expect(effectivePrompt(key, undefined)).toBe(entry.text);
      useSettingsStore.getState().setCustomPromptField(key, `custom:${key}`);
      expect(configuredPrompt(key)).toBe(`custom:${key}`);
      useSettingsStore.getState().resetCustomPromptField(key);
      expect(configuredPrompt(key)).toBe(entry.text);
    }
  });

  it('resolves overrides at request time, preserves empty overrides and never reprocesses inserted data', () => {
    useSettingsStore.setState({ customPrompts: { taskRoot: 'Topic: {topic} {unknown} {toString}', chatWebSearch: '' } });
    expect(configuredPrompt('taskRoot', { topic: '$& {unknown} {topic}' })).toBe('Topic: $& {unknown} {topic} {unknown} {toString}');
    expect(configuredPrompt('chatWebSearch')).toBe('');
    useSettingsStore.setState({ customPrompts: { taskRoot: 'Changed: {topic}' } });
    expect(configuredPrompt('taskRoot', { topic: 'biology' })).toBe('Changed: biology');
    expect(substitute('{constructor}', {})).toBe('{constructor}');
  });

  it('honors chat base, normal, chunking, search and detached-answer overrides independently', () => {
    const custom = { chatBase: 'CHAT', chatNormal: 'NORMAL {normalInstructions}', chatChunking: 'CHUNKED', chatWebSearch: 'SEARCH',
      answerBase: 'ANSWER {formatting}', answerNormal: 'PLAIN {normalInstructions}', taskAnswer: '{previousAnswer}TASK {instruction}', taskAnswerPrevious: 'OLD {previousBody}; ' };
    useSettingsStore.setState({ customPrompts: custom, normalChatInstructions: 'PREFERENCE' });
    expect(chatSystemPrompt(false, 'PREFERENCE', true)).toBe('CHAT\n\nNORMAL PREFERENCE\n\nSEARCH');
    expect(chatSystemPrompt(true, 'PREFERENCE', false)).toBe('CHAT\n\nCHUNKED');
    expect(buildMessages({ context, variant: { kind: 'answer', previousBody: 'text', instruction: 'change', informationChunking: false } }))
      .toEqual([{ role: 'system', content: 'ANSWER PLAIN PREFERENCE' }, { role: 'user', content: 'OLD text; TASK change' }]);
  });

  it('uses the preview and shared term-marking contracts for actual request building', () => {
    const custom = { termPreviewSystem: 'PREVIEWS', termPreviewReminder: 'PREVIEW FORMAT', chipBase: 'TERMS', taskAddChips: 'RULES {plainBody}', termSelectionContract: 'JSON CONTRACT' };
    useSettingsStore.setState({ customPrompts: custom });
    const version = { header: 'Topic', body: 'A [[term]].', contentType: 'explain', generatedBy: 'explain' } as NodeVersion;
    const request = previewRequest(version, ['term']);
    expect(request.system).toMatch(/^PREVIEWS\n\n/);
    expect(request.system).toContain('English (en-US)');
    expect(JSON.parse(request.user)).toMatchObject({ responseReminder: 'PREVIEW FORMAT', terms: [{ id: 0, term: 'term' }] });
    expect(termSelectionPrompt('Unchanged **text**.', custom)).toEqual({ system: 'TERMS\n\nRULES \n\nJSON CONTRACT', user: 'Unchanged **text**.' });
  });

  it('applies editable source policies and interactive/selection contracts', () => {
    const custom = { sourcePolicyOnly: 'ONLY', sourcePolicyUse: 'USE', sourceEvidence: 'EVIDENCE {policy}: {passages}',
      interactiveNodeBase: 'HTML', interactiveNodeTask: '{request}',
      multiSelectionContract: 'PARTS {partCount}', taskModifySelection: 'MODIFY {selectedText}', evidenceRewriteContract: 'EVIDENCE CONTRACT', taskRewriteWithEvidence: '{previousBody}' };
    useSettingsStore.setState({ customPrompts: custom });
    expect(formatSourceEvidenceBlock('only', [])).toBe('EVIDENCE ONLY: ');
    expect(formatSourceEvidenceBlock('use', [])).toBe('EVIDENCE USE: ');
    expect(configuredPrompt('interactiveNodeTask', { request: 'Simulate' })).toBe('Simulate');
    expect(buildMessages({ context, variant: { kind: 'modify-selection', instruction: '', markedBody: '', selectedText: 'pieces', mode: 'explain', partCount: 3 } })[1]?.content).toBe('MODIFY pieces\n\nPARTS 3');
    expect(buildMessages({ context, variant: { kind: 'fact-rewrite', previousBody: 'checked', evidenceReport: '', sourceCatalog: '' } })[1]?.content).toBe('checked\n\nEVIDENCE CONTRACT');
  });

  it('uses edited image templates while retaining model-specific reference ordering and prompt budgets', () => {
    useSettingsStore.setState({ customPrompts: { imageEditWhole: 'WHOLE {instruction}', imageEditSelection: 'EDIT {instruction}; {maskGuide}{cropGuide}{regions}', imageEditMaskGuide: 'MASK; ', imageEditCropGuide: 'CROP {cropNumber}; ', imageFromTextPrefix: 'DRAW\n', imageFromTextSuffix: '\nACCURATE' } });
    const regions = [{ x: 0, y: 0, width: .5, height: .5 }];
    expect(selectedImageEditPrompt('blue', [])).toBe('WHOLE blue');
    expect(selectedImageEditPrompt('blue', regions)).toContain('EDIT blue; MASK; CROP THIRD;');
    expect(selectedImageEditPrompt('blue', regions, 'crop')).toContain('EDIT blue; CROP SECOND;');
    expect(selectedImageEditPrompt('blue', regions, 'coordinates')).not.toMatch(/MASK|CROP/);
    const input = { selectedText: 'cells', sourceTitle: 'Biology', sourceBody: 'context '.repeat(200), maxChars: 150 };
    const prompt = buildSelectedTextImagePrompt(input);
    expect(prompt).toMatch(/^DRAW\n/); expect(prompt).toMatch(/\nACCURATE$/); expect(prompt.length).toBeLessThanOrEqual(150);
  });
});
