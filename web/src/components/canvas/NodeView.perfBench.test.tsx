/**
 * Render-count benchmark for PERF R3 (memoized NodeView).
 *
 * Scenario: we render a fake "canvas" with N NodeView instances. We
 * then simulate a physics tick that updates ONE node's position, the
 * way `setNodePositions` does in production — by mutating just that
 * one node's reference inside an otherwise-stable nodes record. The
 * Profiler counts how many NodeView components actually committed
 * during that update.
 *
 *   Pre-R3:  every Canvas re-render reconciles every NodeView
 *            (N commits per tick).
 *   Post-R3: only the NodeView whose `node` prop reference changed
 *            commits (1 commit per tick).
 *
 * Run with: `npx vitest run src/components/canvas/NodeView.perfBench.test.tsx`
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { Profiler, useState, useRef, type ProfilerOnRenderCallback } from 'react';
import { render, act } from '@testing-library/react';
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
    return {
      x: 0, y: 0, top: 0, left: 0, right: w, bottom: h,
      width: w, height: h, toJSON: () => ({}),
    } as DOMRect;
  };
});

const BODY = `Some intro paragraph here.

- **One**
  - a: first
  - b: second
- **Two**
  - c: third
  - d: fourth
- **Three**
  - e: fifth
  - f: sixth`;

function makeNode(id: string, i: number): ScatterNode {
  return {
    id,
    type: i === 0 ? 'root' : 'term-click',
    position: { x: i * 700, y: 0 },
    frozen: false,
    versions: [{ header: `Node ${i}`, body: BODY, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

function buildProject(n: number): Record<string, ScatterNode> {
  const nodes: Record<string, ScatterNode> = {};
  for (let i = 0; i < n; i++) nodes[`n${i}`] = makeNode(`n${i}`, i);
  const proj = createBlankProject('bench', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes });
  useGraphStore.temporal.getState().pause();
  return nodes;
}

const noop = () => {};

/** Renders N NodeViews and exposes a "tick one node" function. */
function CanvasFake(props: { N: number; onCommit: ProfilerOnRenderCallback; exposeTick: (fn: (id: string) => void) => void }) {
  const [nodes, setNodes] = useState(() => buildProject(props.N));
  // Stable tick exposer — register once.
  const setNodesRef = useRef(setNodes);
  setNodesRef.current = setNodes;
  const exposeOnceRef = useRef(false);
  if (!exposeOnceRef.current) {
    exposeOnceRef.current = true;
    props.exposeTick((id) => {
      setNodesRef.current((cur) => {
        const updated = cur[id];
        if (!updated) return cur;
        // Mutate ONE node's reference; preserve all others.
        // Mirrors what `setNodePositions` does in the real store.
        return { ...cur, [id]: { ...updated, position: { x: updated.position.x + 1, y: 0 } } };
      });
    });
  }

  return (
    <div>
      {Object.values(nodes).map((n) => (
        <Profiler key={n.id} id={`nv-${n.id}`} onRender={props.onCommit}>
          <NodeView
            node={n}
            selected={false}
            onSelect={noop}
            onReferenceClick={noop}
            onDragStart={noop}
            onDragMove={noop}
            onDragEnd={noop}
          />
        </Profiler>
      ))}
    </div>
  );
}

/** Renders N NodeViews under a parent whose camera-only state changes. */
function CameraOnlyFake(props: { N: number; onCommit: ProfilerOnRenderCallback; exposeZoom: (fn: (z: number) => void) => void }) {
  const [nodes] = useState(() => buildProject(props.N));
  const [cameraZoom, setCameraZoom] = useState(1);
  const exposeOnceRef = useRef(false);
  if (!exposeOnceRef.current) {
    exposeOnceRef.current = true;
    props.exposeZoom(setCameraZoom);
  }

  return (
    <div data-camera-zoom={cameraZoom}>
      {Object.values(nodes).map((n) => (
        <Profiler key={n.id} id={`nv-${n.id}`} onRender={props.onCommit}>
          <NodeView
            node={n}
            selected={false}
            onSelect={noop}
            onReferenceClick={noop}
            onDragStart={noop}
            onDragMove={noop}
            onDragEnd={noop}
          />
        </Profiler>
      ))}
    </div>
  );
}

function measure(N: number, ticks: number): { commits: number; medianMsPerTick: number; totalMs: number } {
  const samples: number[] = [];
  let tickMsTotal = 0;
  let totalCommits = 0;
  // Profiler fires onRender for bailout commits too, with near-zero
  // actualDuration (~0.005 ms in measurements). The REAL renders are
  // ≥ 0.1 ms even for the simplest NodeView. Threshold at 0.05 ms to
  // catch the bailouts cleanly.
  const REAL_RENDER_THRESHOLD_MS = 0.05;
  const onCommit: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    if (actualDuration >= REAL_RENDER_THRESHOLD_MS) {
      totalCommits++;
      tickMsTotal += actualDuration;
    }
  };
  let triggerTick: (id: string) => void = () => {};
  render(
    <CanvasFake
      N={N}
      onCommit={onCommit}
      exposeTick={(fn) => { triggerTick = fn; }}
    />,
  );
  // Drop mount commits — only measure tick-induced commits.
  totalCommits = 0;
  tickMsTotal = 0;

  for (let t = 0; t < ticks; t++) {
    const beforeMs = tickMsTotal;
    act(() => { triggerTick(`n${t % N}`); });
    samples.push(tickMsTotal - beforeMs);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  const total = samples.reduce((s, x) => s + x, 0);
  return {
    commits: Math.round(totalCommits / ticks),
    medianMsPerTick: median,
    totalMs: total,
  };
}

describe('NodeView render count — R3 (memo) impact', () => {
  test('per-tick NodeView commits at N = 3, 10, 30', () => {
    for (const N of [3, 10, 30]) {
      const r = measure(N, 30);
      // eslint-disable-next-line no-console
      console.log(
        `[R3 N=${N}] commits/tick=${r.commits} (R3 ON → ~1, R3 OFF would be ${N})  | ` +
        `median ${r.medianMsPerTick.toFixed(3)} ms/tick  | total ${r.totalMs.toFixed(1)} ms over 30 ticks`,
      );
      // With the memo, exactly 1 NodeView commits per tick.
      // (Allow 2 for React Strict-Mode double-render at N=3 small-N noise.)
      expect(r.commits).toBeLessThanOrEqual(2);
    }
  }, 30_000);

  test('camera-only zoom changes do not commit every NodeView', () => {
    let totalCommits = 0;
    const REAL_RENDER_THRESHOLD_MS = 0.05;
    const onCommit: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
      if (actualDuration >= REAL_RENDER_THRESHOLD_MS) totalCommits++;
    };
    let setZoom: (z: number) => void = () => {};
    render(
      <CameraOnlyFake
        N={30}
        onCommit={onCommit}
        exposeZoom={(fn) => { setZoom = fn; }}
      />,
    );
    totalCommits = 0;

    act(() => { setZoom(1.4); });

    expect(totalCommits).toBeLessThanOrEqual(1);
  });
});
