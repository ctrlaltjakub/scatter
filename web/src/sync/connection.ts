import type { SyncConfig } from './types';

/** A saved Google connection remains configured when its short-lived token expires. */
export function hasSyncConnection(config: SyncConfig): boolean {
  return config.provider !== null
    && (config.provider !== 'webdav' || !!config.webdav?.appPassword);
}
