/**
 * Perf contract: the six hidden measurement labs (.sc-ab-measure lists) exist
 * only WHILE measuring. Once the floor + current-width measurements have
 * converged (persisted sizes committed, curLabs stable), the labs unmount —
 * they were ~86% of all body DOM in text-heavy projects, and keeping every
 * expanded node's labs mounted forever made each style/layout/paint pass
 * scale with total project text (the "bullet toggle freezes the app" bug).
 *
 * Invalidation contract: a body change or a measured-width input change
 * remounts the labs, remeasures, and unmounts them again after convergence.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { useState } from 'react';
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

/** BCR reads on LAB items — proves the labs actually (re)measured. */
let labItemReads = 0;

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
      if (el.closest('.sc-ab-measure')) labItemReads++;
      const titleH = 28;
      const describedRows = el.querySelectorAll('.sc-ab-described').length;
      const hasInline = el.querySelector('.sc-ab-inline') !== null;
      h = titleH + describedRows * 22 + (hasInline ? 22 : 0);
    }
    return { x: 0, y: 0, top: 0, left: 0, right: w, bottom: h, width: w, height: h, toJSON: () => ({}) } as DOMRect;
  };
});

function setNode() {
  const node: ScatterNode = {
    id: 'n0',
    type: 'root',
    position: { x: 0, y: 0 },
    frozen: false,
    bulletsCollapsed: false,
    versions: [{ header: 'H', body: BODY, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
  const proj = createBlankProject('lab lifecycle', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
  useGraphStore.temporal.getState().pause();
}

/** Harness whose body prop can change and whose parent can re-render. */
function makeHarness() {
  let setBodyOuter: (b: string) => void = () => {};
  let bump: () => void = () => {};
  function Outer() {
    const [, setTick] = useState(0);
    const [body, setBody] = useState(BODY);
    setBodyOuter = setBody;
    bump = () => setTick((t) => t + 1);
    return <NodeBody body={body} parentNodeId="n0" selected={false} onReferenceClick={() => {}} />;
  }
  const utils = render(<Outer />);
  return {
    ...utils,
    setBody: (b: string) => act(() => setBodyOuter(b)),
    bump: () => act(() => bump()),
  };
}

/** Bump renders until lab DOM stops changing (bounded settle). */
function settle(h: { bump: () => void; container: HTMLElement }): void {
  for (let i = 0; i < 40; i++) {
    const before = h.container.querySelectorAll('.sc-ab-measure').length;
    const beforeReads = labItemReads;
    h.bump();
    const after = h.container.querySelectorAll('.sc-ab-measure').length;
    if (after === before && labItemReads === beforeReads) return;
  }
}

const ver = () => {
  const n = useGraphStore.getState().project!.nodes['n0']!;
  return n.versions[n.currentVersionIndex]!;
};

describe('AdaptiveBullets — measurement labs unmount after convergence', () => {
  beforeEach(() => {
    labItemReads = 0;
    useRewriteStore.setState({ activeByNode: {}, workingBody: {} });
    useActiveIdxStore.setState({ byNodeId: {} });
    useGraphStore.getState().setProject(null);
    setNode();
  });

  it('measures on mount, commits sizes, then unmounts every lab', () => {
    const h = makeHarness();
    settle(h);
    // measurement actually happened and was persisted…
    expect(labItemReads).toBeGreaterThan(0);
    expect(ver().minBodyHeight).not.toBeNull();
    expect(ver().minBodyHeight).toBeDefined();
    expect(ver().expandedMeasureWidth).toBeDefined();
    expect(ver().bodyMaxHeight).toBeDefined();
    // …and the labs are gone.
    expect(h.container.querySelectorAll('.sc-ab-measure').length).toBe(0);
    h.unmount();
  });

  it('a body change remounts the labs, remeasures, and unmounts them again', () => {
    const h = makeHarness();
    settle(h);
    const fullBefore = ver().fullBodyHeight;
    labItemReads = 0;

    h.setBody(`${BODY}\n- Gamma\n  - g1: fifth detail\n  - g2: sixth detail`);
    settle(h);

    expect(labItemReads).toBeGreaterThan(0); // remeasured
    expect(ver().fullBodyHeight).not.toBe(fullBefore); // new body → new size
    expect(h.container.querySelectorAll('.sc-ab-measure').length).toBe(0);
    h.unmount();
  });

  it('a measured-width input change (minWidth) remounts and remeasures', () => {
    const h = makeHarness();
    settle(h);
    labItemReads = 0;

    act(() => {
      useGraphStore.getState().setVersionSize('n0', { minWidth: 760 });
    });
    settle(h);

    expect(labItemReads).toBeGreaterThan(0); // labs came back to remeasure
    expect(h.container.querySelectorAll('.sc-ab-measure').length).toBe(0);
    h.unmount();
  });

  it('a node mounted collapsed still measures at load (invisibly) and unmounts labs', () => {
    act(() => {
      useGraphStore.getState().updateNode('n0', { bulletsCollapsed: true });
    });
    const h = makeHarness();
    settle(h);
    // Measured while collapsed…
    expect(labItemReads).toBeGreaterThan(0);
    expect(ver().minBodyHeight).toBeDefined();
    expect(ver().expandedMeasureWidth).toBeDefined();
    // …labs gone, and expanding needs no further lab work.
    expect(h.container.querySelectorAll('.sc-ab-measure').length).toBe(0);
    labItemReads = 0;
    act(() => {
      useGraphStore.getState().updateNode('n0', { bulletsCollapsed: false });
    });
    settle(h);
    expect(labItemReads).toBe(0);
    expect(h.container.querySelectorAll('.sc-ab-measure').length).toBe(0);
    h.unmount();
  });

  it('re-renders with unchanged inputs never remount the labs', () => {
    const h = makeHarness();
    settle(h);
    labItemReads = 0;
    for (let i = 0; i < 5; i++) h.bump();
    expect(labItemReads).toBe(0);
    expect(h.container.querySelectorAll('.sc-ab-measure').length).toBe(0);
    h.unmount();
  });
});
