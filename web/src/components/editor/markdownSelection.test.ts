import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { answerBodyToDoc, answerDocToBody } from '@/lib/answerEditorSerialize';
import { buildAnswerExtensions } from './answerExtensions';
import { selectionFromMarkdown, selectionToMarkdown } from './markdownSelection';

let editor: Editor;
afterEach(() => editor?.destroy());
const setup = (body: string) => editor = new Editor({ extensions: buildAnswerExtensions(), content: answerBodyToDoc(body) });

describe('Markdown mode selection mapping', () => {
  it.each([
    ['A **target** in prose.', 'target'],
    ['First line. Another sentence.\nA **target** on the next source line.\n\nLast paragraph.', 'target'],
    ['**Bold first line\nwith target on the next.**', 'target'],
    ['# Heading\n\nA [[target]] and _emphasis_.', 'target'],
    ['- Parent\n  - target child', 'target'],
    ['| Name | Value |\n|---|---|\n| Item | target |', 'target'],
    ['> [!note]\n> A target callout.', 'target'],
    ['```js\nconst target = `value`;\n```', 'target'],
    ['Inline ``target ` code``.', 'target'],
    ['A [target](https://example.com) link.', 'target'],
    ['A \\*target\\* and an entity &amp;.', 'target'],
  ])('keeps the same text position in %s', (body, word) => {
    setup(body);
    let position = 0;
    editor.state.doc.descendants((node, at) => {
      const index = node.text?.indexOf(word) ?? -1;
      if (index >= 0) position = at + index + 2;
    });
    editor.commands.setTextSelection(position);
    const original = editor.state.doc;
    const source = answerDocToBody(original.toJSON());
    const range = selectionToMarkdown(editor.state, source);
    expect(source.slice(range.from - 2, range.from + word.length - 2)).toBe(word);
    const restored = selectionFromMarkdown(original, source, range);
    expect(restored.from).toBe(position);
    expect(restored.to).toBe(position);
    expect(editor.state.doc).toBe(original);
  });

  it('preserves a backward selection between repeated words', () => {
    setup('word **word**\n\nword');
    const { doc } = editor.state;
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(doc, 16, 8)));
    const source = answerDocToBody(doc.toJSON());
    const range = selectionToMarkdown(editor.state, source);
    const restored = selectionFromMarkdown(doc, source, range);
    expect(range.direction).toBe('backward');
    expect(restored.anchor).toBe(editor.state.selection.anchor);
    expect(restored.head).toBe(editor.state.selection.head);
  });

  it('maps noncanonical source and positions inside formatting delimiters safely', () => {
    setup('*Italic* and **bold**');
    const source = '*Italic* and **bold**';
    const exact = selectionFromMarkdown(editor.state.doc, source, { from: 4, to: 4 });
    expect(editor.state.doc.textBetween(1, exact.from)).toBe('Ita');
    const delimiter = selectionFromMarkdown(editor.state.doc, source, { from: 14, to: 14 });
    expect(delimiter.$from.parent.isTextblock).toBe(true);
    expect(delimiter.empty).toBe(true);
  });

  it('keeps an insertion point in an empty document', () => {
    setup('');
    const range = selectionToMarkdown(editor.state, '');
    expect(range.from).toBe(0);
    expect(range.to).toBe(0);
    expect(selectionFromMarkdown(editor.state.doc, '', range).from).toBe(1);
  });
});
