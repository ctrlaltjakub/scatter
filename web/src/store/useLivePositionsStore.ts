/**
 * PERF R2 — live runtime positions, separated from `project.nodes[id].position`.
 *
 * The physics worker emits a position tick at ~60 Hz during interaction.
 * Pre-R2 every tick mutated `project` via `setNodePositions`, which forced
 * `Canvas` to re-render (it subscribes to `project`) and cascaded into
 * every NodeView (even after R3 memoization, the project-level diff still
 * costs O(N) clone work).
 *
 * Post-R2 the live position store is the SINGLE source of truth at
 * runtime. `project.nodes[id].position` is "the position at last save /
 * last user-meaningful commit point" — physics motion only updates THIS
 * store, never `project`. Canvas stops re-rendering on every tick;
 * NodeViews subscribe per-node, so only the moving node re-renders.
 *
 * Mirrors the shape of `useArrowAnchorsStore` (same lifecycle, same
 * runtime-only contract — never persisted directly; folded into project
 * at save time by persist.ts and at user-action commit points by Canvas).
 *
 * Sync responsibilities live in Canvas.tsx:
 *   - on project load → seed `positions` from `project.nodes[id].position`
 *   - on `addNode`     → seed that one node's live position
 *   - on `removeNodes` → clear the removed nodes' live positions
 *   - on undo/redo     → reconcile live positions back to project state
 *   - on drag-end      → commit the dragged node's live position to
 *                        `project` via `updateNode` for autosave; semantic
 *                        history deliberately ignores the position
 *
 * Read responsibilities (anyone needing CURRENT position):
 *   - NodeView style transform, drag-start origin, resize origin
 *   - ArrowLayer endpoint rects
 *   - NodeSidePanel anchor
 *   - Canvas pan-to-node target
 *   - NavActions "fit all" / "center on node"
 * Each call should fall back to `node.position` when the live entry is
 * absent (initial render before physics emits the first tick, or
 * sandbox/replay scenarios that don't run physics).
 */
import { create } from 'zustand';

export interface LivePosition { x: number; y: number; }

interface LiveState {
  positions: Record<string, LivePosition>;
  /** Bulk update — one mutation per physics tick. */
  setPositions: (positions: { id: string; x: number; y: number }[]) => void;
  /** Single-node update — used by node-add / explicit commit sites. */
  setPosition: (id: string, x: number, y: number) => void;
  /** Remove entries for ids no longer in the project. */
  removePositions: (ids: string[]) => void;
  /** Seed from a project's persisted positions (project load / hydrate). */
  seedFromMap: (entries: Iterable<[string, LivePosition]>) => void;
  clear: () => void;
}

export const useLivePositionsStore = create<LiveState>((set) => ({
  positions: {},
  setPositions: (positions) => set((s) => {
    let changed = false;
    const next: Record<string, LivePosition> = { ...s.positions };
    for (const p of positions) {
      const cur = next[p.id];
      // Same 0.01-px dead-zone the pre-R2 store-update had, kept here
      // so a settled scene doesn't allocate a fresh `positions` map on
      // every tick (which would defeat the per-subscriber bail-out).
      if (!cur || Math.abs(cur.x - p.x) > 0.01 || Math.abs(cur.y - p.y) > 0.01) {
        next[p.id] = { x: p.x, y: p.y };
        changed = true;
      }
    }
    if (!changed) return s;
    return { positions: next };
  }),
  setPosition: (id, x, y) => set((s) => {
    const cur = s.positions[id];
    if (cur && Math.abs(cur.x - x) < 0.01 && Math.abs(cur.y - y) < 0.01) return s;
    return { positions: { ...s.positions, [id]: { x, y } } };
  }),
  removePositions: (ids) => set((s) => {
    if (ids.length === 0) return s;
    const next = { ...s.positions };
    let changed = false;
    for (const id of ids) {
      if (id in next) { delete next[id]; changed = true; }
    }
    if (!changed) return s;
    return { positions: next };
  }),
  seedFromMap: (entries) => set(() => {
    const next: Record<string, LivePosition> = {};
    for (const [id, p] of entries) next[id] = { x: p.x, y: p.y };
    return { positions: next };
  }),
  clear: () => set({ positions: {} }),
}));

/** Non-reactive lookup — for callers that already re-render for other
 *  reasons each frame (e.g. ArrowLayer subscribes to anchors and reads
 *  positions inline). */
export function getLivePosition(id: string): LivePosition | undefined {
  return useLivePositionsStore.getState().positions[id];
}
