import { create } from 'zustand';
import type { ImageBitmapRect } from '@/lib/imageAtlas';

export interface ImageGeometry {
  projectId: string;
  mediaKey: string;
  /** Actual contained bitmap bounds relative to the node, in world pixels. */
  rect: ImageBitmapRect;
  owner: symbol;
}

/** DOM measurements only: never saved or undoable. Image arrow ports consume
 * the local bounds; the worker owns their moving world-space endpoints. */
export const useImageGeometryStore = create<{
  byNode: Record<string, ImageGeometry>;
  set: (nodeId: string, geometry: ImageGeometry) => void;
  remove: (nodeId: string, owner: symbol) => void;
}>((set) => ({
  byNode: {},
  set: (nodeId, geometry) => set((state) => {
    const old = state.byNode[nodeId];
    if (old?.owner === geometry.owner && old.projectId === geometry.projectId && old.mediaKey === geometry.mediaKey
      && (['x', 'y', 'width', 'height'] as const).every((key) => Math.abs(old.rect[key] - geometry.rect[key]) < .01)) return state;
    return { byNode: { ...state.byNode, [nodeId]: geometry } };
  }),
  remove: (nodeId, owner) => set((state) => {
    if (state.byNode[nodeId]?.owner !== owner) return state;
    const byNode = { ...state.byNode };
    delete byNode[nodeId];
    return { byNode };
  }),
}));
