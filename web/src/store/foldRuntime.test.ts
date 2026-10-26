/**
 * Reading-position persistence: the transient per-node activeIdx (which L1
 * bullet is expanded) is folded into `node.activeBulletIdx` at save time and
 * seeded back into the transient store on project load — same pattern as the
 * live positions / arrow anchors folds, keeping wheel ticks out of undo.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { foldRuntimeIntoProject, activeIdxSeedEntries } from './foldRuntime';
import { useActiveIdxStore } from './useActiveIdxStore';
import { useLivePositionsStore } from './useLivePositionsStore';
import { useArrowAnchorsStore } from './useArrowAnchorsStore';
import { useLiveViewportStore } from './useLiveViewportStore';
import type { Project, ScatterNode } from './types';

const BODY_TWO_BULLETS = [
  'Intro line.',
  '',
  '- Alpha',
  '  - a1: first child description.',
  '- Beta',
  '  - b1: second child description.',
].join('\n');

function makeNode(id: string, extra?: Partial<ScatterNode>): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{ header: 'N', body: BODY_TWO_BULLETS, createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
    ...extra,
  };
}

function makeProject(nodes: Record<string, ScatterNode>): Project {
  return {
    id: 'p1',
    name: 'Test',
    createdAt: 0,
    updatedAt: 0,
    rootNodeId: 'n1',
    nodes,
    arrows: {},
    groups: {},
    viewport: { x: 0, y: 0, zoom: 1 },
    selection: [],
  };
}

beforeEach(() => {
  useActiveIdxStore.getState().replaceAll([]);
  useLivePositionsStore.getState().seedFromMap([]);
  useArrowAnchorsStore.getState().clear();
  useLiveViewportStore.getState().clear();
});

describe('foldRuntimeIntoProject — activeBulletIdx', () => {
  it('includes in-progress pan/zoom in exports and project-switch snapshots', () => {
    const p = makeProject({ n1: makeNode('n1') });
    useLiveViewportStore.getState().setViewport({ x: -300, y: 920, zoom: 0.3 });
    const out = foldRuntimeIntoProject(p);
    expect(out.viewport).toEqual({ x: -300, y: 920, zoom: 0.3 });
    expect(out.viewportUpdatedAt).toBeGreaterThan(0);
    expect(p.viewport.zoom).toBe(1);
  });

  it('keeps newer graph navigation before the canvas mirrors it into the live store', () => {
    useLiveViewportStore.getState().seedFrom({ x: 50, y: 10, zoom: 0.4 }, 10);
    const p = { ...makeProject({ n1: makeNode('n1') }),
      viewport: { x: -700, y: 80, zoom: 0.7 }, viewportUpdatedAt: 20 };
    const out = foldRuntimeIntoProject(p);
    expect(out.viewport).toEqual(p.viewport);
    expect(out.viewportUpdatedAt).toBe(20);
  });
  it('writes the transient activeIdx onto the node at fold time', () => {
    const p = makeProject({ n1: makeNode('n1') });
    useActiveIdxStore.getState().set('n1', 1);
    const out = foldRuntimeIntoProject(p);
    expect(out.nodes.n1!.activeBulletIdx).toBe(1);
  });

  it('strips a previously-persisted index the user cleared this session', () => {
    const p = makeProject({ n1: makeNode('n1', { activeBulletIdx: 1 }) });
    // Transient store has NO entry for n1 → the saved field must go away,
    // not survive as a stale value.
    const out = foldRuntimeIntoProject(p);
    expect('activeBulletIdx' in out.nodes.n1!).toBe(false);
  });

  it('ignores transient entries for nodes that no longer exist', () => {
    const p = makeProject({ n1: makeNode('n1') });
    useActiveIdxStore.getState().set('deleted-node', 4);
    const out = foldRuntimeIntoProject(p);
    expect(out.nodes.n1!.activeBulletIdx).toBeUndefined();
    expect(Object.keys(out.nodes)).toEqual(['n1']);
  });

  it('passes untouched nodes through by reference', () => {
    const n1 = makeNode('n1');
    const p = makeProject({ n1 });
    const out = foldRuntimeIntoProject(p);
    expect(out.nodes.n1).toBe(n1);
  });
});

describe('activeIdxSeedEntries', () => {
  it('returns [nodeId, idx] pairs for valid persisted indices', () => {
    const p = makeProject({ n1: makeNode('n1', { activeBulletIdx: 1 }) });
    expect(activeIdxSeedEntries(p)).toEqual([['n1', 1]]);
  });

  it('clamps an out-of-range index to the last bullet (body edited since save)', () => {
    const p = makeProject({ n1: makeNode('n1', { activeBulletIdx: 9 }) });
    expect(activeIdxSeedEntries(p)).toEqual([['n1', 1]]); // 2 bullets → max idx 1
  });

  it('drops entries whose body has no bullets anymore', () => {
    const bulletless = makeNode('n1', { activeBulletIdx: 0 });
    bulletless.versions[0]!.body = 'Just a paragraph, no bullets.';
    const p = makeProject({ n1: bulletless });
    expect(activeIdxSeedEntries(p)).toEqual([]);
  });

  it('drops negative and absent indices', () => {
    const p = makeProject({
      n1: makeNode('n1', { activeBulletIdx: -1 }),
      n2: makeNode('n2'),
    });
    expect(activeIdxSeedEntries(p)).toEqual([]);
  });
});
