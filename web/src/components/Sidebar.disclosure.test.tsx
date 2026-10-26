import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useSyncStore } from '@/store/useSyncStore';
import { useProjectSyncLabelStore } from '@/store/useProjectSyncLabelStore';
import { defaultSyncLedger } from '@/sync/local';
import type { ScatterNode } from '@/store/types';
import { Sidebar } from './Sidebar';

const { deleteScatterMock, requestSyncNowMock } = vi.hoisted(() => ({
  deleteScatterMock: vi.fn<() => Promise<void>>(),
  requestSyncNowMock: vi.fn<() => Promise<void>>(),
}));

vi.mock('@/store/projectActions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/store/projectActions')>();
  return { ...actual, deleteScatter: deleteScatterMock };
});
vi.mock('@/sync/coordinator', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/sync/coordinator')>(),
  requestSyncNow: requestSyncNowMock,
}));

vi.mock('./NavActions', () => ({ NavActions: () => null }));
vi.mock('./SidebarModelPicker', () => ({ SidebarModelPicker: () => null }));
vi.mock('@/components/canvas/Minimap', () => ({ Minimap: () => null }));

const root: ScatterNode = {
  id: 'root', type: 'root', position: { x: 0, y: 0 }, frozen: true,
  versions: [{ header: 'Root', body: 'Root body.', createdAt: 0, generatedBy: 'root' }],
  currentVersionIndex: 0,
};

describe('Sidebar disclosure sections', () => {
  beforeEach(() => {
    deleteScatterMock.mockReset();
    deleteScatterMock.mockResolvedValue(undefined);
    requestSyncNowMock.mockReset();
    requestSyncNowMock.mockResolvedValue(undefined);
    useSyncStore.setState((state) => ({
      config: { ...state.config, enabled: false, provider: null,
        webdav: { baseUrl: 'https://test.invalid', username: 'test', appPassword: 'test', folder: 'Scatter' } },
      running: false,
      error: null,
      remoteUpdate: null,
      ledger: defaultSyncLedger(),
    }));
    useProjectSyncLabelStore.setState({ entries: {} });
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const project = createBlankProject('sidebar-disclosures', root.id);
    useGraphStore.getState().setProject({ ...project, nodes: { root }, groups: {} });
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    useGraphStore.getState().setProject(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('starts expanded, toggles independently, and remembers each section', () => {
    const first = render(
      <Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />,
    );

    const projects = screen.getByRole('button', { name: 'Projects' });
    const groups = screen.getByRole('button', { name: 'Groups' });
    const shortcuts = screen.getByRole('button', { name: 'Shortcuts' });
    expect(projects).toHaveAttribute('aria-expanded', 'true');
    expect(groups).toHaveAttribute('aria-expanded', 'true');
    expect(shortcuts).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(projects);
    expect(projects).toHaveAttribute('aria-expanded', 'false');
    expect(groups).toHaveAttribute('aria-expanded', 'true');
    expect(shortcuts).toHaveAttribute('aria-expanded', 'true');

    first.unmount();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Projects' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Groups' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps plus clicks separate from disclosure toggling', () => {
    const project = useGraphStore.getState().project!;
    useGraphStore.setState({
      activeProjectId: project.id,
      projectList: [{
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        color: project.color,
      }],
      pickerOpen: false,
    });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const projects = screen.getByRole('button', { name: 'Projects' });
    const newProject = screen.getByRole('button', { name: 'Start new project' });
    expect(newProject).toHaveAttribute('data-tip', 'Start new project');
    fireEvent.click(newProject);
    expect(projects).toHaveAttribute('aria-expanded', 'true');
    expect(useGraphStore.getState().pickerOpen).toBe(true);
    expect(useGraphStore.getState().activeProjectId).toBe(project.id);
    expect(useGraphStore.getState().projectList.map((item) => item.id)).toEqual([project.id]);
  });

  it('keeps manual sync available beside Start new project while automatic sync is paused', () => {
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Open synchronization settings' })).toHaveClass('failed');

    act(() => useSyncStore.setState((state) => ({
      config: { ...state.config, enabled: true, provider: 'webdav' },
    })));
    const sync = screen.getByRole('button', { name: 'Sync projects and settings' });
    expect(sync).toHaveClass('sidebar-section-add');
    expect(sync.querySelector('.lucide-cloud-sync')).not.toBeNull();
    expect(sync.nextElementSibling).toBe(screen.getByRole('button', { name: 'Start new project' }));

    fireEvent.click(sync);
    expect(requestSyncNowMock).toHaveBeenCalledTimes(1);
    expect(requestSyncNowMock).toHaveBeenLastCalledWith({ manual: true });

    act(() => useSyncStore.setState({ running: true, error: null }));
    expect(sync).toHaveClass('syncing');
    expect(sync).toBeDisabled();
    expect(sync).toHaveAttribute('aria-busy', 'true');

    act(() => useSyncStore.setState({ running: false, error: 'Server unavailable' }));
    expect(sync).toHaveClass('failed');
    expect(sync).toHaveAttribute('data-tip', 'Sync failed. Click to retry.');
    fireEvent.click(sync);
    expect(requestSyncNowMock).toHaveBeenCalledTimes(2);

    act(() => useSyncStore.setState((state) => ({
      config: { ...state.config, enabled: false },
      error: null,
    })));
    expect(sync).toBeEnabled();
    expect(sync).toHaveAttribute('data-tip', 'Sync projects and settings once; automatic syncing stays paused.');
    fireEvent.click(sync);
    expect(requestSyncNowMock).toHaveBeenCalledTimes(3);
    expect(useSyncStore.getState().config.enabled).toBe(false);
    act(() => useSyncStore.setState(state => ({ config: { ...state.config, provider: null } })));
    expect(screen.getByRole('button', { name: 'Open synchronization settings' })).toHaveClass('failed');
  });

  it.each([true, false])('keeps two full icon pulses after a quick manual sync (automatic=%s)', async enabled => {
    vi.useFakeTimers();
    useSyncStore.setState(state => ({ config: { ...state.config, provider: 'webdav', enabled } }));
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const sync = screen.getByRole('button', { name: 'Sync projects and settings' });
    fireEvent.click(sync);
    await act(async () => { await Promise.resolve(); });
    expect(requestSyncNowMock).toHaveBeenCalledWith({ manual: true });
    expect(sync).toHaveClass('syncing');
    expect(sync).toBeEnabled();
    expect(useSyncStore.getState().running).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(2_499));
    expect(sync).toHaveClass('syncing');
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(sync).not.toHaveClass('syncing');
    expect(useSyncStore.getState().config.enabled).toBe(enabled);
  });

  it('continues pulsing for long jobs and clears feedback on disconnection', async () => {
    vi.useFakeTimers();
    useSyncStore.setState(state => ({ config: { ...state.config, provider: 'webdav', enabled: false } }));
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const sync = screen.getByRole('button', { name: 'Sync projects and settings' });
    fireEvent.click(sync);
    act(() => useSyncStore.setState({ running: true }));
    await act(() => vi.advanceTimersByTimeAsync(3_000));
    expect(sync).toHaveClass('syncing');
    act(() => useSyncStore.setState({ running: false }));
    expect(sync).not.toHaveClass('syncing');
    fireEvent.click(sync);
    expect(sync).toHaveClass('syncing');
    act(() => useSyncStore.setState(state => ({ config: { ...state.config, provider: null } })));
    expect(sync).not.toHaveClass('syncing');
    expect(sync).toHaveClass('failed');
  });

  it('keeps two more cycles of feedback for another click after a fast completion', async () => {
    vi.useFakeTimers();
    useSyncStore.setState(state => ({ config: { ...state.config, provider: 'webdav', enabled: false } }));
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const sync = screen.getByRole('button', { name: 'Sync projects and settings' });
    fireEvent.click(sync);
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    fireEvent.click(sync);
    await act(() => vi.advanceTimersByTimeAsync(2_499));
    expect(sync).toHaveClass('syncing');
    expect(requestSyncNowMock).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(sync).not.toHaveClass('syncing');
  });

  it.each(['none', 'webdav-without-password'])('opens Synchronization instead of syncing when disconnected (%s)', (connection) => {
    if (connection === 'webdav-without-password') useSyncStore.setState(state => ({ config: {
      ...state.config, provider: 'webdav', webdav: { ...state.config.webdav!, appPassword: '' },
    } }));
    const onOpenSettings = vi.fn();
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={onOpenSettings} />);
    const sync = screen.getByRole('button', { name: 'Open synchronization settings' });
    expect(sync).toBeEnabled();
    expect(sync).toHaveClass('failed');
    expect(sync).toHaveAttribute('data-tip', 'Sync not connected. Open sync settings.');
    expect(sync.nextElementSibling).toBe(screen.getByRole('button', { name: 'Start new project' }));
    fireEvent.click(sync);
    expect(onOpenSettings).toHaveBeenCalledWith('sync');
    expect(requestSyncNowMock).not.toHaveBeenCalled();
  });

  it('updates a hovered project’s ASCII label through paused manual syncing and disconnection', () => {
    const project = useGraphStore.getState().project!;
    useGraphStore.setState({ activeProjectId: project.id, projectList: [{
      id: project.id, name: project.name, createdAt: 0, updatedAt: 1, color: project.color,
    }] });
    useSyncStore.setState(state => ({ config: { ...state.config, provider: 'google-drive', enabled: false } }));
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const row = screen.getByText(project.name).closest('.sidebar-row')!;
    expect(useProjectSyncLabelStore.getState().entries[project.id]).toBeUndefined();
    fireEvent.pointerEnter(row);
    const label = () => useProjectSyncLabelStore.getState().entries[project.id]!;
    expect(label()).toMatchObject({ text: 'SYNC PAUSED', accent: project.color, clearedAt: null });
    expect(row).not.toHaveTextContent('SYNC PAUSED');
    act(() => useSyncStore.setState({ running: true }));
    expect(label().text).toBe('SYNCING');
    act(() => useSyncStore.setState({ running: false, error: 'Offline' }));
    expect(label().text).toBe('SYNC FAILED');
    act(() => useSyncStore.setState({ running: true, error: null }));
    expect(label().text).toBe('SYNCING');
    act(() => useSyncStore.setState({ running: false }));
    expect(label().text).toBe('SYNC PAUSED');
    act(() => useSyncStore.setState(state => ({ config: { ...state.config, provider: null } })));
    expect(label().text).toBe('SYNC NOT CONNECTED');
    fireEvent.pointerLeave(row);
    expect(label().clearedAt).not.toBeNull();
    fireEvent.focus(row);
    expect(label().clearedAt).toBeNull();
    fireEvent.blur(row);
    expect(label().clearedAt).not.toBeNull();
  });

  it('shows a failed sync if manual startup fails before the coordinator reports it', async () => {
    requestSyncNowMock.mockRejectedValueOnce(new Error('Could not acquire sync lock'));
    useSyncStore.setState((state) => ({
      config: { ...state.config, enabled: true, provider: 'webdav' },
    }));
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sync projects and settings' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Retry syncing projects and settings' })).toHaveClass('failed');
    });
  });

  it('opens one project-delete confirmation and dismisses it outside or with the sidebar', () => {
    const project = useGraphStore.getState().project!;
    useGraphStore.setState({
      projectList: [{
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        color: project.color,
      }],
      activeProjectId: project.id,
    });
    const view = render(
      <Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: `Delete ${project.name}` }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Delete project?');
    expect(screen.getByRole('button', { name: 'No' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Yes' })).toBeVisible();

    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('alertdialog')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: `Delete ${project.name}` }));
    view.rerender(
      <Sidebar collapsed onToggle={vi.fn()} onOpenSettings={vi.fn()} />,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('locks an auto-hidden sidebar while its project-delete confirmation is open', () => {
    const project = useGraphStore.getState().project!;
    useGraphStore.setState({
      projectList: [{
        id: project.id,
        name: project.name,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        color: project.color,
      }],
      activeProjectId: project.id,
    });
    const onPeekLockChange = vi.fn();
    render(
      <Sidebar
        collapsed
        peeking
        onToggle={vi.fn()}
        onOpenSettings={vi.fn()}
        onPeekLockChange={onPeekLockChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: `Delete ${project.name}` }));
    expect(onPeekLockChange).toHaveBeenLastCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(onPeekLockChange).toHaveBeenLastCalledWith(false);
  });

  it('shows the replacement project spinner while deleting the active project', async () => {
    const active = createBlankProject('Active project', root.id, () => 0.2);
    const replacement = createBlankProject('Replacement project', 'replacement-root', () => 0.4);
    let finishDelete!: () => void;
    deleteScatterMock.mockImplementation(() => new Promise<void>((resolve) => {
      finishDelete = resolve;
    }));
    useGraphStore.setState({
      project: { ...active, nodes: { root }, groups: {} },
      projectList: [
        { id: active.id, name: active.name, createdAt: 0, updatedAt: 1, color: active.color },
        {
          id: replacement.id,
          name: replacement.name,
          createdAt: 0,
          updatedAt: 2,
          color: replacement.color,
        },
      ],
      activeProjectId: active.id,
    });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: `Delete ${active.name}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));

    expect(screen.getByRole('status', { name: `Opening ${replacement.name}` })).toBeVisible();
    await waitFor(() => expect(deleteScatterMock).toHaveBeenCalledWith(active.id));

    act(() => finishDelete());
    await waitFor(() => {
      expect(screen.queryByRole('status', { name: `Opening ${replacement.name}` })).toBeNull();
    });
  });

  it('opens Groups and reveals a group created while the section is closed', async () => {
    const project = useGraphStore.getState().project!;
    useGraphStore.getState().setProject({
      ...project,
      groups: {
        g1: { id: 'g1', name: 'First group', color: '#123456', gravitate: false },
        g2: { id: 'g2', name: 'Second group', color: '#abcdef', gravitate: false },
      },
    });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const groups = screen.getByRole('button', { name: 'Groups' });
    fireEvent.click(groups);
    expect(groups).toHaveAttribute('aria-expanded', 'false');

    act(() => { useGraphStore.getState().createGroup('Newest group'); });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Groups' })).toHaveAttribute('aria-expanded', 'true');
      expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled();
    });
  });

  it('keeps an empty Groups section expanded and disables its disclosure toggle', () => {
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);
    const groups = screen.getByRole('button', { name: 'Groups' });

    expect(groups).toHaveAttribute('aria-disabled', 'true');
    expect(groups).toHaveAttribute('aria-expanded', 'true');
    expect(groups).toHaveAttribute('data-tip', 'There are no groups to collapse');

    fireEvent.click(groups);
    expect(groups).toHaveAttribute('aria-expanded', 'true');
  });

  it('shows the active project and last-interacted group with an exact hidden count when collapsed', () => {
    const project = createBlankProject('Active project', root.id, () => 0.2);
    const other = createBlankProject('Other project', 'other-root', () => 0.4);
    useGraphStore.setState({
      project: {
        ...project,
        nodes: { root },
        groups: {
          g1: { id: 'g1', name: 'First group', color: '#123456', gravitate: false },
          g2: { id: 'g2', name: 'Remembered group', color: '#abcdef', gravitate: false },
        },
      },
      projectList: [
        { id: project.id, name: project.name, createdAt: 0, updatedAt: 0, color: project.color },
        { id: other.id, name: other.name, createdAt: 0, updatedAt: 0, color: other.color },
      ],
      activeProjectId: project.id,
      lastInteractedGroupIds: { [project.id]: 'g2' },
    });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    fireEvent.click(screen.getByRole('button', { name: 'Groups' }));

    expect(screen.getByText('Active project')).toBeVisible();
    expect(screen.queryByText('Other project')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 1 more project' })).toBeVisible();
    expect(screen.getByText('Remembered group')).toBeVisible();
    expect(screen.queryByText('First group')).toBeNull();
    expect(screen.getByRole('button', { name: 'Show 1 more group' })).toBeVisible();
  });

  it('keeps one-item sections expanded and disables their disclosure toggles', async () => {
    const project = createBlankProject('Only project', root.id, () => 0.2);
    useGraphStore.setState({
      project: {
        ...project,
        nodes: { root },
        groups: { g1: { id: 'g1', name: 'Only group', color: '#123456', gravitate: false } },
      },
      projectList: [
        { id: project.id, name: project.name, createdAt: 0, updatedAt: 0, color: project.color },
      ],
      activeProjectId: project.id,
      lastInteractedGroupIds: { [project.id]: 'g1' },
    });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);

    const projects = screen.getByRole('button', { name: 'Projects' });
    const groups = screen.getByRole('button', { name: 'Groups' });

    await waitFor(() => {
      expect(projects).toHaveAttribute('aria-disabled', 'true');
      expect(projects).toHaveAttribute('aria-expanded', 'true');
      expect(projects).toHaveAttribute('data-tip', 'A single project cannot be collapsed');
      expect(groups).toHaveAttribute('aria-disabled', 'true');
      expect(groups).toHaveAttribute('aria-expanded', 'true');
      expect(groups).toHaveAttribute('data-tip', 'A single group cannot be collapsed');
    });

    fireEvent.click(projects);
    fireEvent.click(groups);
    expect(projects).toHaveAttribute('aria-expanded', 'true');
    expect(groups).toHaveAttribute('aria-expanded', 'true');
  });

  it('reopens collapsed sections when deletion leaves one item', async () => {
    const project = createBlankProject('Active project', root.id, () => 0.2);
    const other = createBlankProject('Other project', 'other-root', () => 0.4);
    useGraphStore.setState({
      project: {
        ...project,
        nodes: { root },
        groups: {
          g1: { id: 'g1', name: 'First group', color: '#123456', gravitate: false },
          g2: { id: 'g2', name: 'Second group', color: '#abcdef', gravitate: false },
        },
      },
      projectList: [
        { id: project.id, name: project.name, createdAt: 0, updatedAt: 0, color: project.color },
        { id: other.id, name: other.name, createdAt: 0, updatedAt: 0, color: other.color },
      ],
      activeProjectId: project.id,
    });
    render(<Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    fireEvent.click(screen.getByRole('button', { name: 'Groups' }));
    expect(screen.getByRole('button', { name: 'Projects' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Groups' })).toHaveAttribute('aria-expanded', 'false');

    act(() => {
      useGraphStore.setState((state) => ({
        projectList: state.projectList.slice(0, 1),
        project: state.project ? {
          ...state.project,
          groups: { g1: state.project.groups.g1! },
        } : null,
      }));
    });

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Projects' })).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByRole('button', { name: 'Projects' })).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('button', { name: 'Groups' })).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByRole('button', { name: 'Groups' })).toHaveAttribute('aria-expanded', 'true');
    });
  });

  it('shows no logo and reshuffles individually coloured letters when a node gains focus', async () => {
    const project = createBlankProject('wordmark', root.id, () => 0.2);
    useGraphStore.getState().setProject({
      ...project,
      color: '#123456',
      nodes: { root },
      groups: {
        g1: { id: 'g1', name: 'One', color: '#abcdef', gravitate: false },
      },
    });
    let random = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => {
      random = (random + 0.271) % 1;
      return random;
    });

    const { container } = render(
      <Sidebar collapsed={false} onToggle={vi.fn()} onOpenSettings={vi.fn()} />,
    );

    expect(container.querySelector('.app-logo')).toBeNull();
    const before = await waitFor(() => {
      const letters = [...container.querySelectorAll<HTMLElement>('.app-wordmark-letter')];
      expect(letters).toHaveLength(7);
      return letters.map((letter) => letter.style.color).join('|');
    });

    act(() => { useGraphStore.getState().setSelection(['root']); });

    await waitFor(() => {
      const after = [...container.querySelectorAll<HTMLElement>('.app-wordmark-letter')]
        .map((letter) => letter.style.color)
        .join('|');
      expect(after).not.toBe(before);
    });
  });
});
