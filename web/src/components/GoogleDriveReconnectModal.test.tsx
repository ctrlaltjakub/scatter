import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GoogleDriveReconnectModal } from './GoogleDriveReconnectModal';
import { useSyncStore } from '@/store/useSyncStore';

const reconnectGoogleDriveSync = vi.fn<() => Promise<void>>();
const disableSync = vi.fn<() => Promise<void>>();

vi.mock('@/sync/actions', () => ({
  reconnectGoogleDriveSync: () => reconnectGoogleDriveSync(),
  disableSync: () => disableSync(),
}));

describe('GoogleDriveReconnectModal', () => {
  beforeEach(() => {
    reconnectGoogleDriveSync.mockReset();
    disableSync.mockReset();
    useSyncStore.setState({
      googleDriveReconnectRequired: false,
      error: null,
    });
  });

  it('stays hidden during ordinary synchronization', () => {
    render(<GoogleDriveReconnectModal />);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('blocks visibly after renewal fails and starts reconnection from its button', async () => {
    reconnectGoogleDriveSync.mockImplementation(async () => {
      useSyncStore.getState().setRuntime({
        googleDriveReconnectRequired: false,
        error: null,
      });
    });
    useSyncStore.setState({
      googleDriveReconnectRequired: true,
      error: 'Google authorization was cancelled.',
    });

    render(<GoogleDriveReconnectModal />);
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Your work is still saved on this device.');
    expect(screen.getByRole('alert')).toHaveTextContent('Google authorization was cancelled.');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect Google Drive' }));
    });

    expect(reconnectGoogleDriveSync).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('remains open and explains a failed reconnect attempt', async () => {
    reconnectGoogleDriveSync.mockRejectedValue(new Error('Popup closed before reconnecting.'));
    useSyncStore.setState({ googleDriveReconnectRequired: true });

    render(<GoogleDriveReconnectModal />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Reconnect Google Drive' }));
    });

    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Popup closed before reconnecting.');
  });

  it('offers stopping sync as the left-hand alternative and closes after it is disabled', async () => {
    disableSync.mockImplementation(async () => {
      useSyncStore.getState().setRuntime({
        googleDriveReconnectRequired: false,
        error: null,
      });
    });
    useSyncStore.setState({ googleDriveReconnectRequired: true });

    render(<GoogleDriveReconnectModal />);
    const buttons = screen.getByRole('alertdialog').querySelectorAll('button');
    expect(buttons[0]).toHaveTextContent('Pause syncing and exit');
    expect(buttons[1]).toHaveTextContent('Reconnect Google Drive');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Pause syncing and exit' }));
    });

    expect(disableSync).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
