import { Mark, mergeAttributes } from '@tiptap/core';
import { expandToWordBoundaries } from './wordSnap';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    term: {
      /** Mark the current selection (snapped to whole words) as a term. */
      markTermAtSelection: () => ReturnType;
      /** Remove the term mark across the current selection. */
      unsetTerm: () => ReturnType;
    };
  }
}

/**
 * A visible-but-not-clickable "term" highlight inside the editor. Rendered as a
 * plain `<span data-term class="editor-term">` (no role/onClick — it reads as
 * selectable text, cursor stays the I-beam). `inclusive:false` so typing past
 * the end of a term doesn't extend it.
 */
export const TermMark = Mark.create({
  name: 'term',
  inclusive: false,

  parseHTML() {
    return [{ tag: 'span[data-term]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-term': '', class: 'editor-term' }), 0];
  },

  addCommands() {
    return {
      markTermAtSelection:
        () =>
        ({ state, dispatch, tr }) => {
          const { from, to } = expandToWordBoundaries(state, state.selection.from, state.selection.to);
          if (from >= to) return false;
          if (dispatch) dispatch(tr.addMark(from, to, this.type.create()));
          return true;
        },
      unsetTerm:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
