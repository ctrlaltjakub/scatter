import { beforeEach, describe, expect, it } from 'vitest';
import { createBlankProject, useGraphStore } from './useGraphStore';
import type { Arrow, ScatterNode } from './types';

const node = (id: string): ScatterNode => ({
  id, type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
  versions: [{ header: id, body: 'Text.', createdAt: 1, generatedBy: 'manual' }], currentVersionIndex: 0,
});
const arrow = (from: string, to: string, kind: Arrow['kind'] = 'auto'): Arrow => ({
  id: `${from}-${to}`, fromNodeId: from, toNodeId: to, kind,
});
const graph = () => useGraphStore.getState();
const history = () => useGraphStore.temporal.getState();
beforeEach(() => {
  const project = createBlankProject('Selection', 'root');
  project.nodes = Object.fromEntries(['root', 'a', 'b', 'c', 'd', 'outside'].map((id) => [id, node(id)]));
  project.groups = { g: { id: 'g', name: 'Group', color: '#ff0000', gravitate: false } };
  useGraphStore.setState({ project, selectedGroupId: null });
  history().clear();
});

describe('bulk node actions', () => {
  it('selection is transient; pin/unpin changes the whole set in one undo step', () => {
    graph().setSelection(['a', 'b']);
    graph().setSelection(['a', 'b', 'c']);
    expect(history().pastStates).toHaveLength(0);
    graph().setNodesFrozen(['a', 'b', 'missing'], true);
    expect(history().pastStates).toHaveLength(1);
    expect(graph().project!.nodes.a!.frozen).toBe(true);
    expect(graph().project!.nodes.b!.frozen).toBe(true);
    history().undo();
    expect(graph().project!.nodes.a!.frozen).toBe(false);
    expect(graph().project!.nodes.b!.frozen).toBe(false);
    history().redo();
    expect(graph().project!.nodes.a!.frozen).toBe(true);
    graph().setNodesFrozen(['a', 'b'], true);
    expect(history().pastStates).toHaveLength(1);
  });
  it('assigns/removes just selected nodes, leaves the root ungrouped, and undoes together', () => {
    graph().assignNodesToGroup(['root', 'a', 'b'], 'g');
    expect(history().pastStates).toHaveLength(1);
    expect(graph().project!.nodes.root!.groupId).toBeUndefined();
    expect(graph().project!.nodes.a!.groupId).toBe('g');
    expect(graph().project!.nodes.b!.groupId).toBe('g');
    expect(graph().project!.nodes.c!.groupId).toBeUndefined();
    graph().assignNodesToGroup(['a', 'b'], null);
    expect(graph().project!.nodes.a!.groupId).toBeUndefined();
    history().undo();
    expect(graph().project!.nodes.a!.groupId).toBe('g');
    expect(graph().project!.nodes.b!.groupId).toBe('g');
    history().undo();
    expect(graph().project!.nodes.a!.groupId).toBeUndefined();
  });
  it('creates a group and assigns its selection atomically', () => {
    const id = graph().createGroupFromNodes(['root', 'a', 'b']);
    expect(history().pastStates).toHaveLength(1);
    expect(graph().project!.groups[id]).toBeDefined();
    expect(graph().project!.nodes.a!.groupId).toBe(id);
    expect(graph().project!.nodes.b!.groupId).toBe(id);
    expect(graph().project!.nodes.root!.groupId).toBeUndefined();
    history().undo();
    expect(graph().project!.groups[id]).toBeUndefined();
    expect(graph().project!.nodes.a!.groupId).toBeUndefined();
    history().redo();
    expect(graph().project!.nodes.b!.groupId).toBe(id);
  });
  it('keeps the selected nodes but clears the old group row when moving them into a new group', () => {
    graph().assignNodesToGroup(['a', 'b'], 'g');
    graph().selectGroup('g');
    const id = graph().createGroupFromNodes(['a', 'b'], 'New group');
    expect(graph().selectedGroupId).toBeNull();
    expect(graph().project?.selection).toEqual(['a', 'b']);
    expect(graph().project?.nodes.a?.groupId).toBe(id);
    expect(graph().project?.nodes.b?.groupId).toBe(id);
  });
  it('deletes overlapping branches together while preserving externally referenced children', () => {
    const arrows = [arrow('a', 'b'), arrow('b', 'c'), arrow('a', 'd'), arrow('outside', 'b', 'dotted')];
    useGraphStore.setState((s) => ({ project: { ...s.project!, arrows: Object.fromEntries(arrows.map((a) => [a.id, a])) } }));
    history().clear();
    graph().deleteNodesCascade(['a', 'c']);
    expect(Object.keys(graph().project!.nodes).sort()).toEqual(['b', 'outside', 'root']);
    expect(graph().project!.arrows['outside-b']!.kind).toBe('auto');
    expect(history().pastStates).toHaveLength(1);
    history().undo();
    expect(graph().project!.nodes.c).toBeDefined();
    expect(graph().project!.nodes.d).toBeDefined();
    expect(graph().project!.arrows['outside-b']!.kind).toBe('dotted');
  });
  it('does not rescue children via another selected branch or rescue an explicitly selected child', () => {
    const arrows = [arrow('a', 'b'), arrow('outside', 'b', 'dotted')];
    useGraphStore.setState((s) => ({ project: { ...s.project!, arrows: Object.fromEntries(arrows.map((a) => [a.id, a])) } }));
    graph().deleteNodesCascade(['outside', 'a']);
    expect(graph().project!.nodes.b).toBeUndefined();
    history().undo();
    graph().deleteNodesCascade(['a', 'b']);
    expect(graph().project!.nodes.b).toBeUndefined();
    expect(graph().project!.nodes.outside).toBeDefined();
  });
});
