import { create } from 'zustand';
/** Local runtime tool only: never saved, synced, or included in undo history. */
export const useScreenshotStore = create<{ open: boolean; setOpen: (open: boolean) => void }>(set => ({
  open: false, setOpen: open => set({ open }),
}));
