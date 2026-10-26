/** Controls own their clicks; only ordinary node surfaces start selection gestures. */
export const NODE_SELECTION_CONTROLS = 'button, .ref-chip, a, input, textarea, select, [contenteditable="true"], [data-image-selection-surface], .node-resize, .node-followup-bar, .side-panel, .node-type-menu';

/** A group uses the same batch UI even when it currently contains one node. */
export function isBatchNodeSelection(selection: readonly string[] | undefined, groupId: string | null): boolean {
  return !!selection?.length && (selection.length > 1 || groupId !== null);
}
