/**
 * Reading-ruler position state. Runtime-only (never persisted) — mirrors
 * useEditorStore's lifecycle style. `nodeId === null` means the ruler is off;
 * while on, exactly one node is being read:
 *
 *   - stop: which section (0 = opening paragraph, k = bullet k-1),
 *   - lineIdx: which visual line inside that section,
 *   - clusterIdx: null = line mode, a number = word mode on that cluster.
 *
 * All navigation goes through lib/readingController.ts; components only READ
 * this store (SidebarShortcuts' availability, ReadingHighlighter's watcher).
 */
import { create } from 'zustand';

export type ActiveReadingReference = {
  kind: 'term';
  parentNodeId: string;
  term: string;
  childId: string | null;
  /** Exact chip represented by the current word cluster. Runtime DOM only. */
  element: HTMLElement;
} | {
  kind: 'selection';
  parentNodeId: string;
  childId: string;
  arrowId: string;
  /** Exact marked segment containing the current reading word. */
  element: HTMLElement;
};

interface ReadingStore {
  nodeId: string | null;
  stop: number;
  lineIdx: number;
  clusterIdx: number | null;
  activeReference: ActiveReadingReference | null;
  begin: (nodeId: string, stop: number, lineIdx: number, clusterIdx: number | null) => void;
  setPos: (
    stop: number,
    lineIdx: number,
    clusterIdx: number | null,
    activeReference?: ActiveReadingReference | null,
  ) => void;
  reset: () => void;
}

export const useReadingStore = create<ReadingStore>((set) => ({
  nodeId: null,
  stop: 0,
  lineIdx: 0,
  clusterIdx: null,
  activeReference: null,
  begin: (nodeId, stop, lineIdx, clusterIdx) => set({
    nodeId,
    stop,
    lineIdx,
    clusterIdx,
    activeReference: null,
  }),
  setPos: (stop, lineIdx, clusterIdx, activeReference = null) => set({
    stop,
    lineIdx,
    clusterIdx,
    activeReference,
  }),
  reset: () => set({
    nodeId: null,
    stop: 0,
    lineIdx: 0,
    clusterIdx: null,
    activeReference: null,
  }),
}));
