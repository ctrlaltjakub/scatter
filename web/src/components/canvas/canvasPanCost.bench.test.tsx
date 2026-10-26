/**
 * PERF R4 — wall-clock pan-tick cost.
 *
 * Mounts a "Canvas-shaped" scene with N NodeView children inside a
 * Profiler. Fires K simulated pan ticks under two scenarios and
 * measures ms/tick.
 *
 *   PRE-R4 scenario:
 *     The outer wrapper subscribes to `useGraphStore((s) => s.project)`
 *     and reads `project.viewport` to position its world transform.
 *     A pan tick = `useGraphStore.setViewport(...)`. The wrapper
 *     re-renders every tick → it allocates JSX for every NodeView →
 *     the per-NodeView memo runs once per node per tick.
 *
 *   POST-R4 scenario:
 *     The outer wrapper subscribes only to `s.project.nodes` and
 *     `s.project.selection` — NOT to the viewport. A separate inner
 *     `CameraTransform` subscribes to `useLiveViewportStore`. A pan
 *     tick = `useLiveViewportStore.setPan(...)`. Only the tiny
 *     CameraTransform re-renders; the outer wrapper stays put;
 *     NodeViews are never even reached.
 *
 * The test reports total ms across K ticks and computes a ratio.
 * Pass condition: ratio ≤ 0.5 (post is at most half the cost of pre).
 * Target: ratio ≤ 0.2 (≥ 5× speedup) — logged but not asserted, since
 * jsdom timing is noisier than a real browser.
 *
 * Run with: `npx vitest run src/components/canvas/canvasPanCost.bench.test.tsx`
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { useMemo, useRef } from 'react';
import { render, act } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { NodeView } from './NodeView';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return {
      x: 0, y: 0, top: 0, left: 0, right: 480, bottom: 200,
      width: 480, height: 200, toJSON: () => ({}),
    } as DOMRect;
  };
});

const SHORT_BODY = `Some intro paragraph here.

- **One**
  - a: first
- **Two**
  - b: second`;

function makeNode(i: number): ScatterNode {
  return {
    id: `n${i}`,
    type: i === 0 ? 'root' : 'term-click',
    position: { x: i * 700, y: 0 },
    frozen: false,
    versions: [{ header: `Node ${i}`, body: SHORT_BODY, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

function buildProject(n: number): void {
  const nodes: Record<string, ScatterNode> = {};
  for (let i = 0; i < n; i++) nodes[`n${i}`] = makeNode(i);
  const proj = createBlankProject('bench', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes });
  useGraphStore.temporal.getState().pause();
  useLiveViewportStore.getState().clear();
}

const noop = () => {};
const renderNodes = (nodes: Record<string, ScatterNode>) => Object.values(nodes).map((n) => (
  <NodeView
    key={n.id}
    node={n}
    selected={false}
    onSelect={noop}
    onReferenceClick={noop}
    onDragStart={noop}
    onDragMove={noop}
    onDragEnd={noop}
  />
));

/** Pre-R4 "Canvas-shaped" wrapper: subscribes to the whole project
 *  and reads viewport from it. Re-renders every time project changes. */
function CanvasPreR4() {
  const project = useGraphStore((s) => s.project);
  if (!project) return null;
  const v = project.viewport;
  return (
    <div style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})` }}>
      {renderNodes(project.nodes)}
    </div>
  );
}

/** Post-R4 "Canvas-shaped" wrapper: subscribes only to nodes/selection
 *  (not viewport). The world transform is applied by an inner
 *  CameraTransform that subscribes to the live viewport store. */
function CameraTransform({ children }: { children: React.ReactNode }) {
  const x = useLiveViewportStore((s) => s.x);
  const y = useLiveViewportStore((s) => s.y);
  const zoom = useLiveViewportStore((s) => s.zoom);
  return (
    <div style={{ transform: `translate(${x}px, ${y}px) scale(${zoom})` }}>
      {children}
    </div>
  );
}

function CanvasPostR4() {
  const nodes = useGraphStore((s) => s.project?.nodes);
  // Memoize children so they don't re-render when CameraTransform does.
  const renderedNodes = useMemo(() => nodes ? renderNodes(nodes) : null, [nodes]);
  if (!renderedNodes) return null;
  return <CameraTransform>{renderedNodes}</CameraTransform>;
}

function measurePreR4(N: number, ticks: number): number {
  buildProject(N);
  const { unmount } = render(<CanvasPreR4 />);
  const start = performance.now();
  for (let t = 1; t <= ticks; t++) {
    act(() => {
      useGraphStore.getState().setViewport({ x: t, y: t * 0.5, zoom: 1 });
    });
  }
  const totalMs = performance.now() - start;
  unmount();
  return totalMs;
}

function measurePostR4(N: number, ticks: number): number {
  buildProject(N);
  // Seed the live store with the project's viewport once at mount.
  const v = useGraphStore.getState().project!.viewport;
  useLiveViewportStore.getState().seedFrom(v);
  const { unmount } = render(<CanvasPostR4 />);
  const start = performance.now();
  for (let t = 1; t <= ticks; t++) {
    act(() => {
      useLiveViewportStore.getState().setPan(t, t * 0.5);
    });
  }
  const totalMs = performance.now() - start;
  unmount();
  return totalMs;
}

describe('PERF R4: wall-clock pan-tick cost', () => {
  // Mount-heavy bench (N=200 builds 200 NodeViews, which include
  // bullet-layout passes). The default 5 s vitest timeout is too tight
  // for the cold-mount phases. The complete suite runs this alongside other
  // jsdom workers, so leave enough wall-clock headroom for scheduler delays;
  // the measured pre/post ratio remains the assertion that guards performance.
  test('post-R4 ms/tick is meaningfully lower than pre-R4 for N = 10, 50, 200', () => {
    const TICKS = 50;
    const results: { N: number; pre: number; post: number; ratio: number }[] = [];
    for (const N of [10, 50, 200]) {
      // Warmup once at each N so jsdom's first-render overhead doesn't
      // skew the pre-R4 number unfairly.
      measurePreR4(N, 5);
      measurePostR4(N, 5);

      const preMs = measurePreR4(N, TICKS);
      const postMs = measurePostR4(N, TICKS);
      const ratio = postMs / preMs;
      results.push({ N, pre: preMs, post: postMs, ratio });
    }
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        `[R4 wall-clock N=${r.N}] ${TICKS} ticks: pre=${r.pre.toFixed(1)}ms  post=${r.post.toFixed(1)}ms  ` +
        `(post/pre=${r.ratio.toFixed(2)}  ${(r.pre / r.post).toFixed(1)}× speedup)`,
      );
    }
    // Sanity: at larger N the win should be bigger, so test the N=200 case.
    // Pass condition kept loose for jsdom noise.
    const big = results.find((r) => r.N === 200)!;
    expect(big.ratio).toBeLessThan(0.5);
  }, 120_000);
});
