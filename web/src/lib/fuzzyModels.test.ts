import { describe, it, expect } from 'vitest';
import { fuzzyFilterModels, searchModelChoices } from './fuzzyModels';

const MODELS = [
  'google/gemini-3.5-flash',
  'google/gemini-3.5-pro',
  'openai/gpt-5.1',
  'anthropic/claude-opus-4-8',
  'deepseek/deepseek-v4',
  'meta-llama/llama-4-70b',
];

describe('fuzzyFilterModels', () => {
  it('returns all models unchanged for an empty query', () => {
    expect(fuzzyFilterModels(MODELS, '')).toEqual(MODELS);
    expect(fuzzyFilterModels(MODELS, '   ')).toEqual(MODELS);
  });

  it('finds models by a plain substring', () => {
    const out = fuzzyFilterModels(MODELS, 'flash');
    expect(out).toContain('google/gemini-3.5-flash');
    expect(out).not.toContain('openai/gpt-5.1');
  });

  it('tolerates a typo (fuzzy match)', () => {
    const out = fuzzyFilterModels(MODELS, 'gemni');
    expect(out).toContain('google/gemini-3.5-flash');
    expect(out).toContain('google/gemini-3.5-pro');
  });

  it('matches across the provider/model separator', () => {
    expect(fuzzyFilterModels(MODELS, 'opus')).toContain('anthropic/claude-opus-4-8');
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(fuzzyFilterModels(MODELS, 'zzzzqqq')).toEqual([]);
  });

  it('does not crash on an empty model list', () => {
    expect(fuzzyFilterModels([], 'gpt')).toEqual([]);
  });

  it('requires every structured query token and avoids unrelated long-row matches', () => {
    const rows = [
      { provider: 'OpenRouter', id: 'google/gemini-3.1-pro-preview' },
      { provider: 'OpenRouter', id: 'openai/gpt-5.6-terra' },
      { provider: 'OpenRouter', id: 'anthropic/claude-opus-4.8' },
    ];
    expect(searchModelChoices(rows, 'terra', (row) => row)).toEqual([rows[1]]);
    expect(searchModelChoices(rows, 'openai terra', (row) => row)).toEqual([rows[1]]);
  });

  it('searches provider, display name, and id while retaining typo tolerance', () => {
    const rows = [
      { provider: 'OpenAI', name: 'Terra Coding', id: 'gpt-5.6-terra' },
      { provider: 'OpenRouter', name: 'Gemini Flash', id: 'google/gemini-3.5-flash' },
    ];
    expect(searchModelChoices(rows, 'openai coding', (row) => row)).toEqual([rows[0]]);
    expect(searchModelChoices(rows, 'gemni', (row) => row)).toEqual([rows[1]]);
  });

  it('ranks an exact model id above a longer prefix match', () => {
    const rows = [
      { provider: 'OpenAI', id: 'gpt-5-mini' },
      { provider: 'OpenAI', id: 'gpt-5' },
    ];
    expect(searchModelChoices(rows, 'gpt-5', (row) => row)).toEqual([rows[1], rows[0]]);
  });
});
