'use client';

import { useEffect, useRef, useState } from 'react';
import { CloudOff, RefreshCw } from 'lucide-react';
import { disableSync, reconnectGoogleDriveSync } from '@/sync/actions';
import { useSyncStore } from '@/store/useSyncStore';

type PendingAction = 'disable' | 'reconnect' | null;

export function GoogleDriveReconnectModal() {
  const reconnectRequired = useSyncStore((state) => state.googleDriveReconnectRequired);
  const syncError = useSyncStore((state) => state.error);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const reconnectButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!reconnectRequired) {
      setPendingAction(null);
      setLocalError(null);
      return;
    }
    reconnectButtonRef.current?.focus();
  }, [reconnectRequired]);

  if (!reconnectRequired) return null;

  const reconnect = async () => {
    if (pendingAction) return;
    setPendingAction('reconnect');
    setLocalError(null);
    try {
      await reconnectGoogleDriveSync();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
      setPendingAction(null);
    }
  };

  const stopSyncing = async () => {
    if (pendingAction) return;
    setPendingAction('disable');
    setLocalError(null);
    try {
      await disableSync();
    } catch (cause) {
      setLocalError(cause instanceof Error ? cause.message : String(cause));
      setPendingAction(null);
    }
  };

  return (
    <div className="modal-backdrop google-drive-reconnect-backdrop">
      <div
        className="google-drive-reconnect-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="google-drive-reconnect-title"
        aria-describedby="google-drive-reconnect-description"
      >
        <div className="google-drive-reconnect-heading">
          <CloudOff size={21} aria-hidden="true" />
          <div id="google-drive-reconnect-title" className="google-drive-reconnect-title">
            Reconnect Google Drive
          </div>
        </div>
        <p id="google-drive-reconnect-description" className="google-drive-reconnect-copy">
          Google could not renew the app&apos;s access. Your work is still saved on this device.
          Reconnect to sync, or pause automatic syncing and continue locally.
        </p>
        {(localError || syncError) ? (
          <div className="sync-update-error" role="alert">{localError || syncError}</div>
        ) : null}
        <div className="google-drive-reconnect-actions">
          <button
            type="button"
            className="btn btn-secondary"
            disabled={pendingAction !== null}
            onClick={() => void stopSyncing()}
          >
            {pendingAction === 'disable' ? 'Pausing…' : 'Pause syncing and exit'}
          </button>
          <button
            ref={reconnectButtonRef}
            type="button"
            className="btn btn-primary"
            disabled={pendingAction !== null}
            onClick={() => void reconnect()}
          >
            <RefreshCw size={15} className={pendingAction === 'reconnect' ? 'spin' : undefined} aria-hidden="true" />
            {pendingAction === 'reconnect' ? 'Reconnecting…' : 'Reconnect Google Drive'}
          </button>
        </div>
      </div>
    </div>
  );
}
