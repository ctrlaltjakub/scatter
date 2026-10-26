import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/store/types';
import { missingSetupConnections, restoreMissingCredentials, validateOnboardingModels } from './onboardingSetup';

const saved = (): Settings => ({ ...DEFAULT_SETTINGS,
  providers: [{ id: 'cloud', preset: 'openrouter', apiKey: '', enabledModels: ['main'] }],
  activeModelRef: { providerId: 'cloud', model: 'main' },
  secondaryModelRef: { providerId: 'cloud', model: 'cheap' },
  interactiveModelRef: { providerId: 'cloud', model: 'coder' }, imageModelRef: null,
});
const text = { cloud: [{ id: 'main', caps: { vision: true, tools: true } }, { id: 'cheap', caps: { vision: true } }, { id: 'coder', caps: { textOutput: true } }] };
describe('restore readiness', () => {
  it('lists only missing connections, not one request per model', () => {
    expect(missingSetupConnections(saved())).toEqual(['cloud']);
  });
  it('reuses an existing matching local key without discarding imported choices', () => {
    const local = saved();
    local.providers = [{ ...local.providers[0]!, id: 'this-device', apiKey: 'local-key', enabledModels: ['other'] }];
    const restored = restoreMissingCredentials(saved(), local);
    expect(restored.providers[0]).toMatchObject({ id: 'cloud', apiKey: 'local-key', enabledModels: ['main'] });
    expect(restored.secondaryModelRef).toEqual(saved().secondaryModelRef);
    expect(missingSetupConnections(restored)).toEqual([]);
  });
  it('keeps a supplied key and does not guess between multiple matching custom servers', () => {
    const imported = saved(); imported.providers[0]!.apiKey = 'file-key';
    const local = saved(); local.providers[0]!.apiKey = 'local-key';
    expect(restoreMissingCredentials(imported, local).providers[0]?.apiKey).toBe('file-key');
    const custom: Settings = { ...saved(), providers: [{ id: 'remote', preset: 'custom', baseUrl: 'https://test.invalid', apiKey: '', enabledModels: ['main'] }] };
    local.providers = ['a', 'b'].map(id => ({ ...custom.providers[0]!, id, apiKey: id }));
    expect(restoreMissingCredentials(custom, local).providers[0]?.apiKey).toBe('');
  });
  it('verifies saved choices without a paid test or replacing them', () => {
    const settings = saved(); settings.providers[0]!.apiKey = 'key';
    expect(validateOnboardingModels(settings, text, {})).toEqual(settings.activeModelRef);
  });
  it('reports missing credentials, unavailable models, and unsupported main capabilities', () => {
    expect(() => validateOnboardingModels(saved(), text, {})).toThrow('Reconnect');
    const settings = saved(); settings.providers[0]!.apiKey = 'key';
    expect(() => validateOnboardingModels(settings, {}, {})).toThrow('unavailable');
    expect(() => validateOnboardingModels(settings, { cloud: text.cloud.filter(m => m.id !== 'cheap') }, {})).toThrow('secondary model');
    expect(() => validateOnboardingModels(settings, { cloud: [{ id: 'main' }] }, {})).toThrow('vision');
  });
  it('requires editing support unless the image-role override is explicitly enabled', () => {
    const settings = saved(); settings.providers[0]!.apiKey = 'key';
    expect(() => validateOnboardingModels(settings, text, {})).not.toThrow();
    settings.imageModelRef = { providerId: 'cloud', model: 'draw' };
    expect(() => validateOnboardingModels(settings, text, { cloud: [{ id: 'draw' }] })).toThrow('incompatible');
    settings.modelCompatibilityOverrides = { image: true };
    expect(() => validateOnboardingModels(settings, text, { cloud: [{ id: 'draw' }] })).not.toThrow();
    expect(() => validateOnboardingModels(settings, { cloud: [...text.cloud, { id: 'draw' }] }, {})).not.toThrow();
    expect(() => validateOnboardingModels(settings, text, {})).not.toThrow();
  });
  it('honors each role override with missing metadata but still requires credentials', () => {
    const settings = saved(); settings.providers[0]!.apiKey = 'key';
    const unknown = { cloud: [{ id: 'main' }, { id: 'cheap' }, { id: 'coder', caps: { textOutput: false } }] };
    settings.modelCompatibilityOverrides = { main: true };
    expect(() => validateOnboardingModels(settings, unknown, {})).toThrow('secondary model');
    settings.modelCompatibilityOverrides.secondary = true;
    expect(() => validateOnboardingModels(settings, unknown, {})).toThrow('interactive model');
    settings.modelCompatibilityOverrides.interactive = true;
    expect(validateOnboardingModels(settings, unknown, {})).toEqual(settings.activeModelRef);
    expect(validateOnboardingModels(settings, {}, {})).toEqual(settings.activeModelRef);
    settings.providers[0]!.apiKey = '';
    expect(() => validateOnboardingModels(settings, unknown, {})).toThrow('Reconnect');
  });
});
