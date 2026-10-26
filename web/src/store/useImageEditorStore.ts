/**
 * Open/close state for the full-window image crop/annotate editor. Runtime-only
 * (never persisted) — the working document lives inside the editor component.
 * Mirror of useEditorStore (the text editor's visibility store).
 *
 * While the editor is open it registers its undo/redo here so the app's
 * toolbar Undo/Redo buttons (NavActions) drive the EDITOR's history instead
 * of the graph's — same routing the editor's capture-phase Ctrl+Z does.
 * See components/imageEditor/ImageEditorOverlay.tsx.
 */
import { create } from 'zustand';

export interface EditorUndoHandle {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

interface ImageEditorStore {
  open: boolean;
  nodeId: string | null;
  /** Non-null while an editor session is mounted. */
  undoHandle: EditorUndoHandle | null;
  openImageEditor: (nodeId: string) => void;
  close: () => void;
  setUndoHandle: (h: EditorUndoHandle | null) => void;
}

export const useImageEditorStore = create<ImageEditorStore>((set) => ({
  open: false,
  nodeId: null,
  undoHandle: null,
  openImageEditor: (nodeId) => set({ open: true, nodeId }),
  close: () => set({ open: false, nodeId: null, undoHandle: null }),
  setUndoHandle: (undoHandle) => set({ undoHandle }),
}));
