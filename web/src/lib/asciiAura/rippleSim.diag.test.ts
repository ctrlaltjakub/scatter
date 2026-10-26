/**
 * Diagnostic: simulate the aura render loop on a CONTROLLED clock and measure
 * the actual focus ripple a user would SEE, so timing-dependent "no ripple"
 * cases reproduce deterministically.
 *
 * Faithfulness to the real renderer (AsciiAuraLayerGL — the field/ripple math is
 * shared via sceneState + wave, which the GPU renderer drives):
 *   - radius = focused ? 300 : 200 (AURA_RADIUS_*).
 *   - the ripple is sampled only where the steady field exists (d < radius),
 *     and the visible ripple amplitude is |waveDensity(d, wave, now)| there.
 *   - waves expire via scene.pruneExpired(now), called every frame.
 *   - handleGraph stamps wave t0 with performance.now() — so we MOCK it to the
 *     simulated clock, making interaction + render share one timeline.
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { waveDensity } from './wave';
import {
  createAuraSceneState,
  AURA_RADIUS_FOCUSED,
  AURA_RADIUS_UNFOCUSED,
  type AuraScene,
} from './sceneState';
import type { ScatterNode } from '@/store/types';

let clock = 0;
const realNow = performance.now.bind(performance);

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

/** Peak |ripple| amplitude a FOCUS wave on `id` would paint right now, sampled
 *  where the steady field exists — i.e. what the user would actually see. */
function focusRippleNow(scene: AuraScene, id: string): number {
  const aura = scene.state.auras.get(id);
  if (!aura) return 0;
  const wave = scene.state.waves.get(id);
  if (!wave || wave.kind !== 'focus') return 0;
  const radius = aura.focused ? AURA_RADIUS_FOCUSED : AURA_RADIUS_UNFOCUSED;
  let peak = 0;
  for (let d = 0; d < radius; d += 6) {
    const steady = 1 - d / radius;
    if (steady <= 0) continue;
    const amp = Math.abs(waveDensity(d, wave, clock));
    if (amp > peak) peak = amp;
  }
  return peak;
}

function makeHarness(scene: AuraScene) {
  const peak: Record<string, number> = {};
  const render = () => {
    scene.pruneExpired(clock);
    for (const id of scene.state.auras.keys()) {
      const p = focusRippleNow(scene, id);
      if (p > (peak[id] ?? 0)) peak[id] = p;
    }
  };
  return {
    peak,
    reset: () => { for (const k in peak) delete peak[k]; },
    render,
    /** Advance `ms` of wall clock, rendering one frame per ~16 ms. */
    run: (ms: number) => {
      const end = clock + ms;
      while (clock < end) { clock += 16; render(); }
    },
  };
}

beforeEach(() => {
  clock = 1000;
  performance.now = () => clock;
  useLivePositionsStore.getState().clear();
  useLiveViewportStore.getState().clear();
});
afterEach(() => {
  performance.now = realNow;
});

const VISIBLE = 0.05; // amplitude floor a human would notice

describe('ripple visibility simulation (controlled clock)', () => {
  test('first focus of an idle node shows a ripple', () => {
    setProjectWith({ a: makeNode('a', 0) });
    const scene = makeScene();
    const h = makeHarness(scene);
    h.run(700); // let the mount/spawn wave finish
    h.reset();
    useGraphStore.getState().setSelection(['a']);
    h.render();
    h.run(650);
    expect(h.peak['a'] ?? 0).toBeGreaterThan(VISIBLE);
  });

  test('clicking around between nodes always shows a focus ripple', () => {
    setProjectWith({ a: makeNode('a', 0), b: makeNode('b', 1), c: makeNode('c', 2) });
    const scene = makeScene();
    const h = makeHarness(scene);
    h.run(700); // spawn waves done

    // Realistic clicking: ~300 ms between clicks, hopping between nodes.
    const seq = ['a', 'b', 'c', 'a', 'b', 'a', 'c'];
    const misses: string[] = [];
    for (let k = 0; k < seq.length; k++) {
      const id = seq[k]!;
      h.reset();
      useGraphStore.getState().setSelection([id]);
      h.render();      // immediate frame after the click
      h.run(300);      // ripple plays a bit before the next click
      if ((h.peak[id] ?? 0) <= VISIBLE) misses.push(`#${k} ${id}`);
    }
    expect(misses, `focus clicks with NO visible ripple: ${misses.join(', ')}`).toEqual([]);
  });

  test('chip-flash focus (no selection) fires a ripple immediately — snappy', () => {
    // Navigating to an existing node via a chip uses flashHighlight + a pan but
    // NO setSelection (see page.tsx onReferenceClick). The ripple must fire on
    // the focus transition right away, NOT be deferred to camera arrival.
    setProjectWith({ a: makeNode('a', 0), b: makeNode('b', 1) });
    const scene = makeScene();
    const h = makeHarness(scene);
    h.run(700); // spawn waves done
    h.reset();
    useGraphStore.getState().flashHighlight({
      parentNodeId: 'a', childNodeId: 'b', arrowId: 'arrow1', term: 'x',
    });
    h.render();  // first frame after the flash — the ripple is already firing
    h.run(300);
    expect(h.peak['b'] ?? 0).toBeGreaterThan(VISIBLE);
  });

  test('re-focusing a node shortly after leaving it shows a ripple', () => {
    setProjectWith({ a: makeNode('a', 0), b: makeNode('b', 1) });
    const scene = makeScene();
    const h = makeHarness(scene);
    h.run(700);

    useGraphStore.getState().setSelection(['a']); // focus a
    h.run(120);                                    // leave quickly
    useGraphStore.getState().setSelection(['b']); // a now unfocusing
    h.run(120);
    h.reset();
    useGraphStore.getState().setSelection(['a']); // re-focus a mid-fade
    h.render();
    h.run(650);
    expect(h.peak['a'] ?? 0).toBeGreaterThan(VISIBLE);
  });
});
