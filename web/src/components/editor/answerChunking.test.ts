import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildAnswerExtensions } from './answerExtensions';
import { answerBodyToDoc, answerDocToBody } from '@/lib/answerEditorSerialize';
import { LANGUAGES } from '@/lib/languages';

let editor: Editor;
afterEach(() => editor?.destroy());
function setup(body: string) {
  editor = new Editor({ extensions: buildAnswerExtensions(), content: answerBodyToDoc(body) });
}
function chunked(enabled: boolean) {
  editor.storage.answerEditing.chunked = enabled;
  editor.view.dispatch(editor.state.tr.setMeta('answerChunking', enabled));
}

describe('rich-editor information chunking', () => {
  it.each(LANGUAGES)('preserves formatting and editor content while chunking $name', language => {
    setup(`**${language.sample}** ⟦1⟧ ${language.sample}`);
    const before = editor.getJSON();
    chunked(true);
    expect(editor.view.dom.querySelectorAll('.editor-answer-sentence-break')).toHaveLength(1);
    expect(editor.view.dom.querySelector('strong')).toHaveTextContent(language.sample);
    expect(editor.getJSON()).toEqual(before);
    chunked(false);
    expect(editor.view.dom.querySelector('.editor-answer-sentence-break')).toBeNull();
    expect(editor.getJSON()).toEqual(before);
  });

  it('keeps sentence-ending terms, bold marks and punctuation inline', () => {
    setup('This ends with a [[term]]. This ends with **[[bold terms]]**. This ends with **bold words**.');
    const before = editor.getJSON();
    chunked(true);
    const paragraph = editor.view.dom.querySelector('p')!;
    expect(paragraph).toHaveClass('editor-answer-chunked');
    expect(paragraph.querySelectorAll('.editor-answer-sentence-break')).toHaveLength(2);
    expect(paragraph.querySelector('[data-term]')?.nextSibling?.textContent).toBe('. ');
    expect(paragraph.querySelector('strong')?.nextSibling?.textContent).toBe('. ');
    expect(paragraph.querySelectorAll('[data-term] .editor-answer-sentence-break, strong .editor-answer-sentence-break')).toHaveLength(0);
    expect(paragraph.querySelector('.editor-answer-sentence')).toBeNull();
    expect(editor.getJSON()).toEqual(before);
  });

  it('does not add breaks to saved Markdown or editor undo history when toggling chunking', () => {
    setup('A [[term]]. Another **sentence**.');
    const body = answerDocToBody(editor.getJSON());
    chunked(true);
    expect(answerDocToBody(editor.getJSON())).toBe(body);
    expect(editor.can().undo()).toBe(false);
    chunked(false);
    expect(editor.view.dom.querySelector('.editor-answer-sentence-break, .editor-answer-chunked')).toBeNull();
    expect(answerDocToBody(editor.getJSON())).toBe(body);
    expect(editor.can().undo()).toBe(false);
  });

  it('updates sentence breaks during typing and undo without separating terminal punctuation', () => {
    setup('A [[term]].');
    chunked(true);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent(' Another sentence.');
    expect(editor.view.dom.querySelectorAll('.editor-answer-sentence-break')).toHaveLength(1);
    expect(editor.view.dom.querySelector('[data-term]')?.nextSibling?.textContent).toBe('. ');
    editor.commands.undo();
    expect(editor.view.dom.querySelector('.editor-answer-sentence-break')).toBeNull();
    expect(answerDocToBody(editor.getJSON())).toBe('A [[term]].');
  });

  it('preserves inline-image offsets and places the next sentence after the image punctuation', () => {
    setup('See ![plot](https://example.com/plot.png). Another [[term]].');
    chunked(true);
    const paragraph = editor.view.dom.querySelector('p')!;
    const separator = paragraph.querySelector('.editor-answer-sentence-break')!;
    expect(paragraph.querySelector('img')?.nextSibling?.textContent).toBe('. ');
    expect(separator.nextSibling?.textContent).toBe('Another ');
    expect(paragraph.querySelectorAll('.editor-answer-sentence-break')).toHaveLength(1);
  });

  it('chunks paragraphs in lists and tables without altering code blocks', () => {
    setup('- A [[term]]. Another sentence.\n\n| Header |\n|---|\n| A **[[term]]**. Another sentence. |\n\n```text\nA term. Another sentence.\n```');
    const before = editor.getJSON();
    chunked(true);
    expect(editor.view.dom.querySelectorAll('li .editor-answer-sentence-break')).toHaveLength(1);
    expect(editor.view.dom.querySelectorAll('td .editor-answer-sentence-break')).toHaveLength(1);
    expect(editor.view.dom.querySelector('pre .editor-answer-sentence-break')).toBeNull();
    expect(editor.getJSON()).toEqual(before);
  });
});
