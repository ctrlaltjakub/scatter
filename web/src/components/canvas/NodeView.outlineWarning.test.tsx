import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { ScatterNode } from '@/store/types';
import { warnAboutRetainedOutline } from '@/lib/retainedOutlineWarning';
import { NodeView } from './NodeView';

const onRetry = vi.fn();
const onSelect = vi.fn();
const noop = () => {};
function LiveCard() {
  const node = useGraphStore(state => state.project!.nodes.n!);
  return <NodeView node={node} selected={false} onRetry={onRetry} onSelect={onSelect}
    onReferenceClick={noop} onDragStart={noop} onDragMove={noop} onDragEnd={noop} />;
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const node: ScatterNode = { id: 'n', type: 'term-click', position: { x: 0, y: 0 }, frozen: false,
    currentVersionIndex: 1, versions: [
      { header: 'First', body: 'Previous version.', generatedBy: 'term-click', createdAt: 1 },
      { header: 'Second', body: 'Original draft⟦1⟧.', generatedBy: 'term-click', createdAt: 2,
        sources: [{ n: 1, url: 'https://example.org/study' }] },
    ] };
  const project = { ...createBlankProject('outline', node.id), nodes: { n: node } };
  useGraphStore.getState().setProject(project);
  useGraphStore.getState().setActiveProjectId(project.id);
  warnAboutRetainedOutline(project.id, node.id, 1, 'An outline correction failed.');
});
afterEach(() => {
  cleanup();
  useGraphStore.getState().setActiveProjectId(null);
  useGraphStore.getState().setProject(null);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it('offers Retry and Ignore on the affected version; Ignore only hides the alert', async () => {
  await act(async () => { render(<LiveCard />); });
  expect(screen.getByRole('alert').textContent).toContain('An outline correction failed.');
  expect(screen.getByRole('button', { name: 'Retry' })).toBeDefined();
  const show = (index: number) => act(async () => { useGraphStore.getState().updateNode('n', { currentVersionIndex: index }); });
  await show(0);
  expect(screen.queryByRole('alert')).toBeNull();
  await show(1);
  const versions = useGraphStore.getState().project!.nodes.n!.versions;
  const lastEdit = useGraphStore.getState().project!.updatedAt;
  const undoCount = useGraphStore.temporal.getState().pastStates.length;
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Ignore' })); });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(useGraphStore.getState().project!.nodes.n!.versions).toBe(versions);
  expect(useGraphStore.getState().project!.updatedAt).toBe(lastEdit);
  expect(useGraphStore.temporal.getState().pastStates).toHaveLength(undoCount);
  expect(onRetry).not.toHaveBeenCalled();
  expect(onSelect).not.toHaveBeenCalled();
  await show(0);
  await show(1);
  expect(screen.queryByRole('alert')).toBeNull();
});
