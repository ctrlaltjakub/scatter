import { describe, it, expect } from 'vitest';
import { bboxFullyVisible, bboxIntersectsViewport, currentSidebarInsetPx, FIT_MARGIN_PX } from './nodeVisibility';

// Container 1000×800, identity camera (zoom 1, no pan) unless noted. Default
// margin is one third of the former 20px; visibility and camera fits share it.
const VP = { x: 0, y: 0, zoom: 1 };
const CONTAINER = { containerW: 1000, containerH: 800 };

describe('bboxFullyVisible — "no pan needed" predicate', () => {
  it('uses one third of the old camera margin, including at the visibility boundary', () => {
    expect(FIT_MARGIN_PX).toBe(20 / 3);
    const bbox = { minX: FIT_MARGIN_PX, minY: FIT_MARGIN_PX, maxX: 1000 - FIT_MARGIN_PX, maxY: 800 - FIT_MARGIN_PX };
    expect(bboxFullyVisible({ bbox, viewport: VP, ...CONTAINER })).toBe(true);
    expect(bboxFullyVisible({ bbox: { ...bbox, minX: FIT_MARGIN_PX - .01 }, viewport: VP, ...CONTAINER })).toBe(false);
  });
  it('returns true for a node comfortably inside the margined window', () => {
    expect(
      bboxFullyVisible({ bbox: { minX: 200, minY: 200, maxX: 600, maxY: 500 }, viewport: VP, ...CONTAINER }),
    ).toBe(true);
  });

  it('returns false when the node spills off the right edge', () => {
    expect(
      bboxFullyVisible({ bbox: { minX: 700, minY: 200, maxX: 1100, maxY: 500 }, viewport: VP, ...CONTAINER }),
    ).toBe(false);
  });

  it('returns false when the node spills off the top edge', () => {
    expect(
      bboxFullyVisible({ bbox: { minX: 200, minY: -50, maxX: 600, maxY: 200 }, viewport: VP, ...CONTAINER }),
    ).toBe(false);
  });

  it('returns false when the node sits under the left sidebar inset', () => {
    // Node at x=40..400 is on-canvas, but a 240px sidebar covers the left strip.
    expect(
      bboxFullyVisible({
        bbox: { minX: 40, minY: 200, maxX: 400, maxY: 500 },
        viewport: VP,
        ...CONTAINER,
        leftInsetPx: 240,
      }),
    ).toBe(false);
  });

  it('accounts for pan + zoom when projecting the bbox to screen', () => {
    // Same world bbox, but pan it back on-screen → visible again.
    const bbox = { minX: 2000, minY: 2000, maxX: 2400, maxY: 2300 };
    expect(bboxFullyVisible({ bbox, viewport: { x: 0, y: 0, zoom: 1 }, ...CONTAINER })).toBe(false);
    expect(bboxFullyVisible({ bbox, viewport: { x: -1800, y: -1800, zoom: 1 }, ...CONTAINER })).toBe(true);
  });
});

describe('bboxIntersectsViewport — "any part on screen" predicate', () => {
  it('returns true for a node fully inside', () => {
    expect(
      bboxIntersectsViewport({ bbox: { minX: 200, minY: 200, maxX: 600, maxY: 500 }, viewport: VP, ...CONTAINER }),
    ).toBe(true);
  });

  it('returns true when the node only partly spills off an edge', () => {
    // Spills off the right but the left half is on screen → still partially visible.
    expect(
      bboxIntersectsViewport({ bbox: { minX: 900, minY: 200, maxX: 1300, maxY: 500 }, viewport: VP, ...CONTAINER }),
    ).toBe(true);
  });

  it('returns false when the node is entirely off screen (to the right)', () => {
    expect(
      bboxIntersectsViewport({ bbox: { minX: 1100, minY: 200, maxX: 1400, maxY: 500 }, viewport: VP, ...CONTAINER }),
    ).toBe(false);
  });

  it('returns false when the node is entirely above the viewport', () => {
    expect(
      bboxIntersectsViewport({ bbox: { minX: 200, minY: -500, maxX: 600, maxY: -10 }, viewport: VP, ...CONTAINER }),
    ).toBe(false);
  });

  it('accounts for pan + zoom', () => {
    const bbox = { minX: 2000, minY: 2000, maxX: 2400, maxY: 2300 };
    expect(bboxIntersectsViewport({ bbox, viewport: { x: 0, y: 0, zoom: 1 }, ...CONTAINER })).toBe(false);
    expect(bboxIntersectsViewport({ bbox, viewport: { x: -1900, y: -1900, zoom: 1 }, ...CONTAINER })).toBe(true);
  });
});

describe('currentSidebarInsetPx', () => {
  it('reports the open sidebar width and ignores a collapsed sidebar', () => {
    document.body.innerHTML = '<aside class="sidebar"></aside>';
    expect(currentSidebarInsetPx()).toBe(240);

    document.querySelector('.sidebar')!.classList.add('collapsed');
    expect(currentSidebarInsetPx()).toBe(0);
  });
});
