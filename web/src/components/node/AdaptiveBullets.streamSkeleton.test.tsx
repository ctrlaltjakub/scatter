/**
 * Tail skeleton while pass-1 text streams in.
 *
 * With bullet-boundary commits, the node sits still between bullet pops — the
 * tail skeleton (a ghost bullet after the list) signals more is coming. The
 * sizing contract is the critical part: while the skeleton shows, the body
 * cap grows by EXACTLY the skeleton's reserve (so it's never clipped and
 * never steals room from real bullets), and once the text stream ends the
 * reserve is returned — persisted sizes must come out byte-identical to a
 * node that never showed a skeleton. The skeleton is display-only: it must
 * never appear inside the hidden measurement labs.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { useState } from 'react';
import { act, render } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { NodeBody } from './NodeBody';
import { STREAM_SKELETON_RESERVE } from './AdaptiveBullets';
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

const FINAL = `${BODY}\n- Gamma\n  - g1: fifth detail\n  - g2: sixth detail`;

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

function setNode(opts?: { body?: string; generating?: boolean; streamingText?: boolean }) {
  const node: ScatterNode = {
    id: 'n0',
    type: 'root',
    position: { x: 0, y: 0 },
    frozen: false,
    bulletsCollapsed: false,
    generating: opts?.generating ?? true,
    streamingText: opts?.streamingText ?? true,
    versions: [{ header: 'H', body: opts?.body ?? BODY, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
  const proj = createBlankProject('stream skeleton', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes: { n0: node } });
  useGraphStore.temporal.getState().pause();
}

function makeHarness() {
  let setBodyOuter: (b: string) => void = () => {};
  let bump: () => void = () => {};
  function Outer({ initialBody }: { initialBody: string }) {
    const [, setTick] = useState(0);
    const [body, setBody] = useState(initialBody);
    setBodyOuter = setBody;
    bump = () => setTick((t) => t + 1);
    return <NodeBody body={body} parentNodeId="n0" selected={false} onReferenceClick={() => {}} />;
  }
  const utils = render(<Outer initialBody={useGraphStore.getState().project!.nodes['n0']!.versions[0]!.body} />);
  return {
    ...utils,
    setBody: (b: string) => act(() => setBodyOuter(b)),
    bump: () => act(() => bump()),
  };
}

function settle(h: { bump: () => void; container: HTMLElement }): void {
  for (let i = 0; i < 40; i++) {
    const before = h.container.querySelectorAll('.sc-ab-measure').length;
    const beforeReads = labItemReads;
    h.bump();
    const after = h.container.querySelectorAll('.sc-ab-measure').length;
    if (after === before && labItemReads === beforeReads) return;
  }
}

const skeletons = (h: { container: HTMLElement }) =>
  h.container.querySelectorAll('.sc-ab-skel-bullet').length;

const ver = () => {
  const n = useGraphStore.getState().project!.nodes['n0']!;
  return n.versions[n.currentVersionIndex]!;
};

describe('AdaptiveBullets — tail skeleton during pass-1 streaming', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    labItemReads = 0;
    useRewriteStore.setState({ activeByNode: {}, workingBody: {}, snapshot: {} });
    useActiveIdxStore.setState({ byNodeId: {} });
    useGraphStore.getState().setProject(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the original width and height while a whole replacement is deleted and streamed', () => {
    setNode();
    const source = { ...ver(), width: 960, minWidth: 624, bodyMaxHeight: 600, minBodyHeight: 500 };
    useGraphStore.getState().updateNode('n0', {
      versions: [source, { ...source, createdAt: 1 }], currentVersionIndex: 1, generatingVersionIndex: 1,
    });
    useRewriteStore.getState().setSnapshot('n0', {
      preBurstBody: BODY, preBurstVersionIndex: 0, draftVersionIndex: 1, generationSessionId: 1,
      preBurstBodyMaxHeight: 600, preBurstMinBodyHeight: 500, preBurstBodyHeightFloor: 600,
      preBurstFreeTextHeight: 40, preBurstHadBullets: true, preBurstWasAtMin: false,
    });
    useRewriteStore.getState().addRecord({ id: 'rewrite', nodeId: 'n0', kind: 'whole', abortController: new AbortController() });
    const h = makeHarness();
    for (const body of [BODY.slice(0, 45), '', 'New introduction.\n\n- New section\n  - Detail: New information.']) {
      act(() => useRewriteStore.getState().setWorkingBody('n0', body));
      h.setBody(body);
      act(() => vi.advanceTimersByTime(460));
      settle(h);
      expect(ver().width).toBe(960);
      expect(ver().bodyMaxHeight).toBeGreaterThanOrEqual(600);
      expect(useGraphStore.getState().project!.nodes.n0!.versions[0]).toEqual(source);
    }
    h.unmount();
  });

  it('shows one tail skeleton while streamingText, and never inside the labs', () => {
    setNode();
    const h = makeHarness();
    settle(h);
    expect(skeletons(h)).toBe(1);
    expect(h.container.querySelectorAll('.sc-ab-measure .sc-ab-skel-bullet')).toHaveLength(0);
    h.unmount();
  });

  it('hides the skeleton during the chip pass and after generation', () => {
    setNode();
    const h = makeHarness();
    settle(h);
    act(() => { useGraphStore.getState().updateNode('n0', { streamingText: false }); }); // chip pass
    expect(skeletons(h)).toBe(0);
    act(() => { useGraphStore.getState().updateNode('n0', { generating: false }); });
    settle(h);
    expect(skeletons(h)).toBe(0);
    h.unmount();
  });

  it('hides the skeleton when the bullets section is collapsed', () => {
    setNode();
    act(() => { useGraphStore.getState().updateNode('n0', { bulletsCollapsed: true }); });
    const h = makeHarness();
    settle(h);
    expect(skeletons(h)).toBe(0);
    h.unmount();
  });

  it('reserves exactly its height in the streamed body cap, and returns it afterwards', () => {
    setNode();
    const h = makeHarness();
    settle(h);
    act(() => { vi.advanceTimersByTime(460); }); // one measure tick during the stream
    settle(h);
    expect(ver().minBodyHeight).toBeDefined();
    expect(ver().bodyMaxHeight).toBe(ver().minBodyHeight! + STREAM_SKELETON_RESERVE);

    // Pass 1 ends → chip pass (generating stays true, streamingText off, body final).
    h.setBody(FINAL);
    act(() => { useGraphStore.getState().updateNode('n0', { streamingText: false }); });
    act(() => { vi.advanceTimersByTime(460); }); // catch-up sweep with reserve off
    settle(h);
    act(() => { useGraphStore.getState().updateNode('n0', { generating: false }); });
    settle(h);
    expect(ver().bodyMaxHeight).toBe(ver().minBodyHeight);
    h.unmount();
  });

  it('persisted sizes are identical to a node that never streamed a skeleton', () => {
    // Run A: full streaming lifecycle with the skeleton.
    setNode();
    const hA = makeHarness();
    settle(hA);
    act(() => { vi.advanceTimersByTime(460); });
    settle(hA);
    hA.setBody(FINAL);
    act(() => { useGraphStore.getState().updateNode('n0', { streamingText: false }); });
    act(() => { vi.advanceTimersByTime(460); });
    settle(hA);
    act(() => { useGraphStore.getState().updateNode('n0', { generating: false }); });
    settle(hA);
    const a = { min: ver().minBodyHeight, full: ver().fullBodyHeight, cap: ver().bodyMaxHeight, w: ver().minWidth };
    hA.unmount();

    // Run B: plain settled node with the same final body, no generation at all.
    useGraphStore.getState().setProject(null);
    setNode({ body: FINAL, generating: false, streamingText: false });
    const hB = makeHarness();
    settle(hB);
    const b = { min: ver().minBodyHeight, full: ver().fullBodyHeight, cap: ver().bodyMaxHeight, w: ver().minWidth };
    hB.unmount();

    expect(a).toEqual(b);
  });
});
