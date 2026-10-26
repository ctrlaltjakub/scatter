import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type Settings } from '@/store/types';
import { applySyncedPreferences, createSyncedPreferences, mergeLocalCredentials } from './preferences';
import { useSettingsStore } from '@/store/useSettingsStore';

function settings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, ...overrides };
}

describe('synchronized preferences', () => {
  it('syncs explicit off choices for both automatic enrichment features', () => {
    const snapshot = createSyncedPreferences(settings({ autoTermPreviews: false, autoFreeImages: false, defaultChatInformationChunking: false }), []);
    expect(mergeLocalCredentials(snapshot.settings, settings()))
      .toMatchObject({ autoTermPreviews: false, autoFreeImages: false, defaultChatInformationChunking: false });
  });
  it('syncs the selected engine and custom search URLs between devices', () => {
    const selectionWebSearch = { engineId: 'custom-library', customEngines: [
      { id: 'custom-library', name: 'Library', urlTemplate: 'https://library.example/?q={query}' },
    ] };
    const snapshot = createSyncedPreferences(settings({ selectionWebSearch }), []);
    expect(mergeLocalCredentials(snapshot.settings, settings()).selectionWebSearch).toEqual(selectionWebSearch);
  });
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('sc-theme', 'dark');
  });

  it('includes future-proof persisted settings and redacts every provider key', () => {
    const local = settings({
      providers: [
        { id: 'one', preset: 'openai', apiKey: 'secret-1', enabledModels: ['gpt-test'] },
        { id: 'two', preset: 'openrouter', apiKey: 'secret-2', enabledModels: ['model/test'] },
      ],
    });
    const snapshot = createSyncedPreferences(local, ['b', 'a']);
    expect(snapshot).not.toHaveProperty('theme');
    expect(snapshot.projectOrder).toEqual(['b', 'a']);
    expect(snapshot.settings.providers.map((provider) => provider.apiKey)).toEqual(['', '']);
    expect(snapshot.settings.sentencePerLine).toBe(local.sentencePerLine);
  });

  it('includes keys only after explicit opt-in without changing the source settings', () => {
    const local = settings({ syncApiKeys: true, providers: [
      { id: 'one', preset: 'openai', apiKey: 'test-one', enabledModels: [] },
      { id: 'two', preset: 'custom', baseUrl: 'https://test.invalid/v1', apiKey: 'test-two', enabledModels: [] },
    ] });
    expect(createSyncedPreferences(local, []).settings.providers.map(p => p.apiKey)).toEqual(['test-one', 'test-two']);
    expect(createSyncedPreferences({ ...local, syncApiKeys: false }, []).settings.providers.map(p => p.apiKey)).toEqual(['', '']);
    expect(local.providers.map(p => p.apiKey)).toEqual(['test-one', 'test-two']);
  });

  it.each([true, false, undefined])('restores keys only from opted-in snapshots (opt-in=%s)', async syncApiKeys => {
    const replace = vi.spyOn(useSettingsStore.getState(), 'replaceSettings').mockResolvedValue();
    useSettingsStore.setState({ providers: [{ id: 'one', preset: 'openai', apiKey: 'local-test-key', enabledModels: [] }] });
    const remote = settings({ providers: [{ id: 'one', preset: 'openai', apiKey: 'remote-test-key', enabledModels: ['test-model'] }] });
    if (syncApiKeys === undefined) delete (remote as Partial<Settings>).syncApiKeys;
    else remote.syncApiKeys = syncApiKeys;
    await applySyncedPreferences({ settings: remote, projectOrder: [] });
    expect(replace.mock.calls[0]?.[0].providers[0]).toMatchObject({
      apiKey: syncApiKeys ? 'remote-test-key' : 'local-test-key', enabledModels: ['test-model'],
    });
    replace.mockRestore();
  });

  it('propagates a deliberately cleared key while key syncing is enabled', async () => {
    const replace = vi.spyOn(useSettingsStore.getState(), 'replaceSettings').mockResolvedValue();
    useSettingsStore.setState({ providers: [{ id: 'one', preset: 'openai', apiKey: 'old-test-key', enabledModels: [] }] });
    await applySyncedPreferences({ settings: settings({ syncApiKeys: true,
      providers: [{ id: 'one', preset: 'openai', apiKey: '', enabledModels: [] }] }), projectOrder: [] });
    expect(replace.mock.calls[0]?.[0].providers[0]?.apiKey).toBe('');
    replace.mockRestore();
  });

  it('ignores an older cloud snapshot theme and keeps this device’s choice', async () => {
    const replace = vi.spyOn(useSettingsStore.getState(), 'replaceSettings').mockResolvedValue();
    await applySyncedPreferences({ settings: settings(), projectOrder: [], theme: 'light' });
    expect(localStorage.getItem('sc-theme')).toBe('dark');
    expect(replace).toHaveBeenCalledOnce();
    replace.mockRestore();
  });

  it('keeps credentials from the receiving browser by exact provider id', () => {
    const local = settings({
      providers: [{ id: 'same', preset: 'openai', apiKey: 'local secret', enabledModels: ['old'] }],
    });
    const remote = settings({
      providers: [{ id: 'same', preset: 'openai', apiKey: '', enabledModels: ['new'] }],
    });
    const merged = mergeLocalCredentials(remote, local);
    expect(merged.providers[0]?.apiKey).toBe('local secret');
    expect(merged.providers[0]?.enabledModels).toEqual(['new']);
  });

  it('does not guess a credential when multiple local accounts match', () => {
    const local = settings({
      providers: [
        { id: 'a', preset: 'openai', apiKey: 'a secret', enabledModels: [] },
        { id: 'b', preset: 'openai', apiKey: 'b secret', enabledModels: [] },
      ],
    });
    const remote = settings({
      providers: [{ id: 'remote', preset: 'openai', apiKey: '', enabledModels: [] }],
    });
    expect(mergeLocalCredentials(remote, local).providers[0]?.apiKey).toBe('');
  });
  it('does not reuse a local key when a restored connection changes provider or destination', () => {
    const local = settings({ providers: [{ id: 'same', preset: 'custom', baseUrl: 'https://trusted.test/API', apiKey: 'private', enabledModels: [] }] });
    for (const patch of [{ baseUrl: 'https://different.test/API' }, { baseUrl: 'https://trusted.test/api' }, { preset: 'openai' as const }]) {
      const remote = settings({ providers: [{ ...local.providers[0]!, ...patch, apiKey: '' }] });
      expect(mergeLocalCredentials(remote, local).providers[0]?.apiKey).toBe('');
    }
  });
});
