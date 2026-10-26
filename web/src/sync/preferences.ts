import { normalizeSettings } from '@/opfs/settingsIO';
import { settingsSnapshot } from '@/store/settingsSnapshot';
import { useSettingsStore } from '@/store/useSettingsStore';
import type { ProviderAccount, Settings } from '@/store/types';
import type { SyncedPreferences } from './types';

function providerKey(provider: ProviderAccount): string {
  // Paths can be case-sensitive. Reusing a key requires the same destination,
  // not merely a matching connection ID copied from an export.
  return `${provider.preset}\n${(provider.baseUrl ?? '').trim().replace(/\/$/, '')}`;
}
/** Credentials are excluded unless the user explicitly enables key syncing.
 * This shared setting travels with the snapshot so restored devices use the
 * same policy; sync-service credentials are never part of Settings. */
export function createSyncedPreferences(settings: Settings, projectOrder: string[]): SyncedPreferences {
  const snapshot = settingsSnapshot(settings);
  return {
    settings: {
      ...snapshot,
      providers: snapshot.providers.map((provider) => ({ ...provider, apiKey: settings.syncApiKeys === true ? provider.apiKey : '' })),
    },
    projectOrder,
  };
}

export function mergeLocalCredentials(remote: Settings, local: Settings): Settings {
  const exact = new Map(local.providers.map((provider) => [provider.id, provider]));
  const semantic = new Map<string, ProviderAccount[]>();
  for (const provider of local.providers) {
    const key = providerKey(provider);
    semantic.set(key, [...(semantic.get(key) ?? []), provider]);
  }
  const providers = remote.providers.map((provider) => {
    const sameId = exact.get(provider.id);
    const matches = semantic.get(providerKey(provider)) ?? [];
    const credentialOwner = sameId && providerKey(sameId) === providerKey(provider)
      ? sameId : matches.length === 1 ? matches[0] : undefined;
    return { ...provider, apiKey: credentialOwner?.apiKey ?? '' };
  });
  return normalizeSettings({ ...remote, providers });
}

export async function applySyncedPreferences(preferences: SyncedPreferences): Promise<void> {
  const local = useSettingsStore.getState();
  // Only marked, opt-in snapshots are authoritative for keys (including a
  // deliberately cleared key). Legacy/opt-out snapshots preserve local keys.
  await local.replaceSettings(preferences.settings.syncApiKeys === true
    ? normalizeSettings(preferences.settings)
    : mergeLocalCredentials(preferences.settings, local));
  // Appearance belongs to this device. Ignore theme values in older snapshots.
}
