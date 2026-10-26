import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';

const key = new PluginKey('l2NameDeco');

/** Absolute doc position of the first ":" in an l2Item that is NOT inside a term
 *  mark (so a colon inside e.g. [[2001: A Space Odyssey]] is skipped), or -1. */
function firstSplitColon(item: PMNode, itemPos: number): number {
  let found = -1;
  let offset = itemPos + 1; // content start of the l2Item
  item.forEach((child) => {
    if (found < 0 && child.isText) {
      const isTerm = child.marks.some((m) => m.type.name === 'term');
      if (!isTerm) {
        const ci = (child.text ?? '').indexOf(':');
        if (ci >= 0) found = offset + ci;
      }
    }
    offset += child.nodeSize;
  });
  return found;
}

function compute(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'l2Item') return;
    const start = pos + 1;
    const colon = firstSplitColon(node, pos);
    const end = colon >= 0 ? colon : pos + node.nodeSize - 1;
    if (end > start) decos.push(Decoration.inline(start, end, { class: 'editor-l2-name' }));
    return false; // don't descend into the l2Item's inline content
  });
  return DecorationSet.create(doc, decos);
}

/**
 * Renders the "name" part of each level-2 line — the text up to the first colon
 * outside a [[term]] — as a bold underlined term. No colon ⇒ the whole line is
 * the name. Render-only: the stored text stays one editable string.
 */
export const L2NameDeco = Extension.create({
  name: 'l2NameDeco',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        state: {
          init: (_config, { doc }) => compute(doc),
          apply: (tr, old) => (tr.docChanged ? compute(tr.doc) : old),
        },
        props: {
          decorations(state) {
            return key.getState(state);
          },
        },
      }),
    ];
  },
});
