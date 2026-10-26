import { create } from 'zustand';

export interface AnchorPos { x: number; y: number; }

interface AnchorState {
  /** Per-arrow chain. Index 0 is at the source port, last index is at the target port. */
  anchors: Record<string /* arrowId */, AnchorPos[]>;
  /** Monotonic runtime revision for expensive derived geometry caches. */
  revision: number;
  setAnchors: (next: Record<string, AnchorPos[]>) => void;
  mergeAnchors: (changed: Record<string, AnchorPos[]>) => void;
  removeAnchors: (ids: readonly string[]) => void;
  clear: () => void;
}

export const useArrowAnchorsStore = create<AnchorState>((set) => ({
  anchors: {},
  revision: 0,
  setAnchors: (next) => set((s) => ({ anchors: next, revision: s.revision + 1 })),
  mergeAnchors: (changed) => set((s) => {
    if (Object.keys(changed).length === 0) return s;
    return {
      anchors: { ...s.anchors, ...changed },
      revision: s.revision + 1,
    };
  }),
  removeAnchors: (ids) => set((s) => {
    if (ids.length === 0) return s;
    const anchors = { ...s.anchors };
    let changed = false;
    for (const id of ids) {
      if (id in anchors) {
        delete anchors[id];
        changed = true;
      }
    }
    return changed ? { anchors, revision: s.revision + 1 } : s;
  }),
  clear: () => set((s) => ({ anchors: {}, revision: s.revision + 1 })),
}));
