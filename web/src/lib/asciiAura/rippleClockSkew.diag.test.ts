/**
 * REGRESSION — the "focus ripple often missing" bug (root-caused 2026-07-02).
 *
 * Two clocks disagree:
 *   - sceneState stamps wave.t0 with performance.now() inside the click task.
 *   - The render loop calls pruneExpired(now) with the rAF frame timestamp,
 *     which in Chrome is the frame's vsync START time — often a few ms EARLIER
 *     than a performance.now() taken in the same frame's input handler.
 *     (Confirmed live: 15/15 focus waves deleted at age 7–15 ms with
 *     rAF-timestamp − t0 between −2.4 and −30 ms, headless dev server.)
 *   - waveStillActive() used to return false for elapsed < 0, so pruneExpired
 *     treated a wave from "3 ms in the future" as EXPIRED and deleted it before
 *     it ever rendered. The aura is already focused, so it never re-fires.
 *     Fixed in wave.ts: negative elapsed = newborn, not expired.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { createAuraSceneState, type AuraScene } from './sceneState';
import { WAVE_DURATION_MS } from './wave';
import type { ScatterNode } from '@/store/types';

const realNow = performance.now.bind(performance);
let wallClock = 0;

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

function setProjectWith(nodes: Record<string, ScatterNode>): void {
  const proj = createBlankProject('sim', Object.keys(nodes)[0] ?? 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes });
  useGraphStore.temporal.getState().pause();
}

function makeScene(): AuraScene {
  const scene = createAuraSceneState({ onDirty: () => {} });
  scene.subscribeStores();
  return scene;
}

beforeEach(() => {
  wallClock = 1000;
  performance.now = () => wallClock;
  useLivePositionsStore.getState().clear();
  useLiveViewportStore.getState().clear();
});
afterEach(() => {
  performance.now = realNow;
});

describe('clock-skew ripple loss (rAF timestamp behind performance.now)', () => {
  test('click 3ms after vsync → same-frame prune deletes the focus wave forever', () => {
    setProjectWith({ a: makeNode('a', 0) });
    const scene = makeScene();
    // Let the spawn wave finish and get pruned.
    scene.pruneExpired(1700);
    expect(scene.state.waves.size).toBe(0);

    // A display frame begins at vsync = 2000. The click task runs 3.2 ms into
    // that frame; handleGraph stamps the focus wave with performance.now().
    wallClock = 2003.2;
    useGraphStore.getState().setSelection(['a']);
    expect(scene.state.waves.get('a')).toEqual({ kind: 'focus', t0: 2003.2 });

    // The render loop's rAF callback for the SAME frame now runs — Chrome hands
    // it the frame's vsync start time (2000), i.e. BEFORE the click.
    scene.pruneExpired(2000);

    // BUG if this fails: the never-rendered wave was deleted as "expired".
    expect(scene.state.waves.get('a'), 'wave must survive until it has played').toBeDefined();
  });

  test('control: click landing between frames (next tick after t0) survives', () => {
    setProjectWith({ a: makeNode('a', 0) });
    const scene = makeScene();
    scene.pruneExpired(1700);

    wallClock = 2003.2;
    useGraphStore.getState().setSelection(['a']);
    // Next rAF tick belongs to the NEXT vsync (2016.7 > t0) — wave lives.
    scene.pruneExpired(2016.7);
    expect(scene.state.waves.get('a')).toBeDefined();
  });

  test('a skew-surviving wave still expires normally at end of life', () => {
    setProjectWith({ a: makeNode('a', 0) });
    const scene = makeScene();
    scene.pruneExpired(1700);

    wallClock = 2003.2;
    useGraphStore.getState().setSelection(['a']);
    scene.pruneExpired(2000); // same-frame skewed prune — must NOT delete
    expect(scene.state.waves.get('a')).toBeDefined();

    // ...but the guard must not make waves immortal: once the ripple has
    // played its full lifetime, the regular prune removes it.
    const done = 2003.2 + WAVE_DURATION_MS + 1;
    wallClock = done;
    scene.pruneExpired(done);
    expect(scene.state.waves.get('a')).toBeUndefined();
  });
});
