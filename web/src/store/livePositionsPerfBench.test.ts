/**
 * PERF R2 — subscriber-fire benchmark.
 *
 * The architectural win of R2: physics tick updates go to
 * `useLivePositionsStore`, which Canvas does NOT subscribe to. So
 * Canvas's `useGraphStore((s) => s.project)` selector does NOT fire
 * during a tick stream, and the entire Canvas → ArrowLayer + N
 * NodeView reconciliation that used to happen per tick is skipped.
 *
 * This bench measures how many times the `project` subscriber and the
 * `live positions` subscriber each fire over K simulated ticks.
 *
 * Pre-R2:  setNodePositions(positions) → project changes → project
 *          subscriber fires every tick.
 * Post-R2: setPositions(positions) on the live store → project does
 *          NOT change → project subscriber fires 0 times. Only the
 *          live subscriber fires.
 *
 * Run with: `npx vitest run src/store/livePositionsPerfBench.test.ts`
 */
import { test, expect } from 'vitest';
import { useGraphStore, createBlankProject } from './useGraphStore';
import { useLivePositionsStore } from './useLivePositionsStore';
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
  useGraphStore.temporal.getState().pause();
  useLivePositionsStore.getState().clear();
}

function nudgePositions(n: number, t: number): { id: string; x: number; y: number }[] {
  const out: { id: string; x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: `n${i}`, x: i * 700 + t * 0.1, y: t * 0.1 });
  }
  return out;
}

test('PERF R2: subscriber fires per tick — project store (pre-R2) vs live store (post-R2)', () => {
  const TICKS = 200;

  for (const N of [3, 10, 30, 100]) {
    buildProject(N);

    // Count subscribers that observe `project` (Canvas's path).
    let projectFires = 0;
    const projectUnsub = useGraphStore.subscribe((state, prevState) => {
      if (state.project !== prevState.project) projectFires++;
    });
    // Count subscribers that observe live positions (only the NodeViews
    // whose own slice changed actually re-render, but raw store-level
    // subscriber count is the fairest before-vs-after comparison).
    let liveFires = 0;
    const liveUnsub = useLivePositionsStore.subscribe((state, prevState) => {
      if (state.positions !== prevState.positions) liveFires++;
    });

    // PRE-R2 simulation: set positions on the project store.
    for (let t = 1; t <= TICKS; t++) {
      useGraphStore.getState().setNodePositions(nudgePositions(N, t));
    }
    const preR2Fires = { project: projectFires, live: liveFires };

    // Reset counters.
    projectFires = 0;
    liveFires = 0;

    // POST-R2 simulation: set positions on the live store.
    for (let t = TICKS + 1; t <= TICKS * 2; t++) {
      useLivePositionsStore.getState().setPositions(nudgePositions(N, t));
    }
    const postR2Fires = { project: projectFires, live: liveFires };

    projectUnsub();
    liveUnsub();

    // eslint-disable-next-line no-console
    console.log(
      `[R2 N=${N}] over ${TICKS} ticks: ` +
      `PRE-R2 project-store fires=${preR2Fires.project}, live-store fires=${preR2Fires.live} | ` +
      `POST-R2 project-store fires=${postR2Fires.project}, live-store fires=${postR2Fires.live}`,
    );

    // Post-R2 invariant: physics ticks do not change `project`.
    expect(postR2Fires.project).toBe(0);
  }
});
