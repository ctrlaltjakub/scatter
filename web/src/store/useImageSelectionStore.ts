import { create } from 'zustand';
import type { ImageRegion } from './types';
import { useGraphStore } from './useGraphStore';
import { normalizedImageRegions } from '@/lib/imageRegions';
import { useImageEditorStore } from './useImageEditorStore';
import { useLiveViewportStore } from './useLiveViewportStore';
import { GROUP_LABEL_ZOOM_THRESHOLD } from '@/lib/asciiAura/groupLabels';

export interface ImageSelection {
  projectId: string;
  nodeId: string;
  versionCreatedAt: number;
  regions: ImageRegion[];
}

export function imageSelectionAllowed(nodeId: string): boolean {
  const editor = useImageEditorStore.getState();
  if (editor.open) return editor.nodeId === nodeId;
  const ids = useGraphStore.getState().project?.selection;
  return ids?.length === 1 && ids[0] === nodeId
    && useLiveViewportStore.getState().zoom >= GROUP_LABEL_ZOOM_THRESHOLD;
}

/** Selection is transient navigation state, never an undoable image edit. */
export const useImageSelectionStore = create<{
  selection: ImageSelection | null;
  set: (selection: ImageSelection) => void;
  clear: () => void;
}>((set) => ({
  selection: null,
  set: (selection) => {
    const project = useGraphStore.getState().project;
    const node = project?.nodes[selection.nodeId];
    if (project?.id !== selection.projectId || !node
      || node.versions[node.currentVersionIndex]?.createdAt !== selection.versionCreatedAt
      || !imageSelectionAllowed(selection.nodeId)) return;
    const regions = normalizedImageRegions(selection.regions);
    set({ selection: regions.length ? { ...selection, regions } : null });
  },
  clear: () => set({ selection: null }),
}));

function clearUnavailableSelection() {
  const state = useGraphStore.getState();
  const selection = useImageSelectionStore.getState().selection;
  if (!selection) return;
  const node = state.project?.nodes[selection.nodeId];
  if (state.project?.id !== selection.projectId || !node
    || node.versions[node.currentVersionIndex]?.createdAt !== selection.versionCreatedAt
    || !imageSelectionAllowed(selection.nodeId)) {
    useImageSelectionStore.getState().clear();
  }
}
useGraphStore.subscribe(clearUnavailableSelection);
useLiveViewportStore.subscribe(clearUnavailableSelection);
useImageEditorStore.subscribe(clearUnavailableSelection);

/** A completed action must not clear a newer gesture or another image's selection. */
export function clearCapturedImageSelection(captured: ImageSelection | null) {
  if (captured && useImageSelectionStore.getState().selection === captured) useImageSelectionStore.getState().clear();
}
