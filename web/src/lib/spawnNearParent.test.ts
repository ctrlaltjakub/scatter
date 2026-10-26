import { describe, it, expect } from 'vitest';
import { spawnNearParent } from './generate';
import { DEFAULT_NODE_W } from './nodeSize';
import type { ScatterNode } from '@/store/types';

const NEW_W = DEFAULT_NODE_W; // 624 — assumed width of a spawned child
const NEW_H = 400;            // TYPICAL_NODE_H — assumed height of a spawned child

function node(
  id: string,
  x: number,
  y: number,
  opts: { width?: number; renderedHeight?: number } = {},
): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x, y },
    frozen: false,
    versions: [{ header: id, body: '', createdAt: 0, generatedBy: 'manual', width: opts.width }],
    currentVersionIndex: 0,
    renderedHeight: opts.renderedHeight ?? NEW_H,
  };
}

/** Which 90° quadrant the spawned child's CENTER lands in, relative to the
 *  parent's center. Mirrors spawnNearParent's own classification. */
function quadrant(
  parent: ScatterNode,
  child: { x: number; y: number },
): 'right' | 'left' | 'below' | 'above' {
  const pW = parent.versions[parent.currentVersionIndex]?.width ?? NEW_W;
  const pH = parent.renderedHeight ?? NEW_H;
  const dx = child.x + NEW_W / 2 - (parent.position.x + pW / 2);
  const dy = child.y + NEW_H / 2 - (parent.position.y + pH / 2);
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
  if (deg > -45 && deg <= 45) return 'right';
  if (deg > 135 || deg <= -135) return 'left';
  if (deg > 45 && deg <= 135) return 'below';
  return 'above';
}

function rectsOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return !(a.x + a.w <= b.x || a.x >= b.x + b.w || a.y + a.h <= b.y || a.y >= b.y + b.h);
}

describe('spawnNearParent', () => {
  it.each([
    ['below', .45, .85], ['above', .45, .05], ['left', .02, .45], ['right', .88, .45],
  ] as const)('places an image selection near the %s edge on that side', (side, x, y) => {
    const parent = node('p', 0, 0);
    const res = spawnNearParent(parent, [parent], undefined, undefined, [{ x, y, width: .1, height: .1 }]);
    expect(quadrant(parent, res)).toBe(side);
  });

  it('uses another free side when the edge closest to an image selection is occupied', () => {
    const parent = node('p', 0, 0);
    const blocker = node('b', -1000, 410, { width: 3000, renderedHeight: 700 });
    const res = spawnNearParent(parent, [parent, blocker], undefined, undefined, [{ x: .45, y: .85, width: .1, height: .1 }]);
    expect(quadrant(parent, res)).not.toBe('below');
    expect(rectsOverlap({ ...res, w: NEW_W, h: NEW_H }, { ...blocker.position, w: 3000, h: 700 })).toBe(false);
  });

  it('places the first child to the RIGHT of the parent in an empty field', () => {
    const parent = node('p', 0, 0);
    const res = spawnNearParent(parent, [parent]);
    expect(quadrant(parent, res)).toBe('right');
  });

  it('is deterministic (no random jitter) for identical inputs', () => {
    const parent = node('p', 100, 200);
    const a = spawnNearParent(parent, [parent]);
    const b = spawnNearParent(parent, [parent]);
    expect(a).toEqual(b);
  });

  it('falls back to the LEFT when the right side is blocked nearby', () => {
    const parent = node('p', 0, 0);
    // One big blocker covering everything from just right of the parent
    // outward and taller than any ring. Because spawned cards are wide,
    // this also catches the BELOW/ABOVE slots (whose cards spill into the
    // region), leaving LEFT as the only free direction.
    const blocker = node('block', 350, -1500, { width: 4000, renderedHeight: 3000 });
    const res = spawnNearParent(parent, [parent, blocker]);
    expect(quadrant(parent, res)).toBe('left');
  });

  it('never returns a slot that overlaps an existing node', () => {
    const parent = node('p', 0, 0);
    const sibling = node('s', 720, 0); // the straight-right slot is taken
    const res = spawnNearParent(parent, [parent, sibling]);
    const childRect = { x: res.x, y: res.y, w: NEW_W, h: NEW_H };
    for (const n of [parent, sibling]) {
      const nodeRect = {
        x: n.position.x,
        y: n.position.y,
        w: n.versions[n.currentVersionIndex]?.width ?? NEW_W,
        h: n.renderedHeight ?? NEW_H,
      };
      expect(rectsOverlap(childRect, nodeRect)).toBe(false);
    }
  });
});
