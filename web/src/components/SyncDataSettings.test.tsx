import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncDataSettings } from './SyncDataSettings';
import { useSyncStore } from '@/store/useSyncStore';
import { useGraphStore } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { defaultSyncConfig, defaultSyncLedger } from '@/sync/local';
import { requestGoogleDriveToken, clearGoogleDriveToken } from '@/sync/providers/googleDrive';
import { deleteSyncHistoryEntry, scheduleSync, requestSyncNow } from '@/sync/coordinator';
import { preferencesSnapshotName } from '@/sync/codec';
import { reconnectGoogleDriveSync } from '@/sync/actions';

vi.mock('@/opfs/settingsIO', async original => ({ ...await original<typeof import('@/opfs/settingsIO')>(), saveSettings: vi.fn(async () => {}) }));
vi.mock('@/sync/local', async original => ({ ...await original<typeof import('@/sync/local')>(), saveSyncConfig: vi.fn(async () => {}) }));
vi.mock('@/sync/coordinator', () => ({ scheduleSync: vi.fn(), stopScheduledSync: vi.fn(), requestSyncNow: vi.fn(), restorePreferencesHistory: vi.fn(), restoreProjectHistory: vi.fn(), deleteSyncHistoryEntry: vi.fn() }));
vi.mock('@/sync/providers/googleDrive', () => ({ requestGoogleDriveToken: vi.fn(), clearGoogleDriveToken: vi.fn(), googleDriveTokenNeedsRefresh: () => false }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(deleteSyncHistoryEntry).mockResolvedValue(undefined);
  useSyncStore.setState({ hydrated: true, config: defaultSyncConfig(), ledger: defaultSyncLedger(),
    error: null, running: false, projectHistory: {}, preferenceHistory: [] });
  useGraphStore.setState({ projectList: [] });
  useSettingsStore.setState({ syncApiKeys: false });
});

describe('sync connection and history controls', () => {
  it.each(['setup', 'enabled', 'paused', 'onboarding'] as const)('explains Google Drive pop-up permissions during %s', state => {
    if (state === 'enabled' || state === 'paused') {
      useSyncStore.setState(current => ({ config: {
        ...current.config, provider: 'google-drive', enabled: state === 'enabled',
      } }));
    }
    render(<SyncDataSettings onRestored={state === 'onboarding' ? vi.fn() : undefined} />);
    const note = screen.getByText('Allow pop-ups for this site');
    expect(note.parentElement).toHaveTextContent('Allow pop-ups for this site to connect and renew Google Drive access.');
    if (state === 'paused') {
      expect(screen.queryByText('next click or keypress within 5 minutes of expiry')).not.toBeInTheDocument();
    }
  });

  it('does not show the Google Drive pop-up requirement for WebDAV', () => {
    render(<SyncDataSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'WebDAV / Nextcloud' }));
    expect(screen.queryByText('Allow pop-ups for this site')).not.toBeInTheDocument();
  });

  it('reconnecting Google Drive does not silently resume automatic syncing', async () => {
    useSyncStore.setState(state => ({ config: { ...state.config, provider: 'google-drive', enabled: false } }));
    await reconnectGoogleDriveSync();
    expect(requestGoogleDriveToken).toHaveBeenCalledOnce();
    expect(requestSyncNow).toHaveBeenCalledWith({ manual: true });
    expect(useSyncStore.getState().config.enabled).toBe(false);
  });
  it('defaults key syncing off and explains the risk before the user opts in', () => {
    render(<SyncDataSettings />);
    const toggle = screen.getByRole('switch', { name: /Sync model-provider API keys/ });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText(/Use at your own risk/)).toBeInTheDocument();
    expect(screen.getByText(/Older snapshots may retain keys/)).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().syncApiKeys).toBe(true);
    fireEvent.click(toggle);
    expect(useSettingsStore.getState().syncApiKeys).toBe(false);
  });
  it.each(['google-drive', 'webdav'] as const)('pauses and resumes %s without disconnecting or requesting credentials again', async provider => {
    const config = { ...defaultSyncConfig(), enabled: true, provider,
      webdav: { baseUrl: 'https://test.invalid', username: 'name', appPassword: 'private', folder: 'Scatter' } };
    useSyncStore.setState({ config });
    render(<SyncDataSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Pause automatic syncing' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume automatic syncing' })).toBeEnabled());
    expect(screen.getByRole('status')).toHaveTextContent('Automatic sync paused');
    expect(useSyncStore.getState().config).toEqual({ ...config, enabled: false });
    expect(screen.queryByRole('button', { name: /Connect Google|Connect WebDAV/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sync now' }));
    await waitFor(() => expect(requestSyncNow).toHaveBeenCalledWith({ manual: true }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Resume automatic syncing' })).toBeEnabled());
    expect(useSyncStore.getState().config.enabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Resume automatic syncing' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Pause automatic syncing' })).toBeEnabled());
    expect(useSyncStore.getState().config).toEqual(config);
    expect(requestGoogleDriveToken).not.toHaveBeenCalled();
    expect(clearGoogleDriveToken).not.toHaveBeenCalled();
    expect(scheduleSync).toHaveBeenCalledWith(0);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(useSyncStore.getState().config.provider).toBeNull());
    expect(clearGoogleDriveToken).toHaveBeenCalledOnce();
    expect(useSyncStore.getState().config.webdav).toBeUndefined();
  });
  it('separates active and the five latest deleted projects and supports keyboard selection', () => {
    useSyncStore.setState({ config: { ...defaultSyncConfig(), enabled: true, provider: 'google-drive' },
      projectHistory: Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`p${index}`, [
        { object: { id: `snapshot${index}`, name: 'snapshot' }, editedAt: index, deleted: index !== 0 },
      ]])),
      ledger: { ...defaultSyncLedger(), historyTitles: Object.fromEntries(Array.from({ length: 9 }, (_, index) =>
        [`p${index}`, { name: `Project ${index}`, snapshotName: 'snapshot' }])) } });
    render(<SyncDataSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'History for' }));
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(7);
    expect(within(list).getByRole('separator')).toBeInTheDocument();
    expect(within(list).queryByText(/Project 3/)).toBeNull();
    expect(within(list).getAllByRole('option').map(item => item.textContent)).toEqual([
      'App settings', 'Project: Project 0', ...[8, 7, 6, 5, 4].map(i => `Project: Project ${i} (deleted)`),
    ]);
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toHaveTextContent('Project 4');
    fireEvent.click(document.activeElement!);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'History for' })).toHaveTextContent('Project 4');
  });

  it('groups connection controls with their summary, followed by API-key syncing and history', () => {
    useSyncStore.setState(state => ({ config: { ...state.config, provider: 'google-drive', enabled: false } }));
    render(<SyncDataSettings />);
    const device = screen.getByLabelText("This device's name");
    const keys = screen.getByRole('switch', { name: /Sync model-provider API keys/ });
    const provider = screen.getByText('Provider');
    const history = screen.getByText('Cloud snapshot history');
    expect(device.compareDocumentPosition(provider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(provider.compareDocumentPosition(keys) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(keys.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(device.closest('.settings-card')).toBe(provider.closest('.settings-card'));
    expect(keys.closest('.settings-card')).not.toBe(device.closest('.settings-card'));
  });

  function renderHistory() {
    const entries = [1, 2].map(day => {
      const editedAt = Date.UTC(2026, 9, day, 12);
      const name = preferencesSnapshotName(editedAt, 1, 'device', `hash-${day}`);
      return { object: { id: name, name }, editedAt };
    });
    useSyncStore.setState(state => ({ config: { ...state.config, provider: 'google-drive', enabled: false }, preferenceHistory: entries }));
    const result = render(<SyncDataSettings />);
    const rows = result.container.querySelectorAll('.sync-history-row');
    return { entries, latest: within(rows[0] as HTMLElement), older: within(rows[1] as HTMLElement) };
  }

  it('puts trash after Restore, protects the latest copy, and confirms older snapshot deletion', async () => {
    const { entries, latest, older } = renderHistory();
    expect(latest.getByRole('button', { name: /^Delete/ })).toBeDisabled();
    expect(latest.getByText('Latest')).toBeInTheDocument();
    const trash = older.getByRole('button', { name: /^Delete/ });
    expect(trash.previousElementSibling).toBe(older.getByRole('button', { name: /^Restore/ }));
    expect(trash.previousElementSibling?.querySelector('.lucide-layer-arrow-down')).not.toBeNull();
    fireEvent.click(trash);
    expect(deleteSyncHistoryEntry).not.toHaveBeenCalled();
    expect(older.getByText('This cannot be undone.')).toBeInTheDocument();
    fireEvent.click(older.getByRole('button', { name: 'Cancel' }));
    expect(older.queryByRole('group', { name: 'Confirm snapshot deletion' })).toBeNull();
    fireEvent.click(trash);
    fireEvent.click(older.getByRole('button', { name: 'Delete snapshot' }));
    await waitFor(() => expect(deleteSyncHistoryEntry).toHaveBeenCalledWith(entries[0]));
    await waitFor(() => expect(older.queryByRole('group', { name: 'Confirm snapshot deletion' })).toBeNull());
    expect(useSyncStore.getState().config.enabled).toBe(false);
  });

  it('keeps the snapshot visible and shows a deletion failure with retry', async () => {
    vi.mocked(deleteSyncHistoryEntry).mockRejectedValueOnce(new Error('Server unavailable'));
    const { older } = renderHistory();
    fireEvent.click(older.getByRole('button', { name: /^Delete/ }));
    fireEvent.click(older.getByRole('button', { name: 'Delete snapshot' }));
    expect(await older.findByRole('alert')).toHaveTextContent('Server unavailable');
    expect(older.getByRole('button', { name: 'Delete snapshot' })).toBeEnabled();
    expect(older.getByRole('button', { name: /^Restore/ })).toBeEnabled();
    expect(useSyncStore.getState().preferenceHistory).toHaveLength(2);
  });
});
