import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ModelRole, type Settings } from '@/store/types';
import { MODEL_ROLES, RECOMMENDED_MODELS, planRecommendedModels, manualModelChoice, normalizeRecommendations, modelUpdatePreferences, recommendedModelIds, pendingRecommendedRoles } from './recommendedModels';
import { listSwitchableModels } from '@/store/providerSelectors';

const text = MODEL_ROLES.filter(role => role !== 'image').map(role => ({ id: RECOMMENDED_MODELS[role].id, caps: { vision: true, tools: true, textOutput: true } }));
const images = [{ id: RECOMMENDED_MODELS.image.id, supportsImageEditing: true }];
const empty = (): Settings => ({ ...DEFAULT_SETTINGS, providers: [{ id: 'or', preset: 'openrouter', apiKey: 'test', enabledModels: [] }] });
const enrolled = () => planRecommendedModels(empty(), 'or', text, images, true).settings;

describe('curated model updates', () => {
  it('defaults OpenRouter interactive builds to Kimi K3.1 Pro with vision and tools', () => {
    expect(RECOMMENDED_MODELS.interactive.id).toBe('moonshotai/kimi-k3.1-pro');
    expect(enrolled().interactiveModelRef?.model).toBe('moonshotai/kimi-k3.1-pro');
  });
  it('uses the native Gemini recommendation without moving the connection or assigning unapproved roles', () => {
    let source: Settings = { ...DEFAULT_SETTINGS, providers: [{ id: 'google', preset: 'gemini', apiKey: 'test', enabledModels: ['gemini-3.5-flash'] }],
      activeModelRef: { providerId: 'google', model: 'gemini-3.5-flash' } };
    source = { ...source, modelRecommendations: modelUpdatePreferences(source, ['main'], true) };
    const plan = planRecommendedModels(source, 'google', [{ id: 'gemini-3.8-flash', caps: { vision: true, tools: true, textOutput: true } }], []);
    expect(plan.changed).toEqual(['main']);
    expect(plan.settings.activeModelRef).toEqual({ providerId: 'google', model: 'gemini-3.8-flash' });
    expect(recommendedModelIds('secondary', 'gemini')).toEqual([]);
    expect(recommendedModelIds('interactive', 'gemini')).toEqual([]);
    expect(recommendedModelIds('image', 'gemini')).toEqual([]);
  });
  it('does not relax automatic-update requirements when manual compatibility overrides are enabled', () => {
    const settings: Settings = { ...empty(), modelCompatibilityOverrides: { main: true, secondary: true, interactive: true, image: true } };
    const plan = planRecommendedModels(settings, 'or', text.map(({ id }) => ({ id })), images.map(({ id }) => ({ id })), true);
    expect(plan.changed).toEqual([]);
    expect(plan.unavailable).toEqual(MODEL_ROLES);
  });
  it('updates direct OpenAI secondary and image roles through their existing connection', () => {
    let source: Settings = { ...DEFAULT_SETTINGS,
      providers: [{ id: 'direct', preset: 'openai', apiKey: 'test', enabledModels: ['my-main'] }],
      activeModelRef: { providerId: 'direct', model: 'my-main' },
      secondaryModelRef: { providerId: 'direct', model: 'old-secondary' }, secondaryUseSameModel: false,
      imageModelRef: { providerId: 'direct', model: 'old-image' },
    };
    source = { ...source, modelRecommendations: modelUpdatePreferences(source, MODEL_ROLES, true) };
    const plan = planRecommendedModels(source, 'direct', [{ id: 'gpt-6-luna' }], [{ id: 'gpt-image-2.5-sunburst', supportsImageEditing: true }]);
    expect(plan.changed).toEqual(['secondary', 'image']);
    expect(plan.settings.secondaryModelRef).toEqual({ providerId: 'direct', model: 'gpt-6-luna' });
    expect(plan.settings.activeModelRef).toEqual(source.activeModelRef); // no approved direct-OpenAI main substitute
    expect(plan.settings.imageModelRef?.providerId).toBe('direct');
  });
  it('never uses another configured provider to replace an unavailable model', () => {
    let source: Settings = { ...enrolled(), secondaryModelRef: { providerId: 'direct', model: 'old-secondary' },
      providers: [...enrolled().providers, { id: 'direct', preset: 'openai', apiKey: 'test', enabledModels: [] }] };
    source = { ...source, modelRecommendations: modelUpdatePreferences(source, ['secondary'], true) };
    expect(planRecommendedModels(source, 'or', text, images).settings.secondaryModelRef).toEqual(source.secondaryModelRef);
    expect(planRecommendedModels(source, 'direct', [], []).settings).toBe(source);
  });
  it('only accepts exact curated proxy IDs with confirmed vision and tool support', () => {
    let source: Settings = { ...DEFAULT_SETTINGS, providers: [{ id: 'proxy', preset: 'custom', apiKey: 'test', enabledModels: [] }],
      interactiveModelRef: { providerId: 'proxy', model: 'old-model' } };
    source = { ...source, modelRecommendations: modelUpdatePreferences(source, ['interactive'], true) };
    for (const catalog of [[{ id: 'gpt-6.1-sol-custom' }], [{ id: 'gpt-6.1-sol' }], [{ id: 'gpt-6.1-sol', caps: { tools: false } }], [{ id: 'gpt-6.1-sol', caps: { tools: true, vision: false } }]]) {
      expect(planRecommendedModels(source, 'proxy', catalog, []).settings).toBe(source);
    }
    expect(planRecommendedModels(source, 'proxy', [{ id: 'gpt-6.1-sol', caps: { tools: true, vision: true } }], []).settings.interactiveModelRef)
      .toEqual({ providerId: 'proxy', model: 'gpt-6.1-sol' });
    expect(recommendedModelIds('interactive', 'ollama')).toEqual([]);
    expect(recommendedModelIds('interactive', 'lm-studio')).toEqual([]);
    expect(recommendedModelIds('main', 'anthropic')).toEqual([]);
  });
  it('updates an opted-in direct OpenAI interactive role, but preserves manual choices', () => {
    let source: Settings = { ...DEFAULT_SETTINGS, providers: [{ id: 'direct', preset: 'openai', apiKey: 'test', enabledModels: [] }],
      interactiveModelRef: { providerId: 'direct', model: 'old-model' } };
    source = { ...source, modelRecommendations: modelUpdatePreferences(source, ['interactive'], true) };
    expect(planRecommendedModels(source, 'direct', [{ id: 'gpt-6.1-sol' }], []).settings.interactiveModelRef?.model).toBe('gpt-6.1-sol');
    const manual = { ...source, modelRecommendations: manualModelChoice(source, 'interactive') };
    expect(planRecommendedModels(manual, 'direct', [{ id: 'gpt-6.1-sol' }], []).settings).toBe(manual);
  });
  it('requires connected search and vision for a custom connection’s secondary model', () => {
    let source: Settings = { ...DEFAULT_SETTINGS, providers: [{ id: 'custom', preset: 'custom', apiKey: 'key', enabledModels: [], webSearchEndpoint: 'https://search.test' }],
      secondaryUseSameModel: false, secondaryModelRef: { providerId: 'custom', model: 'old' } };
    source = { ...source, modelRecommendations: modelUpdatePreferences(source, ['secondary'], true) };
    const catalog = [{ id: 'gpt-6-luna', caps: { tools: true, vision: true } }];
    expect(planRecommendedModels(source, 'custom', catalog, []).changed).toEqual(['secondary']);
    const noSearch = { ...source, providers: [{ ...source.providers[0]!, webSearchEndpoint: undefined }] };
    expect(planRecommendedModels(noSearch, 'custom', catalog, []).settings).toBe(noSearch);
    expect(planRecommendedModels(source, 'custom', [{ ...catalog[0]!, caps: { tools: true } }], []).settings).toBe(source);
  });
  it('marks a still-current recommendation checked without reporting a model replacement', () => {
    const source = enrolled();
    source.modelRecommendations = { ...source.modelRecommendations!, secondary: { ...source.modelRecommendations!.secondary, version: 'old' } };
    const plan = planRecommendedModels(source, 'or', text, images);
    expect(plan.changed).toEqual([]);
    expect(pendingRecommendedRoles(plan.settings)).toEqual([]);
  });
  it('installs all four approved recommendations with updates enabled', () => {
    const { settings, changed } = planRecommendedModels(empty(), 'or', text, images, true);
    expect(changed).toEqual(MODEL_ROLES);
    expect(settings.activeModelRef?.model).toBe(RECOMMENDED_MODELS.main.id);
    expect(settings.secondaryModelRef?.model).toBe(RECOMMENDED_MODELS.secondary.id);
    expect(settings.interactiveModelRef?.model).toBe(RECOMMENDED_MODELS.interactive.id);
    expect(settings.imageModelRef?.model).toBe(RECOMMENDED_MODELS.image.id);
    for (const role of MODEL_ROLES) expect(settings.modelRecommendations?.[role].autoUpdate).toBe(true);
  });
  it('does not enroll existing choices during an automatic check', () => {
    const settings = empty();
    expect(planRecommendedModels(settings, 'or', text, images).settings).toBe(settings);
  });
  it('does nothing when the shipped version is already installed', () => {
    const settings = enrolled();
    expect(planRecommendedModels(settings, 'or', text, images).settings).toBe(settings);
  });
  it('keeps image generation disabled even during explicit quick setup', () => {
    const settings = { ...empty(), imageModelRef: null };
    expect(planRecommendedModels(settings, 'or', text, images, true).settings.imageModelRef).toBeNull();
  });
  it('never substitutes missing models or unsupported capabilities', () => {
    const plan = planRecommendedModels(empty(), 'or', [{ id: 'different', caps: { vision: true, tools: true } }], [], true);
    expect(plan.changed).toEqual([]); expect(plan.unavailable).toEqual(MODEL_ROLES);
  });
  it('replaces the entire main-model list across providers and activates the recommendation', () => {
    const base = enrolled();
    const old = { providerId: 'or', model: 'old-recommendation' };
    const extra = { providerId: 'or', model: 'my-choice' };
    const other = { providerId: 'direct', model: 'other-choice' };
    const settings: Settings = { ...base, activeModelRef: other, mainModelOrder: [other, extra, old],
      secondaryModelRef: other, secondaryUseSameModel: false,
      providers: [{ ...base.providers[0]!, enabledModels: [old.model, extra.model] },
        { id: 'direct', preset: 'openai', apiKey: 'keep-this-key', enabledModels: [other.model] }],
      modelRecommendations: { ...base.modelRecommendations!, main: { autoUpdate: true, ref: old, version: 'old' } } };
    const { settings: next, changed } = planRecommendedModels(settings, 'or', text, images);
    const recommended = { providerId: 'or', model: RECOMMENDED_MODELS.main.id };
    expect(changed).toEqual(['main']);
    expect(next.activeModelRef).toEqual(recommended);
    expect(listSwitchableModels(next)).toEqual([{ ...recommended, preset: 'openrouter' }]);
    expect(next.mainModelOrder).toEqual([recommended]);
    expect(next.providers.map(p => ({ ...p, enabledModels: [] })))
      .toEqual(settings.providers.map(p => ({ ...p, enabledModels: [] })));
    expect(next.secondaryModelRef).toEqual(other);
    expect(next.interactiveModelRef).toEqual(settings.interactiveModelRef);
    expect(next.imageModelRef).toEqual(settings.imageModelRef);
    expect(settings.providers[0]?.enabledModels).toEqual([old.model, extra.model]); // Pure, atomic plan.
  });
  it('reports a changed main list even if the recommended model itself has not changed', () => {
    const base = enrolled();
    const settings: Settings = { ...base, providers: [{ ...base.providers[0]!, enabledModels: [RECOMMENDED_MODELS.main.id, 'extra'] }],
      modelRecommendations: { ...base.modelRecommendations!, main: { ...base.modelRecommendations!.main, version: 'old' } } };
    const plan = planRecommendedModels(settings, 'or', text, images);
    expect(plan.changed).toEqual(['main']);
    expect(plan.settings.providers[0]?.enabledModels).toEqual([RECOMMENDED_MODELS.main.id]);
    expect(plan.settings.mainModelOrder).toEqual([plan.settings.activeModelRef]);
    expect(pendingRecommendedRoles(plan.settings)).toEqual([]);
    expect(planRecommendedModels(plan.settings, 'or', text, images).settings).toBe(plan.settings);
  });
  it.each(['disabled', 'unavailable', 'incompatible', 'disconnected'] as const)('keeps the complete main list when the update is %s', condition => {
    const base = enrolled();
    const ref = { providerId: 'or', model: 'old' };
    const settings: Settings = { ...base, activeModelRef: ref, mainModelOrder: [ref, { providerId: 'or', model: 'extra' }],
      providers: [{ ...base.providers[0]!, apiKey: condition === 'disconnected' ? '' : 'test', enabledModels: ['old', 'extra'] }],
      modelRecommendations: { ...base.modelRecommendations!, main: { autoUpdate: condition !== 'disabled', ref, version: 'old' } } };
    const catalog = condition === 'unavailable' ? [] : condition === 'incompatible'
      ? [{ id: RECOMMENDED_MODELS.main.id, caps: { vision: false, tools: true } }] : text;
    const plan = planRecommendedModels(settings, 'or', catalog, images);
    expect(plan.settings).toBe(settings);
    expect(plan.changed).toEqual([]);
  });
  it('does not clear extra main models merely because the app reloads at the same recommendation version', () => {
    const base = enrolled();
    const settings: Settings = { ...base, providers: [{ ...base.providers[0]!, enabledModels: [RECOMMENDED_MODELS.main.id, 'extra'] }] };
    expect(planRecommendedModels(settings, 'or', text, images).settings).toBe(settings);
  });
  it.each(MODEL_ROLES)('manual %s choices turn off only that role', (role: ModelRole) => {
    const prefs = manualModelChoice(enrolled(), role);
    for (const candidate of MODEL_ROLES) expect(prefs[candidate].autoUpdate).toBe(candidate !== role);
  });
  it('preserves legacy choices while keeping updates on for new setups', () => {
    expect(normalizeRecommendations(undefined, true).main.autoUpdate).toBe(false);
    expect(normalizeRecommendations(undefined, false).main.autoUpdate).toBe(true);
  });
  it('does not overwrite a manually changed slot imported with stale tracking', () => {
    const settings = enrolled();
    settings.secondaryModelRef = { providerId: 'or', model: 'custom' };
    settings.modelRecommendations!.secondary.version = 'old';
    expect(planRecommendedModels(settings, 'or', text, images).settings.secondaryModelRef?.model).toBe('custom');
  });
});
