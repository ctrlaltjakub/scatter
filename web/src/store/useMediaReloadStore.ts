import { create } from 'zustand';

/**
 * Per-node "reload" counter. The media side panel's Regenerate button bumps it;
 * NodeBody uses it (with the version index) as MediaView's React key, so a bump
 * remounts MediaView and forces a fresh load of the current version's media.
 * Runtime only — never persisted.
 */
interface MediaReloadState {
  byNodeId: Record<string, number>;
  bump: (nodeId: string) => void;
}

export const useMediaReloadStore = create<MediaReloadState>((set) => ({
  byNodeId: {},
  bump: (nodeId) =>
    set((s) => ({ byNodeId: { ...s.byNodeId, [nodeId]: (s.byNodeId[nodeId] ?? 0) + 1 } })),
}));
