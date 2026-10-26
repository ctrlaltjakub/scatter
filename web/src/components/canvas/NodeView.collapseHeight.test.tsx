import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, act, cleanup } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { NodeView } from './NodeView';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useSettingsStore } from '@/store/useSettingsStore';
import { DEFAULT_SETTINGS } from '@/store/types';
import { appendChatAnswer, createChatNode, updateChatAnswer } from '@/lib/chat/model';

type ResizeObserverCallbackLike = (entries: Array<{ target: Element; contentRect: { height: number } }>) => void;

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  callback: ResizeObserverCallbackLike;
  observed: Element[] = [];

  constructor(callback: ResizeObserverCallbackLike) {
    this.callback = callback;
    TestResizeObserver.instances.push(this);
  }

  observe(el: Element) { this.observed.push(el); }
  unobserve() {}
  disconnect() {}
}

/** BCR reads on hidden-lab items — the witness that the deferred lab
 *  remount actually measured (the labs themselves unmount again as soon
 *  as the measurements converge, so DOM presence can't be asserted). */
let labItemReads = 0;

beforeEach(() => {
  vi.useFakeTimers();
  labItemReads = 0;
  TestResizeObserver.instances = [];
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = TestResizeObserver;
  useGraphStore.getState().requestPanTo(null);
  useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const cls = (this as HTMLElement).classList;
    let h = 0;
    const w = 480;
    if (cls?.contains('sc-ab-root')) h = 280;
    else if (cls?.contains('sc-ab-freetext')) h = 40;
    else if (cls?.contains('sc-ab-item')) {
      if ((this as HTMLElement).closest('.sc-ab-measure')) labItemReads++;
      h = 28;
    } else if (cls?.contains('node')) h = 420;
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useGraphStore.getState().setProject(null);
  useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan } });
});

const BODY = `Intro paragraph.

- **One**
  - a: first
  - b: second`;

const noop = () => {};

it.each(['empty', 'generating', 'complete'] as const)('keeps all chat resize handles in the %s state', (state) => {
  let node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 350 });
  if (state !== 'empty') node = appendChatAnswer(node, { turnId: 'first', createdAt: 2, question: 'Question' });
  if (state === 'complete') node = { ...updateChatAnswer(node, { turnId: 'first', versionCreatedAt: 2 },
    { body: 'Answer' }, { state: 'complete' }), generating: false, streamingText: false };
  const project = createBlankProject('Chat resizing', node.id);
  useGraphStore.getState().setProject({ ...project, nodes: { [node.id]: node } });
  const { container } = render(<NodeView node={node} selected={false} onSelect={noop} onReferenceClick={noop}
    onDragStart={noop} onDragMove={noop} onDragEnd={noop} />);
  expect(container.querySelectorAll('.node-resize')).toHaveLength(4);
});

function makeNode(id: string, collapsed = false): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    bulletsCollapsed: collapsed,
    versions: [{
      header: 'Node',
      body: BODY,
      createdAt: 0,
      generatedBy: 'root',
      width: 624,
      bodyMaxHeight: 280,
      minBodyHeight: 180,
      fullBodyHeight: 280,
      freeTextHeight: 40,
      expandedMeasureWidth: 624,
    }],
    currentVersionIndex: 0,
  };
}

function renderNode(collapsed = false) {
  const node = makeNode('n0', collapsed);
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

function nodeResizeObserver(): TestResizeObserver {
  const found = TestResizeObserver.instances.find((ro) =>
    ro.observed.some((el) => (el as HTMLElement).classList.contains('node')),
  );
  if (!found) throw new Error('node ResizeObserver not found');
  return found;
}

it('keeps all four resize handles outside the paint-contained detail surface', () => {
  const { container } = renderNode();
  const card = container.querySelector('.node');
  const handles = container.querySelectorAll('.node-resize');
  expect(handles).toHaveLength(4);
  for (const handle of handles) expect(handle.parentElement).toBe(card);
  expect(container.querySelector('.node-detail-surface .node-resize')).toBeNull();
});

function emitNodeHeight(height: number) {
  const ro = nodeResizeObserver();
  const target = ro.observed.find((el) => (el as HTMLElement).classList.contains('node'))!;
  act(() => {
    ro.callback([{ target, contentRect: { height } }]);
  });
}

function flushHeightFrame() {
  act(() => { vi.advanceTimersByTime(17); });
}

describe('NodeView collapse/expand height publishing', () => {
  it('suppresses intermediate renderedHeight writes during collapse animation', () => {
    const { getByLabelText } = renderNode();
    emitNodeHeight(420);
    // ResizeObserver samples are intentionally committed on the next frame so
    // they cannot synchronously re-enter React's layout cycle.
    expect(useGraphStore.getState().project?.nodes.n0?.renderedHeight).toBeUndefined();
    flushHeightFrame();
    expect(useGraphStore.getState().project?.nodes.n0?.renderedHeight).toBe(420);

    fireEvent.click(getByLabelText('Collapse node'));
    emitNodeHeight(300);

    expect(useGraphStore.getState().project?.nodes.n0?.renderedHeight).toBe(420);

    act(() => { vi.advanceTimersByTime(320); });
    flushHeightFrame();
    expect(useGraphStore.getState().project?.nodes.n0?.renderedHeight).toBe(300);
  });

  it('coalesces resize bursts into the latest height for one frame', () => {
    renderNode();
    emitNodeHeight(404);
    emitNodeHeight(412);
    emitNodeHeight(428);

    expect(useGraphStore.getState().project?.nodes.n0?.renderedHeight).toBeUndefined();
    flushHeightFrame();
    expect(useGraphStore.getState().project?.nodes.n0?.renderedHeight).toBe(428);
  });

  it('measures a collapsed node at mount so expanding needs no lab remount', () => {
    const { getByLabelText, container } = renderNode(true);
    // The labs measured invisibly at mount (node still collapsed) and,
    // having converged, unmounted — so the first expand is always warm.
    expect(labItemReads).toBeGreaterThan(0);
    expect(container.querySelectorAll('.sc-ab-measure').length).toBe(0);

    labItemReads = 0;
    fireEvent.click(getByLabelText('Expand node'));
    expect(labItemReads).toBe(0);
    expect(container.querySelectorAll('.sc-ab-measure').length).toBe(0);

    act(() => { vi.advanceTimersByTime(280); });
    // Measurements were fresh from the mount-time pass — the expand needs
    // no lab remount at all (this used to be the heavy "cold expand").
    expect(labItemReads).toBe(0);
    expect(container.querySelectorAll('.sc-ab-measure').length).toBe(0);
  });

  it.each([true, false])('respects expansion camera setting after the card height is measured (enabled=%s)', enabled => {
    useSettingsStore.setState({ cameraAutoPan: { ...DEFAULT_SETTINGS.cameraAutoPan, expand: enabled } });
    const { getByLabelText } = renderNode(true);
    fireEvent.click(getByLabelText('Expand node'));
    expect(useGraphStore.getState().panTo).toBeNull();

    emitNodeHeight(420);
    expect(useGraphStore.getState().panTo).toBeNull();

    act(() => { vi.advanceTimersByTime(320); });
    expect(useGraphStore.getState().panTo?.id).toBe(enabled ? 'n0' : undefined);
  });
});
