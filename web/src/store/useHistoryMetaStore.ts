import { create } from 'zustand';
import type { HistoryActionDescriptor } from '@/lib/historySemantics';

const HISTORY_LIMIT = 100;

interface HistoryMetaState {
  past: HistoryActionDescriptor[];
  future: HistoryActionDescriptor[];
  record: (descriptor: HistoryActionDescriptor) => void;
  undo: (steps?: number) => void;
  redo: (steps?: number) => void;
  clear: () => void;
}

export const useHistoryMetaStore = create<HistoryMetaState>((set) => ({
  past: [],
  future: [],
  record: (descriptor) => set((state) => ({
    past: [...state.past, descriptor].slice(-HISTORY_LIMIT),
    future: [],
  })),
  undo: (steps = 1) => set((state) => {
    const count = Math.max(0, Math.min(steps, state.past.length));
    if (count === 0) return state;
    const past = state.past.slice();
    const moved = past.splice(-count, count);
    return {
      past,
      // Match zundo's stack ordering: the earliest action in a multi-step
      // undo becomes the next redo target.
      future: [...state.future, ...moved.reverse()],
    };
  }),
  redo: (steps = 1) => set((state) => {
    const count = Math.max(0, Math.min(steps, state.future.length));
    if (count === 0) return state;
    const future = state.future.slice();
    const moved = future.splice(-count, count);
    return {
      past: [...state.past, ...moved.reverse()].slice(-HISTORY_LIMIT),
      future,
    };
  }),
  clear: () => set({ past: [], future: [] }),
}));

export function nextUndoDescriptor(): HistoryActionDescriptor | undefined {
  return useHistoryMetaStore.getState().past.at(-1);
}
