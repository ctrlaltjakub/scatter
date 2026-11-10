import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { useSyncStore } from '@/store/useSyncStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { defaultSyncConfig } from '@/sync/local';
import { stopScheduledSync } from '@/sync/coordinator';
import { clearGoogleDriveToken, googleDriveTokenNeedsRefresh } from '@/sync/providers/googleDrive';
import { useIsBrowserOnline } from '@/lib/networkStatus';

vi.mock('@/lib/networkStatus', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/networkStatus')>(),
  useIsBrowserOnline: vi.fn(() => true),
}));

function openDiagnostics() {
  const view = render(<SettingsModal open onClose={vi.fn()} />);
  fireEvent.click(view.getByRole('button', { name: 'Developer' }));
  fireEvent.click(view.getByRole('button', { name: 'Developer options' }));
  return view;
}

function connectedDrive() {
  useSyncStore.setState(state => ({ config: { ...state.config, provider: 'google-drive', enabled: true } }));
  vi.stubEnv('NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID', 'fixture-client');
  type Reply = { access_token?: string; expires_in?: number; error?: string };
  let finish!: (reply: Reply) => void;
  const requestAccessToken = vi.fn();
  vi.stubGlobal('google', { accounts: { oauth2: { initTokenClient: (config: {callback: typeof finish}) => {
    finish = config.callback;
    return { callback: finish, requestAccessToken };
  } } } });
  return { requestAccessToken, reply: (value: Reply) => finish(value) };
}

describe('SettingsModal Google Drive diagnostics', () => {
  beforeEach(() => {
    vi.mocked(useIsBrowserOnline).mockReturnValue(true);
    useSyncStore.setState({
      config: defaultSyncConfig(),
      googleDriveReconnectRequired: false,
      error: null,
      running: true,
      remoteUpdate: null,
    });
    const project = createBlankProject('Conflict preview project', 'root');
    useGraphStore.setState({ project, activeProjectId: project.id });
  });

  afterEach(() => {
    stopScheduledSync();
    clearGoogleDriveToken();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('immediately renews even a fresh grant using the automatic no-prompt flow', async () => {
    const google = connectedDrive();
    localStorage.setItem('scatter.google-drive-token.v1', JSON.stringify({ accessToken: 'previous', expiresAt: Date.now() + 3_600_000 }));
    expect(googleDriveTokenNeedsRefresh()).toBe(false);
    const view = openDiagnostics();
    fireEvent.click(view.getByRole('button', { name: 'Test automatic renewal' }));
    expect(view.getByRole('button', { name: 'Renewing…' })).toBeDisabled();
    expect(google.requestAccessToken).toHaveBeenCalledExactlyOnceWith({ prompt: 'none' });
    await act(() => google.reply({ access_token: 'replacement', expires_in: 3600 }));
    expect(view.getByText('Access renewed successfully.')).toBeVisible();
    expect(JSON.parse(localStorage.getItem('scatter.google-drive-token.v1')!).accessToken).toBe('replacement');
  });

  it.each([true, false])('shows a real authorization error without discarding the token (fresh: %s)', async fresh => {
    const google = connectedDrive();
    const original = JSON.stringify({ accessToken: 'previous', expiresAt: Date.now() + (fresh ? 3_600_000 : 60_000) });
    localStorage.setItem('scatter.google-drive-token.v1', original);
    const view = openDiagnostics();
    fireEvent.click(view.getByRole('button', { name: 'Test automatic renewal' }));
    await act(() => google.reply({ error: 'login_required' }));
    expect(view.getByText('Renewal failed: login_required')).toBeVisible();
    expect(localStorage.getItem('scatter.google-drive-token.v1')).toBe(original);
    expect(useSyncStore.getState().googleDriveReconnectRequired).toBe(!fresh);
  });

  it.each(['unconnected', 'webdav', 'paused', 'reconnect', 'offline'])('blocks the real diagnostic when %s', state => {
    const google = connectedDrive();
    useSyncStore.setState(s => ({
      config: { ...s.config, provider: state === 'unconnected' ? null : state === 'webdav' ? 'webdav' : 'google-drive', enabled: state !== 'paused' },
      googleDriveReconnectRequired: state === 'reconnect',
    }));
    vi.mocked(useIsBrowserOnline).mockReturnValue(state !== 'offline');
    const button = openDiagnostics().getByRole('button', { name: 'Test automatic renewal' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(google.requestAccessToken).not.toHaveBeenCalled();
  });

  it('exercises the real reconnect-required state without contacting Google', () => {
    const onClose = vi.fn();
    const view = render(<SettingsModal open onClose={onClose} />);

    fireEvent.click(view.getByRole('button', { name: 'Developer' }));
    fireEvent.click(view.getByRole('button', { name: 'Developer options' }));
    fireEvent.click(view.getByRole('button', { name: 'Trigger renewal failure' }));

    expect(useSyncStore.getState()).toMatchObject({
      googleDriveReconnectRequired: true,
      error: 'Developer test: Google Drive token renewal failed.',
      running: false,
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('opens a safe version-conflict preview from developer options', () => {
    const onClose = vi.fn();
    const view = render(<SettingsModal open onClose={onClose} />);

    fireEvent.click(view.getByRole('button', { name: 'Developer' }));
    fireEvent.click(view.getByRole('button', { name: 'Developer options' }));
    fireEvent.click(view.getByRole('button', { name: 'Show version conflict' }));

    expect(useSyncStore.getState().remoteUpdate).toMatchObject({
      previewOnly: true,
      remote: { deviceName: 'Other device', deleted: false },
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the start-screen preview but removes the destructive topic-picker shortcut', () => {
    const project = useGraphStore.getState().project;
    const view = render(<SettingsModal open onClose={vi.fn()} />);

    fireEvent.click(view.getByRole('button', { name: 'Developer' }));
    fireEvent.click(view.getByRole('button', { name: 'Developer options' }));

    expect(view.getByRole('button', { name: 'Back to start screen' })).toBeInTheDocument();
    expect(view.queryByRole('button', { name: /back to topic picker/i })).not.toBeInTheDocument();
    expect(view.queryByText(/clears the current project/i)).not.toBeInTheDocument();
    expect(useGraphStore.getState().project).toBe(project);
  });
});
