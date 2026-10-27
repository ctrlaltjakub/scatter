import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createBlankProject, useGraphStore } from './useGraphStore';
import { birthIsPending, NODE_ENTRANCE_MS, useNodeBirthStore } from './useNodeBirthStore';
import type { ScatterNode } from './types';

const birth = () => useNodeBirthStore.getState();
const card = (id: string): ScatterNode => ({ id, type: 'manual-empty', position: { x: 0, y: 0 }, frozen: false,
  currentVersionIndex: 0, versions: [{ header: id, body: '', createdAt: 1, generatedBy: 'manual', emptyText: true }] });
beforeEach(() => { vi.useFakeTimers(); birth().clear(); useGraphStore.getState().setProject(createBlankProject('Test', 'root')); });
afterEach(() => { birth().clear(); vi.useRealTimers(); });

test('only reveals a measured node after the matching worker acknowledgement', () => {
  birth().begin('p', 'n');
  const token = birth().byNode.n!.token;
  expect(birthIsPending(birth().byNode.n)).toBe(true);
  birth().measure('n', 0, 780);
  birth().measure('n', Infinity, 780);
  expect(birth().byNode.n!.phase).toBe('measuring');
  birth().measure('n', 624, 780);
  expect(birth().byNode.n!.size).toEqual({ width: 624, height: 780 });
  birth().reveal('n', token - 1);
  expect(birth().byNode.n!.phase).toBe('placing');
  birth().reveal('n', token);
  expect(birthIsPending(birth().byNode.n)).toBe(false);
  vi.advanceTimersByTime(NODE_ENTRANCE_MS);
  expect(birth().byNode).toEqual({});
});

test('deleted nodes, switches and stale acknowledgements cannot resurrect an entrance', () => {
  birth().begin('p', 'n');
  const old = birth().byNode.n!.token;
  birth().prune('p', new Set());
  birth().reveal('n', old);
  expect(birth().byNode).toEqual({});
  birth().begin('p', 'n');
  birth().reveal('n', old);
  expect(birth().byNode.n!.phase).toBe('measuring');
  birth().prune('other-project', new Set(['n']));
  expect(birth().byNode).toEqual({});
});

test('creation stays one undo step; redo and snapshot loading do not replay it', () => {
  const graph = useGraphStore.getState();
  useGraphStore.temporal.getState().clear();
  graph.addNodeWithArrow(card('child'), { id: 'arrow', fromNodeId: 'root', toNodeId: 'child', kind: 'auto' });
  expect(birth().byNode.child!.parentId).toBe('root');
  expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
  birth().measure('child', 624, 780);
  birth().reveal('child', birth().byNode.child!.token);
  expect(useGraphStore.temporal.getState().pastStates).toHaveLength(1);
  useGraphStore.temporal.getState().undo();
  birth().prune(graph.project!.id, new Set(Object.keys(useGraphStore.getState().project!.nodes)));
  useGraphStore.temporal.getState().redo();
  expect(useGraphStore.getState().project!.nodes.child).toBeDefined();
  expect(birth().byNode).toEqual({});
  graph.setProject(useGraphStore.getState().project, { resetRuntime: true });
  expect(birth().byNode).toEqual({});
});

test('same-project root metadata updates preserve a pending creation; explicit reload cancels it', () => {
  const graph = useGraphStore.getState();
  graph.addNode(card('root'));
  graph.setProject({ ...useGraphStore.getState().project!, name: 'Updated title' });
  expect(birth().byNode.root).toBeDefined();
  graph.setProject(useGraphStore.getState().project, { resetRuntime: true });
  expect(birth().byNode).toEqual({});
});
