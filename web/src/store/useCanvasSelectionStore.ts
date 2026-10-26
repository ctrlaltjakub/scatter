import { create } from 'zustand';
import type { ScreenRect } from '@/lib/asciiAura/statusText';

/** Screen-space gesture geometry only: never persisted or recorded in undo. */
export const useCanvasSelectionStore = create<{
  marquee: { projectId: string; rect: ScreenRect } | null;
  setMarquee: (marquee: { projectId: string; rect: ScreenRect } | null) => void;
}>((set) => ({ marquee: null, setMarquee: (marquee) => set({ marquee }) }));
