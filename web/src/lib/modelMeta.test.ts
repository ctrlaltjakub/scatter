import { describe, expect, test } from 'vitest';
import {
  inferModelCaps,
  resolveCaps,
  modelSupportsReasoning,
  modelSupportsTextOutput,
  modelSupportsVision,
  formatContext,
  formatPricePerM,
  modelPricingForRouting,
  selectTextEndpointForRouting,
  mainModelCompatible,
  secondaryModelCompatible,
} from './modelMeta';
import type { TextModelEndpoint } from '@/providers/types';
import { parseCompatModel } from '@/providers/openai';

describe('inferModelCaps', () => {
  test('requires confirmed vision and a supported search connection for main and secondary models', () => {
    const caps = { vision: true, tools: true, textOutput: true };
    for (const compatible of [mainModelCompatible, secondaryModelCompatible]) {
      expect(compatible('openrouter', 'vendor/model', { id: 'vendor/model', caps })).toBe(true);
      expect(compatible('custom', 'vendor/model', { id: 'vendor/model', caps })).toBe(false);
      expect(compatible('openai', 'gpt-4o')).toBe(false);
      expect(compatible('openai', 'gpt-5.6-luna')).toBe(true);
      expect(compatible('openrouter', 'unknown')).toBe(false);
      expect(compatible('openrouter', 'text-only', { id: 'text-only', caps: { ...caps, vision: false } })).toBe(false);
    }
  });
  test('openai: o-series and gpt-5+ reason, 4o does not', () => {
    expect(inferModelCaps('openai', 'o3').reasoning).toBe(true);
    expect(inferModelCaps('openai', 'o4-mini').reasoning).toBe(true);
    expect(inferModelCaps('openai', 'gpt-5.1').reasoning).toBe(true);
    expect(inferModelCaps('openai', 'gpt-4o').reasoning).toBe(false);
    expect(inferModelCaps('openai', 'gpt-4o').vision).toBe(true);
  });
  test('anthropic: 3.7 and 4.x sonnet/opus reason', () => {
    expect(inferModelCaps('anthropic', 'claude-opus-4-8').reasoning).toBe(true);
    expect(inferModelCaps('anthropic', 'claude-3-7-sonnet').reasoning).toBe(true);
    expect(inferModelCaps('anthropic', 'claude-3-5-haiku').reasoning).toBe(false);
    expect(inferModelCaps('anthropic', 'claude-3-5-haiku').vision).toBe(true);
  });
  test('openrouter/local: no inference', () => {
    expect(inferModelCaps('openrouter', 'anything').reasoning).toBeUndefined();
    expect(inferModelCaps('ollama', 'llama3').reasoning).toBeUndefined();
  });
  test('requires explicit vision support for generic provider models', () => {
    expect(modelSupportsVision('openrouter', 'vendor/unknown', undefined)).toBe(false);
    expect(modelSupportsVision('openrouter', 'vendor/vision', {
      id: 'vendor/vision', caps: { vision: true, textOutput: true },
    })).toBe(true);
    expect(modelSupportsVision('openai', 'gpt-5', undefined)).toBe(true);
  });
  test('filters obvious non-text model families without excluding unknown chat models', () => {
    expect(modelSupportsTextOutput('openai', 'gpt-image-2', undefined)).toBe(false);
    expect(modelSupportsTextOutput('openrouter', 'openai/gpt-image-2', undefined)).toBe(false);
    expect(modelSupportsTextOutput('openrouter', 'vendor/new-code-model', undefined)).toBe(true);
  });
});

describe('resolveCaps: parsed metadata wins over inference', () => {
  test('OpenRouter supported_parameters overrides the name guess', () => {
    // A model whose name implies nothing, but metadata says it reasons.
    const info = parseCompatModel({ id: 'x/y', supported_parameters: ['reasoning', 'tools'] });
    expect(resolveCaps('openrouter', 'x/y', info).reasoning).toBe(true);
    expect(modelSupportsReasoning('openrouter', 'x/y', info)).toBe(true);
    // No metadata → falls back to (empty) inference.
    expect(modelSupportsReasoning('openrouter', 'x/y', undefined)).toBe(false);
  });
});

describe('parseCompatModel', () => {
  test('parses the OpenRouter shape (pricing per-1M, caps, context)', () => {
    const info = parseCompatModel({
      id: 'google/gemini-3.5-flash',
      name: 'Gemini 3.5 Flash',
      context_length: 1048576,
      pricing: { prompt: '0.0000003', completion: '0.0000025', web_search: '0.014' },
      supported_parameters: ['reasoning', 'tools', 'response_format'],
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    });
    expect(info.name).toBe('Gemini 3.5 Flash');
    expect(info.contextLength).toBe(1048576);
    expect(info.pricing?.inputPerM).toBeCloseTo(0.3, 6);
    expect(info.pricing?.outputPerM).toBeCloseTo(2.5, 6);
    expect(info.pricing?.webSearchPerCall).toBeCloseTo(0.014, 6);
    expect(info.caps).toEqual({ reasoning: true, tools: true, json: true, vision: true, textOutput: true });
  });
  test('id-only shape (OpenAI/local) yields just the id', () => {
    const info = parseCompatModel({ id: 'gpt-4o' });
    expect(info).toEqual({ id: 'gpt-4o' });
  });
  test('falls back to top_provider.context_length', () => {
    const info = parseCompatModel({ id: 'm', top_provider: { context_length: 65536 } });
    expect(info.contextLength).toBe(65536);
  });
});

describe('formatContext', () => {
  test('formats k and M', () => {
    expect(formatContext(128000)).toBe('128k');
    expect(formatContext(200000)).toBe('200k');
    expect(formatContext(1_000_000)).toBe('1M');
    expect(formatContext(2_000_000)).toBe('2M');
    expect(formatContext(0)).toBeNull();
    expect(formatContext(undefined)).toBeNull();
  });
});

describe('formatPricePerM', () => {
  test('formats cents and dollars', () => {
    expect(formatPricePerM(0.3)).toBe('$0.30/M');
    expect(formatPricePerM(2.5)).toBe('$2.50/M');
    expect(formatPricePerM(15)).toBe('$15/M');
    expect(formatPricePerM(75)).toBe('$75/M');
    expect(formatPricePerM(12.4)).toBe('$12/M');
    expect(formatPricePerM(0.003)).toBe('$0.0030/M');
    expect(formatPricePerM(0)).toBe('free');
    expect(formatPricePerM(undefined)).toBeNull();
  });
});

describe('OpenRouter route-aware pricing', () => {
  const endpoints: TextModelEndpoint[] = [
    {
      providerName: 'Cheap', tag: 'cheap', status: 0, latencyP50Ms: 3000,
      pricing: { inputPerM: 0.2, outputPerM: 1.2 },
    },
    {
      providerName: 'Fast', tag: 'fast-provider', status: 0, latencyP50Ms: 1000,
      pricing: { inputPerM: 0.22, outputPerM: 1.32 },
    },
    {
      providerName: 'Priority', tag: 'provider/priority', status: 0, latencyP50Ms: 100,
      pricing: { inputPerM: 2, outputPerM: 12 },
    },
    {
      providerName: 'Flex', tag: 'provider/flex', status: 0, latencyP50Ms: 5000,
      pricing: { inputPerM: 0.1, outputPerM: 0.6 },
    },
  ];

  test('fast start chooses the lowest-latency ordinary endpoint', () => {
    expect(selectTextEndpointForRouting(endpoints, 'fast-start')?.providerName).toBe('Fast');
  });

  test('cheapest providers chooses the lowest-price ordinary endpoint', () => {
    expect(selectTextEndpointForRouting(endpoints, 'lowest-cost')?.providerName).toBe('Cheap');
  });

  test('route pricing falls back to the model headline while endpoint data loads', () => {
    expect(modelPricingForRouting({
      id: 'model', pricing: { inputPerM: 1, outputPerM: 5 },
    }, undefined, 'fast-start').pricing?.outputPerM).toBe(5);
  });
});
