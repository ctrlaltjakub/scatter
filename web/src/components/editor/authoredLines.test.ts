import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { buildExtensions } from './editorExtensions';
import { bodyToDoc, docToBody } from '@/lib/editorSerialize';

let editor: Editor;
afterEach(() => editor?.destroy());
function setup(body: string) {
  editor = new Editor({ extensions: buildExtensions('explain'), content: bodyToDoc(body, 'explain', 'Title') });
  let end = 0;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') end = pos + 1 + node.content.size;
  });
  editor.commands.setTextSelection(end);
}
function key(name: string, modifiers: KeyboardEventInit = {}) {
  editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...modifiers }));
}

describe('structured editor authored prose boundaries', () => {
  it('keeps punctuation and pasted prose together until the author inserts a break', () => {
    setup('An initial sentence.');
    editor.commands.insertContent(' Contact Capt. J. B. Vance. Another sentence.');
    expect(editor.state.doc.child(1).childCount).toBe(1);
    expect(docToBody(editor.getJSON())).toBe('An initial sentence. Contact Capt. J. B. Vance. Another sentence.');
  });

  it('Shift+Enter authors a source line and Enter authors a paragraph, both undoable', () => {
    setup('First.');
    key('Enter', { shiftKey: true });
    editor.commands.insertContent('Second.');
    expect(docToBody(editor.getJSON())).toBe('First.\nSecond.');
    editor.view.dispatch(closeHistory(editor.state.tr));
    key('Enter');
    editor.commands.insertContent('Third.');
    expect(docToBody(editor.getJSON())).toBe('First.\nSecond.\n\nThird.');
    editor.commands.undo();
    expect(docToBody(editor.getJSON())).toBe('First.\nSecond.');
    editor.commands.redo();
    expect(docToBody(editor.getJSON())).toBe('First.\nSecond.\n\nThird.');
  });

  it('Backspace can remove an authored line break without a splitter restoring it', () => {
    setup('First.\nSecond.');
    let breakAt = 0;
    editor.state.doc.descendants((node, pos) => { if (node.type.name === 'softBreak') breakAt = pos; });
    editor.commands.setTextSelection(breakAt + 1);
    editor.commands.deleteRange({ from: breakAt, to: breakAt + 1 });
    expect(docToBody(editor.getJSON())).toBe('First.Second.');
    editor.commands.undo();
    expect(docToBody(editor.getJSON())).toBe('First.\nSecond.');
  });
});
