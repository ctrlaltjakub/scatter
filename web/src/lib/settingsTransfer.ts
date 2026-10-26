import { normalizeSettings } from '@/opfs/settingsIO';
import { settingsSnapshot } from '@/store/settingsSnapshot';
import type { Settings } from '@/store/types';
import { useSyncStore } from '@/store/useSyncStore';
import type { SyncConfig } from '@/sync/types';
import {
  applyThemePreference,
  DEFAULT_THEME_PREFERENCE,
  normalizeThemePreference,
  readThemePreference,
  type ThemePreference,
} from './theme';
import {
  normalizeSidebarDisclosures,
  readSidebarDisclosures,
  writeSidebarDisclosures,
  type SidebarDisclosureState,
} from './sidebarPreferences';
import {
  normalizeLastGroupMemory,
  readLastGroupMemory,
  writeLastGroupMemory,
  type LastGroupMemory,
} from './sidebarGroupMemory';

export const SETTINGS_EXPORT_FORMAT = 'scatter-settings';
// v3 carries advanced-default baselines and no saved prompt/layout versions.
// Older apps reject it instead of restoring overrides without these checks.
export const SETTINGS_EXPORT_VERSION = 3;

/** Portable connection only: device identity, sync ledger and OAuth tokens
 * must never be copied to another device. WebDAV passwords are portable. */
export type SettingsSyncPreferences = Pick<SyncConfig, 'enabled' | 'provider' | 'webdav'>;

export function settingsSyncPreferences(config: SyncConfig): SettingsSyncPreferences {
  return {
    enabled: config.enabled,
    provider: config.provider,
    ...(config.provider === 'webdav' && config.webdav ? { webdav: { ...config.webdav } } : {}),
  };
}

export interface SettingsUiPreferences {
  theme: ThemePreference;
  sidebarDisclosures: SidebarDisclosureState;
  lastInteractedGroups: LastGroupMemory;
}

interface SettingsEnvelope {
  format: typeof SETTINGS_EXPORT_FORMAT;
  formatVersion: number;
  exportedAt: number;
  settings: Settings;
  uiPreferences: SettingsUiPreferences;
  syncPreferences: SettingsSyncPreferences;
}

export interface ImportedSettings {
  settings: Settings;
  uiPreferences: SettingsUiPreferences;
  /** Absent in older exports. Leave the receiving device's sync setup alone. */
  syncPreferences?: SettingsSyncPreferences;
}

export class SettingsImportError extends Error {}

const NOT_SETTINGS = 'This file doesn’t look like a Scatter settings export.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function currentSettingsUiPreferences(): SettingsUiPreferences {
  return {
    theme: readThemePreference(),
    sidebarDisclosures: readSidebarDisclosures(),
    lastInteractedGroups: readLastGroupMemory(),
  };
}

export function createSettingsExport(
  settings: Settings,
  uiPreferences = currentSettingsUiPreferences(),
  exportedAt = Date.now(),
  syncConfig = useSyncStore.getState().config,
  options: { includeSecrets?: boolean } = {},
): { blob: Blob; filename: string } {
  const includeSecrets = options.includeSecrets !== false;
  const snapshot = settingsSnapshot(settings);
  // Files transfer configuration, not the user's exploration history. Keep
  // these fields in the shared persistence/sync snapshot, but never export them.
  delete snapshot.topicHistory;
  delete snapshot.chatStartHistory;
  const syncPreferences = settingsSyncPreferences(syncConfig);
  if (!includeSecrets) {
    snapshot.providers = snapshot.providers.map((provider) => ({ ...provider, apiKey: '' }));
    // A shared, sanitized export must not enroll subsequently entered keys.
    snapshot.syncApiKeys = false;
    // A portable, credential-free configuration must not start failed syncs on import.
    syncPreferences.enabled = false;
    if (syncPreferences.webdav) syncPreferences.webdav.appPassword = '';
  }
  const envelope: SettingsEnvelope = {
    format: SETTINGS_EXPORT_FORMAT,
    formatVersion: SETTINGS_EXPORT_VERSION,
    exportedAt,
    settings: snapshot,
    uiPreferences,
    syncPreferences,
  };
  const date = new Date(exportedAt).toISOString().slice(0, 10);
  return {
    blob: new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' }),
    filename: `scatter-settings${includeSecrets ? '' : '-without-secrets'}-${date}.json`,
  };
}

export function parseSettingsExport(raw: unknown): ImportedSettings {
  if (!isRecord(raw) || raw.format !== SETTINGS_EXPORT_FORMAT) {
    throw new SettingsImportError(NOT_SETTINGS);
  }
  if (
    typeof raw.formatVersion !== 'number'
    || raw.formatVersion < 1
    || raw.formatVersion > SETTINGS_EXPORT_VERSION
  ) {
    throw new SettingsImportError(
      typeof raw.formatVersion === 'number' && raw.formatVersion > SETTINGS_EXPORT_VERSION
        ? 'This settings file was created by a newer Scatter version.'
        : NOT_SETTINGS,
    );
  }
  if (!isRecord(raw.settings) || !Array.isArray(raw.settings.providers)) {
    throw new SettingsImportError(NOT_SETTINGS);
  }

  const ui = isRecord(raw.uiPreferences) ? raw.uiPreferences : {};
  let syncPreferences: SettingsSyncPreferences | undefined;
  if (raw.syncPreferences !== undefined || raw.formatVersion >= 2) {
    const sync = raw.syncPreferences;
    if (!isRecord(sync) || typeof sync.enabled !== 'boolean'
      || ![null, 'google-drive', 'webdav'].includes(sync.provider as null | string)
      || (sync.enabled && sync.provider === null)) {
      throw new SettingsImportError('The settings file has invalid synchronization settings.');
    }
    syncPreferences = { enabled: sync.enabled, provider: sync.provider as SyncConfig['provider'] };
    if (sync.provider === 'webdav') {
      const dav = sync.webdav;
      if (!isRecord(dav) || !['baseUrl', 'username', 'appPassword', 'folder'].every((key) => typeof dav[key] === 'string')) {
        throw new SettingsImportError('The settings file has incomplete WebDAV connection settings.');
      }
      const baseUrl = (dav.baseUrl as string).trim();
      try {
        const url = new URL(baseUrl);
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error();
      } catch {
        throw new SettingsImportError('The settings file has an invalid WebDAV server address.');
      }
      syncPreferences.webdav = {
        baseUrl,
        username: (dav.username as string).trim(),
        appPassword: dav.appPassword as string,
        folder: (dav.folder as string).trim() || 'Scatter Sync',
      };
    }
  }
  return {
    settings: normalizeSettings(raw.settings),
    ...(syncPreferences ? { syncPreferences } : {}),
    uiPreferences: {
      theme: normalizeThemePreference(
        typeof ui.theme === 'string' ? ui.theme : null,
      ) ?? DEFAULT_THEME_PREFERENCE,
      sidebarDisclosures: normalizeSidebarDisclosures(ui.sidebarDisclosures),
      lastInteractedGroups: normalizeLastGroupMemory(ui.lastInteractedGroups),
    },
  };
}

export async function parseSettingsFile(file: File): Promise<ImportedSettings> {
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new SettingsImportError(NOT_SETTINGS);
  }
  return parseSettingsExport(raw);
}

export function applySettingsUiPreferences(preferences: SettingsUiPreferences): void {
  applyThemePreference(preferences.theme);
  writeSidebarDisclosures(preferences.sidebarDisclosures);
  writeLastGroupMemory(preferences.lastInteractedGroups);
}
