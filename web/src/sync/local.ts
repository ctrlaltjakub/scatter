import { readJSON, writeJSON } from '@/opfs/storage';
import { newId } from '@/lib/ids';
import type { SyncConfig, SyncLedger } from './types';

const CONFIG_PATH = 'sync/config.json';
const LEDGER_PATH = 'sync/ledger.json';

// Serialize metadata writes: an older writable must not close after a newer
// one and replace it. Imports also drain this queue before reloading the page.
let pendingWrites: Promise<void> = Promise.resolve();
function persist(path: string, value: unknown): Promise<void> {
  const snapshot = structuredClone(value);
  const write = pendingWrites.catch(() => undefined).then(() => writeJSON(path, snapshot));
  pendingWrites = write;
  return write;
}

export async function flushSyncPersistence(): Promise<void> {
  let pending: Promise<void>;
  do {
    pending = pendingWrites;
    await pending;
  } while (pending !== pendingWrites);
}

function defaultDeviceName(): string {
  if (typeof navigator === 'undefined') return 'Scatter device';
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } })
    .userAgentData?.platform || navigator.platform || '';
  if (/mac/i.test(platform)) return 'Mac';
  if (/win/i.test(platform)) return 'Windows PC';
  if (/linux/i.test(platform)) return 'Linux PC';
  return 'Scatter device';
}

export function defaultSyncConfig(): SyncConfig {
  return {
    schemaVersion: 1,
    enabled: false,
    provider: null,
    deviceId: newId(),
    deviceName: defaultDeviceName(),
  };
}

export function defaultSyncLedger(): SyncLedger {
  return {
    schemaVersion: 1,
    projects: {},
    knownProjectIds: [],
    settingsEditedAt: 0,
  };
}

export async function loadSyncConfig(): Promise<SyncConfig> {
  const raw = await readJSON<Partial<SyncConfig>>(CONFIG_PATH, { allowEmpty: true });
  const fallback = defaultSyncConfig();
  if (!raw || raw.schemaVersion !== 1) return fallback;
  return {
    schemaVersion: 1,
    enabled: raw.enabled === true,
    provider: raw.provider === 'google-drive' || raw.provider === 'webdav'
      ? raw.provider
      : null,
    deviceId: typeof raw.deviceId === 'string' && raw.deviceId ? raw.deviceId : fallback.deviceId,
    deviceName: typeof raw.deviceName === 'string' && raw.deviceName.trim()
      ? raw.deviceName.trim()
      : fallback.deviceName,
    ...(raw.webdav && typeof raw.webdav === 'object'
      ? {
          webdav: {
            baseUrl: String(raw.webdav.baseUrl ?? ''),
            username: String(raw.webdav.username ?? ''),
            appPassword: String(raw.webdav.appPassword ?? ''),
            folder: String(raw.webdav.folder ?? 'Scatter Sync'),
          },
        }
      : {}),
  };
}

export function saveSyncConfig(config: SyncConfig): Promise<void> {
  return persist(CONFIG_PATH, config);
}

export async function loadSyncLedger(): Promise<SyncLedger> {
  const raw = await readJSON<Partial<SyncLedger>>(LEDGER_PATH, { allowEmpty: true });
  if (!raw || raw.schemaVersion !== 1) return defaultSyncLedger();
  return {
    schemaVersion: 1,
    projects: raw.projects && typeof raw.projects === 'object' ? raw.projects : {},
    knownProjectIds: Array.isArray(raw.knownProjectIds)
      ? raw.knownProjectIds.filter((id): id is string => typeof id === 'string')
      : [],
    settingsEditedAt: typeof raw.settingsEditedAt === 'number' ? raw.settingsEditedAt : 0,
    settingsRevision: typeof raw.settingsRevision === 'number' ? raw.settingsRevision : 0,
    settingsHash: typeof raw.settingsHash === 'string' ? raw.settingsHash : undefined,
    restoredProjectOrder: Array.isArray(raw.restoredProjectOrder)
      ? [...new Set(raw.restoredProjectOrder.filter((id): id is string => typeof id === 'string'))] : undefined,
    lastSyncedAt: typeof raw.lastSyncedAt === 'number' ? raw.lastSyncedAt : undefined,
    historyTitles: raw.historyTitles && typeof raw.historyTitles === 'object'
      ? Object.fromEntries(Object.entries(raw.historyTitles).filter(([, title]) => (
          title && typeof title === 'object'
          && (title.name === undefined || typeof title.name === 'string')
          && (title.snapshotName === undefined || typeof title.snapshotName === 'string')
        )))
      : {},
    restoredSnapshots: raw.restoredSnapshots && typeof raw.restoredSnapshots === 'object'
      ? Object.fromEntries(Object.entries(raw.restoredSnapshots).filter(([, time]) => typeof time === 'number' && Number.isFinite(time) && time >= 0))
      : {},
  };
}

export function saveSyncLedger(ledger: SyncLedger): Promise<void> {
  return persist(LEDGER_PATH, ledger);
}
