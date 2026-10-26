import { describe, it, expect } from 'vitest';
import {
  centerDistance,
  directAutoRelativeIds,
  dragAwayExcessFromAny,
  pinArmStrength,
  shouldPinOnDragAway,
  shouldPinOnDragAwayFromAny,
  DRAG_AWAY_PIN_PX,
} from './dragAwayPin';

describe('centerDistance — distance between two node centers', () => {
  it('measures center-to-center, not corner-to-corner', () => {
    // A: 100×100 at (0,0) → center (50,50). B: 100×100 at (300,50) → center (350,100).
    const d = centerDistance({ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 50, w: 100, h: 100 });
    expect(d).toBeCloseTo(Math.hypot(350 - 50, 100 - 50), 6);
  });

  it('is zero for two identical rects', () => {
    expect(centerDistance({ x: 10, y: 10, w: 60, h: 40 }, { x: 10, y: 10, w: 60, h: 40 })).toBe(0);
  });
});

describe('shouldPinOnDragAway — auto-pin a child dragged clear of its parent', () => {
  it('pins when the child ended well past the threshold farther from the parent', () => {
    expect(shouldPinOnDragAway({ distStart: 100, distEnd: 700 })).toBe(true);
  });

  it('uses a 160 canvas-pixel default threshold', () => {
    expect(DRAG_AWAY_PIN_PX).toBe(160);
    expect(shouldPinOnDragAway({ distStart: 100, distEnd: 261 })).toBe(true);
  });

  it('does not pin at exactly the threshold (strictly greater)', () => {
    expect(
      shouldPinOnDragAway({ distStart: 100, distEnd: 100 + DRAG_AWAY_PIN_PX }),
    ).toBe(false);
  });

  it('does not pin for a small move', () => {
    expect(shouldPinOnDragAway({ distStart: 100, distEnd: 200 })).toBe(false);
  });

  it('does not pin when the child was dragged CLOSER (negative delta)', () => {
    expect(shouldPinOnDragAway({ distStart: 900, distEnd: 100 })).toBe(false);
  });

  it('honors a custom threshold', () => {
    expect(shouldPinOnDragAway({ distStart: 0, distEnd: 150, threshold: 100 })).toBe(true);
    expect(shouldPinOnDragAway({ distStart: 0, distEnd: 80, threshold: 100 })).toBe(false);
  });

  it('never arms or pins again during a gesture that already shook the node loose', () => {
    expect(shouldPinOnDragAway({
      distStart: 100,
      distEnd: 700,
      suppressed: true,
    })).toBe(false);
  });
});

describe('drag-away pinning across direct relatives', () => {
  it('never arms from a dotted reference, including legacy gravitating references', () => {
    const reference = { kind: 'dotted', fromNodeId: 'a', toNodeId: 'b', gravitates: true };
    for (const id of ['a', 'b']) {
      const distances = directAutoRelativeIds(id, [reference]).map(() => ({ distStart: 0, distEnd: 10000 }));
      expect(distances).toEqual([]);
      expect(shouldPinOnDragAwayFromAny({ distances })).toBe(false);
    }
    expect(directAutoRelativeIds('b', [{ ...reference, kind: 'auto' }])).toEqual(['a']);
  });
  it('collects both the parent and every child connected by automatic arrows', () => {
    expect(directAutoRelativeIds('middle', [
      { kind: 'auto', fromNodeId: 'parent', toNodeId: 'middle' },
      { kind: 'auto', fromNodeId: 'middle', toNodeId: 'child-b' },
      { kind: 'manual', fromNodeId: 'middle', toNodeId: 'manual-neighbor' },
      { kind: 'auto', fromNodeId: 'middle', toNodeId: 'child-a' },
      { kind: 'auto', fromNodeId: 'unrelated-a', toNodeId: 'unrelated-b' },
    ])).toEqual(['parent', 'child-b', 'child-a']);
  });

  it('pins when movement exceeds the threshold away from any one direct relative', () => {
    expect(shouldPinOnDragAwayFromAny({
      distances: [
        { distStart: 300, distEnd: 330 },
        { distStart: 180, distEnd: 341 },
        { distStart: 500, distEnd: 420 },
      ],
    })).toBe(true);
  });

  it('does not pin when no direct-relative distance exceeds the threshold', () => {
    expect(shouldPinOnDragAwayFromAny({
      distances: [
        { distStart: 300, distEnd: 460 },
        { distStart: 500, distEnd: 620 },
      ],
    })).toBe(false);
  });

  it('suppresses every relative after shake-to-unpin for the rest of the gesture', () => {
    expect(shouldPinOnDragAwayFromAny({
      distances: [{ distStart: 100, distEnd: 900 }],
      suppressed: true,
    })).toBe(false);
  });

  it('reports no excess at the exact threshold', () => {
    expect(dragAwayExcessFromAny({
      distances: [{ distStart: 100, distEnd: 260 }],
    })).toBe(0);
  });

  it('reports the largest excess distance among all direct relatives', () => {
    expect(dragAwayExcessFromAny({
      distances: [
        { distStart: 100, distEnd: 300 },
        { distStart: 200, distEnd: 620 },
      ],
    })).toBe(260);
  });

  it('reports no excess after shake-to-unpin suppression', () => {
    expect(dragAwayExcessFromAny({
      distances: [{ distStart: 0, distEnd: 900 }],
      suppressed: true,
    })).toBe(0);
  });

  it('normalizes excess distance across the capped 320px visual ramp', () => {
    expect(pinArmStrength(-20)).toBe(0);
    expect(pinArmStrength(160)).toBe(0.5);
    expect(pinArmStrength(500)).toBe(1);
  });
});
