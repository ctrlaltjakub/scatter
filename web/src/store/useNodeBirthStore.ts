import { create } from 'zustand';
import type { PlacementRegion } from '@/lib/nodePlacement';

export const NODE_ENTRANCE_MS = 200;
export interface NodeBirth {
  projectId: string;
  token: number;
  phase: 'measuring' | 'placing' | 'entering';
  parentId?: string;
  regions?: readonly PlacementRegion[];
  size?: { width: number; height: number };
  revealedAt?: number;
}
let nonce = 0;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const stopTimer = (id: string) => { clearTimeout(timers.get(id)); timers.delete(id); };

/** Runtime-only creation handshake, never serialized or recorded in undo.
 * Loading/sync/redo use setProject/history, not begin: they never fade cards in. */
export const useNodeBirthStore = create<{
  byNode: Record<string, NodeBirth>;
  begin: (projectId: string, id: string, parentId?: string, regions?: readonly PlacementRegion[]) => void;
  measure: (id: string, width: number, height: number) => void;
  reveal: (id: string, token: number) => void;
  prune: (projectId: string, ids: ReadonlySet<string>) => void;
  clear: () => void;
}>(set => ({
  byNode: {},
  begin: (projectId, id, parentId, regions) => {
    stopTimer(id);
    set(s => ({ byNode: { ...s.byNode, [id]: { projectId, token: ++nonce, phase: 'measuring', parentId, regions } } }));
  },
  measure: (id, width, height) => set(s => {
    const entry = s.byNode[id];
    if (!entry || entry.phase !== 'measuring' || !Number.isFinite(width + height) || !(width > 0 && height > 0)) return s;
    return { byNode: { ...s.byNode, [id]: { ...entry, phase: 'placing', size: { width, height } } } };
  }),
  reveal: (id, token) => {
    set(s => {
      const entry = s.byNode[id];
      if (!entry || entry.token !== token || entry.phase !== 'placing') return s;
      stopTimer(id);
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        set(current => {
          if (current.byNode[id]?.token !== token) return current;
          const byNode = { ...current.byNode }; delete byNode[id]; return { byNode };
        });
      }, NODE_ENTRANCE_MS));
      return { byNode: { ...s.byNode, [id]: { ...entry, phase: 'entering', revealedAt: performance.now() } } };
    });
  },
  prune: (projectId, ids) => set(s => {
    const stale = Object.keys(s.byNode).filter(id => s.byNode[id]!.projectId !== projectId || !ids.has(id));
    if (!stale.length) return s;
    const byNode = { ...s.byNode };
    for (const id of stale) { stopTimer(id); delete byNode[id]; }
    return { byNode };
  }),
  clear: () => { for (const id of timers.keys()) stopTimer(id); set({ byNode: {} }); },
}));

export const birthIsPending = (birth?: NodeBirth) => !!birth && birth.phase !== 'entering';
