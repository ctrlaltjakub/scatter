import { describe, expect, it } from 'vitest';
import { resolveInteractiveModel } from './interactiveModel';
import type { ProviderAccount } from '@/store/types';

const provider = (
  id: string,
  preset: ProviderAccount['preset'],
  apiKey = 'key',
): ProviderAccount => ({ id, preset, apiKey, enabledModels: [] });

describe('resolveInteractiveModel', () => {
  it('uses an explicit connected selection first', () => {
    expect(resolveInteractiveModel({
      providers: [provider('router', 'openrouter')],
      activeModelRef: { providerId: 'router', model: 'google/gemini' },
      interactiveModelRef: { providerId: 'router', model: 'anthropic/claude' },
      catalog: { router: [{ id: 'anthropic/claude' }] },
    })).toEqual({
      ref: { providerId: 'router', model: 'anthropic/claude' },
      automatic: false,
    });
  });

  it('uses the active main model when no dedicated model is selected', () => {
    expect(resolveInteractiveModel({
      providers: [provider('openai', 'openai'), provider('router', 'openrouter')],
      activeModelRef: { providerId: 'router', model: 'google/gemini' },
      catalog: {},
    })).toEqual({
      ref: { providerId: 'router', model: 'google/gemini' },
      automatic: true,
    });
  });

  it('does not replace the main model with an available Terra route', () => {
    expect(resolveInteractiveModel({
      providers: [provider('router', 'openrouter')],
      activeModelRef: { providerId: 'router', model: 'google/gemini' },
      catalog: { router: [{ id: 'openai/gpt-5.6-terra' }] },
    }).ref).toEqual({ providerId: 'router', model: 'google/gemini' });
  });

  it('never silently substitutes a selected model because the catalog omits it', () => {
    expect(resolveInteractiveModel({
      providers: [provider('router', 'openrouter')],
      activeModelRef: { providerId: 'router', model: 'google/gemini' },
      interactiveModelRef: { providerId: 'router', model: 'missing' },
      catalog: { router: [{ id: 'google/gemini' }] },
    }).ref).toEqual({ providerId: 'router', model: 'missing' });
  });
});
