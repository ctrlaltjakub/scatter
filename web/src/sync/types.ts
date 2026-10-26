import type { Project, Settings } from '@/store/types';
import type { ThemePreference } from '@/lib/theme';

export const SYNC_FORMAT = 'scatter-sync';
export const SYNC_FORMAT_VERSION = 1;
export const SYNC_HISTORY_LIMIT = 10;

export type SyncProviderKind = 'google-drive' | 'webdav';
export type ProjectSyncStatus =
  | 'pending'
  | 'syncing'
  | 'synced'
  | 'remote-update'
  | 'paused';

export interface WebDavConnection {
  baseUrl: string;
  username: string;
  appPassword: string;
  folder: string;
}

/** Stored only in this browser. No token or WebDAV credential enters a remote snapshot. */
export interface SyncConfig {
  schemaVersion: 1;
  /** Automatic syncing only; an explicit manual run may bypass this flag. */
  enabled: boolean;
  provider: SyncProviderKind | null;
  deviceId: string;
  deviceName: string;
  webdav?: WebDavConnection;
}

export interface ProjectSyncLedgerEntry {
  projectId: string;
  localEditedAt: number;
  /** Monotonic edit counter, including edits within the same millisecond. */
  localRevision?: number;
  lastSyncedHash?: string;
  lastSyncedAt?: number;
  status: ProjectSyncStatus;
  deleted?: boolean;
  error?: string;
}

export interface SyncLedger {
  schemaVersion: 1;
  projects: Record<string, ProjectSyncLedgerEntry>;
  knownProjectIds: string[];
  settingsEditedAt: number;
  settingsRevision?: number;
  settingsHash?: string;
  /** Download-first setup restores this order after projects arrive on the first sync. */
  restoredProjectOrder?: string[];
  lastSyncedAt?: number;
  /** Display metadata survives local deletion; never used to decide sync conflicts. */
  historyTitles?: Record<string, { name?: string; snapshotName?: string }>;
  /** Immutable snapshot name → original timestamp for restored copies. */
  restoredSnapshots?: Record<string, number>;
}

export interface SyncedPreferences {
  settings: Settings;
  /** Legacy snapshots only; never uploaded or applied by current clients. */
  theme?: ThemePreference;
  projectOrder: string[];
}

export interface ProjectSnapshotEnvelope {
  format: typeof SYNC_FORMAT;
  formatVersion: typeof SYNC_FORMAT_VERSION;
  kind: 'project';
  projectId: string;
  /** Kept even in deletion snapshots, which intentionally omit project content. */
  projectName?: string;
  editedAt: number;
  sequence: number;
  deviceId: string;
  deviceName: string;
  hash: string;
  deleted: boolean;
  /** Compatibility union. Older clients download every entry as a media blob;
   * new clients use the typed lists below and fetch lazy originals on demand. */
  assetIds: string[];
  mediaAssetIds?: string[];
  sourceAssetIds?: string[];
  lazySourceAssetIds?: string[];
  project?: Project;
  restoredFrom?: number;
}

export interface PreferencesSnapshotEnvelope {
  format: typeof SYNC_FORMAT;
  formatVersion: typeof SYNC_FORMAT_VERSION;
  kind: 'preferences';
  editedAt: number;
  sequence: number;
  deviceId: string;
  deviceName: string;
  hash: string;
  preferences: SyncedPreferences;
  restoredFrom?: number;
}

/** Small navigation record; never participates in project-content conflicts. */
export interface ProjectViewEnvelope {
  format: typeof SYNC_FORMAT;
  formatVersion: typeof SYNC_FORMAT_VERSION;
  kind: 'view';
  projectId: string;
  editedAt: number;
  sequence: number;
  deviceId: string;
  viewport: Project['viewport'];
}

export type SyncSnapshotEnvelope = ProjectSnapshotEnvelope | PreferencesSnapshotEnvelope | ProjectViewEnvelope;

export interface RemoteObject {
  /** Stable legacy objects omit this field. */
  namespace?: 'beta';
  id: string;
  name: string;
  size?: number;
  modifiedAt?: number;
  etag?: string;
}

export interface SyncProvider {
  readonly kind: SyncProviderKind;
  test(): Promise<void>;
  list(): Promise<RemoteObject[]>;
  read(object: RemoteObject): Promise<Blob>;
  write(name: string, data: Blob): Promise<RemoteObject>;
  remove(object: RemoteObject): Promise<void>;
  /** Scope the disposable index to this destination/authorization. Never a credential. */
  indexScope?(): Promise<string>;
  changes?(cursor?: string): Promise<RemoteChanges>;
}

export interface RemoteChanges {
  /** A full listing replaces the cache; deltas update it by remote object ID. */
  reset: boolean;
  objects: RemoteObject[];
  removedIds: string[];
  cursor: string;
}

export interface ParsedSnapshotName {
  kind: 'project' | 'preferences' | 'asset' | 'view';
  projectId?: string;
  assetId?: string;
  editedAt?: number;
  sequence?: number;
  deviceId?: string;
  hash?: string;
  deleted?: boolean;
}

export interface RemoteProjectUpdate {
  projectId: string;
  local: Project;
  remote: ProjectSnapshotEnvelope;
  object: RemoteObject;
  /** Runtime-only developer preview. Resolving closes the modal without syncing. */
  previewOnly?: boolean;
}
