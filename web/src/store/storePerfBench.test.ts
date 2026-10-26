/**
 * Store-mutation perf benchmark for PERF R1.
 *
 * Compares the pre-R1 path (N individual `updateNode` calls per tick)
 * against the new `setNodePositions` action (1 bulk call). Reports
 * cumulative wall time over K simulated ticks at various N.
 *
 * Run with: `npx vitest run src/store/storePerfBench.test.ts`
 */
import { test, expect } from 'vitest';
import { useGraphStore, createBlankProject } from './useGraphStore';
import type { ScatterNode } from './types';

function buildProject(n: number): void {
  const rootId = `n0`;
  const proj = createBlankProject('bench', rootId);
  const nodes: Record<string, ScatterNode> = {};
  for (let i = 0; i < n; i++) {
    nodes[`n${i}`] = {
      id: `n${i}`,
      type: i === 0 ? 'root' : 'term-click',
      position: { x: i * 700, y: 0 },
      frozen: false,
      versions: [{ header: `Node ${i}`, body: '', createdAt: 0, generatedBy: 'root' }],
      currentVersionIndex: 0,
    };
  }
  useGraphStore.getState().setProject({ ...proj, nodes });
  // History pause so the temporal middleware doesn't dominate the bench.
  useGraphStore.temporal.getState().pause();
}

function nudgePositions(n: number, t: number): { id: string; x: number; y: number }[] {
  const out: { id: string; x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    // Each tick moves each node by 0.1 px so the dead-zone filter
    // doesn't elide updates and we measure the heaviest path.
    out.push({ id: `n${i}`, x: i * 700 + t * 0.1, y: t * 0.1 });
  }
  return out;
}

function timeIterations(fn: () => void, iters: number): { totalMs: number; medianMs: number } {
  const samples: number[] = [];
  for (let s = 0; s < iters; s++) {
    const t0 = performance.now();
    fn();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)]!;
  const total = samples.reduce((a, b) => a + b, 0);
  return { totalMs: total, medianMs: median };
}

test('PERF R1: N updateNode vs 1 setNodePositions per tick', () => {
  // Mimic Canvas onTick's per-tick pattern. Both variants apply the
  // SAME effective state change (each tick nudges every node a tiny
  // bit), just via different store APIs.
  const TICKS = 1000;

  for (const N of [3, 10, 30, 100]) {
    buildProject(N);

    // Warm — let V8 settle.
    for (let w = 0; w < 200; w++) {
      const positions = nudgePositions(N, w);
      // OLD path
      for (const p of positions) {
        useGraphStore.getState().updateNode(p.id, { position: { x: p.x, y: p.y } });
      }
    }
    for (let w = 0; w < 200; w++) {
      const positions = nudgePositions(N, w);
      useGraphStore.getState().setNodePositions(positions);
    }

    // OLD: N individual updateNode calls per tick.
    let t = 0;
    const oldRun = timeIterations(() => {
      t++;
      const positions = nudgePositions(N, t);
      for (const p of positions) {
        useGraphStore.getState().updateNode(p.id, { position: { x: p.x, y: p.y } });
      }
    }, TICKS);

    // NEW: 1 setNodePositions call per tick.
    let t2 = 100000;
    const newRun = timeIterations(() => {
      t2++;
      const positions = nudgePositions(N, t2);
      useGraphStore.getState().setNodePositions(positions);
    }, TICKS);

    const ratio = oldRun.medianMs / Math.max(newRun.medianMs, 1e-9);
    const sign = ratio > 1 ? 'faster' : 'SLOWER';
    // eslint-disable-next-line no-console
    console.log(
      `[R1 N=${N}] OLD ${(oldRun.medianMs * 1000).toFixed(1)}µs/tick (total ${oldRun.totalMs.toFixed(1)}ms over ${TICKS}) | ` +
      `NEW ${(newRun.medianMs * 1000).toFixed(1)}µs/tick (total ${newRun.totalMs.toFixed(1)}ms) | ` +
      `${ratio.toFixed(2)}× ${sign}`,
    );
  }
  expect(true).toBe(true);
}, 30_000);
