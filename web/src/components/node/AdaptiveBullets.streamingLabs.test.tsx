/**
 * Streaming perf contract: while a node's LLM stream is rewriting `body`
 * every frame (`generating: true`), the hidden measurement labs must NOT
 * remeasure per body change — per-frame offsetHeight sweeps over ~6×N lab
 * items were the O(n²) long-node streaming freeze. Instead:
 *   - the labs stay MOUNTED for the whole stream (incremental per-bullet DOM
 *     updates are cheap; remount/unmount churn per frame is not),
 *   - the offsetHeight sweeps run only on a ~450ms tick (and only when the
 *     body actually changed since the last sweep — a static body during the
 *     chip-marking pass costs zero sweeps),
 *   - `generating: false` runs one final ungated measure, commits the final
 *     sizes, and the existing labsDone latch unmounts the labs.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
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

/** Successive streamed states — each step adds a measurable row, the way a
 *  real stream grows the list. */
const GROW: string[] = [
  `${BODY}\n- Gamma`,
  `${BODY}\n- Gamma\n  - g1: fifth detail`,
  `${BODY}\n- Gamma\n  - g1: fifth detail\n  - g2: sixth detail`,
  `${BODY}\n- Gamma\n  - g1: fifth detail\n  - g2: sixth detail\n- Delta`,
  `${BODY}\n- Gamma\n  - g1: fifth detail\n  - g2: sixth detail\n- Delta\n  - d1: seventh detail`,
];

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
    generating: true,
    versions: [{ header: 'H', body: BODY, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
  const proj = createBlankProject('streaming labs', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
  useGraphStore.temporal.getState().pause();
}

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

/** Bump renders until lab DOM + reads stop changing (bounded settle). */
function settle(h: { bump: () => void; container: HTMLElement }): void {
  for (let i = 0; i < 40; i++) {
    const before = h.container.querySelectorAll('.sc-ab-measure').length;
    const beforeReads = labItemReads;
    h.bump();
    const after = h.container.querySelectorAll('.sc-ab-measure').length;
    if (after === before && labItemReads === beforeReads) return;
  }
}

const labCount = (h: { container: HTMLElement }) =>
  h.container.querySelectorAll('.sc-ab-measure').length;

const ver = () => {
  const n = useGraphStore.getState().project!.nodes['n0']!;
  return n.versions[n.currentVersionIndex]!;
};

describe('AdaptiveBullets — labs during a streaming generation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    labItemReads = 0;
    useRewriteStore.setState({ activeByNode: {}, workingBody: {} });
    useActiveIdxStore.setState({ byNodeId: {} });
    useGraphStore.getState().setProject(null);
    setNode();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('streamed body changes between ticks trigger zero measurement sweeps', () => {
    const h = makeHarness();
    settle(h); // initial mount measure (once, at stream start)
    labItemReads = 0;

    for (const b of GROW) h.setBody(b);

    expect(labItemReads).toBe(0);
    h.unmount();
  });

  it('labs stay mounted across streamed body changes (no remount churn)', () => {
    const h = makeHarness();
    settle(h);
    expect(labCount(h)).toBeGreaterThan(0); // suppressed latch: still mounted

    for (const b of GROW) {
      h.setBody(b);
      expect(labCount(h)).toBeGreaterThan(0);
    }
    h.unmount();
  });

  it('the periodic tick runs one sweep and commits the grown size — and a static body costs nothing', () => {
    const h = makeHarness();
    settle(h);
    h.setBody(GROW[2]!); // +3 measurable rows since mount
    labItemReads = 0;
    const sizeBefore = ver().fullBodyHeight;

    act(() => { vi.advanceTimersByTime(460); });
    settle(h);
    expect(labItemReads).toBeGreaterThan(0); // the tick swept…
    expect(ver().fullBodyHeight).not.toBe(sizeBefore); // …and committed the growth

    labItemReads = 0;
    act(() => { vi.advanceTimersByTime(920); }); // two more ticks, body unchanged
    settle(h);
    expect(labItemReads).toBe(0); // static body → no sweeps (chip-pass regime)
    h.unmount();
  });

  it('generating→false runs a final measure, commits the final size, and unmounts the labs', () => {
    const h = makeHarness();
    settle(h);
    h.setBody(GROW[2]!);
    act(() => { vi.advanceTimersByTime(460); });
    settle(h);
    const sizeAtLastTick = ver().fullBodyHeight;

    h.setBody(GROW[4]!); // final text lands (adds rows), no tick after it
    labItemReads = 0;
    act(() => { useGraphStore.getState().updateNode('n0', { generating: false }); });
    settle(h);

    expect(labItemReads).toBeGreaterThan(0); // final ungated measure ran
    expect(ver().fullBodyHeight).not.toBe(sizeAtLastTick); // final size includes the tail
    expect(labCount(h)).toBe(0); // latch fired — labs unmounted with no timers left
    h.unmount();
  });
});
