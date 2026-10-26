import { create } from 'zustand';

/**
 * Exact source range represented by a visible selection in one node body.
 * Runtime-only: selections are an interaction state, not project data.
 */
export interface NodeTextSelection {
  nodeId: string;
  versionIndex: number;
  sourceBody: string;
  start: number;
  end: number;
  text: string;
  /**
   * Individually visible source fragments covered by the browser range.
   * A selection across collapsed bullet titles has one part per title, so
   * hidden descriptions between them can never be modified accidentally.
   */
  parts?: NodeTextSelectionPart[];
}

export interface NodeTextSelectionPart {
  sourceField: string;
  start: number;
  end: number;
  text: string;
}

interface NodeTextSelectionState {
  selection: NodeTextSelection | null;
  set: (selection: NodeTextSelection) => void;
  clear: () => void;
}

export const useNodeTextSelectionStore = create<NodeTextSelectionState>((set) => ({
  selection: null,
  set: (selection) => set({ selection }),
  clear: () => set({ selection: null }),
}));
