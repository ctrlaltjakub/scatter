import { fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsModal } from './SettingsModal';
import { useSyncStore } from '@/store/useSyncStore';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';

describe('SettingsModal Google Drive diagnostics', () => {
  beforeEach(() => {
    useSyncStore.setState({
      googleDriveReconnectRequired: false,
      error: null,
      running: true,
      remoteUpdate: null,
    });
    const project = createBlankProject('Conflict preview project', 'root');
    useGraphStore.setState({ project, activeProjectId: project.id });
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
