import { useSettingsStore } from '@/store/useSettingsStore';
import { useSyncStore } from '@/store/useSyncStore';
import { defaultSyncLedger, flushSyncPersistence } from '@/sync/local';
import { suspendSyncForSettingsImport } from '@/sync/coordinator';
import { hasGoogleDriveAccessToken } from '@/sync/providers/googleDrive';
import { settingsSyncPreferences, type ImportedSettings } from './settingsTransfer';

/** Shared by onboarding and Settings. Finish every settings/sync write before
 * the caller reloads, and never move device identity or sync baselines. */
export async function applySettingsImport(imported: ImportedSettings): Promise<void> {
  await useSyncStore.getState().hydrate();
  const resume = await suspendSyncForSettingsImport();
  const store = useSyncStore.getState();
  const current = store.config;
  const previousLedger = store.ledger;
  try {
    if (imported.syncPreferences) {
      const connection = imported.syncPreferences;
      const previous = settingsSyncPreferences(current);
      const changed = previous.provider !== connection.provider
        || JSON.stringify(previous.webdav) !== JSON.stringify(connection.webdav);
      await store.replaceConfig({
        schemaVersion: 1,
        deviceId: current.deviceId,
        deviceName: current.deviceName,
        ...connection,
        // A new browser still needs Google authorization. An already-authorized
        // Google connection on this device can resume without another Connect.
        enabled: connection.enabled && (connection.provider !== 'google-drive'
          || (current.provider === 'google-drive' && hasGoogleDriveAccessToken())),
      });
      await store.replaceLedger({
        ...(changed ? defaultSyncLedger() : useSyncStore.getState().ledger),
        settingsEditedAt: Date.now(),
      });
    } else {
      // Legacy exports contain no sync settings, but applying their preferences
      // still needs durable bookkeeping before reload.
      await store.replaceLedger({ ...store.ledger, settingsEditedAt: Date.now() });
    }
    await flushSyncPersistence();
    // Publishing providers can immediately unmount onboarding. Do it only once
    // all sync configuration/metadata is durable, so errors stay visible there.
    const currentSettings = useSettingsStore.getState();
    await currentSettings.replaceSettings({
      ...imported.settings,
      // Current exports omit exploration history. Importing preferences must
      // not erase this device's history; older files can still restore theirs.
      topicHistory: imported.settings.topicHistory ?? currentSettings.topicHistory,
      chatStartHistory: imported.settings.chatStartHistory ?? currentSettings.chatStartHistory,
    });
  } catch (error) {
    try {
      await store.replaceConfig(current);
      await store.replaceLedger(previousLedger);
      await flushSyncPersistence();
    } catch (cause) {
      console.error('[scatter] sync configuration could not be restored after import failure', cause);
      // Do not restart cloud writes against a partially replaced destination.
      throw error;
    }
    await resume().catch((cause) => console.error('[scatter] sync could not resume after import failure', cause));
    throw error;
  }
}
