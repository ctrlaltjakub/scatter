import { create } from 'zustand';

interface WikimediaGalleryState {
  open: boolean;
  nodeId: string | null;
  versionCreatedAt: number | null;
  index: number;
  openGallery: (nodeId: string, versionCreatedAt: number, index: number) => void;
  setIndex: (index: number) => void;
  close: () => void;
}

export const useWikimediaGalleryStore = create<WikimediaGalleryState>((set) => ({
  open: false,
  nodeId: null,
  versionCreatedAt: null,
  index: 0,
  openGallery: (nodeId, versionCreatedAt, index) => set({
    open: true, nodeId, versionCreatedAt, index,
  }),
  setIndex: (index) => set({ index }),
  close: () => set({ open: false, nodeId: null, versionCreatedAt: null, index: 0 }),
}));
