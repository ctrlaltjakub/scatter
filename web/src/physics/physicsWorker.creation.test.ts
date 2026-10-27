import { afterEach, beforeEach, expect, test } from 'vitest';
import { DEFAULT_PHYSICS_CONFIG } from './defaults';
import { placementOverlaps } from '@/lib/nodePlacement';
import { dispatchMessage, endLoadFrictionForTest, inspectNode, setEmit, stopAutoTimer, tickOnce } from './physicsWorker';

type Message = Parameters<typeof dispatchMessage>[0];
type Output = Parameters<Parameters<typeof setEmit>[0]>[0];
let outputs: Output[] = [];
const node = (id: string, x: number, y = 0, frozen = false) => ({ id, x, y, frozen });
const link = (source: string, target: string, kind: 'auto' | 'dotted' = 'auto') =>
  ({ source, target, kind, gravitates: true, arrowId: `${source}-${target}` });
function send(message: Message) { dispatchMessage(message); stopAutoTimer(); }
function advance(ticks: number) { for (let i = 0; i < ticks; i++) tickOnce(); }
const position = (id: string) => { const n = inspectNode(id)!; return { x: n.x!, y: n.y! }; };
const remote = () => ['a', 'b'].map(position);
function load() {
  send({ type: 'init', config: DEFAULT_PHYSICS_CONFIG, nodes: [
    node('a', -10000), node('b', -9100), node('parent', 0, 0, true), node('obstacle', 720, 500, true),
  ], links: [link('a', 'b')] });
  for (const id of ['a', 'b', 'parent', 'obstacle']) send({ type: 'set-size', id, width: 624, height: 390, wake: 'none' });
  endLoadFrictionForTest();
}
function insert(ids = ['child']) {
  send({ type: 'add-graph', nodes: ids.map((id, i) => ({ ...node(id, 720), width: 624, height: 780,
    birth: { token: i + 1, parentId: 'parent' } })), links: ids.map(id => link('parent', id)) });
}
beforeEach(() => { outputs = []; setEmit(message => outputs.push(message)); load(); });
afterEach(() => { stopAutoTimer(); setEmit(() => {}); });

test('publishes measured safe placement and connected arrows before the first physics tick', () => {
  insert();
  const arrival = outputs.find(m => m.placedNodes?.length)!;
  expect(arrival.placedNodes).toEqual([{ id: 'child', token: 1 }]);
  const rect = { ...position('child'), width: 624, height: 780 };
  expect(arrival.nodes.find(n => n.id === 'child')).toEqual({ id: 'child', x: rect.x, y: rect.y });
  expect(placementOverlaps(rect, { id: 'obstacle', x: 720, y: 500, width: 624, height: 390 }, 50)).toBe(false);
  expect(arrival.arrowAnchors['parent-child']!.length).toBeGreaterThanOrEqual(2);
  tickOnce();
  expect(Math.hypot(position('child').x - rect.x, position('child').y - rect.y)).toBeLessThan(5);
  expect(position('obstacle')).toEqual({ x: 720, y: 500 });
});

test('creation, additional arrows, and removal do not wake a remote cluster', () => {
  const before = remote();
  insert(); advance(150);
  send({ type: 'add-link', link: link('child', 'a', 'dotted') }); advance(150);
  send({ type: 'remove-links', ids: ['child-a'] }); advance(150);
  send({ type: 'remove-nodes', ids: ['child'] }); advance(150);
  expect(remote()).toEqual(before);
});

test('an already moving remote cluster keeps exactly the same cooling trajectory', () => {
  const run = (create: boolean) => {
    load(); send({ type: 'resume' }); advance(15);
    if (create) insert();
    const trajectory = [];
    for (let i = 0; i < 100; i++) { tickOnce(); trajectory.push(remote()); }
    return trajectory;
  };
  expect(run(true)).toEqual(run(false));
});

test('one atomic insertion reserves space for each child and routes each connection', () => {
  insert(['first', 'second']);
  const first = { ...position('first'), width: 624, height: 780 };
  const second = { id: 'second', ...position('second'), width: 624, height: 780 };
  expect(placementOverlaps(first, second, DEFAULT_PHYSICS_CONFIG.collidePadding * 2)).toBe(false);
  expect(outputs.at(-1)!.placedNodes).toHaveLength(2);
  expect(Object.keys(outputs.at(-1)!.arrowAnchors)).toEqual(expect.arrayContaining(['parent-first', 'parent-second']));
});

test('repeated insertion acknowledges the existing position without duplicating a node', () => {
  insert();
  const before = position('child');
  outputs = [];
  insert();
  expect(outputs.at(-1)!.placedNodes).toEqual([{ id: 'child', token: 1 }]);
  expect(outputs.at(-1)!.nodes.filter(n => n.id === 'child')).toEqual([{ id: 'child', ...before }]);
});

test('a movable parent can settle with its child but pins and distant nodes stay exact', () => {
  send({ type: 'set-frozen', id: 'parent', frozen: false });
  const before = remote();
  insert(); advance(120);
  expect(remote()).toEqual(before);
  expect(position('obstacle')).toEqual({ x: 720, y: 500 });
  expect(Number.isFinite(position('child').x + position('child').y)).toBe(true);
});
