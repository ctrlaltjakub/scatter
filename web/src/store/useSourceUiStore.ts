import { create } from 'zustand';

export interface SourceViewerTarget {
  projectId: string;
  sourceId: string;
  revisionId: string;
  passageId?: string;
  /** Present when opened from a node citation, enabling that node's ruler. */
  nodeId?: string;
}

interface SourceUiState {
  managerOpen: boolean;
  importOpen: boolean;
  viewer: SourceViewerTarget | null;
  topicDraft: { projectId: string; returnProjectId: string } | null;
  openManager: () => void;
  closeManager: () => void;
  toggleManager: () => void;
  openImport: () => void;
  closeImport: () => void;
  openViewer: (target: SourceViewerTarget) => void;
  closeViewer: () => void;
  setTopicDraft: (draft: { projectId: string; returnProjectId: string } | null) => void;
}

/** Runtime-only source chrome. Source content and source choices live in the
 * project; windows and the currently inspected passage deliberately do not. */
export const useSourceUiStore = create<SourceUiState>((set) => ({
  managerOpen: false,
  importOpen: false,
  viewer: null,
  topicDraft: null,
  openManager: () => set({ managerOpen: true }),
  closeManager: () => set({ managerOpen: false }),
  toggleManager: () => set((state) => ({ managerOpen: !state.managerOpen })),
  openImport: () => set({ importOpen: true }),
  closeImport: () => set({ importOpen: false }),
  openViewer: (viewer) => set({ viewer }),
  closeViewer: () => set({ viewer: null }),
  setTopicDraft: (topicDraft) => set({ topicDraft }),
}));
