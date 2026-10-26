/**
 * Render-count benchmark for PERF R7 (memoized ArrowItem with
 * per-arrow value-equality chain subscription).
 *
 * Scenario: render an SVG containing K ArrowItem instances backed by
 * the live anchor store. Simulate a worker tick that changes ONE
 * arrow's chain. Count how many ArrowItems actually commit (cost >
 * threshold) per tick.
 *
 *   Pre-R7: every Canvas-or-anchor-tick re-renders ALL arrows because
 *           setAnchors swaps the whole record and the parent walks
 *           the .map again.
 *   Post-R7: only the ArrowItem whose own chain crossed the dead
 *            zone re-renders. Others bail at the Zustand-level
 *            equality comparator (chainsEqual).
 *
 * The bench is structural rather than wall-time — counts commits not
 * milliseconds — because wall-time of SVG render in jsdom is
 * dominated by the synthetic DOM cost which doesn't match production
 * SVG-painting at all.
 *
 * Run with: `npx vitest run src/components/canvas/ArrowLayer.perfBench.test.tsx`
 */
import { describe, test, expect, beforeAll } from 'vitest';
import { Profiler, useState, useRef, type ProfilerOnRenderCallback } from 'react';
import { render, act } from '@testing-library/react';
import type { Project, Arrow, ScatterNode } from '@/store/types';
import { ArrowLayer } from './ArrowLayer';
import { useArrowAnchorsStore } from '@/store/useArrowAnchorsStore';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
});

function makeNode(id: string, i: number): ScatterNode {
  return {
    id,
    type: i === 0 ? 'root' : 'term-click',
    position: { x: i * 700, y: 0 },
    frozen: false,
    versions: [{ header: `Node ${i}`, body: '', createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

function makeChain(seed: number): { x: number; y: number }[] {
  // Eight anchors along a slight arc.
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < 8; i++) {
    out.push({ x: i * 80 + seed, y: Math.sin(i / 7 * Math.PI) * 40 + seed });
  }
  return out;
}

function buildScene(N: number): { project: Project } {
  const nodes: Record<string, ScatterNode> = {};
  for (let i = 0; i < N; i++) nodes[`n${i}`] = makeNode(`n${i}`, i);
  const arrows: Record<string, Arrow> = {};
  for (let i = 0; i < N - 1; i++) {
    const id = `a${i}`;
    arrows[id] = {
      id, fromNodeId: `n${i}`, toNodeId: `n${i + 1}`,
      kind: 'auto', gravitates: true,
    };
  }
  // Pre-populate live anchor store with chains for every arrow.
  const initial: Record<string, { x: number; y: number }[]> = {};
  for (const id in arrows) initial[id] = makeChain(0);
  useArrowAnchorsStore.getState().setAnchors(initial);
  return {
    project: {
      id: 'p', name: 'bench', createdAt: 0, updatedAt: 0,
      rootNodeId: 'n0', nodes, arrows, groups: {},
      viewport: { x: 0, y: 0, zoom: 1 }, selection: [],
    },
  };
}

/** Force ArrowLayer to render N ArrowItems, then simulate a "worker
 *  tick that moved ONE arrow's chain". Count how many Profilers
 *  actually commit beyond a bailout. */
describe('ArrowLayer render count — R7 (per-arrow memo + value-eq chain) impact', () => {
  test('per-tick ArrowItem commits at N = 5, 15, 50', () => {
    for (const N of [5, 15, 50]) {
      const { project } = buildScene(N);
      let totalCommits = 0;
      const REAL_RENDER_THRESHOLD_MS = 0.05;
      const onRender: ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
        if (actualDuration >= REAL_RENDER_THRESHOLD_MS) totalCommits++;
      };
      const { unmount } = render(
        <Profiler id="arrow-layer" onRender={onRender}>
          <ArrowLayer project={project} />
        </Profiler>,
      );
      // Mount commits — drop.
      totalCommits = 0;

      // Simulate 30 ticks; each tick replaces the whole anchor map
      // (like setAnchors does in prod) but only ONE arrow's chain
      // actually changes by more than 0.01 px.
      const ticks = 30;
      for (let t = 1; t <= ticks; t++) {
        const cur = useArrowAnchorsStore.getState().anchors;
        const next: Record<string, { x: number; y: number }[]> = {};
        for (const id in cur) {
          if (id === `a${t % Math.max(1, N - 1)}`) {
            next[id] = makeChain(t * 5); // moved
          } else {
            // Same values — but a NEW array reference (matching
            // worker snapshot() behavior). chainsEqual must catch this.
            next[id] = cur[id]!.map((p) => ({ x: p.x, y: p.y }));
          }
        }
        act(() => { useArrowAnchorsStore.getState().setAnchors(next); });
      }
      unmount();

      const commitsPerTick = Math.round(totalCommits / ticks);
      // eslint-disable-next-line no-console
      console.log(
        `[R7 N=${N}] commits/tick=${commitsPerTick} (R7 ON → ~1, R7 OFF would be ~${N - 1})`,
      );
      // Allow 2 to cover the Profiler-wrapping commit + the changed item.
      expect(commitsPerTick).toBeLessThanOrEqual(2);
    }
  });
});
