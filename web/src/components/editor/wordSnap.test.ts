import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import { EditorState } from '@tiptap/pm/state';
import { buildExtensions } from './editorExtensions';
import { bodyToDoc } from '@/lib/editorSerialize';
import { expandToWordBoundaries } from './wordSnap';

const schema = getSchema(buildExtensions('root'));

/** A doc whose opening paragraph is exactly `text` (one plain prose line). */
function paraState(text: string): EditorState {
  const doc = schema.nodeFromJSON(bodyToDoc(text, 'root', 'T'));
  return EditorState.create({ schema, doc });
}

/** Absolute from/to of the first occurrence of `sub` in a single text node. */
function rangeOf(state: EditorState, sub: string): { from: number; to: number } {
  let from = -1;
  let to = -1;
  state.doc.descendants((node, p) => {
    if (from >= 0) return false;
    if (node.isText && node.text) {
      const i = node.text.indexOf(sub);
      if (i >= 0) {
        from = p + i;
        to = p + i + sub.length;
        return false;
      }
    }
    return true;
  });
  return { from, to };
}

/** The text the mark would actually cover after snapping. */
function snapText(state: EditorState, sel: { from: number; to: number }): string {
  const { from, to } = expandToWordBoundaries(state, sel.from, sel.to);
  return state.doc.textBetween(from, to);
}

describe('expandToWordBoundaries', () => {
  it('expands a partial selection to the whole word', () => {
    const s = paraState('alpha beta gamma');
    expect(snapText(s, rangeOf(s, 'lph'))).toBe('alpha');
  });

  it('does NOT grab the next word when the selection has a trailing space', () => {
    const s = paraState('alpha beta gamma');
    expect(snapText(s, rangeOf(s, 'alpha '))).toBe('alpha');
  });

  it('does NOT grab the previous word when the selection has a leading space', () => {
    const s = paraState('alpha beta gamma');
    expect(snapText(s, rangeOf(s, ' beta'))).toBe('beta');
  });

  it('trims whitespace on both sides', () => {
    const s = paraState('alpha beta gamma');
    expect(snapText(s, rangeOf(s, ' beta '))).toBe('beta');
  });

  it('still expands a collapsed cursor to the word under it', () => {
    const s = paraState('alpha beta gamma');
    const r = rangeOf(s, 'beta');
    expect(snapText(s, { from: r.from + 1, to: r.from + 1 })).toBe('beta');
  });
});
