import { describe, expect, it } from 'vitest';
import { customFontFixture } from '@/test/customFontFixture';
import { DEFAULT_SETTINGS, type Settings } from '@/store/types';
import type { SyncConfig } from '@/sync/types';
import { DEFAULT_PHYSICS_CONFIG } from '@/physics/defaults';
import { DEFAULT_BULLET_SIZING_CONFIG } from '@/lib/bulletSizingDefaults';
import { PROMPT_KEYS } from '@/lib/promptCatalog';
import {
  SETTINGS_EXPORT_FORMAT,
  SETTINGS_EXPORT_VERSION,
  SettingsImportError,
  createSettingsExport,
  parseSettingsExport,
} from './settingsTransfer';

const settings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  providers: [{
    id: 'router',
    preset: 'openrouter',
    apiKey: 'sk-private-test-key',
    enabledModels: ['google/gemini'],
  }],
  activeModelRef: { providerId: 'router', model: 'google/gemini' },
  interactiveModelRef: { providerId: 'router', model: 'openai/gpt-5.6-terra' },
  topicHistory: ['A topic'],
  chatStartHistory: ['Tell me about: therapy'],
  nodeFontId: 'comic-sans',
});

describe('settings transfer', () => {
  it('exports and restores the generation language with the existing font preference', async () => {
    const source = { ...settings(), generationLanguage: 'ja' as const, nodeFontId: 'inter' };
    const { blob } = createSettingsExport(source, undefined, 1, undefined, { includeSecrets: false });
    expect(parseSettingsExport(JSON.parse(await blob.text())).settings).toMatchObject({ generationLanguage: 'ja', nodeFontId: 'inter' });
  });
  it.each([true, false])('embeds custom font files in both export types (secrets=%s)', async includeSecrets => {
    const source = { ...settings(), customNodeFonts: [customFontFixture], nodeFontId: customFontFixture.id };
    const { blob } = createSettingsExport(source, undefined, 1, undefined, { includeSecrets });
    const imported = parseSettingsExport(JSON.parse(await blob.text())).settings;
    expect(imported.customNodeFonts).toEqual(source.customNodeFonts);
    expect(imported.nodeFontId).toBe(source.nodeFontId);
    expect(imported.providers[0]?.apiKey).toBe(includeSecrets ? source.providers[0]?.apiKey : '');
  });
  it.each([true, false])('round-trips disabled automatic enrichment with includeSecrets=%s', async includeSecrets => {
    const exported = createSettingsExport({ ...settings(), autoTermPreviews: false, autoFreeImages: false, defaultChatInformationChunking: false }, undefined, 1, undefined, { includeSecrets });
    expect(parseSettingsExport(JSON.parse(await exported.blob.text())).settings)
      .toMatchObject({ autoTermPreviews: false, autoFreeImages: false, defaultChatInformationChunking: false });
  });
  it.each([true, false])('round-trips search engines with includeSecrets=%s', async includeSecrets => {
    const selectionWebSearch = { engineId: 'custom-library', customEngines: [
      { id: 'custom-library', name: 'Library', urlTemplate: 'https://library.example/?search={query}&lang=en' },
    ] };
    const exported = createSettingsExport({ ...settings(), selectionWebSearch }, undefined, 1, undefined, { includeSecrets });
    expect(parseSettingsExport(JSON.parse(await exported.blob.text())).settings.selectionWebSearch).toEqual(selectionWebSearch);
  });
  it.each([true, false])('exports and imports every prompt override with includeSecrets=%s', async (includeSecrets) => {
    const customPrompts = Object.fromEntries(PROMPT_KEYS.map(key => [key, `Customized ${key}`]));
    const original = { ...settings(), customPrompts };
    const exported = createSettingsExport(original, undefined, 1, undefined, { includeSecrets });
    const imported = parseSettingsExport(JSON.parse(await exported.blob.text()));
    expect(imported.settings.customPrompts).toEqual(customPrompts);
    expect(imported.settings).not.toHaveProperty('promptSnapshots');
  });
  it.each([true, false])('excludes exploration history without changing local settings (secrets=%s)', async includeSecrets => {
    const source = settings();
    const { blob } = createSettingsExport(source, undefined, 1, undefined, { includeSecrets });
    const json = await blob.text();
    const raw = JSON.parse(json);
    expect(raw.settings).not.toHaveProperty('topicHistory');
    expect(raw.settings).not.toHaveProperty('chatStartHistory');
    expect(json).not.toContain('A topic');
    expect(json).not.toContain('Tell me about: therapy');
    expect(source.topicHistory).toEqual(['A topic']);
    expect(source.chatStartHistory).toEqual(['Tell me about: therapy']);
  });
  it('exports without credentials while retaining current prompts and developer overrides', async () => {
    const source = { ...settings(),
      syncApiKeys: true,
      customPrompts: { base: 'My system prompt' },
      physicsConfig: DEFAULT_PHYSICS_CONFIG,
      bulletSizingConfig: DEFAULT_BULLET_SIZING_CONFIG,
    };
    const config: SyncConfig = { schemaVersion: 1, enabled: true, provider: 'webdav', deviceId: 'device', deviceName: 'Laptop',
      webdav: { baseUrl: 'https://dav.example.test/', username: 'user', appPassword: 'test-secret-password', folder: 'Scatter Sync' } };
    const exported = createSettingsExport(source, undefined, 1, config, { includeSecrets: false });
    const json = await exported.blob.text();
    expect(exported.filename).toContain('without-secrets');
    expect(json).not.toContain('sk-private-test-key');
    expect(json).not.toContain('test-secret-password');
    const restored = parseSettingsExport(JSON.parse(json));
    expect(restored.settings.providers[0]?.apiKey).toBe('');
    expect(restored.settings.syncApiKeys).toBe(false);
    expect(source.syncApiKeys).toBe(true);
    expect(restored.syncPreferences?.enabled).toBe(false);
    expect(restored.syncPreferences?.webdav?.appPassword).toBe('');
    for (const field of ['customPrompts', 'physicsConfig', 'bulletSizingConfig'] as const) {
      expect(restored.settings[field]).toEqual(source[field]);
    }
    expect(source.providers[0]?.apiKey).toBe('sk-private-test-key');
    expect(config.webdav?.appPassword).toBe('test-secret-password');
  });
  it('exports API keys and round-trips settings plus UI preferences', async () => {
    const exported = createSettingsExport(settings(), {
      theme: 'dark',
      sidebarDisclosures: { projects: false, groups: true, shortcuts: false },
      lastInteractedGroups: { project: 'group' },
    }, Date.UTC(2026, 6, 29));
    expect(exported.filename).toBe('scatter-settings-2026-07-29.json');

    const raw = JSON.parse(await exported.blob.text()) as unknown;
    const imported = parseSettingsExport(raw);

    expect(imported.settings.providers[0]?.apiKey).toBe('sk-private-test-key');
    expect(imported.settings.interactiveModelRef?.model).toBe('openai/gpt-5.6-terra');
    expect(imported.settings.topicHistory).toBeUndefined();
    expect(imported.settings.chatStartHistory).toBeUndefined();
    expect(imported.settings.nodeFontId).toBe('comic-sans');
    expect(imported.uiPreferences).toEqual({
      theme: 'dark',
      sidebarDisclosures: { projects: false, groups: true, shortcuts: false },
      lastInteractedGroups: { project: 'group' },
    });
  });

  it('fills settings introduced after an older export from current defaults', () => {
    const imported = parseSettingsExport({
      format: SETTINGS_EXPORT_FORMAT,
      formatVersion: 1,
      exportedAt: 1,
      settings: { providers: [], activeModelRef: null },
      uiPreferences: {},
    });

    expect(imported.settings.groupColorAssignment).toBe(DEFAULT_SETTINGS.groupColorAssignment);
    expect(imported.settings.selectionWebSearch).toEqual({ engineId: 'google', customEngines: [] });
    expect(imported.settings.openRouterRouting).toBe('fast-start');
    expect(imported.settings.imageGenerationSettings).toEqual(DEFAULT_SETTINGS.imageGenerationSettings);
    expect(imported.settings.nodeFontId).toBe(DEFAULT_SETTINGS.nodeFontId);
    expect(imported.uiPreferences.theme).toBe('dark');
    expect(imported.uiPreferences.sidebarDisclosures).toEqual({
      projects: true,
      groups: true,
      shortcuts: true,
    });
    expect(imported.syncPreferences).toBeUndefined();
  });

  it.each(['light', 'dark', 'system'])('preserves an explicitly exported %s theme', theme => {
    const imported = parseSettingsExport({
      format: SETTINGS_EXPORT_FORMAT, formatVersion: 1, exportedAt: 1,
      settings: { providers: [] }, uiPreferences: { theme },
    });
    expect(imported.uiPreferences.theme).toBe(theme);
  });

  it.each(['google-drive', 'webdav'] as const)('round-trips %s without device identity or authorization tokens', async (provider) => {
    const config: SyncConfig = {
      schemaVersion: 1, enabled: true, provider,
      deviceId: 'source-device', deviceName: 'Source laptop',
      webdav: { baseUrl: 'https://dav.example.test/', username: 'user', appPassword: 'private-test-password', folder: 'Scatter Sync' },
    };
    const out = createSettingsExport(settings(), undefined, 1, config);
    const raw = JSON.parse(await out.blob.text());
    expect(raw.syncPreferences).toEqual({
      enabled: true, provider, ...(provider === 'webdav' ? { webdav: config.webdav } : {}),
    });
    expect(raw.syncPreferences).not.toHaveProperty('deviceId');
    expect(raw.syncPreferences).not.toHaveProperty('deviceName');
    expect(raw.syncPreferences).not.toHaveProperty('accessToken');
    expect(parseSettingsExport(raw).syncPreferences).toEqual(raw.syncPreferences);
  });

  it('rejects missing or malformed new sync configuration', () => {
    const raw = { format: SETTINGS_EXPORT_FORMAT, formatVersion: 2, settings: { providers: [] } };
    expect(() => parseSettingsExport(raw)).toThrow('invalid synchronization settings');
    expect(() => parseSettingsExport({ ...raw, syncPreferences: { enabled: true, provider: 'webdav' } }))
      .toThrow('incomplete WebDAV');
    expect(() => parseSettingsExport({ ...raw, syncPreferences: { enabled: true, provider: null } }))
      .toThrow('invalid synchronization settings');
  });

  it('rejects malformed and newer settings files without normalizing them', () => {
    expect(() => parseSettingsExport({ nope: true })).toThrow(SettingsImportError);
    expect(() => parseSettingsExport({
      format: SETTINGS_EXPORT_FORMAT,
      formatVersion: SETTINGS_EXPORT_VERSION + 1,
      settings: { providers: [] },
    })).toThrow('newer Scatter version');
  });
});
