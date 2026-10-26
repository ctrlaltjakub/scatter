import { create } from 'zustand';

/** Restart is presentation/runtime state, not an edit or an undo step. */
export const useInteractiveRuntimeStore = create<{
  revisions: Record<string, number>;
  restart: (nodeId: string) => void;
}>((set) => ({
  revisions: {},
  restart: (id) => set((state) => ({ revisions: {
    ...state.revisions, [id]: (state.revisions[id] ?? 0) + 1,
  } })),
}));
