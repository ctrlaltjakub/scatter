import { describe, expect, it } from 'vitest';
import { effectiveReasoningEffort, reasoningLevels } from './modelReasoning';
import { parseCompatModel } from '@/providers/openai';
import { parseAnthropicModel } from '@/providers/anthropic';
import { modelDisplayName } from './modelDisplay';

describe('model-specific reasoning', () => {
  it('does not offer unsupported Off reasoning for GPT-6.1 Sol', () => {
    expect(reasoningLevels('openai', 'gpt-6.1-sol')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effectiveReasoningEffort('openai', 'gpt-6.1-sol', 'off')).toBe('low');
  });
  it('reads reported levels in order and respects mandatory reasoning', () => {
    const info = parseCompatModel({ id: 'test', reasoning: { supported_efforts: ['high', 'low', 'none', 'unknown'], mandatory: true } });
    expect(reasoningLevels('openrouter', 'test', info)).toEqual(['low', 'high']);
    expect(effectiveReasoningEffort('openrouter', 'test', 'medium', info)).toBe('low');
    expect(effectiveReasoningEffort('openrouter', 'test', 'max', info)).toBe('high');
  });
  it('distinguishes unrestricted efforts from an omitted selector and non-reasoning models', () => {
    expect(reasoningLevels('openrouter', 'test', parseCompatModel({ id: 'test', reasoning: { supported_efforts: null } }))).toContain('max');
    expect(reasoningLevels('openrouter', 'test', parseCompatModel({ id: 'test', reasoning: { supports_max_tokens: true } }))).toEqual([]);
    expect(reasoningLevels('openai', 'gpt-4.1')).toEqual([]);
    expect(reasoningLevels('openrouter', 'unknown')).toEqual([]);
    expect(reasoningLevels('openai', 'gpt-5-pro')).toEqual(['high']);
  });
  it('reads Anthropic capabilities and token limits', () => {
    const info = parseAnthropicModel({ id: 'claude-example', max_input_tokens: 200000, capabilities: {
      thinking: { supported: true, types: { adaptive: { supported: true } } },
      effort: { supported: true, low: { supported: true }, high: { supported: true }, max: { supported: false } },
      image_input: { supported: true },
    } });
    expect(info.contextLength).toBe(200000);
    expect(info.reasoning?.mode).toBe('adaptive');
    expect(reasoningLevels('anthropic', info.id, info)).toEqual(['low', 'high']);
  });
  it('cleans display names without losing decimal versions', () => {
    expect(modelDisplayName('google/gemini-3.8-flash')).toBe('gemini 3.8 flash');
    expect(modelDisplayName('gpt-5.6-luna')).toBe('gpt 5.6 luna');
    expect(modelDisplayName('claude-sonnet-4-6')).toBe('claude sonnet 4.6');
    expect(modelDisplayName('anthropic/claude-3-5-haiku')).toBe('claude 3.5 haiku');
  });
});
