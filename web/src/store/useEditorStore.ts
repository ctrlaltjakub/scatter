/**
 * Open/close state for the full-window "Edit text" editor. Runtime-only (never
 * persisted). The working copy lives in the TipTap editor itself — this store
 * only tracks WHICH node is open. See components/editor/TextEditorOverlay.tsx.
 */
import { create } from 'zustand';

interface EditorStore {
  open: boolean;
  nodeId: string | null;
  openEditor: (nodeId: string) => void;
  close: () => void;
}

export const useEditorStore = create<EditorStore>((set) => ({
  open: false,
  nodeId: null,
  openEditor: (nodeId) => set({ open: true, nodeId }),
  close: () => set({ open: false, nodeId: null }),
}));
