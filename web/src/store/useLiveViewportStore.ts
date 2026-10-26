/**
 * PERF R4 — live runtime camera viewport, separated from
 * `project.viewport`.
 *
 * Camera pan emits `pointermove` updates at 120–240 Hz during a drag.
 * Pre-R4 every move mutated `project.viewport` via `setViewport`,
 * which forced `Canvas` to re-render (it subscribed to `project`) and
 * cascaded into JSX allocation + memo-comparator walks for every
 * NodeView. Even with the per-NodeView memo from R3, the Canvas-level
 * reconciliation per pan tick was the dominant cost.
 *
 * Post-R4 the live viewport store is the SINGLE source of truth at
 * runtime. `project.viewport` is "the camera position at last save /
 * last user-meaningful commit point" — pan ticks only update THIS
 * store, never `project`. Canvas stops re-rendering on every pan
 * tick; only a tiny `CameraTransform` wrapper subscribes per-frame
 * to apply the world-transform style.
 *
 * Mirrors the shape of `useLivePositionsStore` (same lifecycle, same
 * runtime-only contract — never persisted directly; folded into
 * project at save time and at user-action commit points by Canvas).
 *
 * Sync responsibilities (in Canvas.tsx unless noted):
 *   - on project load → seed from `project.viewport`
 *   - on pan-end (`onPointerUp` after a moved pan) → commit live
 *     viewport back to `project.viewport` via `setViewport` so autosave
 *     captures it (semantic history deliberately ignores camera position)
 *   - on `onWheel` (zoom) → write live immediately, debounce the
 *     project commit until the wheel gesture settles
 *   - on undo/redo → reseed live viewport from the restored
 *     `project.viewport`
 *   - on programmatic pan (NavActions: fit-all, center-on-node, the
 *     `requestPanTo` tween) → write live during the tween, commit
 *     to project at the end
 *
 * Read responsibilities (anyone needing CURRENT camera state):
 *   - Canvas world-transform wrapper (CameraTransform)
 *   - AsciiAuraLayer pan/zoom detection
 *   - CanvasToolbar zoom indicator
 *   - NavActions (reads current viewport for fit/center calculations)
 *   - NodeScrollbar and pointer handlers that need current zoom
 * Each call should fall back to `project.viewport` when the live
 * entry hasn't been seeded yet (initial render before Canvas mount,
 * or any test/sandbox path that bypasses Canvas).
 */
import { create } from 'zustand';
import { clampCameraZoom, clampViewportZoom } from '@/lib/zoomLimits';

export interface LiveViewport {
  x: number;
  y: number;
  zoom: number;
}

interface LiveViewportState extends LiveViewport {
  /** Last local movement, not a project load or a remote update. */
  editedAt: number;
  /** Full viewport update — used by zoom (which changes all three fields)
   *  and by seed/sync paths. */
  setViewport: (v: LiveViewport) => void;
  /** Pan-only update (zoom unchanged) — the hot path during a pointer drag. */
  setPan: (x: number, y: number) => void;
  /** Zoom-only update (x/y unchanged) — used by panTo tweens that only
   *  change zoom, and by any future smooth-zoom UI. */
  setZoom: (zoom: number) => void;
  /** Seed from a project's persisted viewport (project load / hydrate /
   *  undo-redo reconcile). Always writes, even if values match — the
   *  caller wants the live store reset to a known state. */
  seedFrom: (v: LiveViewport, editedAt?: number) => void;
  /** Reset to identity — used by tests + sandbox between scenarios. */
  clear: () => void;
}

const IDENTITY: LiveViewport = { x: 0, y: 0, zoom: 1 };

export const useLiveViewportStore = create<LiveViewportState>((set) => ({
  ...IDENTITY,
  editedAt: 0,
  setViewport: (v) => set((s) => {
    const next = clampViewportZoom(v);
    if (
      Math.abs(s.x - next.x) < 0.01
      && Math.abs(s.y - next.y) < 0.01
      && Math.abs(s.zoom - next.zoom) < 0.0001
    ) return s;
    return { x: next.x, y: next.y, zoom: next.zoom, editedAt: Math.max(Date.now(), s.editedAt + 1) };
  }),
  setPan: (x, y) => set((s) => {
    if (Math.abs(s.x - x) < 0.01 && Math.abs(s.y - y) < 0.01) return s;
    return { x, y, editedAt: Math.max(Date.now(), s.editedAt + 1) };
  }),
  setZoom: (zoom) => set((s) => {
    const nextZoom = clampCameraZoom(zoom);
    if (Math.abs(s.zoom - nextZoom) < 0.0001) return s;
    return { zoom: nextZoom, editedAt: Math.max(Date.now(), s.editedAt + 1) };
  }),
  seedFrom: (v, editedAt = 0) => set((s) => {
    const next = clampViewportZoom(v);
    // Same dead-zone as setViewport — when project.viewport changes
    // because pan-end just committed live → project (so live already
    // matches), we want this to be a no-op. Only undo/redo/load
    // genuinely need to reseed.
    if (
      Math.abs(s.x - next.x) < 0.01
      && Math.abs(s.y - next.y) < 0.01
      && Math.abs(s.zoom - next.zoom) < 0.0001
      && s.editedAt === editedAt
    ) return s;
    return { x: next.x, y: next.y, zoom: next.zoom, editedAt };
  }),
  clear: () => set({ ...IDENTITY, editedAt: 0 }),
}));

/** Non-reactive lookup — for callers in non-React contexts (canvas paint
 *  loops, event handlers) that don't want a re-render subscription. */
export function getLiveViewport(): LiveViewport {
  const s = useLiveViewportStore.getState();
  return { x: s.x, y: s.y, zoom: s.zoom };
}
