/**
 * PERF R4 — subscriber-fire benchmark (camera pan).
 *
 * The architectural win of R4 mirrors R2 (which split node positions
 * off into `useLivePositionsStore`): camera-pan ticks go to
 * `useLiveViewportStore`, which Canvas does NOT subscribe to. So
 * Canvas's `useGraphStore((s) => s.project)` selector does NOT fire
 * during a pan stream, and the Canvas + ArrowLayer + NodeView
 * reconciliation that used to happen per pan tick is skipped.
 *
 * Pre-R4:  setViewport(v) → project.viewport changes → project
 *          subscriber fires every pan tick.
 * Post-R4: setViewport(v) on the live store → project does NOT
 *          change → project subscriber fires 0 times. Only the
 *          live viewport subscriber fires.
 *
 * Run with: `npx vitest run src/store/liveViewportPerfBench.test.ts`
 */
import { test, expect } from 'vitest';
import { useGraphStore, createBlankProject } from './useGraphStore';
import { useLiveViewportStore } from './useLiveViewportStore';
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
  useLiveViewportStore.getState().clear();
}

test('PERF R4: subscriber fires per pan tick — project store (pre-R4) vs live viewport store (post-R4)', () => {
  const TICKS = 200;

  for (const N of [3, 10, 30, 100]) {
    buildProject(N);

    // Count subscribers that observe `project` (Canvas's path).
    let projectFires = 0;
    const projectUnsub = useGraphStore.subscribe((state, prevState) => {
      if (state.project !== prevState.project) projectFires++;
    });
    // Count subscribers that observe the live viewport store (only the
    // tiny CameraTransform wrapper subscribes to it; this is the cheap
    // re-render we accept in exchange for the expensive one we removed).
    let liveFires = 0;
    const liveUnsub = useLiveViewportStore.subscribe((state, prevState) => {
      if (state.x !== prevState.x || state.y !== prevState.y || state.zoom !== prevState.zoom) {
        liveFires++;
      }
    });

    // PRE-R4 simulation: pan ticks go through the project-level setViewport.
    for (let t = 1; t <= TICKS; t++) {
      useGraphStore.getState().setViewport({ x: t, y: t * 0.5, zoom: 1 });
    }
    const preR4Fires = { project: projectFires, live: liveFires };

    // Reset counters.
    projectFires = 0;
    liveFires = 0;

    // POST-R4 simulation: pan ticks go through the live viewport store.
    for (let t = TICKS + 1; t <= TICKS * 2; t++) {
      useLiveViewportStore.getState().setPan(t, t * 0.5);
    }
    const postR4Fires = { project: projectFires, live: liveFires };

    projectUnsub();
    liveUnsub();

    // eslint-disable-next-line no-console
    console.log(
      `[R4 N=${N}] over ${TICKS} ticks: ` +
      `PRE-R4 project-store fires=${preR4Fires.project}, live-store fires=${preR4Fires.live} | ` +
      `POST-R4 project-store fires=${postR4Fires.project}, live-store fires=${postR4Fires.live}`,
    );

    // Pre-R4 baseline: every pan tick mutates project (the bug).
    expect(preR4Fires.project).toBe(TICKS);
    // Post-R4 invariant: pan ticks do not change `project`.
    expect(postR4Fires.project).toBe(0);
    // Post-R4: the live store still fires (it's where the camera lives now).
    expect(postR4Fires.live).toBe(TICKS);
  }
});
