import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildAnswerExtensions } from './answerExtensions';
import { answerBodyToDoc, answerDocToBody } from '@/lib/answerEditorSerialize';
import { clearMarkdownFormatting, editMarkdownSource } from './markdownCommands';

let editor: Editor;
afterEach(() => editor?.destroy());
const setup = (body: string) => editor = new Editor({ extensions: buildAnswerExtensions(), content: answerBodyToDoc(body) });
const key = (name: string, shiftKey = false) => {
  const event = new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true, cancelable: true });
  editor.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
};
describe('Markdown editing commands', () => {
  it('retains authored lines when converting prose to a code block and back', () => {
    setup('One line.\nAnother line.');
    editor.commands.selectAll();
    editor.commands.toggleNode('codeBlock', 'paragraph');
    expect(answerDocToBody(editor.getJSON())).toBe('```\nOne line.\nAnother line.\n```');
    editor.commands.toggleNode('codeBlock', 'paragraph');
    expect(answerDocToBody(editor.getJSON())).toBe('One line.\nAnother line.');
  });
  it('keeps source lines and paragraphs when clearing their formatting', () => {
    setup('**One line.\nAnother line.**\n\n_Last paragraph._');
    editor.commands.selectAll(); clearMarkdownFormatting(editor);
    expect(answerDocToBody(editor.getJSON())).toBe('One line.\nAnother line.\n\nLast paragraph.');
    editor.commands.undo();
    expect(answerDocToBody(editor.getJSON())).toBe('**One line.\nAnother line.**\n\n_Last paragraph._');
  });
  it('clears headings, nested lists, links and inline marks in one operation, with undo', () => {
    setup('> ## **Heading**\n>\n> - **One**\n>   - _Two_ [link](https://example.com)\n\n| Col |\n|---|\n| ~~Value~~ |');
    const original = answerDocToBody(editor.getJSON());
    editor.commands.selectAll(); clearMarkdownFormatting(editor);
    expect(editor.getJSON().content?.every(node => node.type === 'paragraph')).toBe(true);
    expect(answerDocToBody(editor.getJSON())).toBe('Heading\n\nOne\n\nTwo link\n\nCol\n\nValue');
    editor.commands.undo();
    expect(answerDocToBody(editor.getJSON())).toBe(original);
  });
  it('outdents a nested item on Backspace at the start', () => {
    setup('- Parent\n  - Child');
    let at = 0; editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Child') at = pos; });
    editor.commands.setTextSelection(at);
    expect(key('Backspace')).toBe(true);
    expect(answerDocToBody(editor.getJSON())).toBe('- Parent\n- Child');
  });
  it('indents with Tab and consumes it when no further valid nesting exists', () => {
    setup('- Parent\n- Child');
    let at = 0; editor.state.doc.descendants((node, pos) => { if (node.isText && node.text === 'Child') at = pos; });
    editor.commands.setTextSelection(at);
    expect(key('Tab')).toBe(true);
    expect(answerDocToBody(editor.getJSON())).toContain('  - Child');
    const before = answerDocToBody(editor.getJSON());
    expect(key('Tab')).toBe(true);
    expect(answerDocToBody(editor.getJSON())).toBe(before);
    expect(key('Tab', true)).toBe(true);
    expect(answerDocToBody(editor.getJSON())).toBe('- Parent\n- Child');
  });
  it('does not Tab into task checkboxes', () => {
    setup('- [ ] A task');
    expect(editor.view.dom.querySelector('input')).toHaveAttribute('tabindex', '-1');
    editor.commands.setTextSelection(3);
    expect(key('Tab')).toBe(true);
  });
  it('autolinks a typed www address and keeps its target current as typing continues', () => {
    setup('');
    for (const letter of 'www.example.com/path ') editor.commands.insertContent(letter);
    const link = editor.getJSON().content![0]!.content!.find(node => node.marks?.some(mark => mark.type === 'link'));
    expect(link?.marks?.find(mark => mark.type === 'link')?.attrs?.href).toBe('https://www.example.com/path');
  });
  it('source formatting preserves unselected syntax and returns the caret between delimiters', () => {
    expect(editMarkdownSource({ text: 'Hello ', from: 6, to: 6 }, 'bold')).toEqual({ text: 'Hello ****', from: 8, to: 8 });
    expect(editMarkdownSource({ text: '# Heading\n\nplain', from: 11, to: 16 }, 'italic')).toEqual({ text: '# Heading\n\n*plain*', from: 12, to: 17 });
  });
});
