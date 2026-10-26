import { create } from 'zustand';

export interface DragHintEntry {
  nodeId: string;
  text: 'DRAG AWAY TO PIN' | 'SHAKE TO UNPIN';
  startedAt: number;
  clearedAt: number | null;
}

interface DragHintState {
  hint: DragHintEntry | null;
  show: (nodeId: string, text: DragHintEntry['text']) => void;
  clear: (nodeId: string) => void;
  remove: (nodeId: string) => void;
}

const nowMs = (): number =>
  typeof performance !== 'undefined' ? performance.now() : Date.now();

/** Runtime-only feedback for a node drag. Only one pointer drag can be active. */
export const useDragHintStore = create<DragHintState>((set, get) => ({
  hint: null,
  show: (nodeId, text) => {
    const current = get().hint;
    if (current?.nodeId === nodeId && current.text === text && current.clearedAt == null) return;
    set({ hint: { nodeId, text, startedAt: nowMs(), clearedAt: null } });
  },
  clear: (nodeId) => {
    const current = get().hint;
    if (!current || current.nodeId !== nodeId || current.clearedAt != null) return;
    set({ hint: { ...current, clearedAt: nowMs() } });
  },
  remove: (nodeId) => {
    if (get().hint?.nodeId === nodeId) set({ hint: null });
  },
}));
