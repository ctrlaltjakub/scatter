/**
 * Dragged card paints on top.
 *
 * While a node is dragged it gets the `dragging` class (z-index 20 — above
 * selected/highlighted), so it slides OVER other cards while physics pushes
 * them aside. On release it keeps `drag-top` (z-index only) for a short
 * linger, so it doesn't pop underneath a neighbor it still overlaps while
 * the push-apart finishes.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { NodeView } from './NodeView';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const cls = (this as HTMLElement).classList;
    let h = 0;
    const w = 480;
    if (cls?.contains('sc-ab-root')) h = 280;
    else if (cls?.contains('sc-ab-freetext')) h = 40;
    else if (cls?.contains('sc-ab-item')) h = 28;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const noop = () => {};

function makeNode(id: string): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{ header: 'Node', body: 'Body.', createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

function renderNode() {
  const node = makeNode('n0');
  const proj = createBlankProject('t', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
  useGraphStore.temporal.getState().pause();
  return render(
    <NodeView
      node={node}
      selected={false}
      onSelect={noop}
      onReferenceClick={noop}
      onDragStart={noop}
      onDragMove={noop}
      onDragEnd={noop}
    />,
  );
}

const HANDLE = '[data-tip="Drag to move the node"]';

describe('NodeView — dragged card paints on top', () => {
  it('wears .dragging during the drag, .drag-top for a short linger, then neither', () => {
    vi.useFakeTimers();
    const { container } = renderNode();
    const card = container.querySelector('.node')!;
    const handle = container.querySelector(HANDLE)!;
    expect(card.classList.contains('dragging')).toBe(false);

    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 30, clientY: 10 }); // > 3px threshold
    expect(card.classList.contains('dragging')).toBe(true);
    expect(card.classList.contains('drag-top')).toBe(false);

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 30, clientY: 10 });
    expect(card.classList.contains('dragging')).toBe(false);
    expect(card.classList.contains('drag-top')).toBe(true);

    act(() => { vi.advanceTimersByTime(500); }); // linger is 400ms
    expect(card.classList.contains('drag-top')).toBe(false);
  });

  it('never raises the card for a click without movement', () => {
    const { container } = renderNode();
    const card = container.querySelector('.node')!;
    const handle = container.querySelector(HANDLE)!;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(card.classList.contains('dragging')).toBe(false);
    expect(card.classList.contains('drag-top')).toBe(false);
  });
});
