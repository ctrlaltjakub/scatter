/**
 * Transient per-node "active bullet index" state.
 *
 * Tracks which L1 bullet (if any) is the user's current focus within
 * a node's adaptive-bullet cascade. Drives:
 *
 *   - AdaptiveBullets: the active bullet is force-promoted to
 *     maxMode (full children with descriptions) while the cascade's
 *     other bullets demote to fit.
 *   - NodeScrollbar: the scrollbar's active tick dot tracks
 *     `activeIdx + 1` (stop 0 = freetext, stops 1..N = bullet i-1).
 *   - NodeSidePanel: the "Expand selected" button uses activeIdx +
 *     bulletsCollapsed to decide whether to expand the freetext or
 *     a specific bullet.
 *
 * `null` means "no L1 forced active" — the cascade uses its default
 * uniform-first seed and the scrollbar sits at stop 0 (freetext).
 *
 * The reading position PERSISTS across reloads, but through a fold, not
 * live writes: this store stays transient (wheel-tick updates would
 * flood temporal-undo history with hundreds of micro-changes if they
 * touched the persisted graph). At save time foldRuntime snapshots
 * `byNodeId` into each node's `activeBulletIdx`; on project load,
 * `replaceAll(activeIdxSeedEntries(project))` seeds it back — same
 * lifecycle as useLivePositionsStore / useArrowAnchorsStore.
 *
 * Same pattern as useRewriteStore — keyed by nodeId so multiple
 * focused nodes could in principle hold their own activeIdx
 * concurrently (in practice only one node is focused at a time).
 */
import { create } from 'zustand';

interface ActiveIdxStore {
  byNodeId: Record<string, number | null>;
  /** Set the active bullet for a node. Pass null to clear (cascade
   *  reverts to default fill, scrollbar sits at freetext stop). */
  set: (nodeId: string, idx: number | null) => void;
  /** Rebuild the whole map (project load/switch — also wipes the previous
   *  scatter's entries). */
  replaceAll: (entries: Array<[string, number]>) => void;
}

export const useActiveIdxStore = create<ActiveIdxStore>((set) => ({
  byNodeId: {},
  set: (nodeId, idx) => set((state) => {
    const next = { ...state.byNodeId };
    if (idx === null) delete next[nodeId];
    else next[nodeId] = idx;
    return { byNodeId: next };
  }),
  replaceAll: (entries) => set(() => {
    const next: Record<string, number | null> = {};
    for (const [id, idx] of entries) next[id] = idx;
    return { byNodeId: next };
  }),
}));
