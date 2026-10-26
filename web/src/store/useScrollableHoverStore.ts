import { create } from 'zustand';

/**
 * Tiny runtime flag: which node's scrollable body (the cascade section-stepper)
 * is the pointer currently over, if any?
 *
 * Set on the node body's mouse enter/leave (NodeBody) only while that node is
 * the focused stepper (selected, has bullets, not collapsed, not media). The
 * sidebar shortcut list reads it to surface the "force scroll" (Ctrl/⌘+scroll)
 * hint while the pointer is over content the wheel would otherwise step
 * through. Keyed by nodeId (not a bare boolean) so one node clearing its hover
 * can't wipe another node's. Runtime only — never persisted.
 */
interface ScrollableHoverState {
  nodeId: string | null;
  setHover: (id: string | null) => void;
}

export const useScrollableHoverStore = create<ScrollableHoverState>((set) => ({
  nodeId: null,
  setHover: (id) => set((s) => (s.nodeId === id ? s : { nodeId: id })),
}));
