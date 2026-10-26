'use client';

import { useState } from 'react';
import { CloudDownload, Laptop, Pause } from 'lucide-react';
import { useSyncStore } from '@/store/useSyncStore';
import { resolveRemoteProjectUpdate } from '@/sync/coordinator';
import { disableSync } from '@/sync/actions';
import type { RemoteProjectUpdate } from '@/sync/types';

function formatTime(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function SyncRemoteUpdateModal() {
  const update = useSyncStore((state) => state.remoteUpdate);
  return update ? <SyncRemoteUpdateDialog key={update.object.id} update={update} /> : null;
}

function SyncRemoteUpdateDialog({ update }: { update: RemoteProjectUpdate }) {
  const [resolving, setResolving] = useState<'cloud' | 'local' | null>(null);
  const [pausing, setPausing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const projectName = update.remote.project?.name || update.local.name;
  const remoteNodes = update.remote.project ? Object.keys(update.remote.project.nodes).length : 0;
  const localNodes = Object.keys(update.local.nodes).length;
  const resolve = async (choice: 'cloud' | 'local') => {
    if (resolving || pausing) return;
    setResolving(choice);
    setError(null);
    if (update.previewOnly) {
      useSyncStore.getState().setRuntime({ remoteUpdate: null });
      setResolving(null);
      return;
    }
    try {
      await resolveRemoteProjectUpdate(choice);
      setResolving(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setResolving(null);
    }
  };

  const pauseAndExit = async () => {
    if (pausing) return;
    setPausing(true);
    setError(null);
    try {
      if (update.previewOnly) useSyncStore.getState().setRuntime({ remoteUpdate: null });
      else await disableSync();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPausing(false);
    }
  };

  return (
    <div className="modal-backdrop sync-update-backdrop">
      <div
        className="sync-update-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="sync-update-title"
        aria-describedby="sync-update-description"
      >
        <div className="sync-update-heading">
          <CloudDownload size={20} aria-hidden="true" />
          <div>
            <div id="sync-update-title" className="sync-update-title">Newer synchronized project</div>
            <div className="sync-update-project">{projectName}</div>
          </div>
        </div>
        <div id="sync-update-description" className="sync-update-copy">
          <strong>
            {update.remote.deleted
              ? 'Keep this project or accept its cloud deletion?'
              : 'Which version do you want to keep?'}
          </strong>
          <span>The other version remains available in Sync history.</span>
        </div>
        <div className="sync-update-compare">
          <button
            type="button"
            className={'sync-update-version' + (resolving === 'local' ? ' is-resolving' : '')}
            disabled={!!resolving || pausing}
            onClick={() => void resolve('local')}
            aria-label="Keep the version from this device"
          >
            <span><Laptop size={15} /> This device</span>
            <strong>{formatTime(update.local.updatedAt)}</strong>
            <small>
              {resolving === 'local'
                ? 'Keeping…'
                : `${localNodes} ${localNodes === 1 ? 'node' : 'nodes'}`}
            </small>
          </button>
          <button
            type="button"
            className={'sync-update-version' + (resolving === 'cloud' ? ' is-resolving' : '')}
            disabled={!!resolving || pausing}
            onClick={() => void resolve('cloud')}
            aria-label={update.remote.deleted
              ? 'Accept the cloud deletion'
              : `Keep the version from ${update.remote.deviceName || 'the other device'}`}
          >
            <span><CloudDownload size={15} /> {update.remote.deviceName || 'Other device'}</span>
            <strong>{formatTime(update.remote.editedAt)}</strong>
            <small>
              {resolving === 'cloud'
                ? update.remote.deleted ? 'Deleting…' : 'Applying…'
                : update.remote.deleted
                ? 'Project deleted remotely'
                : `${remoteNodes} ${remoteNodes === 1 ? 'node' : 'nodes'}`}
            </small>
          </button>
        </div>
        {error && <div className="sync-update-error" role="alert">{error}</div>}
        <div className="sync-update-actions">
          <button type="button" className="btn btn-secondary" disabled={pausing}
            onClick={() => void pauseAndExit()}>
            <Pause size={14} aria-hidden="true" /> {pausing ? 'Pausing…' : 'Pause syncing and exit'}
          </button>
        </div>
      </div>
    </div>
  );
}
