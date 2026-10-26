import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { NodeSelectionToolbar } from './NodeSelectionToolbar';
import { cancelNodeGeneration } from '@/lib/generate';
import { secondaryTaskCompletion } from '@/lib/secondaryTaskCompletion';
vi.mock('@/lib/generate', () => ({ cancelNodeGeneration: vi.fn() }));
vi.mock('@/lib/secondaryTaskCompletion', () => ({ secondaryTaskCompletion: vi.fn() }));
beforeEach(() => {
  const project = createBlankProject('Test', 'root');
  project.nodes = Object.fromEntries(['root', 'a', 'b'].map((id) => [id, {
    id, type: 'term-click', position: { x: 0, y: 0 }, frozen: id === 'b',
    versions: [{ header: id, body: 'Body.', createdAt: 1, generatedBy: 'manual' }], currentVersionIndex: 0,
  }]));
  project.selection = ['a', 'b'];
  project.groups = { g: { id: 'g', name: 'Learning', color: '#00ff00', gravitate: false } };
  useGraphStore.setState({ project, selectedGroupId: null });
  useGraphStore.temporal.getState().clear();
  vi.mocked(cancelNodeGeneration).mockClear();
  vi.mocked(secondaryTaskCompletion).mockReset();
});
afterEach(cleanup);
describe('multi-selection toolbar', () => {
  it('also appears for a selected one-node group, but not an empty group', () => {
    const graph = useGraphStore.getState();
    graph.assignNodeToGroup('a', 'g');
    graph.selectGroup('g');
    render(<NodeSelectionToolbar />);
    expect(screen.getByRole('toolbar', { name: 'Selected nodes' })).toBeInTheDocument();
    expect(useGraphStore.getState().project?.selection).toEqual(['a']);
    fireEvent.click(screen.getByRole('button', { name: 'Pin selected nodes' }));
    expect(useGraphStore.getState().project?.nodes.a?.frozen).toBe(true);
    act(() => {
      const empty = graph.createGroup('Empty');
      graph.selectGroup(empty);
    });
    expect(screen.queryByRole('toolbar', { name: 'Selected nodes' })).not.toBeInTheDocument();
  });
  it('clears the group origin on deletion and restores nodes through undo', () => {
    const graph = useGraphStore.getState();
    graph.assignNodesToGroup(['a', 'b'], 'g');
    graph.selectGroup('g');
    useGraphStore.temporal.getState().clear();
    render(<NodeSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected nodes' }));
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
    expect(useGraphStore.getState().project?.selection).toEqual([]);
    expect(Object.keys(useGraphStore.getState().project!.nodes)).toEqual(['root']);
    act(() => useGraphStore.temporal.getState().undo());
    expect(useGraphStore.getState().project?.nodes.a?.groupId).toBe('g');
    expect(useGraphStore.getState().project?.nodes.b?.groupId).toBe('g');
  });
  it('appears only for multiple nodes, and handles mixed pins', () => {
    render(<NodeSelectionToolbar />);
    expect(screen.getByRole('toolbar', { name: 'Selected nodes' })).toBeInTheDocument();
    expect(screen.queryByText(/\d+ selected/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pin selected nodes' }));
    expect(useGraphStore.getState().project!.nodes.a!.frozen).toBe(true);
    expect(screen.getByRole('button', { name: 'Unpin selected nodes' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unpin selected nodes' }));
    expect(useGraphStore.getState().project!.nodes.b!.frozen).toBe(false);
    act(() => useGraphStore.getState().setSelection(['a']));
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });
  it('reuses the group rows without branch actions and closes after applying or Escape', () => {
    render(<NodeSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to group' }));
    expect(screen.queryByRole('button', { name: 'Add branch to new group' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add selected nodes to Learning' }));
    expect(useGraphStore.getState().project!.nodes.a!.groupId).toBe('g');
    expect(useGraphStore.getState().project!.nodes.b!.groupId).toBe('g');
    expect(screen.queryByRole('region', { name: 'Groups' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add to group' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('region', { name: 'Groups' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add to group' })).toHaveFocus();
  });
  it('deletes and stops only the affected nodes in one undoable action', () => {
    render(<NodeSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete selected nodes' }));
    expect(Object.keys(useGraphStore.getState().project!.nodes)).toEqual(['root']);
    expect(cancelNodeGeneration).toHaveBeenCalledTimes(2);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    act(() => useGraphStore.temporal.getState().undo());
    expect(useGraphStore.getState().project!.nodes.a).toBeDefined();
    expect(useGraphStore.getState().project!.nodes.b).toBeDefined();
  });
  it('creates the group immediately and keeps the toolbar available while it is named', async () => {
    let resolve!: (text: string) => void;
    vi.mocked(secondaryTaskCompletion).mockImplementation(() => new Promise(r => { resolve = r; }));
    render(<NodeSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to new group' }));
    expect(screen.getByRole('button', { name: 'Add to group' })).not.toBeDisabled();
    expect(Object.values(useGraphStore.getState().project!.groups).some(g => g.name === 'Generating title')).toBe(true);
    await act(async () => resolve('{"name":"Learning Strategies"}'));
    expect(Object.values(useGraphStore.getState().project!.groups).some(g => g.name === 'Learning Strategies')).toBe(true);
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Add to group' })).toHaveFocus();
  });
  it('keeps naming after deselection and toolbar unmount', async () => {
    let resolve!: (text: string) => void;
    vi.mocked(secondaryTaskCompletion).mockImplementation(() => new Promise(r => { resolve = r; }));
    const view = render(<NodeSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to group' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add to new group' }));
    const signal = vi.mocked(secondaryTaskCompletion).mock.calls[0]![0].signal;
    act(() => useGraphStore.getState().setSelection(['a']));
    view.unmount();
    expect(signal?.aborted).toBe(false);
    await act(async () => resolve('{"name":"Learning Strategies"}'));
    expect(Object.values(useGraphStore.getState().project!.groups).some(g => g.name === 'Learning Strategies')).toBe(true);
  });
  it('keeps the assigned group and stores an error if naming fails', async () => {
    vi.mocked(secondaryTaskCompletion).mockRejectedValue(new Error('Choose a secondary tasks model first.'));
    render(<NodeSelectionToolbar />);
    fireEvent.click(screen.getByRole('button', { name: 'Add to group' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Add to new group' })));
    expect(Object.values(useGraphStore.getState().project!.groups).find(g => g.name === 'Untitled group')?.titleGeneration?.error).toBe('Choose a secondary tasks model first.');
    expect(screen.getByRole('button', { name: 'Add to group' })).not.toBeDisabled();
  });
});
