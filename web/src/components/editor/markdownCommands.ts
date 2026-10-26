import type { Editor } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';

/** Replace the selected document fragment with unmarked paragraphs in one undo step. */
export function clearMarkdownFormatting(editor: Editor): boolean {
  const { state } = editor;
  const { from, to, empty } = state.selection;
  if (empty) return editor.chain().unsetAllMarks().clearNodes().run();
  const paragraphs = state.doc.textBetween(from, to, '\n\n', node => node.attrs.alt ?? node.attrs.value ?? '')
    .split(/\n+/).map(text => state.schema.nodes.paragraph!.create(null, text ? state.schema.text(text) : null));
  editor.view.dispatch(state.tr.replaceSelection(new Slice(Fragment.fromArray(paragraphs), 0, 0)).setStoredMarks([]));
  // A partial selection inside a nested list can retain its enclosing wrappers.
  // Unwrap all levels, not just the nearest list in a single clearNodes call.
  for (let i = 0; i < state.selection.$from.depth + 2; i++) editor.commands.clearNodes();
  editor.view.focus();
  return true;
}

export interface SourceSelection { text: string; from: number; to: number }
export interface SourceEdit extends SourceSelection {}
export type MarkdownAction = 'bold' | 'italic' | 'strike' | 'highlight' | 'comment' | 'code' | 'math' | 'mathBlock'
  | 'bullet' | 'numbered' | 'task' | 'quote' | 'callout' | 'rule' | 'codeBlock' | 'clear' | 'body' | `h${number}`;

/** Source-mode controls edit the selected source only; untouched syntax stays byte-for-byte intact. */
export function editMarkdownSource(selection: SourceSelection, action: MarkdownAction, plainText?: string): SourceEdit {
  const { text, from, to } = selection;
  const selected = text.slice(from, to);
  const delimiters: Partial<Record<MarkdownAction, string>> = { bold: '**', italic: '*', strike: '~~', highlight: '==', comment: '%%', code: '`', math: '$' };
  const delimiter = delimiters[action];
  if (delimiter) {
    if (text.slice(from - delimiter.length, from) === delimiter && text.slice(to, to + delimiter.length) === delimiter) {
      return { text: text.slice(0, from - delimiter.length) + selected + text.slice(to + delimiter.length), from: from - delimiter.length, to: to - delimiter.length };
    }
    return { text: text.slice(0, from) + delimiter + selected + delimiter + text.slice(to), from: from + delimiter.length, to: to + delimiter.length };
  }
  if (action === 'rule' || action === 'mathBlock' || action === 'codeBlock' || action === 'callout') {
    const insert = action === 'rule' ? '\n\n---\n\n' : action === 'callout' ? `> [!note]\n> ${selected || 'Callout text'}\n`
      : `${action === 'mathBlock' ? '$$' : '```'}\n${selected}\n${action === 'mathBlock' ? '$$' : '```'}\n`;
    return { text: text.slice(0, from) + insert + text.slice(to), from: from + insert.length, to: from + insert.length };
  }
  const start = text.lastIndexOf('\n', Math.max(0, from - 1)) + 1;
  const end = text.indexOf('\n', to);
  const stop = end < 0 ? text.length : end;
  const raw = text.slice(start, stop);
  const content = action === 'clear' ? (plainText ?? selected) : raw.split('\n').map((line, i) => {
    const clean = line.replace(/^\s*(?:#{1,6}\s+|>\s*|(?:[-*+] |\d+\. )(?:\[[ xX]\] )?)/, '');
    const prefix = action === 'bullet' ? '- ' : action === 'numbered' ? `${i + 1}. ` : action === 'task' ? '- [ ] '
      : action === 'quote' ? '> ' : action.startsWith('h') ? '#'.repeat(Number(action.slice(1))) + ' ' : '';
    return prefix + clean;
  }).join('\n');
  const left = action === 'clear' ? from : start, right = action === 'clear' ? to : stop;
  return { text: text.slice(0, left) + content + text.slice(right), from: left, to: left + content.length };
}
