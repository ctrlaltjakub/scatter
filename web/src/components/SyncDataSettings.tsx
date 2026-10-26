'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Cloud, CloudOff, RefreshCw, Server, Trash2 } from 'lucide-react';
import { LayerArrowDown } from './icons/LayerArrowDown';
import { SyncHistoryPicker } from './settings/SyncHistoryPicker';
import { useGraphStore } from '@/store/useGraphStore';
import { useSyncStore, type SyncHistoryEntry } from '@/store/useSyncStore';
import { syncFailureMessage } from '@/sync/requestTimeout';
import { hasSyncConnection } from '@/sync/connection';
import { useSettingsStore } from '@/store/useSettingsStore';
import { SettingsToggle } from './settings/SettingsSection';
import {
  connectGoogleDriveSync,
  connectWebDavSync,
  disableSync,
  disconnectSync,
  reconnectGoogleDriveSync,
  renameSyncDevice,
  resumeSync,
} from '@/sync/actions';
import { deleteSyncHistoryEntry, requestSyncNow, restorePreferencesHistory, restoreProjectHistory, restoreSetupFromSync } from '@/sync/coordinator';
import { compareSnapshotObjects } from '@/sync/codec';
import type { SyncProviderKind } from '@/sync/types';
import { historyProjectLabel, historyProjectGroups } from '@/sync/history';
import { googleDriveTokenNeedsRefresh } from '@/sync/providers/googleDrive';
import { releaseChannel } from '@/lib/deployment';

function formatTime(value?: number): string {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function HistoryRow({
  entry,
  target,
  onRestore,
  onDelete,
  latest,
  busy,
}: {
  entry: SyncHistoryEntry;
  target: string;
  onRestore: () => Promise<void>;
  onDelete: () => Promise<void>;
  latest: boolean;
  busy: boolean;
}) {
  const [working, setWorking] = useState<'restore' | 'delete' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const perform = async (action: 'restore' | 'delete') => {
    setWorking(action);
    setError(null);
    try {
      await (action === 'restore' ? onRestore() : onDelete());
      setConfirmDelete(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setWorking(null); }
  };
  return (
    <div className="sync-history-row">
      <span>
        {formatTime(entry.editedAt)}
        {entry.deleted ? <small>Deleted</small> : null}
        {entry.restoredFrom != null ? <small title={`Restored from ${formatTime(entry.restoredFrom)}`}>Restored</small> : null}
        {latest ? <small className="sync-history-latest">Latest</small> : null}
      </span>
      <div className="sync-history-actions">
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!!working || busy || entry.deleted}
          aria-label={`Restore ${target} from ${formatTime(entry.editedAt)}`}
          onClick={() => void perform('restore')}
        >
          <LayerArrowDown size={14} aria-hidden="true" /> {working === 'restore' ? 'Restoring…' : 'Restore'}
        </button>
        <button type="button" className="btn btn-ghost" disabled={!!working || busy || latest}
          aria-label={`Delete ${target} snapshot from ${formatTime(entry.editedAt)}`}
          title={latest ? 'The latest snapshot is required for syncing' : 'Delete snapshot'}
          aria-expanded={confirmDelete && !latest}
          onClick={() => { setConfirmDelete(value => !value); setError(null); }}>
          <Trash2 size={14} aria-hidden="true" />
        </button>
      </div>
      {confirmDelete && !latest && <div className="sync-history-confirm" role="group" aria-label="Confirm snapshot deletion">
        <span>Delete this cloud snapshot? <strong>This cannot be undone.</strong></span>
        <button type="button" className="btn btn-ghost" disabled={!!working} onClick={() => setConfirmDelete(false)}>Cancel</button>
        <button type="button" className="btn btn-secondary settings-danger-action" disabled={!!working || busy} onClick={() => void perform('delete')}>
          {working === 'delete' ? 'Deleting…' : 'Delete snapshot'}
        </button>
      </div>}
      {error ? <span className="sync-inline-error" role="alert">{error}</span> : null}
    </div>
  );
}

export function SyncDataSettings({ onRestored, onWorkingChange }: { onRestored?: () => void; onWorkingChange?: (working: boolean) => void } = {}) {
  const hydrated = useSyncStore((state) => state.hydrated);
  const config = useSyncStore((state) => state.config);
  const syncApiKeys = useSettingsStore(state => state.syncApiKeys);
  const setSyncApiKeys = useSettingsStore(state => state.setSyncApiKeys);
  const ledger = useSyncStore((state) => state.ledger);
  const running = useSyncStore((state) => state.running);
  const syncError = useSyncStore((state) => state.error);
  const projectHistory = useSyncStore((state) => state.projectHistory);
  const preferenceHistory = useSyncStore((state) => state.preferenceHistory);
  const projectList = useGraphStore((state) => state.projectList);
  const [provider, setProvider] = useState<SyncProviderKind>(config.provider ?? 'google-drive');
  const [baseUrl, setBaseUrl] = useState(config.webdav?.baseUrl ?? '');
  const [username, setUsername] = useState(config.webdav?.username ?? '');
  const [appPassword, setAppPassword] = useState(config.webdav?.appPassword ?? '');
  const [folder, setFolder] = useState(config.webdav?.folder ?? 'Scatter Sync');
  const [deviceName, setDeviceName] = useState(config.deviceName);
  const [working, setWorking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const historyGroups = useMemo(() => historyProjectGroups(projectHistory,
    new Set(projectList.map(project => project.id))), [projectHistory, projectList]);
  const [historyTarget, setHistoryTarget] = useState('preferences');
  const connected = hasSyncConnection(config);
  const historyEntries = useMemo(() => [...(historyTarget === 'preferences'
    ? preferenceHistory : projectHistory[historyTarget] ?? [])]
    .sort((a, b) => b.editedAt - a.editedAt || compareSnapshotObjects(b.object, a.object)),
  [historyTarget, preferenceHistory, projectHistory]);
  useEffect(() => {
    if (historyTarget !== 'preferences' && ![...historyGroups.active, ...historyGroups.deleted].includes(historyTarget)) {
      setHistoryTarget('preferences');
    }
  }, [historyTarget, historyGroups]);

  useEffect(() => {
    if (hydrated) return;
    void useSyncStore
      .getState()
      .hydrate()
      .catch((cause) => {
        setLocalError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [hydrated]);
  useEffect(() => {
    if (!hydrated) return;
    setProvider(config.provider ?? 'google-drive');
    setBaseUrl(config.webdav?.baseUrl ?? '');
    setUsername(config.webdav?.username ?? '');
    setAppPassword(config.webdav?.appPassword ?? '');
    setFolder(config.webdav?.folder ?? 'Scatter Sync');
    setDeviceName(config.deviceName);
  }, [config, hydrated]);

  const run = async (action: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    onWorkingChange?.(true);
    setLocalError(null);
    try {
      await action();
    } catch (cause) {
      setLocalError(syncFailureMessage(cause));
    } finally {
      setWorking(false);
      onWorkingChange?.(false);
    }
  };

  const connect = () =>
    run(async () => {
      if (provider === 'google-drive') await connectGoogleDriveSync({ deferSync: !!onRestored });
      else await connectWebDavSync({ baseUrl, username, appPassword, folder }, { deferSync: !!onRestored });
      if (onRestored) { await restoreSetupFromSync(); onRestored(); }
    });

  const reconnect = () =>
    run(async () => {
      if (config.provider === 'google-drive') await reconnectGoogleDriveSync();
      else if (config.webdav) await connectWebDavSync(config.webdav);
    });

  const projectName = (id: string) => {
    const local = projectList.find((project) => project.id === id);
    return historyProjectLabel(
      local?.name ?? ledger.historyTitles?.[id]?.name,
      !local && historyGroups.deleted.includes(id),
    );
  };

  return (
    <section className="sync-settings" aria-labelledby="sync-settings-title">
      {releaseChannel() === 'beta' && <p className="field-help"><strong>Beta sync is separate.</strong> Projects and settings sync only with other beta instances, even when using the same Google Drive or WebDAV account. Import a project file to copy it from stable.</p>}
      <div className="sync-settings-title-row">
        <div>
          <div id="sync-settings-title" className="sync-settings-title">
            Projects and settings
          </div>
          <p><strong>Local saving</strong> always continues. Automatic sync runs while <strong>enabled</strong> and the app is open. You can also sync manually.</p>
        </div>
        <span
          className={'sync-state-pill' + (syncError && connected ? ' has-error' : config.enabled || running ? ' enabled' : '')}
          role="status"
        >
          {config.enabled || running ? <Cloud size={14} /> : <CloudOff size={14} />}
          {running ? 'Syncing' : syncError && connected ? 'Needs attention' : config.enabled ? 'Enabled' : connected ? 'Automatic sync paused' : 'Off'}
        </span>
      </div>

      {!connected ? (
        <>
          <div className="settings-sync-providers" role="group" aria-label="Sync provider">
            <button
              type="button"
              aria-label="Google Drive"
              aria-pressed={provider === 'google-drive'}
              onClick={() => setProvider('google-drive')}
            >
              <Cloud size={20} />
              <span>
                <strong>Google Drive</strong>
                <small>Your private app-data folder</small>
              </span>
              {provider === 'google-drive' && <Check size={15} />}
            </button>
            <button
              type="button"
              aria-label="WebDAV / Nextcloud"
              aria-pressed={provider === 'webdav'}
              onClick={() => setProvider('webdav')}
            >
              <Server size={20} />
              <span>
                <strong>WebDAV / Nextcloud</strong>
                <small>Your own server and storage</small>
              </span>
              {provider === 'webdav' && <Check size={15} />}
            </button>
          </div>
          {provider === 'webdav' ? (
            <div className="sync-webdav-fields">
              <label>
                Server WebDAV URL
                <input
                  className="input"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="https://cloud.example.com/remote.php/dav/files/name/"
                />
              </label>
              <label>
                Username
                <input
                  className="input"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                />
              </label>
              <label>
                App password
                <input
                  className="input"
                  type="password"
                  value={appPassword}
                  onChange={(event) => setAppPassword(event.target.value)}
                  autoComplete="current-password"
                />
              </label>
              <label>
                Remote folder
                <input className="input" value={folder} onChange={(event) => setFolder(event.target.value)} />
              </label>
              <p className="field-help">
                <strong>WebDAV</strong> lets the app store files on your own server, such as Nextcloud.
                The server must allow <strong>connections from the app’s website</strong> (CORS).
                Credentials stay on this device and in full settings exports. They are <strong>excluded from cloud snapshots</strong>.
              </p>
            </div>
          ) : (
            <p className="field-help">
              The app can access only its <strong>hidden app-data folder</strong>, not your other Drive files.{' '}
              <GoogleDriveRenewalNote />
            </p>
          )}
          <button
            type="button"
            className="btn btn-primary settings-connect-sync"
            disabled={working}
            onClick={() => void connect()}
          >
            <Cloud size={15} />{' '}
            {working
              ? 'Connecting…'
              : provider === 'google-drive'
                ? 'Connect Google Drive'
                : 'Connect WebDAV'}
          </button>
        </>
      ) : (
        <>
          {!config.enabled && <p className="field-help"><strong>Automatic syncing is paused.</strong> {onRestored ? 'Restore your saved setup first. Synchronization resumes after onboarding.' : 'Your connection is saved. Manual syncing remains available.'}</p>}
          {config.provider === 'google-drive' && <p className="field-help">
            {config.enabled ? <GoogleDriveRenewalNote /> : <GoogleDrivePopupNote />}
          </p>}
          <div className="field-row">
            <label className="field-label" htmlFor="sync-device-name">
              This device&apos;s name
            </label>
            <input
              id="sync-device-name"
              className="input"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              onBlur={() => void renameSyncDevice(deviceName)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
          </div>
          <div className="sync-button-row">
            {onRestored && <button type="button" className="btn btn-primary" disabled={working || running}
              onClick={() => void run(async () => {
                if (config.provider === 'google-drive' && googleDriveTokenNeedsRefresh()) await connectGoogleDriveSync({ deferSync: true });
                await restoreSetupFromSync(); onRestored();
              })}>
              <Cloud size={14} /> Restore saved setup
            </button>}
            {!onRestored && <><button
              type="button"
              className="btn btn-secondary"
              disabled={running || working}
              onClick={() => void run(() => requestSyncNow({ manual: true }))}
            >
              <RefreshCw size={14} className={running ? 'spin' : undefined} /> Sync now
            </button>
            {syncError && config.enabled ? (
              <button
                type="button"
                className="btn btn-secondary"
                disabled={working}
                onClick={() => void reconnect()}
              >
                Reconnect
              </button>
            ) : null}
            <button type="button" className="btn btn-secondary" disabled={working}
              onClick={() => void run(config.enabled ? disableSync : resumeSync)}>
              {config.enabled ? 'Pause automatic syncing' : 'Resume automatic syncing'}
            </button>
            </>}
            <button type="button" className="btn btn-ghost" disabled={working} onClick={() => void run(disconnectSync)}>
              Disconnect
            </button>
          </div>
          {!onRestored && <p className="field-help">Use <strong>Sync now</strong> or the <strong>cloud-sync button next to Projects</strong> to sync once, even while automatic syncing is paused.</p>}
        </>
      )}
      {localError || syncError ? (
        <div className="sync-settings-error" role="alert">
          {localError || syncError}
        </div>
      ) : null}

      {!onRestored && <div className="sync-key-setting">
        <SettingsToggle title="Sync model-provider API keys" checked={syncApiKeys} onChange={setSyncApiKeys}
          description={<><strong>Use at your own risk.</strong> Cloud snapshots are not encrypted by the app. Anyone with access can use these keys.</>} />
        <p className="field-help">Applies across synced devices. <strong>Older snapshots may retain keys</strong> after you turn this off. Sync-service credentials stay local.</p>
      </div>}

      {connected && <div className="sync-summary-grid">
        <span>Provider<strong>{config.provider === 'google-drive' ? 'Google Drive' : 'WebDAV / Nextcloud'}</strong></span>
        <span>Last synchronized<strong>{formatTime(ledger.lastSyncedAt)}</strong></span>
      </div>}

      {connected && !onRestored ? (
        <div className="sync-history">
          <div className="sync-history-heading">Cloud snapshot history</div>
          <p className="field-help">
            Sync keeps <strong>previous copies of each project and your app settings</strong>.
            Choose what to restore in <strong>History for</strong>. The list shows only that item’s saved copies, dated by their last edit.
            {' '}The picker lists active projects and the <strong>5 most recently deleted projects</strong>, separated below them.
          </p>
          <div className="field-row">
            <label className="field-label" htmlFor="sync-history-target">
              History for
            </label>
            <SyncHistoryPicker value={historyTarget} onChange={setHistoryTarget}
              active={[{ id: 'preferences', label: 'App settings' }, ...historyGroups.active.map(id => ({ id, label: `Project: ${projectName(id)}` }))]}
              deleted={historyGroups.deleted.map(id => ({ id, label: `Project: ${projectName(id)}` }))} />
          </div>
          <h4 className="settings-history-caption">
            Saved snapshots · {historyTarget === 'preferences' ? 'App settings' : projectName(historyTarget)}
          </h4>
          <div className="sync-history-list">
            {historyEntries.map((entry, index) => (
              <HistoryRow
                key={entry.object.id}
                entry={entry}
                latest={index === 0}
                busy={running}
                onDelete={() => deleteSyncHistoryEntry(entry)}
                target={historyTarget === 'preferences' ? 'app settings' : projectName(historyTarget)}
                onRestore={() =>
                  historyTarget === 'preferences'
                    ? restorePreferencesHistory(entry)
                    : restoreProjectHistory(entry)
                }
              />
            ))}
            {(historyTarget === 'preferences' ? preferenceHistory : (projectHistory[historyTarget] ?? []))
              .length === 0 ? (
              <div className="sync-history-empty">No saved cloud snapshots for this item yet.</div>
            ) : null}
          </div>
          <p className="field-help">
            Up to <strong>10 copies per item</strong> are kept, newest first.{' '}
            <strong>Restore replaces only the selected project or app settings</strong> with that saved copy.
            The restored copy becomes the current synchronized version. Other projects are unchanged.
            Restoring is <strong>not undoable with Ctrl/⌘+Z</strong>.
            {' '}The <strong>latest snapshot is kept for syncing</strong>. Deleting an older snapshot is permanent.
          </p>
        </div>
      ) : null}
    </section>
  );
}

function GoogleDrivePopupNote() {
  return <><strong>Allow pop-ups for this site</strong> to connect and renew Google Drive access.</>;
}

function GoogleDriveRenewalNote() {
  return <><GoogleDrivePopupNote />{' '}Google’s access token usually lasts <strong>1 hour</strong>.
    The app renews it on your <strong>next click or keypress within 5 minutes of expiry</strong>, or after it expires.
    A <strong>Google popup</strong> opens and normally closes quickly. Google may ask you to sign in again.</>;
}
