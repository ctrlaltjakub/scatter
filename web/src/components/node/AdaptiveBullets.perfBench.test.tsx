/**
 * React-render benchmark for AdaptiveBullets, focused on PERF R4 (the
 * memoized hidden measurement lab subtree).
 *
 * Direct OLD vs NEW comparison without copying ~600 lines of component
 * is awkward, so we use the memo's own deps as the toggle:
 *
 *   MEMO-HIT scenario:  parentNodeId stays constant across renders.
 *                       useMemo returns cached lab JSX. React's
 *                       reconciler bails out of the hidden 3-list
 *                       subtree entirely. This is what the prod app
 *                       does during a drag (parentNodeId doesn't
 *                       change while a node is moving).
 *
 *   MEMO-MISS scenario: parentNodeId changes each render.
 *                       useMemo recomputes the lab JSX. React must
 *                       reconcile (and re-mount, since the ref tree
 *                       inside changes too) the entire 3-list subtree.
 *                       This is a proxy for the pre-R4 code path —
 *                       slightly pessimistic since pre-R4 wouldn't
 *                       have changed parentNodeId either, but the
 *                       render-side WORK is the same (rebuild lab JSX,
 *                       reconcile lab DOM).
 *
 * Reports cumulative actualDuration (wall time spent inside React's
 * render commit) over K forced re-renders. Difference between the two
 * scenarios is what R4 saves per re-render.
 *
 * Run with: `npx vitest run src/components/node/AdaptiveBullets.perfBench.test.tsx`
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { Profiler, useState, type ProfilerOnRenderCallback } from 'react';
import { render, act } from '@testing-library/react';
import { AdaptiveBullets } from './AdaptiveBullets';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // jsdom returns 0×0 for everything. Synthesize plausible heights so
  // the measurement effect inside AdaptiveBullets settles like it would
  // in a real browser; otherwise it loops on zero-height inputs and
  // skews the timing measurement.
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

/** Realistic body — comparable size to typical generated nodes
 *  (~12 bullets total counting children, mix of refs/bold/plain). */
const REALISTIC = `**Lactic fermentation** converts [[glucose]] to [[lactic acid]] anaerobically.

- **Process**
  - **Substrate**: [[glucose]] from carbohydrates
  - **Enzyme**: [[lactate dehydrogenase]] catalyzes the reaction
  - **Products**: [[lactic acid]] and regenerated NAD+
  - **Yield**: about 2 [[ATP]] per molecule
- **Conditions**
  - **Anaerobic**: occurs when [[oxygen]] is limited
  - **Substrate**: [[glycolysis]] intermediates required
  - **Cells**: [[fast-twitch fibers]] during sprints
  - **pH**: optimal around 6 to 7
- **Applications**
  - **Food**: [[yogurt]], [[sauerkraut]], [[kimchi]]
  - **Industry**: [[bioplastics]] and [[lactic acid polymers]]
  - **Medicine**: [[wound healing]] research
  - **Agriculture**: [[silage]] preservation`;

/** Parent that re-renders K times. `parentNodeIdMode === 'stable'`
 *  keeps `parentNodeId` constant (memo hits); 'changing' rotates it
 *  every render (memo misses). */
function Harness(props: {
  parentNodeIdMode: 'stable' | 'changing';
  triggerVersion: number;
  onProfilerRender: ProfilerOnRenderCallback;
}) {
  const parentNodeId = props.parentNodeIdMode === 'stable'
    ? 'p0'
    : `p${props.triggerVersion}`;
  return (
    <Profiler id="ab" onRender={props.onProfilerRender}>
      <AdaptiveBullets
        body={REALISTIC}
        parentNodeId={parentNodeId}
        onReferenceClick={noop}
      />
    </Profiler>
  );
}
function noop() {}

function measure(
  mode: 'stable' | 'changing',
  rerenders: number,
): { totalMs: number; medianMs: number; renders: number } {
  const samples: number[] = [];
  const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    samples.push(actualDuration);
  };
  let setVersion: (n: number) => void = () => {};
  function Outer() {
    const [v, sv] = useState(0);
    setVersion = sv;
    return <Harness parentNodeIdMode={mode} triggerVersion={v} onProfilerRender={onRender} />;
  }
  const { unmount } = render(<Outer />);
  // Drop the initial mount sample — only interested in subsequent
  // re-render cost.
  samples.length = 0;
  for (let i = 1; i <= rerenders; i++) {
    act(() => { setVersion(i); });
  }
  unmount();
  if (samples.length === 0) return { totalMs: 0, medianMs: 0, renders: 0 };
  const sorted = samples.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  const total = samples.reduce((a, b) => a + b, 0);
  return { totalMs: total, medianMs: median, renders: samples.length };
}

describe('AdaptiveBullets render perf — R4 (lab memo) impact', () => {
  test('memo-HIT vs memo-MISS over 200 re-renders', () => {
    const K = 200;

    // Warm V8 — first cold run is dominated by JIT bringup.
    measure('stable', 50);
    measure('changing', 50);

    const hit = measure('stable', K);
    const miss = measure('changing', K);

    const saveMs = miss.totalMs - hit.totalMs;
    const saveFrac = hit.totalMs > 0 ? (miss.totalMs - hit.totalMs) / miss.totalMs : 0;
    // eslint-disable-next-line no-console
    console.log(
      `[R4 bench] ${K} forced re-renders of AdaptiveBullets (REALISTIC body, 12 bullets w/ children)\n` +
      `  memo-HIT  (R4 ON, stable parentNodeId)   : total ${hit.totalMs.toFixed(1)}ms, median ${hit.medianMs.toFixed(3)}ms/re-render\n` +
      `  memo-MISS (R4 effectively off, churning) : total ${miss.totalMs.toFixed(1)}ms, median ${miss.medianMs.toFixed(3)}ms/re-render\n` +
      `  R4 saves ${saveMs.toFixed(1)}ms total (${(saveFrac * 100).toFixed(1)}% of render time)\n` +
      `  At 60 Hz drag with N=10 nodes → R4 saves ≈ ${(saveFrac * 100 * 10 * 60 / K).toFixed(2)}% × 10 = ${((saveMs / K) * 10 * 60).toFixed(1)}ms/sec of main-thread time`,
    );

    // hit and miss can differ in render count: when parentNodeId
    // changes, AdaptiveBullets' useLayoutEffect re-runs and may
    // setState, scheduling extra renders that don't happen on the
    // stable path. The MEDIAN per-render time is the apples-to-apples
    // comparison; the total just confirms the median scaled.
    expect(hit.renders).toBeGreaterThanOrEqual(K);
    expect(miss.renders).toBeGreaterThanOrEqual(K);
  }, 30_000);
});
