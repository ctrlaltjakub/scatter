/**
 * Should a keydown in the editor's Modify box submit the instruction?
 *
 * Plain Enter sends; Shift+Enter is reserved for inserting a newline (matching
 * the app's NodeFollowUpBar convention, so multi-line prompts still work). Enter
 * is no longer modifier-gated — Ctrl/⌘+Enter also submits, since it's still Enter.
 */
export function shouldSubmitOnEnter(e: { key: string; shiftKey: boolean; isComposing?: boolean }): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing;
}
