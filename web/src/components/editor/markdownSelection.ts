import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { EditorState, Selection, TextSelection } from '@tiptap/pm/state';
import { Transform } from '@tiptap/pm/transform';
import { answerBodyToDoc, answerDocToBody } from '@/lib/answerEditorSerialize';

export interface MarkdownSelection {
  from: number;
  to: number;
  direction?: 'forward' | 'backward' | 'none';
}

/** Temporary bookmarks are used only on copies, never in the editor or saved
 * Markdown. This reuses the actual parser/serializer for formatting, tables,
 * terms and code rather than guessing offsets by stripping punctuation. */
function bookmarkFor(source: string): string {
  let marker = '\uE000\uE001';
  while (source.includes(marker)) marker += '\uE001';
  return marker;
}

export function selectionToMarkdown(state: EditorState, source: string): MarkdownSelection {
  const marker = bookmarkFor(source);
  const offset = (position: number) => {
    if (position === 0) return 0;
    if (position === state.doc.content.size) return source.length;
    const marked = answerDocToBody(state.tr.insertText(marker, position).doc.toJSON());
    const at = marked.indexOf(marker);
    if (at >= 0 && marked.replace(marker, '') === source) return at;
    // A block/node selection can add a paragraph for the temporary text.
    // Its serialized prefix still gives the nearest source boundary.
    const prefix = answerDocToBody(state.doc.cut(0, position).toJSON());
    let common = 0;
    while (common < prefix.length && prefix[common] === source[common]) common++;
    return common;
  };
  const from = offset(state.selection.from);
  return { from, to: state.selection.empty ? from : offset(state.selection.to),
    direction: state.selection.anchor > state.selection.head ? 'backward' : 'forward' };
}

export function selectionFromMarkdown(doc: ProseMirrorNode, source: string, range: MarkdownSelection): Selection {
  const marker = bookmarkFor(source);
  const offset = (requested: number) => {
    const at = Math.max(0, Math.min(source.length, requested));
    if (at === 0) return Selection.atStart(doc).from;
    if (at === source.length) return Selection.atEnd(doc).to;
    // A caret inside formatting delimiters has no visual equivalent. Try the
    // adjacent text boundary too, but keep parsing work bounded per switch.
    for (const delta of [0, -1, 1, -2, 2]) {
      const candidate = at + delta;
      if (candidate < 0 || candidate > source.length) continue;
      const marked = doc.type.schema.nodeFromJSON(answerBodyToDoc(source.slice(0, candidate) + marker + source.slice(candidate)));
      let found: number | undefined;
      marked.descendants((node, position) => {
        const index = node.text?.indexOf(marker) ?? -1;
        if (index >= 0) found = position + index;
      });
      if (found != null && new Transform(marked).delete(found, found + marker.length).doc.eq(doc)) return found;
    }
    // URLs, image metadata and other syntax can be invisible in Visual mode.
    // Choose a valid nearby text position rather than losing the caret.
    return Selection.near(doc.resolve(Math.round(at / Math.max(1, source.length) * doc.content.size))).from;
  };
  const from = offset(range.from);
  const to = range.from === range.to ? from : offset(range.to);
  return range.direction === 'backward'
    ? TextSelection.between(doc.resolve(to), doc.resolve(from))
    : TextSelection.between(doc.resolve(from), doc.resolve(to));
}
