import { create } from 'zustand';

/**
 * Runtime registry of object URLs for media assets, keyed by assetId.
 *
 * Object URLs (`URL.createObjectURL`) are session-scoped and MUST NOT live in
 * the project (it's the undo target + gets serialized). On scatter load we
 * hydrate this from the OPFS asset files; on scatter switch we revoke + clear.
 */
interface MediaUrlState {
  urls: Record<string, string>;
  /** Register a freshly created object URL for an asset. */
  set: (assetId: string, objectUrl: string) => void;
  /** Revoke + forget a single asset's URL. */
  remove: (assetId: string) => void;
  /** Revoke every URL and clear (scatter switch / teardown). */
  revokeAll: () => void;
}

export const useMediaUrlStore = create<MediaUrlState>((set) => ({
  urls: {},
  set: (assetId, objectUrl) => set((s) => ({ urls: { ...s.urls, [assetId]: objectUrl } })),
  remove: (assetId) =>
    set((s) => {
      const url = s.urls[assetId];
      if (url) URL.revokeObjectURL(url);
      const next = { ...s.urls };
      delete next[assetId];
      return { urls: next };
    }),
  revokeAll: () =>
    set((s) => {
      for (const url of Object.values(s.urls)) URL.revokeObjectURL(url);
      return { urls: {} };
    }),
}));

/** Non-reactive read helper. */
export function getMediaUrl(assetId: string): string | undefined {
  return useMediaUrlStore.getState().urls[assetId];
}
