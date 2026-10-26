import { create } from 'zustand';

/**
 * Tiny runtime flag: is a node's follow-up textarea currently focused?
 *
 * Set on the textarea's focus/blur (NodeFollowUpBar). The sidebar shortcut
 * list reads it to show the typing-only shortcuts (Enter = ask, Shift+Enter =
 * new line, Ctrl+Enter depends on the preference) while the user is typing. Runtime
 * only — never persisted.
 */
interface FollowUpFocusState {
  focused: boolean;
  setFocused: (v: boolean) => void;
}

export const useFollowUpFocusStore = create<FollowUpFocusState>((set) => ({
  focused: false,
  setFocused: (v) => set({ focused: v }),
}));
