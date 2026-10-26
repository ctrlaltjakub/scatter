import { useSyncStore } from '@/store/useSyncStore';
import { clearGoogleDriveToken, GoogleDriveSyncProvider, googleDriveTokenNeedsRefresh, requestGoogleDriveToken } from './providers/googleDrive';
import { WebDavSyncProvider } from './providers/webdav';
import { requestSyncNow, scheduleSync, stopScheduledSync } from './coordinator';
import type { SyncConfig, WebDavConnection } from './types';
import { hasSyncConnection } from './connection';

export async function connectGoogleDriveSync(options: { deferSync?: boolean } = {}): Promise<void> {
  await requestGoogleDriveToken();
  const provider = new GoogleDriveSyncProvider();
  await provider.test();
  const current = useSyncStore.getState().config;
  const config: SyncConfig = { ...current, enabled: !options.deferSync, provider: 'google-drive' };
  await useSyncStore.getState().replaceConfig(config);
  useSyncStore.getState().setRuntime({ googleDriveReconnectRequired: false, error: null });
  if (!options.deferSync) scheduleSync(0);
}
export async function reconnectGoogleDriveSync(): Promise<void> {
  await requestGoogleDriveToken();
  await useSyncStore.getState().patchConfig({ provider: 'google-drive' });
  useSyncStore.getState().setRuntime({ googleDriveReconnectRequired: false, error: null });
  await requestSyncNow({ manual: true });
}

export async function connectWebDavSync(connection: WebDavConnection, options: { deferSync?: boolean } = {}): Promise<void> {
  const normalized: WebDavConnection = {
    baseUrl: connection.baseUrl.trim(),
    username: connection.username.trim(),
    appPassword: connection.appPassword,
    folder: connection.folder.trim() || 'Scatter Sync',
  };
  const provider = new WebDavSyncProvider(normalized);
  await provider.test();
  const current = useSyncStore.getState().config;
  await useSyncStore.getState().replaceConfig({
    ...current,
    enabled: !options.deferSync,
    provider: 'webdav',
    webdav: normalized,
  });
  useSyncStore.getState().setRuntime({ googleDriveReconnectRequired: false, error: null });
  if (!options.deferSync) scheduleSync(0);
}

export async function disableSync(): Promise<void> {
  stopScheduledSync();
  const store = useSyncStore.getState();
  await store.patchConfig({ enabled: false });
  // Also cancel anything scheduled while persisting the preference.
  stopScheduledSync();
  store.setRuntime({ running: false, error: null, remoteUpdate: null, googleDriveReconnectRequired: false });
}

/** Resume the saved connection; only ask Google again when authorization expired. */
export async function resumeSync(): Promise<void> {
  const store = useSyncStore.getState();
  if (!store.config.provider) return;
  if (store.config.provider === 'google-drive' && googleDriveTokenNeedsRefresh()) {
    await requestGoogleDriveToken();
  }
  await store.patchConfig({ enabled: true });
  store.setRuntime({ googleDriveReconnectRequired: false, error: null });
  scheduleSync(0);
}

export async function disconnectSync(): Promise<void> {
  stopScheduledSync();
  const store = useSyncStore.getState();
  clearGoogleDriveToken();
  await store.replaceConfig({
    schemaVersion: 1,
    enabled: false,
    provider: null,
    deviceId: store.config.deviceId,
    deviceName: store.config.deviceName,
  });
  store.setRuntime({
    running: false,
    error: null,
    remoteUpdate: null,
    projectHistory: {},
    preferenceHistory: [],
    googleDriveReconnectRequired: false,
  });
}

export async function renameSyncDevice(deviceName: string): Promise<void> {
  const trimmed = deviceName.trim();
  if (!trimmed) return;
  await useSyncStore.getState().patchConfig({ deviceName: trimmed });
}

export function syncStatusLabel(projectId: string, store = useSyncStore.getState()): string {
  if (!hasSyncConnection(store.config)) return 'SYNC NOT CONNECTED';
  if (store.remoteUpdate?.projectId === projectId) return 'REMOTE UPDATE AVAILABLE';
  // A manual run is active even with automatic syncing paused. Include the
  // initial connection/index check, before individual ledger entries change.
  if (store.running) return 'SYNCING';
  if (store.error) return 'SYNC FAILED';
  if (!store.config.enabled) return 'SYNC PAUSED';
  const entry = store.ledger.projects[projectId];
  const status = entry?.status ?? 'pending';
  if (status === 'synced') return 'SYNCED';
  if (status === 'syncing') return 'SYNCING';
  if (status === 'remote-update') return 'REMOTE UPDATE AVAILABLE';
  if (status === 'paused') return 'SYNC PAUSED';
  return entry?.lastSyncedAt ? 'CHANGES PENDING' : 'NOT SYNCED';
}
