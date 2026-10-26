import { describe, expect, test } from 'vitest';
import { modelSupportsWebSearch, webSearchUnavailableHint, isKnownPreset, getAdapter, getImageAdapter } from './registry';
import { isProviderEnabled } from './providerPolicy';

describe('modelSupportsWebSearch', () => {
  test('disables direct Gemini without deleting its stored preset or affecting OpenRouter', async () => {
    expect(isKnownPreset('gemini')).toBe(true);
    expect(isProviderEnabled('gemini')).toBe(false);
    expect(modelSupportsWebSearch('gemini', 'gemini-test', undefined, undefined, undefined, true)).toBe(false);
    expect(await getAdapter('gemini').listModels('test')).toEqual([]);
    expect(getImageAdapter('gemini')).toBeUndefined();
    await expect(getAdapter('gemini').streamChat('test', { model: 'gemini-test', messages: [], maxOutputTokens: 100 })[Symbol.asyncIterator]().next()).rejects.toThrow('disabled');
    expect(modelSupportsWebSearch('openrouter', 'google/gemini-test')).toBe(true);
  });
  test('openai: current Responses web-search model families', () => {
    expect(modelSupportsWebSearch('openai', 'gpt-4o')).toBe(false);
    expect(modelSupportsWebSearch('openai', 'gpt-5-search-api')).toBe(true);
    expect(modelSupportsWebSearch('openai', 'gpt-4.1-mini')).toBe(true);
    expect(modelSupportsWebSearch('openai', 'gpt-5.5')).toBe(true);
    expect(modelSupportsWebSearch('openai', 'o3')).toBe(true);
    expect(modelSupportsWebSearch('openai', 'o4-mini')).toBe(true);
    expect(modelSupportsWebSearch('openai', undefined)).toBe(false);
  });
  test('anthropic + openrouter: any model', () => {
    expect(modelSupportsWebSearch('anthropic', 'claude-x')).toBe(true);
    expect(modelSupportsWebSearch('openrouter', 'anything')).toBe(true);
  });
  test('local/compatible presets: require a search connection and confirmed tool calling', () => {
    expect(modelSupportsWebSearch('ollama', 'llama3')).toBe(false);
    expect(modelSupportsWebSearch('lm-studio', 'anything')).toBe(false);
    expect(modelSupportsWebSearch('custom', 'anything')).toBe(false);
    for (const preset of ['ollama', 'lm-studio', 'custom'] as const) {
      expect(modelSupportsWebSearch(preset, 'local-model', { id: 'local-model', caps: { tools: true } }, 'https://search.test')).toBe(true);
      expect(modelSupportsWebSearch(preset, 'local-model', { id: 'local-model' }, 'https://search.test')).toBe(false);
      expect(modelSupportsWebSearch(preset, 'local-model', { id: 'local-model', caps: { tools: true } }, 'not-a-url')).toBe(false);
    }
  });
});

describe('webSearchUnavailableHint', () => {
  test('gives a model-switch hint for openai and a search-connection hint for local models', () => {
    expect(webSearchUnavailableHint('openai')).toMatch(/search/i);
    expect(webSearchUnavailableHint('ollama')).toMatch(/SearXNG/);
    expect(webSearchUnavailableHint('custom')).toMatch(/SearXNG/);
  });
});

describe('isKnownPreset', () => {
  test('accepts shipped presets, rejects dropped/unknown ones', () => {
    expect(isKnownPreset('openrouter')).toBe(true);
    expect(isKnownPreset('ollama')).toBe(true);
    expect(isKnownPreset('gemini')).toBe(true);
    expect(isKnownPreset('deepseek')).toBe(false);
    expect(isKnownPreset('nonsense')).toBe(false);
  });
});
