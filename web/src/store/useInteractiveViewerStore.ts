/**
 * Runtime-only state for the full-window interactive explanation viewer.
 * The chosen version is captured when the preview opens so unrelated canvas
 * version changes cannot silently replace the program under the user.
 */
import { create } from 'zustand';

interface InteractiveViewerStore {
  open: boolean;
  nodeId: string | null;
  versionIndex: number | null;
  /** Viewing an unverified draft is transient navigation, never an approval. */
  draftCreatedAt: number | null;
  openViewer: (nodeId: string, versionIndex: number, draftCreatedAt?: number) => void;
  close: () => void;
}

export const useInteractiveViewerStore = create<InteractiveViewerStore>((set) => ({
  open: false,
  nodeId: null,
  versionIndex: null,
  draftCreatedAt: null,
  openViewer: (nodeId, versionIndex, draftCreatedAt) => set({ open: true, nodeId, versionIndex, draftCreatedAt: draftCreatedAt ?? null }),
  close: () => set({ open: false, nodeId: null, versionIndex: null, draftCreatedAt: null }),
}));
