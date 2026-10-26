import { describe, it, expect } from 'vitest';
import { computeEdgePan, type EdgePanInput } from './edgePan';

/** Shared canvas geometry for the cases below. */
const BASE: Omit<EdgePanInput, 'screenLeft' | 'screenRight' | 'screenTop' | 'dxMove' | 'dyMove'> = {
  cw: 1000,
  ch: 800,
  margin: 40,
  rate: 0.08,
};

/** A node parked away from every edge (centre of the canvas). */
function centred(over: Partial<EdgePanInput>): EdgePanInput {
  return { ...BASE, screenLeft: 500, screenRight: 600, screenTop: 400, dxMove: 0, dyMove: 0, ...over };
}

describe('computeEdgePan — only pans toward an edge the node is moving toward', () => {
  it('pans when the node is near the right edge AND moving right', () => {
    const { panX, panY } = computeEdgePan(centred({ screenLeft: 900, screenRight: 990, dxMove: 5 }));
    expect(panX).toBeLessThan(0); // camera follows toward the right
    expect(panY).toBe(0);
  });

  it('does NOT pan when near the right edge but moving left (toward the middle)', () => {
    const { panX } = computeEdgePan(centred({ screenLeft: 900, screenRight: 990, dxMove: -5 }));
    expect(panX).toBe(0);
  });

  it('does NOT pan when near the right edge but holding still (dxMove === 0)', () => {
    const { panX } = computeEdgePan(centred({ screenLeft: 900, screenRight: 990, dxMove: 0 }));
    expect(panX).toBe(0);
  });

  it('pans when near the left edge AND moving left', () => {
    const { panX, panY } = computeEdgePan(centred({ screenLeft: 10, screenRight: 110, dxMove: -5 }));
    expect(panX).toBeGreaterThan(0);
    expect(panY).toBe(0);
  });

  it('does NOT pan when near the left edge but moving right (away)', () => {
    const { panX } = computeEdgePan(centred({ screenLeft: 10, screenRight: 110, dxMove: 5 }));
    expect(panX).toBe(0);
  });

  it('pans when near the top edge AND moving up', () => {
    const { panX, panY } = computeEdgePan(centred({ screenTop: 10, dyMove: -5 }));
    expect(panY).toBeGreaterThan(0);
    expect(panX).toBe(0);
  });

  it('does NOT pan when near the top edge but moving down (away)', () => {
    const { panY } = computeEdgePan(centred({ screenTop: 10, dyMove: 5 }));
    expect(panY).toBe(0);
  });

  it('pans when the node top crosses the bottom margin AND moving down', () => {
    const { panY } = computeEdgePan(centred({ screenTop: 790, dyMove: 5 }));
    expect(panY).toBeLessThan(0);
  });

  it('does NOT pan when near the bottom but moving up (away)', () => {
    const { panY } = computeEdgePan(centred({ screenTop: 790, dyMove: -5 }));
    expect(panY).toBe(0);
  });

  it('does not pan at all when away from every edge', () => {
    const { panX, panY } = computeEdgePan(centred({ dxMove: 20, dyMove: 20 }));
    expect(panX).toBe(0);
    expect(panY).toBe(0);
  });

  it('pans both axes when cornered and moving into the corner', () => {
    const { panX, panY } = computeEdgePan(
      centred({ screenLeft: 900, screenRight: 990, screenTop: 790, dxMove: 5, dyMove: 5 }),
    );
    expect(panX).toBeLessThan(0);
    expect(panY).toBeLessThan(0);
  });
});
