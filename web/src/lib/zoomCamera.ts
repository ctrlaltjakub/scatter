/**
 * Smooth, centered camera zoom — shared by the nav-bar zoom buttons and the
 * Q/E keyboard shortcuts.
 *
 * Zooms AROUND the centre of the visible canvas (so the middle of the view
 * stays put), animating over a short duration. Rapid presses accumulate toward
 * the running target and keep the motion smooth. Each settled zoom commits once
 * to the project for autosave; the in-between frames write only the live
 * viewport. Semantic undo deliberately ignores camera movement.
 */
import { useLiveViewportStore } from '@/store/useLiveViewportStore';
import { useGraphStore } from '@/store/useGraphStore';
import { clampCameraZoom } from './zoomLimits';

/** Per-step zoom factor (≈half the old ×1.25 step). Out = 1/IN. */
export const ZOOM_STEP = 1.125;
export const ZOOM_IN_FACTOR = ZOOM_STEP;
export const ZOOM_OUT_FACTOR = 1 / ZOOM_STEP;

const DURATION_MS = 140;

let raf: number | null = null;
let animating = false;
let startTime = 0;
let startZoom = 1;
let targetZoom = 1;
let anchorScreenX = 0;
let anchorScreenY = 0;
let anchorWorldX = 0;
let anchorWorldY = 0;

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Screen-space centre of the visible canvas (relative to the canvas host). */
function canvasCenter(): { sx: number; sy: number } {
  const rect = typeof document !== 'undefined'
    ? document.querySelector('.canvas-host')?.getBoundingClientRect()
    : null;
  if (!rect) return { sx: 0, sy: 0 };
  return { sx: rect.width / 2, sy: rect.height / 2 };
}

function viewportAt(zoom: number): { x: number; y: number; zoom: number } {
  return {
    x: anchorScreenX - anchorWorldX * zoom,
    y: anchorScreenY - anchorWorldY * zoom,
    zoom,
  };
}

function step(): void {
  const now = performance.now();
  const t = Math.min(1, (now - startTime) / DURATION_MS);
  const z = startZoom + (targetZoom - startZoom) * easeOutCubic(t);
  useLiveViewportStore.getState().setViewport(viewportAt(z));
  if (t < 1) {
    raf = requestAnimationFrame(step);
  } else {
    animating = false;
    raf = null;
    // Commit the settled camera to the project for autosave only.
    const final = viewportAt(targetZoom);
    useLiveViewportStore.getState().setViewport(final);
    useGraphStore.getState().setViewport(final);
  }
}

/** Zoom the camera by `factor` (>1 in, <1 out), animated and centered. */
export function zoomCameraBy(factor: number): void {
  const lv = useLiveViewportStore.getState();
  const { sx, sy } = canvasCenter();
  // Re-anchor to the world point currently under the canvas centre.
  anchorScreenX = sx;
  anchorScreenY = sy;
  anchorWorldX = (sx - lv.x) / lv.zoom;
  anchorWorldY = (sy - lv.y) / lv.zoom;

  const base = animating ? targetZoom : lv.zoom;
  const next = clampCameraZoom(base * factor);
  if (next === lv.zoom && !animating) return;
  startZoom = lv.zoom;
  targetZoom = next;
  startTime = performance.now();

  // Dragging the camera by hand cancels follow tweens; an explicit zoom should
  // too, so the two don't fight.
  useGraphStore.getState().requestPanTo(null);

  if (!animating) {
    animating = true;
    raf = requestAnimationFrame(step);
  }
}
