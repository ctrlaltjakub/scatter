import { create } from 'zustand';
import type { ChatAnswerRef } from './chatTypes';
interface State {
  target: ({ nodeId: string; tableIndex: number } & ChatAnswerRef) | null;
  open: (target: NonNullable<State['target']>) => void;
  close: () => void;
}
export const useChatTableStore = create<State>((set) => ({
  target: null, open: (target) => set({ target }), close: () => set({ target: null }),
}));
