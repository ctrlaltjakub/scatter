import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { sentenceSplitPoints } from '@/lib/bulletParse';

const key = new PluginKey('introChunk');

/**
 * Live "information chunking": while editing, keep each free-text sentence on its
 * own line by splitting any opening-paragraph that has grown to hold more than one
 * sentence (typed or pasted). Shares the canvas's boundary scanner
 * (`sentenceSplitPoints`) so the editor and the node always agree on where a
 * sentence ends.
 *
 * ADDITIVE only — it never merges. To rejoin two lines, press Backspace at a line
 * start (ProseMirror's default join); a save+reopen always re-normalises since the
 * stored body re-joins the sentences and re-splits on load.
 *
 * Always registered, but gated at runtime by `editor.storage.introChunk.enabled`
 * (the chunking toggle flips it) so turning chunking on/off never rebuilds the editor.
 */
export const IntroChunk = Extension.create({
  name: 'introChunk',
  addStorage() {
    return { enabled: true };
  },
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      new Plugin({
        key,
        appendTransaction(transactions, _oldState, newState) {
          if (!editor.storage.introChunk?.enabled) return null;
          if (!transactions.some((t) => t.docChanged)) return null;

          const termType = newState.schema.marks.term;

          // Collect absolute split positions across every free-text paragraph.
          // (Paragraphs live only inside freeTextSection in this schema.)
          const splits: number[] = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name === 'freeTextSection') return true; // descend in
            if (node.type.name !== 'paragraph') return false;      // skip the rest
            const text = node.textContent;
            if (!text) return false;
            const contentStart = pos + 1; // first inline offset inside the paragraph
            for (const k of sentenceSplitPoints(text)) {
              const abs = contentStart + k;
              // Don't split on a terminator that sits inside a [[term]] mark.
              if (termType) {
                const marks = newState.doc.resolve(abs - 1).marks();
                if (marks.some((m) => m.type === termType)) continue;
              }
              splits.push(abs);
            }
            return false;
          });

          if (splits.length === 0) return null;

          // Split high → low so earlier positions stay valid; the transaction maps
          // the caret through each split automatically.
          splits.sort((a, b) => b - a);
          const tr = newState.tr;
          for (const pos of splits) tr.split(pos);
          return tr.steps.length ? tr : null;
        },
      }),
    ];
  },
});
