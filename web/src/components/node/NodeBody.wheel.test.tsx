import { act, render, screen } from '@testing-library/react';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ScatterNode } from '@/store/types';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { useReadingStore } from '@/store/useReadingStore';
import { NodeBody } from './NodeBody';

const BODY = `Opening paragraph.

- Alpha
  - a1: first detail
- Beta
  - b1: second detail`;

const CHANGED_BODY = `Changed opening paragraph.

- Alpha
  - a1: changed detail
- Beta
  - b1: changed second detail`;

it('keeps rate-limit notices outside the clipped body even on a very short node', () => {
  setNode();
  const { container } = render(<NodeBody body={BODY} parentNodeId="n0" selected={false}
    onReferenceClick={() => {}} bodyStyle={{ height: 12, overflow: 'hidden' }}
    error="This model is rate limited. Try again shortly." />);
  const notice = screen.getByRole('alert');
  const body = container.querySelector('.node-body')!;
  expect(body.contains(notice)).toBe(false);
  expect(notice.nextElementSibling).toBe(body);
});

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function setNode(collapsed = false) {
  const node: ScatterNode = {
    id: 'n0',
    type: 'root',
    position: { x: 0, y: 0 },
    frozen: false,
    bulletsCollapsed: collapsed,
    versions: [{ header: 'Header', body: BODY, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
  const project = createBlankProject('wheel test', 'n0');
  useGraphStore.getState().setProject({ ...project, nodes: { n0: node } });
  useGraphStore.temporal.getState().pause();
}

function wheel(
  element: Element,
  deltaY: number,
  timeStamp: number,
  init: WheelEventInit = {},
): WheelEvent {
  const event = new WheelEvent('wheel', {
    deltaY,
    deltaMode: 0,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  element.dispatchEvent(event);
  return event;
}

describe('NodeBody wheel section navigation', () => {
  beforeEach(() => {
    useRewriteStore.setState({ activeByNode: {}, workingBody: {} });
    useActiveIdxStore.setState({ byNodeId: {} });
    useGraphStore.getState().setProject(null);
    useReadingStore.getState().reset();
    setNode();
  });

  it('steps immediately when the first smooth direction is recognized', () => {
    const { container } = render(
      <NodeBody body={BODY} parentNodeId="n0" selected onReferenceClick={() => {}} />,
    );
    const body = container.querySelector('.node-body')!;

    act(() => {
      wheel(body, 20, 0);
    });

    expect(useActiveIdxStore.getState().byNodeId.n0).toBeUndefined();

    act(() => { wheel(body, 20, 16); });

    expect(useActiveIdxStore.getState().byNodeId.n0).toBe(0);
  });

  it('exits the reading ruler when wheel input changes the active section', () => {
    const { container } = render(
      <NodeBody body={BODY} parentNodeId="n0" selected onReferenceClick={() => {}} />,
    );
    const body = container.querySelector('.node-body')!;
    useReadingStore.getState().begin('n0', 0, 0, null);

    act(() => {
      wheel(body, 20, 0);
      wheel(body, 20, 16);
    });

    expect(useActiveIdxStore.getState().byNodeId.n0).toBe(0);
    expect(useReadingStore.getState().nodeId).toBeNull();
  });

  it('clears partial smooth motion when bullets collapse', () => {
    const { container } = render(
      <NodeBody body={BODY} parentNodeId="n0" selected onReferenceClick={() => {}} />,
    );
    const body = container.querySelector('.node-body')!;

    act(() => {
      for (let index = 0; index < 4; index++) wheel(body, 20, index * 16);
      useGraphStore.getState().updateNode('n0', { bulletsCollapsed: true });
    });
    act(() => useGraphStore.getState().updateNode('n0', { bulletsCollapsed: false }));
    act(() => { wheel(body, 20, 120); });

    expect(useActiveIdxStore.getState().byNodeId.n0).toBe(0);
  });

  it('clears partial smooth motion when displayed content changes', () => {
    const { container, rerender } = render(
      <NodeBody body={BODY} parentNodeId="n0" selected onReferenceClick={() => {}} />,
    );
    const body = container.querySelector('.node-body')!;

    act(() => {
      for (let index = 0; index < 4; index++) wheel(body, 20, index * 16);
    });
    rerender(
      <NodeBody body={CHANGED_BODY} parentNodeId="n0" selected onReferenceClick={() => {}} />,
    );
    act(() => { wheel(body, 20, 120); });

    expect(useActiveIdxStore.getState().byNodeId.n0).toBe(0);
  });

  it('leaves modifiers, horizontal input, and unfocused nodes untouched', () => {
    const { container, rerender } = render(
      <NodeBody body={BODY} parentNodeId="n0" selected onReferenceClick={() => {}} />,
    );
    const body = container.querySelector('.node-body')!;

    let ctrlEvent!: WheelEvent;
    let horizontalEvent!: WheelEvent;
    act(() => {
      ctrlEvent = wheel(body, 100, 0, { ctrlKey: true });
      horizontalEvent = wheel(body, 20, 16, { deltaX: 40 });
    });
    rerender(
      <NodeBody body={BODY} parentNodeId="n0" selected={false} onReferenceClick={() => {}} />,
    );
    let unfocusedEvent!: WheelEvent;
    act(() => { unfocusedEvent = wheel(body, 100, 32); });

    expect(ctrlEvent.defaultPrevented).toBe(false);
    expect(horizontalEvent.defaultPrevented).toBe(false);
    expect(unfocusedEvent.defaultPrevented).toBe(false);
    expect(useActiveIdxStore.getState().byNodeId.n0).toBeUndefined();
  });
});
