import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { NodeView } from './NodeView';

vi.mock('@/lib/shakeDetect', () => ({
  createShakeDetector: () => ({
    reset: () => {},
    push: () => true,
  }),
}));

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 480, bottom: 80,
    width: 480, height: 80, toJSON: () => ({}),
  } as DOMRect);
});

afterEach(() => cleanup());

describe('NodeView shake-to-unpin gesture state', () => {
  it('marks every later drag move as suppressed after the shake unpins the node', () => {
    const node: ScatterNode = {
      id: 'n0',
      type: 'term-click',
      position: { x: 0, y: 0 },
      frozen: true,
      versions: [{ header: 'Pinned', body: 'Body.', createdAt: 0, generatedBy: 'term-click' }],
      currentVersionIndex: 0,
    };
    const project = createBlankProject('shake', node.id);
    useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
    useGraphStore.temporal.getState().pause();
    const onDragMove = vi.fn();
    const { container } = render(
      <NodeView
        node={node}
        selected={false}
        onSelect={() => {}}
        onReferenceClick={() => {}}
        onDragStart={() => {}}
        onDragMove={onDragMove}
        onDragEnd={() => {}}
      />,
    );
    const handle = container.querySelector('[data-tip="Drag to move the node"]')!;

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 30, clientY: 10 });
    expect(useGraphStore.getState().project?.nodes.n0?.frozen).toBe(false);
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 45, clientY: 10 });

    expect(onDragMove).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.any(Number),
      { unpinnedByShake: true },
    );
  });
});
