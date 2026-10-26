/**
 * The measure-correct loop in AdaptiveBullets runs in a useLayoutEffect with
 * NO dependency array — by design, so it can re-check real rendered heights
 * after any render. But once the cascade has CONVERGED, a re-render whose
 * height-relevant inputs are all unchanged (physics ticks, unrelated store
 * updates) must NOT force layout again: N getBoundingClientRect reads per
 * render × every re-render is the per-frame tax that makes big streaming
 * nodes feel low-FPS while scrolling.
 *
 * These tests pin the contract:
 *   - after convergence, re-renders with identical inputs do ZERO visible-list
 *     BCR reads;
 *   - any body change re-activates measurement (correctness stays intact).
 */
import { describe, test, expect, beforeAll, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, act } from '@testing-library/react';
import { AdaptiveBullets } from './AdaptiveBullets';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';

/** Counts BCR reads on VISIBLE-list bullet items (the measure-correct loop's
 *  targets). Lab items live under .sc-ab-measure and are excluded — their
 *  effects have dependency arrays and are not what this test pins. */
let visibleItemReads = 0;

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // jsdom returns 0×0 for everything — synthesize plausible heights (same
  // scheme as AdaptiveBullets.perfBench.test.tsx) so the cascade settles.
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const el = this as HTMLElement;
    const cls = el.classList;
    let h = 0;
    const w = 480;
    if (cls?.contains('sc-ab-root')) {
      h = 280;
    } else if (cls?.contains('sc-ab-freetext')) {
      h = 40;
    } else if (cls?.contains('sc-ab-item')) {
      if (!el.closest('.sc-ab-measure')) visibleItemReads++;
      const titleH = 28;
      const describedRows = el.querySelectorAll('.sc-ab-described').length;
      const hasInline = el.querySelector('.sc-ab-inline') !== null;
      h = titleH + describedRows * 22 + (hasInline ? 22 : 0);
    } else {
      h = 0;
    }
    return {
      x: 0, y: 0, top: 0, left: 0, right: w, bottom: h,
      width: w, height: h, toJSON: () => ({}),
    } as DOMRect;
  };
});

beforeEach(() => {
  visibleItemReads = 0;
  useGraphStore.getState().setProject(null);
});

const BODY = `Opening line about the topic.

- Alpha
  - a1: first thing
  - a2: second thing
- Beta
  - b1: third thing
  - b2: fourth thing
- Gamma
  - g1: fifth thing`;

function noop() {}

/** Harness: `bump` forces parent re-renders with UNCHANGED AdaptiveBullets
 *  props; `setBody` changes the body. */
function makeHarness() {
  let bump: () => void = () => {};
  let setBodyOuter: (b: string) => void = () => {};
  function Outer() {
    const [, setTick] = useState(0);
    const [body, setBody] = useState(BODY);
    bump = () => setTick((t) => t + 1);
    setBodyOuter = setBody;
    return (
      <AdaptiveBullets body={body} parentNodeId="p0" onReferenceClick={noop} />
    );
  }
  const utils = render(<Outer />);
  return { ...utils, bump: () => act(() => bump()), setBody: (b: string) => act(() => setBodyOuter(b)) };
}

/** Re-render until the measure loop stops issuing reads (converged), with a
 *  generous cap well past maxAdjustmentIter. */
function settle(h: { bump: () => void }): void {
  for (let i = 0; i < 80; i++) {
    const before = visibleItemReads;
    h.bump();
    if (visibleItemReads === before) return;
  }
}

describe('AdaptiveBullets — converged measure loop skips redundant DOM reads', () => {
  test('re-renders with unchanged inputs do ZERO visible-item BCR reads', () => {
    const h = makeHarness();
    settle(h);
    visibleItemReads = 0;
    for (let i = 0; i < 5; i++) h.bump();
    expect(visibleItemReads).toBe(0);
    h.unmount();
  });

  test('a body change re-activates measurement', () => {
    const h = makeHarness();
    settle(h);
    visibleItemReads = 0;
    h.setBody(`${BODY}\n- Delta\n  - d1: sixth [[thing]]`);
    expect(visibleItemReads).toBeGreaterThan(0);
    h.unmount();
  });

  test('viewport zoom changes do not re-activate visible-item measurement', () => {
    useGraphStore.getState().setProject(createBlankProject('zoom test', 'p0'));
    const h = makeHarness();
    settle(h);
    visibleItemReads = 0;

    act(() => {
      useGraphStore.getState().setViewport({ x: 12, y: -8, zoom: 1.35 });
    });

    expect(visibleItemReads).toBe(0);
    h.unmount();
  });
});
