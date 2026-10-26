/**
 * Dragged nodes are EXEMPT from collision walls.
 *
 * A drag follows the cursor exactly — over pinned nodes too (the card paints
 * on top; NodeView's .dragging z-index). Overlap resolves at the moment the
 * node stops being cursor-driven:
 *  - released unpinned → rectCollide slides it out to the floor over a few
 *    ticks (animated by the sim);
 *  - released while pinned, or freshly pinned while overlapping → nudged out
 *    of every pinned node's rectCollide floor once (two pinned nodes could
 *    never separate on their own).
 */
import { test, expect, beforeEach } from 'vitest';
import {
  dispatchMessage,
  stopAutoTimer,
  tickOnce,
  inspectNode,
  setEmit,
} from './physicsWorker';
import { DEFAULT_PHYSICS_CONFIG } from './defaults';

const W = 624;  // default SimNode width when none is set
const H = 120;  // default SimNode height when none is set
const FLOOR = DEFAULT_PHYSICS_CONFIG.collidePadding * 2; // rectCollide min border gap

beforeEach(() => { setEmit(() => {}); });

test('a selected set clears pinned obstacles with one shared translation, preserving its spacing', () => {
  dispatchMessage({ type: 'init', nodes: [
    { id: 'a', x: 0, y: 0, frozen: true },
    { id: 'b', x: 750, y: 0, frozen: true },
    { id: 'c', x: 1500, y: 200, frozen: true },
  ], links: [] });
  stopAutoTimer();
  dispatchMessage({ type: 'drag-start', id: 'a', x: 0, y: 0 });
  dispatchMessage({ type: 'drag-start', id: 'b', x: 750, y: 0 });
  dispatchMessage({ type: 'drag-move', id: 'a', x: 150, y: 150 });
  dispatchMessage({ type: 'drag-move', id: 'b', x: 900, y: 150 });
  // Release before a tick to cover queued final pointer movement too.
  dispatchMessage({ type: 'drag-end-many', ids: ['a', 'b'] });
  stopAutoTimer();
  expect(pos('b').x - pos('a').x).toBe(750);
  expect(pos('b').y - pos('a').y).toBe(0);
  expect(pos('b').x + W + FLOOR).toBeLessThanOrEqual(pos('c').x);
  expect(pos('c')).toEqual({ x: 1500, y: 200 });
});

test('multi-drag commits the latest pointer targets and preserves mixed pin states', () => {
  init(false);
  dispatchMessage({ type: 'drag-start', id: 'a', x: 0, y: 0 });
  dispatchMessage({ type: 'drag-start', id: 'b', x: 800, y: 0 });
  dispatchMessage({ type: 'drag-move', id: 'a', x: 50, y: 80 });
  dispatchMessage({ type: 'drag-move', id: 'b', x: 850, y: 80 });
  dispatchMessage({ type: 'drag-end-many', ids: ['a', 'b'] });
  stopAutoTimer();
  expect(pos('a')).toEqual({ x: 50, y: 80 });
  expect(pos('b')).toEqual({ x: 850, y: 80 });
  expect(inspectNode('a')!.fx).toBeNull();
  expect(inspectNode('b')!.fx).toBe(850);
});

function pos(id: string): { x: number; y: number } {
  const n = inspectNode(id)!;
  return { x: n.fx ?? n.x ?? 0, y: n.fy ?? n.y ?? 0 };
}

/** Largest border-to-border gap between A's and B's rects across both axes
 *  (positive = separated by that much on some axis). */
function separation(): number {
  const a = pos('a');
  const b = pos('b');
  const gapX = Math.max(b.x - (a.x + W), a.x - (b.x + W));
  const gapY = Math.max(b.y - (a.y + H), a.y - (b.y + H));
  return Math.max(gapX, gapY);
}

function init(aFrozen: boolean) {
  dispatchMessage({
    type: 'init',
    nodes: [
      { id: 'a', x: 0, y: 0, frozen: aFrozen },
      { id: 'b', x: 800, y: 0, frozen: true },
    ],
    links: [],
  });
  stopAutoTimer();
}

test('drag-move puts the node exactly at the cursor, even on top of a pinned node', () => {
  init(false);
  dispatchMessage({ type: 'drag-start', id: 'a', x: 0, y: 0 });
  dispatchMessage({ type: 'drag-move', id: 'a', x: 800, y: 0 }); // dead-centre on B
  stopAutoTimer();
  expect(pos('a')).toEqual({ x: 800, y: 0 }); // no wall, no clamp
});

test('an unpinned node released over a pinned one slides out to the rectCollide floor', () => {
  init(false);
  dispatchMessage({ type: 'drag-start', id: 'a', x: 0, y: 0 });
  dispatchMessage({ type: 'drag-move', id: 'a', x: 800, y: 0 });
  stopAutoTimer();
  tickOnce(); // apply the fixed position to A.x/y so the release is real

  dispatchMessage({ type: 'drag-end', id: 'a' });
  stopAutoTimer();
  for (let i = 0; i < 20; i++) tickOnce();

  expect(separation()).toBeGreaterThanOrEqual(FLOOR - 2);
});

test('a PINNED node released over a pinned one is nudged out immediately', () => {
  init(true);
  dispatchMessage({ type: 'drag-start', id: 'a', x: 0, y: 0 });
  dispatchMessage({ type: 'drag-move', id: 'a', x: 800, y: 0 });
  stopAutoTimer();

  dispatchMessage({ type: 'drag-end', id: 'a' });
  stopAutoTimer();

  // No ticks — the nudge happens in the drag-end handler itself (nothing
  // else could ever separate two pinned rects).
  expect(separation()).toBeGreaterThanOrEqual(FLOOR - 0.01);
  expect(inspectNode('a')!.fx).not.toBeNull(); // still pinned
});

test('pinning a node that overlaps a pinned one nudges it out of the floor', () => {
  dispatchMessage({
    type: 'init',
    nodes: [
      { id: 'a', x: 800, y: 30, frozen: false }, // overlapping B
      { id: 'b', x: 800, y: 0, frozen: true },
    ],
    links: [],
  });
  stopAutoTimer();

  dispatchMessage({ type: 'set-frozen', id: 'a', frozen: true });
  stopAutoTimer();

  expect(separation()).toBeGreaterThanOrEqual(FLOOR - 0.01);
  expect(inspectNode('a')!.fx).not.toBeNull();
});
