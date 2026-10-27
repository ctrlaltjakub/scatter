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
  it.each(LANGUAGES)('uses authored lines, retaining $name content and formatting across toggles', language => {
    const source = `**${language.sample}** ⟦1⟧ ${language.sample}\n${language.sample}`;
    setup(source);
    const before = editor.getJSON();
    const body = answerDocToBody(before);
    chunked(true);
    expect(editor.view.dom.querySelectorAll('.editor-soft-break')).toHaveLength(1);
    expect(editor.view.dom.querySelector('p')).toHaveClass('editor-answer-chunked');
    expect(editor.view.dom.querySelector('strong')).toHaveTextContent(language.sample);
    expect(editor.getJSON()).toEqual(before);
    chunked(false);
    expect(editor.view.dom.querySelector('.editor-answer-chunked')).toBeNull();
    expect(editor.view.dom.querySelectorAll('.editor-soft-break')).toHaveLength(1);
    expect(editor.getJSON()).toEqual(before);
    expect(answerDocToBody(editor.getJSON())).toBe(body);
    expect(editor.can().undo()).toBe(false);
  });

  it('does not invent sentence breaks around abbreviations, terms or emphasis', () => {
    const source = 'Dear **Dr. Richard D. Stith Jr.**, contact **Capt. J. B. Vance**. This ends with a [[term]]. Another **sentence**.';
    setup(source);
    chunked(true);
    expect(editor.view.dom.querySelectorAll('.editor-soft-break, .editor-answer-sentence-break')).toHaveLength(0);
    expect(editor.view.dom.querySelector('[data-term]')?.nextSibling?.textContent).toBe('. Another ');
    expect(answerDocToBody(editor.getJSON())).toBe(source);
  });

  it('typing punctuation never changes line boundaries, and explicit breaks support undo', () => {
    setup('A [[term]].');
    chunked(true);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.insertContent(' Another sentence.');
    expect(editor.view.dom.querySelector('.editor-soft-break, .editor-answer-sentence-break')).toBeNull();
    editor.commands.undo();
    expect(answerDocToBody(editor.getJSON())).toBe('A [[term]].');
    editor.commands.insertContent({ type: 'hardBreak' });
    editor.commands.insertContent('A line chosen by the author.');
    expect(answerDocToBody(editor.getJSON())).toBe('A [[term]].\\\nA line chosen by the author.');
    chunked(false);
    expect(editor.view.dom.querySelector('p br')).not.toBeNull();
  });

  it('retains soft and hard breaks in lists, tables, quotes, code and math', () => {
    const source = '- A [[term]]. Another sentence.\n  A new source line.\n\n| Header |\n|---|\n| A **[[term]]**. Another sentence.<br>A new line. |\n\n> A quoted sentence. Another.\n> Second line.\n\n```text\nA term. Another sentence.\nNext code line.\n```\n\n$$\nx = 1\ny = 2\n$$';
    setup(source);
    const before = editor.getJSON();
    chunked(true);
    expect(editor.view.dom.querySelectorAll('li .editor-soft-break')).toHaveLength(1);
    expect(editor.view.dom.querySelectorAll('blockquote .editor-soft-break')).toHaveLength(1);
    expect(editor.view.dom.querySelectorAll('td .editor-soft-break')).toHaveLength(0);
    expect(editor.view.dom.querySelector('td br')).not.toBeNull();
    expect(editor.view.dom.querySelector('pre .editor-soft-break')).toBeNull();
    expect(editor.getJSON()).toEqual(before);
  });

  it('does not include the following source line when automatically linking a URL', () => {
    setup('');
    editor.commands.insertContent([{ type: 'text', text: 'Visit www.example.com' }, { type: 'softBreak' },
      { type: 'text', text: 'A separate line.' }]);
    expect(editor.view.dom.querySelector('a')?.getAttribute('href')).toBe('https://www.example.com');
    expect(editor.view.dom.querySelector('a .editor-soft-break')).toBeNull();
    expect(answerDocToBody(editor.getJSON())).toContain('\nA separate line.');
  });
});
