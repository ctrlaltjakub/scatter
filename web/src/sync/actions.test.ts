import { beforeEach, describe, expect, it } from 'vitest';
import { syncStatusLabel } from './actions';
import { defaultSyncConfig, defaultSyncLedger } from './local';
import { useSyncStore } from '@/store/useSyncStore';

describe('project sync status labels', () => {
  beforeEach(() => {
    useSyncStore.setState({
      config: defaultSyncConfig(),
      ledger: defaultSyncLedger(),
      hydrated: true,
      running: false,
      error: null,
      remoteUpdate: null,
    });
  });

  it('shows the disconnected state even with an old successful ledger entry', () => {
    expect(syncStatusLabel('p')).toBe('SYNC NOT CONNECTED');
    useSyncStore.setState({ ledger: { ...defaultSyncLedger(), projects: {
      p: { projectId: 'p', localEditedAt: 1, status: 'synced' },
    } } });
    expect(syncStatusLabel('p')).toBe('SYNC NOT CONNECTED');
  });

  it('treats an imported WebDAV connection without its password as disconnected', () => {
    useSyncStore.setState({ config: { ...defaultSyncConfig(), provider: 'webdav',
      webdav: { baseUrl: 'https://test.invalid', username: 'test', appPassword: '', folder: 'Scatter' } } });
    expect(syncStatusLabel('p')).toBe('SYNC NOT CONNECTED');
  });

  it('shows a manual run and failures while automatic syncing stays paused', () => {
    useSyncStore.setState({ config: { ...defaultSyncConfig(), provider: 'google-drive', enabled: false } });
    expect(syncStatusLabel('p')).toBe('SYNC PAUSED');
    useSyncStore.setState({ running: true });
    expect(syncStatusLabel('p')).toBe('SYNCING');
    useSyncStore.setState({ running: false, error: 'Offline' });
    expect(syncStatusLabel('p')).toBe('SYNC FAILED');
    useSyncStore.setState({ running: true, error: null });
    expect(syncStatusLabel('p')).toBe('SYNCING');
    useSyncStore.setState({ running: false });
    expect(syncStatusLabel('p')).toBe('SYNC PAUSED');
    expect(useSyncStore.getState().config.enabled).toBe(false);
  });

  it('describes enabled project states without putting them in the row permanently', () => {
    useSyncStore.setState({
      config: { ...defaultSyncConfig(), enabled: true, provider: 'google-drive' },
      ledger: {
        ...defaultSyncLedger(),
        projects: {
          p: { projectId: 'p', localEditedAt: 1, lastSyncedAt: 1, status: 'pending' },
        },
      },
    });
    expect(syncStatusLabel('p')).toBe('CHANGES PENDING');
    useSyncStore.setState((state) => ({
      ledger: { ...state.ledger, projects: { p: { ...state.ledger.projects.p!, status: 'synced' } } },
    }));
    expect(syncStatusLabel('p')).toBe('SYNCED');
  });
});
