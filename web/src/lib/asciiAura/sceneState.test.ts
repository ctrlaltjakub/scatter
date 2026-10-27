/**
 * R5.1 — unit tests for the shared aura scene-state module.
 *
 * sceneState owns the store-subscription logic extracted from
 * AsciiAuraLayer (spawn/ghost/focus detection, wave firing, viewport
 * tracking, intensity tween, baseline palette membership) so BOTH
 * renderers (2D fallback, WebGL) consume identical scene data.
 *
 * The renderer-facing contract under test:
 *   - createAuraSceneState({ onDirty }) → { state, subscribeStores,
 *     pruneExpired, evalIntensities }
 *   - onDirty(reason) fires with a DirtyReason the renderer maps to
 *     its own repaint flags ('zoom' | 'recolor' | 'palette' must be
 *     distinguishable — the 2D path maps those to full refresh).
 */
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useNodeBirthStore } from '@/store/useNodeBirthStore';
import { useLivePositionsStore } from '@/store/useLivePositionsStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { nodeWidth, nodeRenderedH } from '@/lib/nodeSize';
import { createChatNode } from '@/lib/chat/model';
import { WAVE_DURATION_MS, COLLAPSE_DURATION_MS } from './wave';
import type { ScatterNode, Group, CatppuccinAccent } from '@/store/types';
import {
  createAuraSceneState,
  AURA_RADIUS_UNFOCUSED,
  INTENSITY_TRANSITION_MS,
  FOCUS_TRANSITION_MS,
  UNFOCUS_TRANSITION_MS,
  FLASH_FOCUS_HOLD_MS,
  MAX_FOCUS_ECHOES,
  type AuraScene,
  type DirtyReason,
} from './sceneState';

function makeNode(id: string, i: number, groupId?: string): ScatterNode {
  return {
    id,
    type: i === 0 ? 'root' : 'term-click',
    position: { x: i * 700, y: i * 50 },
    frozen: false,
    groupId,
    versions: [{ header: `Node ${i}`, body: '', createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

function makeGroup(id: string, color: CatppuccinAccent): Group {
  return { id, name: id, color, gravitate: false };
}

function setProjectWith(
  nodes: Record<string, ScatterNode>,
  groups: Record<string, Group> = {},
  color?: string,
): void {
  // Strip the seeded base color — most scenarios here model the legacy
  // (grey/neutral) project; pass `color` explicitly to test the base color.
  const { color: _seeded, ...proj } = createBlankProject('scene-test', Object.keys(nodes)[0] ?? 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes, groups, ...(color ? { color } : {}) });
  useGraphStore.temporal.getState().pause();
}

let unsub: (() => void) | null = null;
let reasons: DirtyReason[] = [];

function makeScene(): AuraScene {
  reasons = [];
  const scene = createAuraSceneState({ onDirty: (r) => reasons.push(r) });
  unsub = scene.subscribeStores();
  reasons = []; // drop whatever the initial sync fired
  return scene;
}

beforeEach(() => {
  useLivePositionsStore.getState().clear();
  useLiveViewportStore.getState().clear();
});

afterEach(() => {
  if (unsub) { unsub(); unsub = null; }
  // Clear selection/group/highlight so state doesn't leak across tests (a
  // leftover highlight would re-fire on the next scene's first sync).
  useGraphStore.getState().selectGroup(null);
  useGraphStore.getState().clearHighlight();
});

describe('aura lifecycle', () => {
  test('creation starts its aura at the final position, together with the card', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    useGraphStore.getState().addNode(makeNode('child', 1));
    expect(scene.state.auras.has('child')).toBe(false);
    expect(scene.state.waves.has('child')).toBe(false);
    useNodeBirthStore.getState().measure('child', 624, 780);
    useLivePositionsStore.getState().setPosition('child', 686.5, -195);
    useGraphStore.getState().updateNode('child', { renderedHeight: 780 });
    useNodeBirthStore.getState().reveal('child', useNodeBirthStore.getState().byNode.child!.token);
    expect(scene.state.auras.get('child')!.rect).toEqual({ x: 686.5, y: -195, w: 624, h: 780 });
    expect(scene.state.waves.get('child')?.kind).toBe('spawn');
  });

  test('initial sync creates an aura per node with node-sized rect', () => {
    const n0 = makeNode('n0', 0);
    setProjectWith({ n0 });
    const scene = makeScene();
    const aura = scene.state.auras.get('n0');
    expect(aura).toBeDefined();
    expect(aura!.rect).toEqual({
      x: n0.position.x,
      y: n0.position.y,
      w: nodeWidth(n0),
      h: nodeRenderedH(n0),
    });
    expect(aura!.focused).toBe(false);
    expect(aura!.intensity).toBe(0);
  });

  test('new node fires a spawn wave and dirties the scene', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    expect(scene.state.auras.has('n1')).toBe(true);
    expect(scene.state.waves.get('n1')?.kind).toBe('spawn');
    expect(reasons).toContain('wave');
    expect(reasons).toContain('geometry');
  });

  test('explain identity and stable glyph seed are derived from the node at runtime', () => {
    const n0 = makeNode('stable-explain-id', 0);
    n0.type = 'explain';
    n0.versions[0] = { ...n0.versions[0]!, contentType: 'explain' };
    setProjectWith({ [n0.id]: n0 });
    const first = makeScene().state.auras.get(n0.id)!;
    expect(first.isExplain).toBe(true);
    expect(first.glyphSeed).toBeTypeOf('number');
    unsub?.();
    unsub = null;
    const second = makeScene().state.auras.get(n0.id)!;
    expect(second.glyphSeed).toBe(first.glyphSeed);
  });

  test('removed node leaves a collapse ghost with the unfocused radius', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    setProjectWith({ n0: makeNode('n0', 0) });
    expect(scene.state.auras.has('n1')).toBe(false);
    const ghost = scene.state.ghosts.get('n1');
    expect(ghost).toBeDefined();
    expect(ghost!.wave.kind).toBe('collapse');
    expect(ghost!.wave.startRadius).toBe(AURA_RADIUS_UNFOCUSED);
    expect(reasons).toContain('geometry');
  });

  test('chat identity follows the current version and survives focus changes', () => {
    const n0 = makeNode('chat', 0);
    n0.versions = [n0.versions[0]!, { ...n0.versions[0]!, contentType: 'chat' }];
    n0.currentVersionIndex = 1;
    setProjectWith({ [n0.id]: n0 });
    const scene = makeScene();
    expect(scene.state.auras.get(n0.id)).toMatchObject({ isChat: true, isExplain: false });
    useGraphStore.getState().setSelection([n0.id]);
    expect(scene.state.auras.get(n0.id)).toMatchObject({ isChat: true, focused: true });
    setProjectWith({ [n0.id]: { ...n0, currentVersionIndex: 0 } });
    expect(scene.state.auras.get(n0.id)?.isChat).toBe(false);
  });
});

describe('focus and group selection', () => {
  test('selecting a node focuses its aura, fires a focus wave, anchors the tween', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    // Initial sync fires a spawn wave for every node (mount pulse). Expire it
    // first so this test isolates the focus tween/intensity assertions. (The
    // focus ripple now fires regardless of an active wave — see the dedicated
    // regression tests below.)
    scene.pruneExpired(scene.state.waves.get('n0')!.t0 + WAVE_DURATION_MS + 1);
    useGraphStore.getState().setSelection(['n0']);
    const aura = scene.state.auras.get('n0')!;
    expect(aura.focused).toBe(true);
    expect(aura.intensityFrom).toBe(0); // tween starts from old intensity
    expect(scene.state.waves.get('n0')?.kind).toBe('focus');
    expect(reasons).toContain('geometry');
  });

  // Regression: the focus ripple must ALWAYS fire when a node gains focus,
  // even if another wave is still playing on it. Previously handleGraph
  // skipped the focus wave while any wave was active, so re-focusing a node
  // within ~0.5 s of spawning or leaving it silently dropped the ripple — the
  // "sometimes there's no ripple" bug.
  test('focus ripple fires even while the spawn wave is still active', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    // Do NOT expire the spawn wave — it is still playing.
    expect(scene.state.waves.get('n0')?.kind).toBe('spawn');
    useGraphStore.getState().setSelection(['n0']);
    expect(scene.state.waves.get('n0')?.kind).toBe('focus');
  });

  test('re-focusing while the unfocus ripple is still receding still ripples', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    scene.pruneExpired(scene.state.waves.get('n0')!.t0 + WAVE_DURATION_MS + 1); // clear spawn
    useGraphStore.getState().setSelection(['n0']);                              // focus
    scene.pruneExpired(scene.state.waves.get('n0')!.t0 + WAVE_DURATION_MS + 1); // clear focus
    useGraphStore.getState().setSelection([]);                                  // unfocus
    expect(scene.state.waves.get('n0')?.kind).toBe('unfocus');                  // receding
    useGraphStore.getState().setSelection(['n0']);                             // re-focus mid-recede
    expect(scene.state.waves.get('n0')?.kind).toBe('focus');
  });

  test('selectGroup focuses every member even when selection was already empty (F.1-quater)', () => {
    setProjectWith(
      { n0: makeNode('n0', 0, 'g1'), n1: makeNode('n1', 1, 'g1'), n2: makeNode('n2', 2) },
      { g1: makeGroup('g1', 'mauve') },
    );
    const scene = makeScene();
    // selection is already [] — selectGroup must still propagate focus.
    useGraphStore.getState().selectGroup('g1');
    expect(scene.state.auras.get('n0')!.focused).toBe(true);
    expect(scene.state.auras.get('n1')!.focused).toBe(true);
    expect(scene.state.auras.get('n2')!.focused).toBe(false);
    expect(scene.state.waves.get('n0')?.kind).toBe('focus');
    expect(scene.state.waves.get('n1')?.kind).toBe('focus');
  });
});

describe('viewport dirty reasons', () => {
  test('pan fires "pan" and updates state.viewport', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    useLiveViewportStore.getState().setPan(50, 25);
    expect(reasons).toContain('pan');
    expect(scene.state.viewport.x).toBe(50);
    expect(scene.state.viewport.y).toBe(25);
  });

  test('zoom fires "zoom" (the 2D full-refresh trigger)', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    makeScene();
    useLiveViewportStore.getState().setViewport({ x: 0, y: 0, zoom: 0.5 });
    expect(reasons).toContain('zoom');
  });
});

describe('accent and palette tracking', () => {
  test('chat-title-only edits wake the renderer without changing aura geometry', () => {
    const node = createChatNode({ id: 'chat', createdAt: 1, position: { x: 0, y: 0 }, bodyHeight: 300 });
    setProjectWith({ chat: node });
    const scene = makeScene();
    const rect = { ...scene.state.auras.get('chat')!.rect };
    useGraphStore.getState().updateNode('chat', { chat: { ...node.chat!, title: 'Memory systems' } });
    expect(reasons).toContain('geometry');
    expect(scene.state.auras.get('chat')!.rect).toEqual(rect);
    expect(useGraphStore.getState().project?.nodes.chat?.versions).toBe(node.versions);
  });

  test('group-name-only edits wake the renderer for ASCII labels', () => {
    const nodes = { n0: makeNode('n0', 0, 'g1') };
    setProjectWith(nodes, { g1: makeGroup('g1', 'mauve') });
    makeScene();
    useGraphStore.getState().renameGroup('g1', 'Renamed group');
    expect(reasons).toContain('geometry');
  });

  test('group recolor updates the aura accent and fires "recolor"', () => {
    const nodes = { n0: makeNode('n0', 0, 'g1') };
    setProjectWith(nodes, { g1: makeGroup('g1', 'mauve') });
    const scene = makeScene();
    expect(scene.state.auras.get('n0')!.accent).toBe('mauve');
    setProjectWith(nodes, { g1: makeGroup('g1', 'green') });
    expect(scene.state.auras.get('n0')!.accent).toBe('green');
    expect(reasons).toContain('recolor');
  });

  test('palette membership: sorted accents + anyUngrouped, version bump + "palette"', () => {
    setProjectWith(
      { n0: makeNode('n0', 0, 'g1'), n1: makeNode('n1', 1) },
      { g1: makeGroup('g1', 'mauve') },
    );
    const scene = makeScene();
    expect(scene.state.baselineAccents).toEqual(['mauve']);
    expect(scene.state.anyUngrouped).toBe(true);
    const v0 = scene.state.paletteVersion;
    setProjectWith(
      {
        n0: makeNode('n0', 0, 'g1'),
        n1: makeNode('n1', 1, 'g2'),
        n2: makeNode('n2', 2, 'g2'),
      },
      { g1: makeGroup('g1', 'mauve'), g2: makeGroup('g2', 'green') },
    );
    expect(scene.state.baselineAccents).toEqual(['green', 'mauve']); // sorted
    expect(scene.state.anyUngrouped).toBe(false);
    expect(scene.state.paletteVersion).toBeGreaterThan(v0);
    expect(reasons).toContain('palette');
  });

  test('ungrouped node wears the project base color (accent + palette member)', () => {
    setProjectWith({ n0: makeNode('n0', 0) }, {}, '#aabbcc');
    const scene = makeScene();
    expect(scene.state.auras.get('n0')!.accent).toBe('#aabbcc');
    expect(scene.state.baselineAccents).toContain('#aabbcc');
    expect(scene.state.anyUngrouped).toBe(false); // colored ≠ neutral-grey path
  });

  test('recolorProject alone repaints (perf short-circuit must track it)', () => {
    // recolorProject changes ONLY project.color — nodes/selection/groups refs
    // stay identical, which the O(N)-walk short-circuit would skip without a
    // dedicated project-color ref.
    setProjectWith({ n0: makeNode('n0', 0) }, {}, '#aabbcc');
    const scene = makeScene();
    useGraphStore.getState().recolorProject('#112233');
    expect(scene.state.auras.get('n0')!.accent).toBe('#112233');
    expect(reasons).toContain('recolor');
    expect(reasons).toContain('palette');
  });

  test('legacy color-less project keeps the neutral path (null accent)', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    expect(scene.state.auras.get('n0')!.accent ?? null).toBeNull();
    expect(scene.state.anyUngrouped).toBe(true);
  });
});

describe('live position sync', () => {
  test('physics tick moves the aura rect and fires "geometry"', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    useLivePositionsStore.getState().setPositions([{ id: 'n0', x: 123, y: 456 }]);
    const aura = scene.state.auras.get('n0')!;
    expect(aura.rect.x).toBe(123);
    expect(aura.rect.y).toBe(456);
    expect(reasons).toContain('geometry');
  });
});

describe('intensity tween (evalIntensities)', () => {
  test('progresses 0 → 1 over the transition window and reports completion', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    useGraphStore.getState().setSelection(['n0']);
    const aura = scene.state.auras.get('n0')!;
    const t0 = aura.intensityFlipAt;

    expect(scene.evalIntensities(t0 + INTENSITY_TRANSITION_MS / 2)).toBe(true);
    expect(aura.intensity).toBeCloseTo(0.5, 5);

    // +1 ms past the window: `(t0 + DURATION) - t0` isn't exactly DURATION
    // for large performance.now() values, so evaluating AT the boundary
    // flips `elapsed >= duration` at random. A 1 ms margin is still
    // "transition complete" but makes the boundary unambiguous.
    expect(scene.evalIntensities(t0 + INTENSITY_TRANSITION_MS + 1)).toBe(false);
    expect(aura.intensity).toBe(1);
  });

  test('mid-flight reverse animates out from the partial value, not from 1', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    useGraphStore.getState().setSelection(['n0']);
    const aura = scene.state.auras.get('n0')!;
    const t0 = aura.intensityFlipAt;
    scene.evalIntensities(t0 + FOCUS_TRANSITION_MS / 2); // intensity ≈ 0.5

    useGraphStore.getState().setSelection([]); // reverse mid-flight
    const aura2 = scene.state.auras.get('n0')!;
    expect(aura2.intensityFrom).toBeCloseTo(0.5, 5);
    const t1 = aura2.intensityFlipAt;

    // Unfocus uses the slower fade window.
    scene.evalIntensities(t1 + UNFOCUS_TRANSITION_MS / 2);
    // halfway from 0.5 toward 0 → 0.25
    expect(aura2.intensity).toBeCloseTo(0.25, 5);
  });

  test('focus rises in 200 ms; unfocus fades over the slower 450 ms', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    expect(FOCUS_TRANSITION_MS).toBe(200);
    expect(UNFOCUS_TRANSITION_MS).toBe(450);

    useGraphStore.getState().setSelection(['n0']);
    const aura = scene.state.auras.get('n0')!;
    const tf = aura.intensityFlipAt;
    expect(scene.evalIntensities(tf + FOCUS_TRANSITION_MS + 1)).toBe(false); // +1 ms: see note above
    expect(aura.intensity).toBe(1);

    useGraphStore.getState().setSelection([]);
    const tu = scene.state.auras.get('n0')!.intensityFlipAt;
    // Still mid-fade at the OLD (200 ms) deadline — proves it's slower.
    expect(scene.evalIntensities(tu + FOCUS_TRANSITION_MS)).toBe(true);
    expect(scene.state.auras.get('n0')!.intensity).toBeGreaterThan(0);
    // Settled just past the unfocus deadline (+1 ms: see note above).
    expect(scene.evalIntensities(tu + UNFOCUS_TRANSITION_MS + 1)).toBe(false);
    expect(scene.state.auras.get('n0')!.intensity).toBe(0);
  });
});

describe('unfocus receding ripple', () => {
  test('dropping focus fires an "unfocus" wave', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    // Focus, expire the focus wave, then unfocus.
    useGraphStore.getState().setSelection(['n0']);
    scene.pruneExpired(scene.state.waves.get('n0')!.t0 + WAVE_DURATION_MS + 1);
    reasons = [];
    useGraphStore.getState().setSelection([]);
    expect(scene.state.waves.get('n0')?.kind).toBe('unfocus');
    expect(reasons).toContain('wave');
  });
});

describe('chip-flash transient focus (no selection)', () => {
  function flash(childNodeId: string, source: 'chip' | 'node' = 'chip') {
    useGraphStore.getState().flashHighlight({
      parentNodeId: 'n0', childNodeId, arrowId: 'a0', term: 'x',
      source,
    });
  }

  function arrive() {
    const requestId = useGraphStore.getState().panTo!.requestId;
    useGraphStore.getState().completePanTo(requestId);
  }

  test('flashing a node lifts it to focused AND ripples immediately, without selection change', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    scene.pruneExpired(scene.state.waves.get('n1')!.t0 + WAVE_DURATION_MS + 1); // settle spawn
    flash('n1');
    const aura = scene.state.auras.get('n1')!;
    expect(aura.focused).toBe(true);
    expect(useGraphStore.getState().project!.selection).toEqual([]); // unchanged
    // The ripple fires on the focus transition right away — snappy, NOT
    // deferred to camera arrival.
    expect(scene.state.waves.get('n1')?.kind).toBe('focus');
    expect(FLASH_FOCUS_HOLD_MS).toBe(1000);
  });

  test('a chip-flash ripple fires even while the mount spawn wave is still active', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    expect(scene.state.waves.get('n1')?.kind).toBe('spawn'); // still playing
    flash('n1');
    expect(scene.state.waves.get('n1')?.kind).toBe('focus'); // overridden
  });

  test('chip flash waits for matching camera arrival before starting its ripple', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    scene.pruneExpired(scene.state.waves.get('n1')!.t0 + WAVE_DURATION_MS + 1);
    useGraphStore.getState().requestPanTo('n1');
    flash('n1');
    expect(scene.state.waves.has('n1')).toBe(false);
    expect(scene.state.auras.get('n1')?.focused).toBe(true);
    arrive();
    expect(scene.state.waves.get('n1')?.kind).toBe('focus');
  });

  test('cancelling the camera request discards the queued chip ripple', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    scene.pruneExpired(scene.state.waves.get('n1')!.t0 + WAVE_DURATION_MS + 1);
    useGraphStore.getState().requestPanTo('n1');
    const cancelledRequestId = useGraphStore.getState().panTo!.requestId;
    flash('n1');
    useGraphStore.getState().requestPanTo(null);
    useGraphStore.getState().completePanTo(cancelledRequestId);
    expect(scene.state.waves.has('n1')).toBe(false);
  });

  test('every repeated chip flash restarts an already-focused ripple and stacks the previous wave', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    flash('n1');
    const firstT0 = scene.state.waves.get('n1')!.t0;
    flash('n1');
    expect(scene.state.waves.get('n1')?.kind).toBe('focus');
    expect(scene.state.focusEchoes.get('n1')).toContain(firstT0);
    flash('n1');
    flash('n1');
    flash('n1');
    expect(scene.state.focusEchoes.get('n1')).toHaveLength(MAX_FOCUS_ECHOES);
  });

  test('a chip click still starts a new ripple after the prior highlight auto-clears', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    flash('n1');
    const firstT0 = scene.state.waves.get('n1')!.t0;
    scene.pruneExpired(firstT0 + WAVE_DURATION_MS + 1);
    useGraphStore.getState().clearHighlight();

    flash('n1');

    expect(scene.state.waves.get('n1')?.kind).toBe('focus');
  });

  test('each arrived chip click restarts the wave and stacks the previous wave', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    scene.pruneExpired(scene.state.waves.get('n1')!.t0 + WAVE_DURATION_MS + 1);
    useGraphStore.getState().requestPanTo('n1');
    flash('n1');
    arrive();
    const firstT0 = scene.state.waves.get('n1')!.t0;
    useGraphStore.getState().requestPanTo('n1');
    flash('n1');
    arrive();
    expect(scene.state.focusEchoes.get('n1')).toContain(firstT0);
  });

  test('a stale same-node completion cannot release the latest queued ripple', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    scene.pruneExpired(scene.state.waves.get('n1')!.t0 + WAVE_DURATION_MS + 1);
    useGraphStore.getState().requestPanTo('n1');
    const staleRequestId = useGraphStore.getState().panTo!.requestId;
    flash('n1');
    useGraphStore.getState().requestPanTo('n1');
    const currentRequestId = useGraphStore.getState().panTo!.requestId;
    flash('n1');

    useGraphStore.getState().completePanTo(staleRequestId);
    expect(useGraphStore.getState().panTo?.requestId).toBe(currentRequestId);
    expect(scene.state.waves.has('n1')).toBe(false);

    useGraphStore.getState().completePanTo(currentRequestId);
    expect(scene.state.waves.get('n1')?.kind).toBe('focus');
  });

  test('node-origin flashes do not add a second ripple after selection focused the node', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    useGraphStore.getState().setSelection(['n1']);
    const focusWave = scene.state.waves.get('n1')!;
    flash('n1', 'node');
    expect(scene.state.waves.get('n1')).toEqual(focusWave);
    expect(scene.state.focusEchoes.has('n1')).toBe(false);
    useGraphStore.getState().requestPanTo('n1');
    arrive();
    expect(scene.state.waves.get('n1')).toEqual(focusWave);
    expect(scene.state.focusEchoes.has('n1')).toBe(false);
  });

  test('flash expiry unfocuses with a receding ripple', () => {
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const scene = makeScene();
    flash('n1');
    const tFlash = scene.state.waves.get('n1')!.t0; // focus ripple start
    // Focus ripple ends; the 1 s hold still pins the node focused.
    scene.pruneExpired(tFlash + WAVE_DURATION_MS + 1);
    expect(scene.state.auras.get('n1')!.focused).toBe(true);
    reasons = [];
    // Past the hold (nothing else holds focus) → unfocus + receding ripple.
    scene.pruneExpired(tFlash + FLASH_FOCUS_HOLD_MS + 1);
    expect(scene.state.auras.get('n1')!.focused).toBe(false);
    expect(scene.state.waves.get('n1')?.kind).toBe('unfocus');
    expect(reasons).toContain('wave');
  });

  test('a flashed node that is ALSO selected stays focused after the flash expires', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    const t = performance.now();
    useGraphStore.getState().setSelection(['n0']);
    flash('n0');
    scene.pruneExpired(t + FLASH_FOCUS_HOLD_MS + 1);
    expect(scene.state.auras.get('n0')!.focused).toBe(true); // selection holds it
    expect(scene.state.waves.get('n0')?.kind).not.toBe('unfocus');
  });
});

describe('pruneExpired', () => {
  test('drops finished waves and ghosts, firing "wave"', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    // Spawn a node (wave) then delete it (ghost).
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    setProjectWith({ n0: makeNode('n0', 0) });
    const wave = scene.state.waves.get('n1');
    const ghost = scene.state.ghosts.get('n1');
    // The spawn wave was deleted with the node; the ghost remains.
    expect(wave).toBeUndefined();
    expect(ghost).toBeDefined();

    reasons = [];
    const past = ghost!.wave.t0 + COLLAPSE_DURATION_MS + 1;
    scene.pruneExpired(past);
    expect(scene.state.ghosts.size).toBe(0);
    expect(reasons).toContain('wave');
  });

  test('keeps still-active waves', () => {
    setProjectWith({ n0: makeNode('n0', 0) });
    const scene = makeScene();
    setProjectWith({ n0: makeNode('n0', 0), n1: makeNode('n1', 1) });
    const wave = scene.state.waves.get('n1')!;
    scene.pruneExpired(wave.t0 + WAVE_DURATION_MS - 50);
    expect(scene.state.waves.has('n1')).toBe(true);
  });
});
