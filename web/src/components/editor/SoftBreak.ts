import { Node } from '@tiptap/core';

/** A source newline, distinct from Markdown's explicit hard break. Its text is
 * whitespace in flowing prose and a line break in the chunked presentation.
 * Keeping a node (rather than decoration-only punctuation breaks) makes source
 * editing, cursor mapping, saving, and undo agree on the authored boundary. */
export const SoftBreak = Node.create({
  name: 'softBreak',
  inline: true,
  group: 'inline',
  selectable: false,
  // Preserve authored lines when a toolbar action converts prose to/from code.
  linebreakReplacement: true,
  parseHTML: () => [{ tag: 'span[data-editor-soft-break]' }],
  renderHTML: () => ['span', { 'data-editor-soft-break': '', class: 'editor-soft-break' }, '\n'],
  renderText: () => '\n',
});
