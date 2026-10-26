import { afterEach, beforeEach, expect, test } from 'vitest';
import { DEFAULT_PHYSICS_CONFIG } from './defaults';
import {
  dispatchMessage, endLoadFrictionForTest, getAlpha, inspectNode,
  setEmit, stopAutoTimer, tickOnce,
} from './physicsWorker';

type Message = Parameters<typeof dispatchMessage>[0];
const node = (id: string, x: number, frozen = false, y = 0) => ({ id, x, y, frozen });
const link = (source: string, target: string, kind: 'auto' | 'dotted' = 'auto') =>
  ({ source, target, kind, gravitates: true, arrowId: `${source}-${target}` });
function send(message: Message) { dispatchMessage(message); stopAutoTimer(); }
function advance(ticks: number) { for (let i = 0; i < ticks; i++) tickOnce(); }
function position(id: string) {
  const n = inspectNode(id)!;
  return { x: n.x, y: n.y };
}
function load(extraLinks: ReturnType<typeof link>[] = [], config = DEFAULT_PHYSICS_CONFIG) {
  send({ type: 'init', config, nodes: [
    node('a', 0), node('b', 900), node('wall', 2500, true),
    node('wall2', 3500, true), node('mover', 5000),
  ], links: [link('a', 'b'), ...extraLinks] });
  for (const id of ['a', 'b', 'wall', 'wall2', 'mover']) {
    send({ type: 'set-size', id, width: 100, height: 80 });
  }
  endLoadFrictionForTest();
}
function dragDistantNode() {
  send({ type: 'drag-start', id: 'mover', x: 5000, y: 0 });
  for (let i = 0; i < 60; i++) {
    send({ type: 'drag-move', id: 'mover', x: 5000 + i * 4, y: i * 2 });
    tickOnce();
  }
  send({ type: 'drag-end', id: 'mover' });
  advance(150);
}

beforeEach(() => setEmit(() => {}));
afterEach(stopAutoTimer);

test.each(['restored', 'cooled'] as const)('a distant drag leaves a %s cluster exactly in place', (state) => {
  load();
  if (state === 'cooled') {
    send({ type: 'resume' });
    while (getAlpha() >= .005) tickOnce();
    // The simulation stopped before the link reached its ideal distance.
    expect(position('b').x! - position('a').x! - 100).toBeGreaterThan(DEFAULT_PHYSICS_CONFIG.linkDistance + 1);
  }
  const before = [position('a'), position('b')];
  dragDistantNode();
  expect([position('a'), position('b')]).toEqual(before);
  expect(position('mover')).toEqual({ x: 5236, y: 118 });
  expect(position('wall')).toEqual({ x: 2500, y: 0 });
});

test('a stationary pinned node stops wake propagation through structural links', () => {
  load([link('b', 'wall'), link('wall', 'mover')]);
  const before = [position('a'), position('b')];
  dragDistantNode();
  expect([position('a'), position('b')]).toEqual(before);
});

test('dotted references do not wake the referenced cluster', () => {
  load([link('mover', 'a', 'dotted')]);
  const before = [position('a'), position('b')];
  dragDistantNode();
  expect([position('a'), position('b')]).toEqual(before);
});

test('an actual structural connection still pulls the linked cluster', () => {
  load([link('b', 'mover')]);
  dragDistantNode();
  expect(position('a').x).toBeGreaterThan(0);
  expect(position('b').x).toBeGreaterThan(900);
});

test('dragging into an unrelated cluster still pushes it aside', () => {
  load();
  send({ type: 'drag-start', id: 'mover', x: 5000, y: 0 });
  send({ type: 'drag-move', id: 'mover', x: 40, y: 10 });
  advance(20);
  expect(position('a')).not.toEqual({ x: 0, y: 0 });
  expect(position('mover')).toEqual({ x: 40, y: 10 });
  send({ type: 'drag-end', id: 'mover' });
  advance(150);
  const a = position('a'), m = position('mover');
  const gap = Math.max(Math.abs(a.x! - m.x!) - 100, Math.abs(a.y! - m.y!) - 80);
  expect(gap).toBeGreaterThanOrEqual(DEFAULT_PHYSICS_CONFIG.collidePadding * 2 - 2);
});

test('an already-moving distant cluster follows the same cooling path during a drag', () => {
  function run(drag: boolean) {
    load();
    send({ type: 'resume' });
    advance(15);
    if (drag) send({ type: 'drag-start', id: 'mover', x: 5000, y: 0 });
    const trajectory = [];
    for (let i = 0; i < 120; i++) {
      if (drag) send({ type: 'drag-move', id: 'mover', x: 5000 + i * 4, y: 0 });
      tickOnce();
      trajectory.push([position('a'), position('b')]);
    }
    return trajectory;
  }
  expect(run(true)).toEqual(run(false));
});

test('dragging against a pinned obstacle cannot wake a cluster attached behind it', () => {
  load([link('b', 'wall')]);
  send({ type: 'drag-start', id: 'mover', x: 5000, y: 0 });
  send({ type: 'drag-move', id: 'mover', x: 2540, y: 10 });
  advance(30);
  send({ type: 'drag-end', id: 'mover' });
  advance(150);
  expect(position('a')).toEqual({ x: 0, y: 0 });
  expect(position('b')).toEqual({ x: 900, y: 0 });
  expect(position('wall')).toEqual({ x: 2500, y: 0 });
});

test('moving a pinned node does wake its connected movable neighbors', () => {
  load([link('b', 'wall')]);
  send({ type: 'drag-start', id: 'wall', x: 2500, y: 0 });
  send({ type: 'drag-move', id: 'wall', x: 2700, y: 100 });
  advance(20);
  expect(position('b').x).toBeGreaterThan(900);
  send({ type: 'drag-end', id: 'wall' });
  advance(150);
  expect(position('wall')).toEqual({ x: 2700, y: 100 });
  expect(inspectNode('wall')!.frozen).toBe(true);
});

test('multi-drag and release preserve pin states without waking remote nodes', () => {
  load();
  for (const [id, x] of [['wall2', 3500], ['mover', 5000]] as const) {
    send({ type: 'drag-start', id, x, y: 0 });
    send({ type: 'drag-move', id, x: x + 200, y: 100 });
  }
  advance(10);
  send({ type: 'drag-end-many', ids: ['wall2', 'mover'] });
  advance(150);
  expect(position('a')).toEqual({ x: 0, y: 0 });
  expect(position('b')).toEqual({ x: 900, y: 0 });
  expect(position('wall2')).toEqual({ x: 3700, y: 100 });
  expect(position('mover')).toEqual({ x: 5200, y: 100 });
  expect(inspectNode('wall2')!.frozen).toBe(true);
  expect(inspectNode('mover')!.fx).toBeNull();
});

test('enabled repulsion wakes nearby unlinked nodes but not distant ones', () => {
  load([], { ...DEFAULT_PHYSICS_CONFIG, unlinkedRepelStrength: -50, repelRange: 600 });
  send({ type: 'drag-start', id: 'mover', x: 5000, y: 0 });
  send({ type: 'drag-move', id: 'mover', x: 1300, y: 0 });
  tickOnce();
  expect(position('b').x).toBeLessThan(900);
  expect(position('wall2')).toEqual({ x: 3500, y: 0 });
  expect(position('mover')).toEqual({ x: 1300, y: 0 });
});

test('disabled springs do not transmit a wake across an otherwise structural link', () => {
  load([link('b', 'mover')], { ...DEFAULT_PHYSICS_CONFIG, linkStrength: 0 });
  dragDistantNode();
  expect(position('a')).toEqual({ x: 0, y: 0 });
  expect(position('b')).toEqual({ x: 900, y: 0 });
});

test.each([
  { type: 'set-frozen', id: 'mover', frozen: true },
  { type: 'set-size', id: 'mover', width: 200, height: 160 },
] satisfies Message[])('local $type changes do not restart remote springs', (message) => {
  load();
  send(message);
  advance(150);
  expect(position('a')).toEqual({ x: 0, y: 0 });
  expect(position('b')).toEqual({ x: 900, y: 0 });
});

test('shaping an arrow updates its route without waking node physics', () => {
  load();
  let anchors: { x: number; y: number }[] | undefined;
  setEmit(message => { if (message.arrowAnchors['a-b']) anchors = message.arrowAnchors['a-b']; });
  send({ type: 'arrow-drag-start', arrowId: 'a-b', x: 400, y: 300 });
  advance(10);
  expect(anchors?.some(p => p.y > 200)).toBe(true);
  send({ type: 'arrow-drag-end', arrowId: 'a-b' });
  advance(150);
  expect(position('a')).toEqual({ x: 0, y: 0 });
  expect(position('b')).toEqual({ x: 900, y: 0 });
});
