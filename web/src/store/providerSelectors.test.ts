import { describe, expect, it } from 'vitest';
import type { ProviderAccount } from './types';
import { listSwitchableModels, sortProviderAccounts } from './providerSelectors';

const providers: ProviderAccount[] = [
  { id: 'or', preset: 'openrouter', apiKey: 'x', enabledModels: ['zeta', 'Alpha'] },
  { id: 'custom', preset: 'custom', apiKey: 'x', enabledModels: ['beta', 'ALPHA'] },
  { id: 'anth', preset: 'anthropic', apiKey: 'x', enabledModels: ['Zulu', 'eta'] },
];

describe('switchable model ordering', () => {
  it('honors cross-provider ordering while pruning stale entries and duplicates', () => {
    const mainModelOrder = [
      { providerId: 'or', model: 'zeta' },
      { providerId: 'anth', model: 'Zulu' },
      { providerId: 'or', model: 'zeta' },
      { providerId: 'missing', model: 'gone' },
    ];
    expect(listSwitchableModels({ providers, mainModelOrder }).map((ref) => `${ref.providerId}:${ref.model}`)).toEqual([
      'or:zeta', 'anth:Zulu', 'anth:eta', 'custom:ALPHA', 'custom:beta', 'or:Alpha',
    ]);
  });
  it('sorts provider groups by their display label and model ids case-insensitively', () => {
    expect(sortProviderAccounts(providers).map((p) => p.id)).toEqual(['anth', 'custom', 'or']);
    expect(listSwitchableModels({ providers }).map((m) => `${m.providerId}:${m.model}`)).toEqual([
      'anth:eta', 'anth:Zulu',
      'custom:ALPHA', 'custom:beta',
      'or:Alpha', 'or:zeta',
    ]);
  });
});
