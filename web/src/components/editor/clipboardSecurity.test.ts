import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { Schema } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { EditorView } from '@tiptap/pm/view';
import { buildAnswerExtensions } from './answerExtensions';
import { buildExtensions } from './editorExtensions';

describe('clipboard security boundaries', () => {
  it('rejects clipboard context that violates schema attribute validation', () => {
    const schema = new Schema({ nodes: {
      doc: { content: 'block+' },
      paragraph: { group: 'block', content: 'text*', attrs: { label: { default: '', validate: 'string' } },
        parseDOM: [{ tag: 'p' }], toDOM: () => ['p', 0] },
      text: {},
    } });
    const view = new EditorView(document.createElement('div'), { state: EditorState.create({ schema }) });
    try {
      view.pasteHTML('<p data-pm-slice=\'0 0 ["paragraph", {"label":123}]\'>Safe text</p>', new Event('paste') as ClipboardEvent);
      expect(view.state.doc.textContent).toBe('Safe text');
      view.state.doc.descendants(node => {
        if (node.type.name === 'paragraph') expect(typeof node.attrs.label).toBe('string');
      });
    } finally { view.destroy(); }
  });

  it.each(['answer', 'explain', 'root'] as const)('keeps untrusted attribute objects outside the %s schema', kind => {
    const editor = new Editor({ extensions: kind === 'answer' ? buildAnswerExtensions() : buildExtensions(kind) });
    try {
      editor.view.pasteHTML('<p><strong>Résumé العربية 日本語 हिंदी</strong> <span data-term="" onclick="bad()">Term</span></p>', new Event('paste') as ClipboardEvent);
      expect(editor.getText()).toContain('Résumé العربية 日本語 हिंदी');
      expect(editor.getHTML()).not.toContain('onclick');
      // A JSON-looking string stays text; it is never used as an attribute map.
      editor.commands.insertContent('{"__proto__":{"onclick":"bad()"}}');
      expect(editor.view.dom.querySelector('[onclick]')).toBeNull();
      expect(editor.commands.undo()).toBe(true);
      expect(editor.commands.redo()).toBe(true);
      expect(Object.prototype).not.toHaveProperty('onclick');
    } finally { editor.destroy(); }
  });
});
