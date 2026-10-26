import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { NodeBody } from './NodeBody';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useRewriteStore } from '@/store/useRewriteStore';
import { useActiveIdxStore } from '@/store/useActiveIdxStore';

const BODY = `Opening paragraph for the node.

- Alpha
  - a1: first detail
  - a2: second detail
- Beta
  - b1: third detail
  - b2: fourth detail`;

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    const cls = el.classList;
    let h = 0;
    const w = 480;
    if (cls?.contains('sc-ab-root')) h = 280;
    else if (cls?.contains('sc-ab-freetext')) h = 40;
    else if (cls?.contains('sc-ab-item')) {
      const titleH = 28;
      const describedRows = el.querySelectorAll('.sc-ab-described').length;
      const hasInline = el.querySelector('.sc-ab-inline') !== null;
      h = titleH + describedRows * 22 + (hasInline ? 22 : 0);
    }
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
});

function setNode(collapsed: boolean) {
  const node: ScatterNode = {
    id: 'n0',
    type: 'root',
    position: { x: 0, y: 0 },
    frozen: false,
    bulletsCollapsed: collapsed,
    versions: [{ header: 'H', body: BODY, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
  const proj = createBlankProject('collapse labs', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
  useGraphStore.temporal.getState().pause();
}

const renderBody = () =>
  render(
    <NodeBody body={BODY} parentNodeId="n0" selected={false} onReferenceClick={() => {}} />,
  );

describe('NodeBody collapse lab cleanup', () => {
  beforeEach(() => {
    useRewriteStore.setState({ activeByNode: {}, workingBody: {} });
    useActiveIdxStore.setState({ byNodeId: {} });
    useGraphStore.getState().setProject(null);
  });

  it('removes hidden measurement labs immediately when collapsed', () => {
    setNode(false);
    const { container } = renderBody();
    // Labs converge and unmount right after the mount measurement (the
    // AdaptiveBullets.labLifecycle contract), so there is nothing mounted
    // to assert here — the persisted sizes prove the measurement ran.
    const n0 = () => useGraphStore.getState().project!.nodes.n0!;
    expect(n0().versions[0]!.minBodyHeight).toBeDefined();

    act(() => {
      useGraphStore.getState().updateNode('n0', { bulletsCollapsed: true });
    });

    const parkedList = container.querySelector<HTMLElement>('.sc-ab-root > .sc-ab-list');
    expect(parkedList).not.toBeNull();
    expect(parkedList!.style.display).not.toBe('none');
    expect(parkedList!.style.visibility).toBe('hidden');
    expect(parkedList!.style.pointerEvents).toBe('none');
    expect(container.querySelectorAll('.sc-ab-measure').length).toBe(0);
  });
});
