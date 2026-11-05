import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { NodeView } from './NodeView';

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

function renderNode() {
  const node: ScatterNode = {
    id: 'n0',
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{ header: 'Header', body: 'Body.', createdAt: 0, generatedBy: 'term-click' }],
    currentVersionIndex: 0,
  };
  useGraphStore.getState().setProject({ ...createBlankProject('drag-click', node.id), nodes: { [node.id]: node } });
  const onSelect = vi.fn();
  const { container } = render(
    <NodeView
      node={node}
      selected={false}
      onSelect={onSelect}
      onReferenceClick={() => {}}
      onDragStart={() => {}}
      onDragMove={() => {}}
      onDragEnd={() => {}}
    />,
  );
  return { handle: container.querySelector('[data-tip="Drag to move the node"]')!, onSelect };
}

function dragHeader(handle: Element, pointerType: string) {
  fireEvent.pointerDown(handle, { pointerId: 1, pointerType, clientX: 10, clientY: 10 });
  fireEvent.pointerMove(handle, { pointerId: 1, pointerType, clientX: 40, clientY: 30 });
  fireEvent.pointerUp(handle, { pointerId: 1, pointerType, clientX: 40, clientY: 30 });
}

describe('NodeView click after a header drag', () => {
  it('ignores the click that ends a mouse drag', () => {
    const { handle, onSelect } = renderNode();
    dragHeader(handle, 'mouse');
    fireEvent.click(handle);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects the node on the next tap after a touch drag, which ends without a click', () => {
    const { handle, onSelect } = renderNode();
    dragHeader(handle, 'touch');
    fireEvent.click(handle);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});
