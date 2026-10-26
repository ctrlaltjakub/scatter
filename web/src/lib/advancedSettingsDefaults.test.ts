import { describe, expect, it } from 'vitest';
import { CURRENT_ADVANCED_DEFAULTS, defaultFingerprint } from './advancedSettingsDefaults';
import { normalizeSettings } from '@/opfs/settingsIO';
import { DEFAULT_SETTINGS } from '@/store/types';
import { DEFAULT_PROMPTS } from './promptDefaults';
import { DEFAULT_PHYSICS_CONFIG } from '@/physics/defaults';
import { DEFAULT_BULLET_SIZING_CONFIG } from './bulletSizingDefaults';
import { createSettingsExport, parseSettingsExport } from './settingsTransfer';
import { createSyncedPreferences, mergeLocalCredentials } from '@/sync/preferences';

const customized = () => ({ ...DEFAULT_SETTINGS,
  providers: [{ id: 'or', preset: 'openrouter' as const, apiKey: 'test-key', enabledModels: ['chosen'] }],
  activeModelRef: { providerId: 'or', model: 'chosen' },
  normalChatInstructions: 'My personal instructions', nodeFontId: 'comic-sans',
  topicHistory: ['topic'], chatStartHistory: ['question'],
  customPrompts: { base: 'Custom encyclopedia', chatBase: '', termPreviewSystem: 'Custom previews' },
  physicsConfig: { ...DEFAULT_PHYSICS_CONFIG, linkDistance: 250 },
  bulletSizingConfig: { ...DEFAULT_BULLET_SIZING_CONFIG, safetyMinPx: 100 },
  outputTokenCap: 24000, secondaryOutputTokenCap: 18000, interactiveOutputTokenCap: 64000,
});

describe('advanced override updates', () => {
  it('uses stable identifiers compatible with the former prompt baselines', () => {
    expect(defaultFingerprint('hello')).toBe('2y0dev');
    expect(defaultFingerprint('hello')).not.toBe(defaultFingerprint('hello '));
    expect(CURRENT_ADVANCED_DEFAULTS.prompts.base).toBe(defaultFingerprint(DEFAULT_PROMPTS.base));
  });
  it('keeps matching overrides, including deliberately empty prompts', () => {
    const original = customized();
    expect(normalizeSettings(original)).toMatchObject(original);
  });
  it('resets only prompts whose shipped default changed and does not retain history', () => {
    const source = customized();
    const result = normalizeSettings({ ...source,
      advancedDefaults: { ...CURRENT_ADVANCED_DEFAULTS, prompts: { ...CURRENT_ADVANCED_DEFAULTS.prompts, base: 'old-default' } },
      promptSnapshots: [{ id: 'old', config: source.customPrompts }], physicsSnapshots: [], bulletSizingSnapshots: [],
    });
    expect(result.customPrompts).toEqual({ chatBase: '', termPreviewSystem: 'Custom previews' });
    expect(result.normalChatInstructions).toBe(source.normalChatInstructions);
    expect(result.physicsConfig).toEqual(source.physicsConfig);
    for (const field of ['promptSnapshots', 'physicsSnapshots', 'bulletSizingSnapshots', 'acknowledgedPromptDefaults']) expect(result).not.toHaveProperty(field);
  });
  it.each(['physics', 'bulletSizing', 'generationLimits'] as const)('resets the changed %s group only', group => {
    const source = customized();
    const result = normalizeSettings({ ...source, advancedDefaults: { ...CURRENT_ADVANCED_DEFAULTS, [group]: 'old-default' } });
    expect(result.physicsConfig).toEqual(group === 'physics' ? undefined : source.physicsConfig);
    expect(result.bulletSizingConfig).toEqual(group === 'bulletSizing' ? undefined : source.bulletSizingConfig);
    expect(result.outputTokenCap).toBe(group === 'generationLimits' ? DEFAULT_SETTINGS.outputTokenCap : source.outputTokenCap);
    expect(result.secondaryOutputTokenCap).toBe(group === 'generationLimits' ? DEFAULT_SETTINGS.secondaryOutputTokenCap : source.secondaryOutputTokenCap);
    expect(result.interactiveOutputTokenCap).toBe(group === 'generationLimits' ? DEFAULT_SETTINGS.interactiveOutputTokenCap : source.interactiveOutputTokenCap);
    expect(result.customPrompts).toEqual(source.customPrompts);
  });
  it('resets unverifiable advanced values, preserving ordinary settings and credentials', () => {
    const source = customized();
    const result = normalizeSettings({ ...source, advancedDefaults: undefined });
    expect(result.customPrompts).toBeUndefined();
    expect(result.physicsConfig).toBeUndefined();
    expect(result.bulletSizingConfig).toBeUndefined();
    expect(result.outputTokenCap).toBe(DEFAULT_SETTINGS.outputTokenCap);
    for (const key of ['providers', 'activeModelRef', 'normalChatInstructions', 'nodeFontId', 'topicHistory', 'chatStartHistory'] as const) expect(result[key]).toEqual(source[key]);
  });
  it('accepts matching legacy prompt fingerprints without reviving saved versions', () => {
    const result = normalizeSettings({ ...customized(), advancedDefaults: undefined,
      acknowledgedPromptDefaults: { base: CURRENT_ADVANCED_DEFAULTS.prompts.base, chatBase: 'outdated' },
    });
    expect(result.customPrompts).toEqual({ base: 'Custom encyclopedia' });
    expect(result).not.toHaveProperty('acknowledgedPromptDefaults');
  });
  it('validates malformed baselines and unknown prompt keys without crashing', () => {
    for (const advancedDefaults of [null, [], 3, { prompts: [] }, { prompts: { base: null } }]) {
      expect(normalizeSettings({ ...customized(), advancedDefaults }).customPrompts).toBeUndefined();
    }
    const result = normalizeSettings({ ...customized(), customPrompts: { base: 5, unknown: 'ignored', chatBase: '' } });
    expect(result.customPrompts).toEqual({ chatBase: '' });
  });
  it.each([true, false])('an export from before a defaults update cannot restore outdated overrides (secrets=%s)', async includeSecrets => {
    const source = customized();
    const old = { ...source, advancedDefaults: { ...CURRENT_ADVANCED_DEFAULTS, physics: 'previous',
      prompts: { ...CURRENT_ADVANCED_DEFAULTS.prompts, base: 'previous' } }, promptSnapshots: [{ config: source.customPrompts }] };
    const exported = createSettingsExport(old, undefined, 1, undefined, { includeSecrets });
    const raw = JSON.parse(await exported.blob.text());
    expect(raw.settings).not.toHaveProperty('promptSnapshots');
    const result = parseSettingsExport(raw).settings;
    expect(result.physicsConfig).toBeUndefined();
    expect(result.customPrompts).toEqual({ chatBase: '', termPreviewSystem: 'Custom previews' });
    expect(result.providers[0]?.apiKey).toBe(includeSecrets ? 'test-key' : '');
    expect(normalizeSettings(result)).toEqual(result); // normalization is idempotent
    expect(old.customPrompts.base).toBe('Custom encyclopedia'); // no mutation of the file source
  });
  it('applies the same reset rule to cloud settings without losing local credentials', () => {
    const local = customized();
    const remote = createSyncedPreferences({ ...local, advancedDefaults: { ...CURRENT_ADVANCED_DEFAULTS, generationLimits: 'old' } }, []);
    const result = mergeLocalCredentials(remote.settings, local);
    expect(result.outputTokenCap).toBe(DEFAULT_SETTINGS.outputTokenCap);
    expect(result.providers[0]?.apiKey).toBe('test-key');
    expect(result.customPrompts).toEqual(local.customPrompts);
  });
});
