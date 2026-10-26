import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '@/store/types';
import { useSettingsStore } from '@/store/useSettingsStore';
import { saveSettings } from '@/opfs/settingsIO';
import { customFontFixture as font } from '@/test/customFontFixture';
import { applySyncedPreferences, createSyncedPreferences } from './preferences';
import { decodeEnvelope, encodeEnvelope } from './codec';
import { SYNC_FORMAT, SYNC_FORMAT_VERSION, type PreferencesSnapshotEnvelope } from './types';

vi.mock('@/opfs/settingsIO', async original => ({
  ...await original<typeof import('@/opfs/settingsIO')>(), saveSettings: vi.fn(async () => {}),
}));
afterEach(() => { useSettingsStore.setState({ ...DEFAULT_SETTINGS }); vi.clearAllMocks(); });

describe('custom fonts in synchronized settings', () => {
  it.each([true, false])('restores files and selection with API key syncing=%s', async syncApiKeys => {
    const preferences = createSyncedPreferences({ ...DEFAULT_SETTINGS, customNodeFonts: [font], nodeFontId: font.id, syncApiKeys }, []);
    const snapshot: PreferencesSnapshotEnvelope = {
      format: SYNC_FORMAT, formatVersion: SYNC_FORMAT_VERSION, kind: 'preferences',
      editedAt: 10, sequence: 1, deviceId: 'source', deviceName: 'Source', hash: 'test', preferences,
    };
    // This codec is shared by Google Drive and WebDAV, including onboarding restore.
    const decoded = await decodeEnvelope(await encodeEnvelope(snapshot));
    if (decoded.kind !== 'preferences') throw new Error('Wrong snapshot kind');
    useSettingsStore.setState({ ...DEFAULT_SETTINGS });
    await applySyncedPreferences(decoded.preferences);
    expect(useSettingsStore.getState()).toMatchObject({ customNodeFonts: [font], nodeFontId: font.id });
    expect(saveSettings).toHaveBeenCalledWith(expect.objectContaining({ customNodeFonts: [font], nodeFontId: font.id }));
  });
  it('propagates removals and falls back if the selected font is absent', async () => {
    useSettingsStore.setState({ customNodeFonts: [font], nodeFontId: font.id });
    await applySyncedPreferences({ settings: { ...DEFAULT_SETTINGS, nodeFontId: font.id }, projectOrder: [] });
    expect(useSettingsStore.getState()).toMatchObject({ customNodeFonts: [], nodeFontId: 'app' });
  });
});
