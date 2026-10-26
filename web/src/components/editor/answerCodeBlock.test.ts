import { afterEach, describe, expect, it, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import { closeHistory } from '@tiptap/pm/history';
import { buildAnswerExtensions } from './answerExtensions';
import { answerBodyToDoc, answerDocToBody } from '@/lib/answerEditorSerialize';

let editor: Editor;
afterEach(() => { editor?.destroy(); vi.restoreAllMocks(); });

function setup(text = 'const example = 1;') {
  editor = new Editor({ extensions: buildAnswerExtensions(), content: {
    type: 'doc', content: [{ type: 'codeBlock', attrs: { language: 'js' },
      ...(text ? { content: [{ type: 'text', text }] } : {}) }],
  } });
  editor.commands.setTextSelection(text.length + 1);
}
function key(name: string, modifiers: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...modifiers });
  editor.view.dom.dispatchEvent(event);
  return event.defaultPrevented;
}

describe('leaving a Markdown code block', () => {
  it('keeps two Enters as code newlines, then exits on the third without converting the code', () => {
    setup();
    key('Enter'); key('Enter');
    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock');
    expect(editor.state.doc.firstChild?.textContent).toBe('const example = 1;\n\n');
    expect(key('Enter')).toBe(true);
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
    editor.commands.insertContent('Normal text');
    expect(answerDocToBody(editor.getJSON())).toBe('```js\nconst example = 1;\n```\n\nNormal text');
  });

  it('makes the exit and removal of the two trailing newlines one undoable edit', () => {
    setup('code\n\n');
    editor.view.dispatch(closeHistory(editor.state.tr));
    key('Enter');
    editor.commands.undo();
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.textContent).toBe('code\n\n');
    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock');
    editor.commands.redo();
    expect(editor.state.doc.firstChild?.textContent).toBe('code');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('does not exit or remove blank lines in the middle of code', () => {
    setup('first\n\nlast\n\n');
    editor.commands.setTextSelection(8);
    key('Enter');
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.textContent).toBe('first\n\n\nlast\n\n');
  });

  it('replaces a selection with a newline rather than exiting', () => {
    setup('code\n\n');
    editor.commands.setTextSelection({ from: 1, to: 7 });
    key('Enter');
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.type.name).toBe('codeBlock');
    expect(editor.state.doc.firstChild?.textContent).toBe('\n');
  });

  it('lets Down Arrow create a paragraph after the final code block, including an empty block', () => {
    setup('');
    expect(key('ArrowDown')).toBe(true);
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.type.name).toBe('codeBlock');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('does not add an extra paragraph when Down Arrow can reach existing content', () => {
    setup('code');
    editor.commands.setContent(answerBodyToDoc('```js\ncode\n```\n\nExisting paragraph'));
    editor.commands.setTextSelection(5);
    const before = editor.getJSON();
    // The normal arrow handler needs browser line geometry, absent in JSDOM.
    vi.spyOn(editor.view, 'endOfTextblock').mockReturnValue(false);
    key('ArrowDown');
    expect(editor.getJSON()).toEqual(before);
  });

  it('keeps Ctrl+Enter as an immediate exit without changing code content', () => {
    setup('first\nlast');
    editor.commands.setTextSelection(3);
    expect(key('Enter', { ctrlKey: true })).toBe(true);
    expect(editor.state.doc.firstChild?.textContent).toBe('first\nlast');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('can exit a code block inside a quote without removing the quote', () => {
    setup();
    editor.commands.setContent(answerBodyToDoc('> ```js\n> code\n> ```'));
    editor.commands.setTextSelection(6);
    key('Enter'); key('Enter'); key('Enter');
    expect(editor.state.doc.firstChild?.type.name).toBe('blockquote');
    expect(editor.state.doc.firstChild?.childCount).toBe(2);
    expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe('code');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
  });

  it('keeps Enter inside nested list code until the third Enter exits into a paragraph in the same item', () => {
    setup();
    editor.commands.setContent(answerBodyToDoc('- Parent\n\n  ```js\n  code\n  ```'));
    let codeEnd = 0;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock') codeEnd = pos + 1 + node.content.size;
    });
    expect(codeEnd).toBeGreaterThan(0);
    editor.commands.setTextSelection(codeEnd);
    key('Enter');
    expect(editor.state.selection.$from.parent.type.name).toBe('codeBlock');
    key('Enter'); key('Enter');
    const list = editor.state.doc.firstChild!;
    expect(list.type.name).toBe('bulletList');
    expect(list.childCount).toBe(1);
    expect(list.firstChild!.child(1).type.name).toBe('codeBlock');
    expect(list.firstChild!.child(1).textContent).toBe('code');
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph');
  });
});
