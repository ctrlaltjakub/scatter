import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ScatterNode } from './types';
import { createBlankProject, useGraphStore } from './useGraphStore';

function node(id: string, groupId?: string): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x: 100, y: 200 },
    frozen: false,
    versions: [{ header: id, body: 'Body', createdAt: 1, generatedBy: 'term-click' }],
    currentVersionIndex: 0,
    groupId,
  };
}

beforeEach(() => {
  useGraphStore.setState({
    project: {
      ...createBlankProject('Fit', 'a'),
      nodes: { a: node('a'), b: node('b', 'group') },
      groups: { group: { id: 'group', name: 'Group', color: '#89b4fa', gravitate: false } },
      selection: ['a'],
    },
    panTo: null,
    panArrival: null,
    panRequestNonce: 0,
    selectedGroupId: null,
    lastInteractedGroupIds: {},
  });
  useGraphStore.temporal.getState().resume();
  useGraphStore.temporal.getState().clear();
});

afterEach(() => {
  useGraphStore.setState({ project: null, panTo: null, selectedGroupId: null, lastInteractedGroupIds: {} });
  useGraphStore.temporal.getState().clear();
});

describe('explicit node fit', () => {
  it('focuses its target and publishes centered camera intent atomically', () => {
    const notifications: Array<{ selection: string[]; centered: boolean }> = [];
    const unsubscribe = useGraphStore.subscribe((state) => {
      notifications.push({
        selection: state.project!.selection,
        centered: state.panTo?.kind === 'node' && state.panTo.fit === 'centered',
      });
    });
    const previousProject = useGraphStore.getState().project!;
    useGraphStore.getState().requestFitNode('b');
    unsubscribe();
    const state = useGraphStore.getState();
    expect(notifications).toEqual([{ selection: ['b'], centered: true }]);
    expect(state.panTo).toMatchObject({ kind: 'node', id: 'b', fit: 'centered' });
    expect(state.project!.nodes).toBe(previousProject.nodes);
    expect(state.project!.updatedAt).toBe(previousProject.updatedAt);
    expect(state.lastInteractedGroupIds[previousProject.id]).toBe('group');
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it.each(['multiple nodes', 'group'])('replaces a %s selection with just the fitted node', (selection) => {
    if (selection === 'group') useGraphStore.getState().selectGroup('group');
    else useGraphStore.getState().setSelection(['a', 'b']);
    useGraphStore.getState().requestFitNode('b');
    expect(useGraphStore.getState().project!.selection).toEqual(['b']);
    expect(useGraphStore.getState().selectedGroupId).toBeNull();
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
  });

  it('refits an already focused node without replacing the project or accepting stale completion', () => {
    const project = useGraphStore.getState().project;
    useGraphStore.getState().requestFitNode('a');
    const first = useGraphStore.getState().panTo!;
    useGraphStore.getState().requestFitNode('a');
    const second = useGraphStore.getState().panTo!;
    expect(second.requestId).toBeGreaterThan(first.requestId);
    expect(useGraphStore.getState().project).toBe(project);
    useGraphStore.getState().completePanTo(first.requestId);
    expect(useGraphStore.getState().panTo).toBe(second);
    useGraphStore.getState().completePanTo(second.requestId);
    expect(useGraphStore.getState().panTo).toBeNull();
    expect(useGraphStore.getState().panArrival).toBeNull();
  });

  it('retains its full centered fit when focusing opens a chat/history panel', () => {
    useGraphStore.getState().requestFitNode('b');
    const fit = useGraphStore.getState().panTo;
    useGraphStore.getState().requestPanelReveal('b');
    expect(useGraphStore.getState().panTo).toBe(fit);
  });

  it('does not discard redo history', () => {
    useGraphStore.getState().updateNode('a', { frozen: true });
    useGraphStore.temporal.getState().undo();
    expect(useGraphStore.temporal.getState().futureStates).toHaveLength(1);
    useGraphStore.getState().requestFitNode('b');
    expect(useGraphStore.temporal.getState().pastStates).toHaveLength(0);
    expect(useGraphStore.temporal.getState().futureStates).toHaveLength(1);
  });

  it('ignores missing/deleted targets and a closed project without disturbing camera intent', () => {
    useGraphStore.getState().requestFitNode('a');
    const state = useGraphStore.getState();
    state.requestFitNode('missing');
    expect(useGraphStore.getState()).toBe(state);
    useGraphStore.setState({ project: null });
    const closed = useGraphStore.getState();
    closed.requestFitNode('a');
    expect(useGraphStore.getState()).toBe(closed);
  });
});
