import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject } from '@/store/useGraphStore';
import { useSyncStore } from '@/store/useSyncStore';
import { SYNC_FORMAT, SYNC_FORMAT_VERSION } from '@/sync/types';
import { SyncRemoteUpdateModal } from './SyncRemoteUpdateModal';

const resolveRemoteProjectUpdate = vi.fn<(choice: 'cloud' | 'local') => Promise<void>>();
const disableSync = vi.fn<() => Promise<void>>();
vi.mock('@/sync/actions', () => ({ disableSync: () => disableSync() }));

vi.mock('@/sync/coordinator', () => ({
  resolveRemoteProjectUpdate: (choice: 'cloud' | 'local') => resolveRemoteProjectUpdate(choice),
}));

describe('SyncRemoteUpdateModal', () => {
  beforeEach(() => {
    resolveRemoteProjectUpdate.mockReset();
    resolveRemoteProjectUpdate.mockResolvedValue();
    disableSync.mockReset();
    disableSync.mockImplementation(async () => {
      useSyncStore.setState(state => ({ config: { ...state.config, enabled: false }, remoteUpdate: null }));
    });
    const local = createBlankProject('Shared project', 'root');
    local.updatedAt = 1_000;
    const remoteProject = { ...createBlankProject('Shared project', 'root'), id: local.id, updatedAt: 2_000 };
    useSyncStore.setState({
      remoteUpdate: {
        projectId: local.id,
        local,
        remote: {
          format: SYNC_FORMAT,
          formatVersion: SYNC_FORMAT_VERSION,
          kind: 'project',
          projectId: local.id,
          editedAt: 2_000,
          sequence: 2,
          deviceId: 'laptop',
          deviceName: 'Laptop',
          hash: 'remote-hash',
          deleted: false,
          assetIds: [],
          project: remoteProject,
        },
        object: { id: 'remote-object', name: 'remote.scatter' },
      },
    });
  });

  it('uses the two version cards as the choices without duplicate action buttons', async () => {
    render(<SyncRemoteUpdateModal />);

    expect(screen.getByText('Which version do you want to keep?')).toBeInTheDocument();
    expect(screen.queryByText('Keep local version')).not.toBeInTheDocument();
    expect(screen.queryByText('Use cloud version')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(3);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep the version from Laptop' }));
    });
    expect(resolveRemoteProjectUpdate).toHaveBeenCalledWith('cloud');
  });

  it('dismisses a developer preview without contacting the sync coordinator', async () => {
    const update = useSyncStore.getState().remoteUpdate!;
    useSyncStore.setState({ remoteUpdate: { ...update, previewOnly: true } });
    render(<SyncRemoteUpdateModal />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Keep the version from this device' }));
    });

    expect(resolveRemoteProjectUpdate).not.toHaveBeenCalled();
    expect(useSyncStore.getState().remoteUpdate).toBeNull();
  });

  it('can pause and exit while a version choice is still waiting', async () => {
    let finish!: () => void;
    resolveRemoteProjectUpdate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    render(<SyncRemoteUpdateModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep the version from Laptop' }));
    expect(screen.getByRole('button', { name: 'Pause syncing and exit' })).toBeEnabled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause syncing and exit' })); });
    expect(disableSync).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await act(async () => { finish(); });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not retain an old error when the conflict window is reopened', async () => {
    const update = useSyncStore.getState().remoteUpdate!;
    resolveRemoteProjectUpdate.mockRejectedValueOnce(new Error('Temporary failure'));
    render(<SyncRemoteUpdateModal />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Keep the version from Laptop' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Temporary failure');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause syncing and exit' })); });
    act(() => useSyncStore.setState({ remoteUpdate: update }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('exits a developer preview without changing the real sync preference', async () => {
    useSyncStore.setState(state => ({ remoteUpdate: { ...state.remoteUpdate!, previewOnly: true } }));
    render(<SyncRemoteUpdateModal />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Pause syncing and exit' })); });
    expect(disableSync).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
