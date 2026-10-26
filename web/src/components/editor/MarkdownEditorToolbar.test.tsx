import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildAnswerExtensions } from './answerExtensions';
import { answerBodyToDoc, answerDocToBody } from '@/lib/answerEditorSerialize';
import { MarkdownEditorToolbar } from './MarkdownEditorToolbar';

let editor: Editor;
afterEach(() => { cleanup(); editor?.view.dom.remove(); editor?.destroy(); });
function setup(body = 'Some text') {
  editor = new Editor({ extensions: buildAnswerExtensions(), content: answerBodyToDoc(body) });
  render(<MarkdownEditorToolbar editor={editor} disabled={false} />);
}
describe('Markdown formatting controls', () => {
  it('keeps the caret and typing marks when toggling formatting mid-sentence', () => {
    setup('Plain');
    document.body.appendChild(editor.view.dom);
    act(() => {
      editor.commands.setTextSelection(6);
      editor.view.dispatch(editor.state.tr.insertText(' '));
      editor.view.focus();
    });
    const bold = screen.getByRole('button', { name: 'Bold' });
    expect(fireEvent.mouseDown(bold)).toBe(false);
    fireEvent.click(bold);
    expect(document.activeElement).toBe(editor.view.dom);
    act(() => { editor.view.dispatch(editor.state.tr.insertText('bold')); });
    fireEvent.click(bold);
    expect(document.activeElement).toBe(editor.view.dom);
    act(() => { editor.view.dispatch(editor.state.tr.insertText(' plain')); });
    expect(answerDocToBody(editor.getJSON())).toBe('Plain **bold** plain');
  });
  it('formats selected text and supports local undo', () => {
    setup();
    act(() => { editor.commands.setTextSelection({ from: 1, to: 5 }); });
    fireEvent.click(screen.getByRole('button', { name: 'Italic' }));
    expect(answerDocToBody(editor.getJSON())).toBe('_Some_ text');
    act(() => { editor.commands.undo(); });
    expect(answerDocToBody(editor.getJSON())).toBe('Some text');
    fireEvent.click(screen.getByRole('button', { name: 'Text style' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Heading 3' }));
    expect(answerDocToBody(editor.getJSON())).toBe('### Some text');
  });
  it('adds and deletes rows/columns and stores alignment on the whole column', () => {
    setup('| Name | Value |\n|---|---|\n| First | 12 |');
    act(() => { editor.commands.setTextSelection(4); });
    fireEvent.click(screen.getByRole('button', { name: 'Row below' }));
    fireEvent.click(screen.getByRole('button', { name: 'Column right' }));
    let table = editor.getJSON().content![0]!;
    expect(table.content).toHaveLength(3);
    expect(table.content![0]!.content).toHaveLength(3);
    fireEvent.change(screen.getByRole('combobox', { name: 'Column alignment' }), { target: { value: 'right' } });
    table = editor.getJSON().content![0]!;
    expect(table.content!.every(row => row.content![0]!.attrs!.align === 'right')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Delete column' }));
    expect(editor.getJSON().content![0]!.content![0]!.content).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Delete table' }));
    expect(editor.getJSON().content!.some(node => node.type === 'table')).toBe(false);
  });
  it('edits link text and URL without permitting script URLs', () => {
    setup('[Old](https://example.com)');
    act(() => { editor.commands.setTextSelection(2); });
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    fireEvent.change(screen.getByLabelText('Link URL'), { target: { value: 'javascript:alert(1)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('alert')).toBeVisible();
    fireEvent.change(screen.getByLabelText('Link URL'), { target: { value: 'https://example.org' } });
    fireEvent.change(screen.getByLabelText('Link text'), { target: { value: 'New' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(answerDocToBody(editor.getJSON())).toBe('[New](https://example.org)');
  });
});
