import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeJSON } from '@/opfs/storage';
import { useSettingsStore } from '@/store/useSettingsStore';
import { useSyncStore } from '@/store/useSyncStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { defaultSyncConfig, defaultSyncLedger } from '@/sync/local';
import { clearGoogleDriveToken } from '@/sync/providers/googleDrive';
import { parseSettingsExport } from './settingsTransfer';
import { applySettingsImport } from './applySettingsImport';

vi.mock('@/opfs/storage', async (original) => ({
  ...await original<typeof import('@/opfs/storage')>(), writeJSON: vi.fn().mockResolvedValue(undefined),
}));

const imported = (syncPreferences?: unknown) => parseSettingsExport({
  format: 'scatter-settings', formatVersion: syncPreferences ? 2 : 1,
  settings: { ...DEFAULT_SETTINGS, providers: [], outputTokenCap: 24000 }, syncPreferences,
});
beforeEach(() => {
  clearGoogleDriveToken();
  vi.clearAllMocks();
  vi.mocked(writeJSON).mockResolvedValue(undefined);
  useSettingsStore.setState({ ...DEFAULT_SETTINGS, hydrated: true, topicHistory: undefined, chatStartHistory: undefined });
  useSyncStore.setState({ hydrated: true, config: {
    ...defaultSyncConfig(), deviceId: 'this-device', deviceName: 'This laptop',
  }, ledger: defaultSyncLedger() });
});
afterEach(() => clearGoogleDriveToken());

describe('applying settings imports', () => {
  it('keeps local exploration history when the imported file omits it', async () => {
    useSettingsStore.setState({ topicHistory: ['Local topic'], chatStartHistory: ['Local question'] });
    await applySettingsImport(imported());
    expect(useSettingsStore.getState().topicHistory).toEqual(['Local topic']);
    expect(useSettingsStore.getState().chatStartHistory).toEqual(['Local question']);
    expect(writeJSON).toHaveBeenCalledWith('settings.json', expect.objectContaining({
      topicHistory: ['Local topic'], chatStartHistory: ['Local question'],
    }));
  });

  it('still restores history explicitly included in an older file', async () => {
    useSettingsStore.setState({ topicHistory: ['Local topic'], chatStartHistory: ['Local question'] });
    const file = imported();
    file.settings.topicHistory = ['Imported topic'];
    file.settings.chatStartHistory = [];
    await applySettingsImport(file);
    expect(useSettingsStore.getState().topicHistory).toEqual(['Imported topic']);
    expect(useSettingsStore.getState().chatStartHistory).toEqual([]);
  });

  it('restores the WebDAV connection and enabled state without cloning device identity', async () => {
    const webdav = { baseUrl: 'https://dav.example.test/', username: 'me', appPassword: 'synthetic-password', folder: 'Backups' };
    await applySettingsImport(imported({ provider: 'webdav', enabled: true, webdav, deviceId: 'other-device' }));
    expect(useSyncStore.getState().config).toEqual({
      schemaVersion: 1, deviceId: 'this-device', deviceName: 'This laptop',
      provider: 'webdav', enabled: true, webdav,
    });
    expect(writeJSON).toHaveBeenCalledWith('sync/config.json', useSyncStore.getState().config);
  });

  it('restores Google Drive but requires a real authorization gesture on the receiving device', async () => {
    await applySettingsImport(imported({ provider: 'google-drive', enabled: true, accessToken: 'not-portable' }));
    expect(useSyncStore.getState().config).toMatchObject({ provider: 'google-drive', enabled: false, deviceId: 'this-device' });
    expect(useSyncStore.getState().config).not.toHaveProperty('accessToken');
  });

  it('automatically resumes an existing Google Drive connection using this browser’s valid token', async () => {
    useSyncStore.setState({ config: { ...useSyncStore.getState().config, provider: 'google-drive', enabled: true } });
    localStorage.setItem('scatter.google-drive-token.v1', JSON.stringify({
      accessToken: 'local-test-token', expiresAt: Date.now() + 3600_000,
    }));
    await applySettingsImport(imported({ provider: 'google-drive', enabled: true }));
    expect(useSyncStore.getState().config.enabled).toBe(true);
    expect(writeJSON).toHaveBeenCalledWith('sync/config.json', expect.objectContaining({ enabled: true }));
  });

  it('does not enable Google Drive with expired authorization or override an imported pause', async () => {
    useSyncStore.setState({ config: { ...useSyncStore.getState().config, provider: 'google-drive', enabled: true } });
    localStorage.setItem('scatter.google-drive-token.v1', JSON.stringify({
      accessToken: 'expired-test-token', expiresAt: Date.now() - 1,
    }));
    await applySettingsImport(imported({ provider: 'google-drive', enabled: true }));
    expect(useSyncStore.getState().config.enabled).toBe(false);
    localStorage.setItem('scatter.google-drive-token.v1', JSON.stringify({
      accessToken: 'local-test-token', expiresAt: Date.now() + 3600_000,
    }));
    await applySettingsImport(imported({ provider: 'google-drive', enabled: false }));
    expect(useSyncStore.getState().config.enabled).toBe(false);
  });

  it('rolls back the sync destination if the settings save fails, and can retry', async () => {
    const config = useSyncStore.getState().config;
    const ledger = useSyncStore.getState().ledger;
    let failOnce = true;
    vi.mocked(writeJSON).mockImplementation(async (path) => {
      if (path === 'settings.json' && failOnce) { failOnce = false; throw new Error('Disk full'); }
    });
    const file = imported({ provider: 'google-drive', enabled: true });
    await expect(applySettingsImport(file)).rejects.toThrow('Disk full');
    expect(useSyncStore.getState().config).toEqual(config);
    expect(useSyncStore.getState().ledger).toEqual(ledger);
    expect(useSettingsStore.getState().outputTokenCap).toBe(DEFAULT_SETTINGS.outputTokenCap);
    await applySettingsImport(file);
    expect(useSyncStore.getState().config.provider).toBe('google-drive');
    expect(useSettingsStore.getState().outputTokenCap).toBe(24000);
  });

  it('preserves sync configuration when importing an older settings file', async () => {
    const config = { ...useSyncStore.getState().config, provider: 'google-drive' as const, enabled: true };
    useSyncStore.setState({ config });
    await applySettingsImport(imported());
    expect(useSyncStore.getState().config).toEqual(config);
    expect(writeJSON).not.toHaveBeenCalledWith('sync/config.json', expect.anything());
  });

  it('does not finish until sync metadata is saved, even for a legacy file', async () => {
    let finish!: () => void;
    vi.mocked(writeJSON).mockImplementation(async (path) => {
      if (path === 'sync/ledger.json') await new Promise<void>((resolve) => { finish = resolve; });
    });
    let complete = false;
    const applying = applySettingsImport(imported()).then(() => { complete = true; });
    await vi.waitFor(() => expect(writeJSON).toHaveBeenCalledWith('sync/ledger.json', expect.anything()));
    expect(complete).toBe(false);
    expect(useSettingsStore.getState().outputTokenCap).toBe(DEFAULT_SETTINGS.outputTokenCap);
    finish();
    await applying;
    expect(complete).toBe(true);
    expect(useSettingsStore.getState().outputTokenCap).toBe(24000);
    vi.mocked(writeJSON).mockResolvedValue(undefined);
  });
});
