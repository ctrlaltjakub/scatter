/**
 * Minimap pointer behavior.
 *
 * 1. Grabbing the camera via the minimap must cancel a pending follow/autopan
 *    request (`panTo`) the same way an empty-canvas drag or an explicit zoom
 *    does — otherwise the follow loop yanks the camera back mid-generation.
 * 2. Hovering a node's rect updates the canvas `data-tip` to that node's
 *    header, which AppTooltips displays beside the minimap.
 *
 * jsdom setup: a no-op 2D context Proxy + synchronous rAF let the real draw()
 * run, so the hover hit-test works against the same rects the map paints.
 * With clientWidth 0 the map collapses to scale 0: every node rect becomes
 * 2×2 CSS px at x=0, y=MINIMAP_H/2 — deterministic hover coordinates.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import type { ScatterNode } from '@/store/types';
import { Minimap } from './Minimap';
import { useGraphStore, createBlankProject } from '@/store/useGraphStore';
import { useLiveViewportStore } from '@/store/useLiveViewportStore';

const DEFAULT_TIP = 'Click or drag to pan the camera';

beforeAll(() => {
  if (!('ResizeObserver' in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // jsdom has no 2D canvas: hand draw() a context whose every method is a
  // no-op and every property assignment is accepted, so it runs to the end
  // (filling the hover rects) without painting anything.
  const fakeCtx = new Proxy({}, { get: () => () => {}, set: () => true });
  HTMLCanvasElement.prototype.getContext = (() => fakeCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  // Synchronous rAF (returning 0 keeps the component's `if (!raf)` gate open).
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => { cb(0); return 0; }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
});

afterEach(() => {
  cleanup();
});

function makeNode(id: string, header = 'Node'): ScatterNode {
  return {
    id,
    type: 'term-click',
    position: { x: 0, y: 0 },
    frozen: false,
    versions: [{ header, body: 'Body.', createdAt: 0, generatedBy: 'root' }],
    currentVersionIndex: 0,
  };
}

function renderMinimap(header?: string) {
  const proj = createBlankProject('t', 'n0');
  useGraphStore.getState().setProject({ ...proj, nodes: { n0: makeNode('n0', header) } });
  useGraphStore.temporal.getState().pause();
  const utils = render(<Minimap />);
  const canvas = utils.container.querySelector('.sidebar-minimap-canvas')!;
  return { ...utils, canvas };
}

// The collapsed-map node rect: x∈[0,2], y∈[62,64] (see header comment).
const OVER_NODE = { clientX: 1, clientY: 63 };
const OVER_EMPTY = { clientX: 60, clientY: 5 };

describe('Minimap — panning cancels autopan', () => {
  it('clears a pending panTo request on pointer-down and still pans the camera', () => {
    const { canvas } = renderMinimap();
    useGraphStore.getState().requestPanTo('n0');
    useLiveViewportStore.getState().setViewport({ x: 999, y: 999, zoom: 1 });

    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 10, clientY: 10 });

    // The follow request is gone…
    expect(useGraphStore.getState().panTo).toBeNull();
    // …and the manual pan still went through to the live viewport.
    expect(useLiveViewportStore.getState().x).not.toBe(999);
  });
});

describe('Minimap — hover shows node header via data-tip', () => {
  it('starts with the default tip', () => {
    const { canvas } = renderMinimap();
    expect(canvas.getAttribute('data-tip')).toBe(DEFAULT_TIP);
  });

  it('shows the hovered node header, and restores the default off-node', () => {
    const { canvas } = renderMinimap('World History');
    fireEvent.pointerMove(canvas, OVER_NODE);
    expect(canvas.getAttribute('data-tip')).toBe('World History');

    fireEvent.pointerMove(canvas, OVER_EMPTY);
    expect(canvas.getAttribute('data-tip')).toBe(DEFAULT_TIP);
  });

  it('falls back to "Untitled" for a blank header', () => {
    const { canvas } = renderMinimap('   ');
    fireEvent.pointerMove(canvas, OVER_NODE);
    expect(canvas.getAttribute('data-tip')).toBe('Untitled');
  });

  it('restores the default tip on pointer leave', () => {
    const { canvas } = renderMinimap();
    fireEvent.pointerMove(canvas, OVER_NODE);
    fireEvent.pointerLeave(canvas);
    expect(canvas.getAttribute('data-tip')).toBe(DEFAULT_TIP);
  });

  it('does not update the tip while dragging the camera', () => {
    const { canvas } = renderMinimap();
    fireEvent.pointerDown(canvas, { pointerId: 1, clientX: 60, clientY: 5 });
    fireEvent.pointerMove(canvas, OVER_NODE);
    expect(canvas.getAttribute('data-tip')).toBe(DEFAULT_TIP);
    fireEvent.pointerUp(canvas, { pointerId: 1, ...OVER_NODE });
  });
});
