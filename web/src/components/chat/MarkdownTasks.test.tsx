import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import postcss from 'postcss';
import { ChatMarkdown } from './ChatMarkdown';
import { buildAnswerExtensions } from '@/components/editor/answerExtensions';
import { answerBodyToDoc, answerDocToBody } from '@/lib/answerEditorSerialize';
import { createBlankProject, useGraphStore } from '@/store/useGraphStore';
import type { NodeVersion } from '@/store/types';

const css = postcss.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../app/globals.css'), 'utf8'));
const itemSelectors = ['.chat-markdown li.task-list-item', '.answer-editor-article li.markdown-task-item'];
const inputSelectors = [
  '.chat-markdown li.task-list-item > input[type="checkbox"]',
  '.chat-markdown li.task-list-item > p:first-child > input[type="checkbox"]',
  '.answer-editor-article li.markdown-task-item > input[type="checkbox"]',
];
function declarations(selector: string) {
  const result: Record<string, string> = {};
  css.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(decl => { result[decl.prop] = decl.value; });
  });
  return result;
}
const version = (body: string, chunked: boolean): NodeVersion => ({
  createdAt: 1, generatedBy: 'manual', header: 'Tasks', body, contentType: 'answer', markdownNote: true,
  chat: { turnId: 'tasks', question: '', title: 'Tasks', state: 'complete', contextPath: [], informationChunking: chunked },
});
const cases = [
  { name: 'tight mixed and nested lists', body: '- [ ] Parent. Another sentence.\n  - [X] Nested **task**.\n  - Ordinary nested bullet.\n- [x] Completed.\n- Ordinary bullet.', checked: [false, true, true] },
  { name: 'loose lists with several paragraphs', body: '- [ ] First sentence. Second sentence.\n\n  Another paragraph.\n\n  - [x] Child task.\n\n- [ ] Last task.', checked: [false, true, false] },
  { name: 'ordered and alternate list markers', body: '4. [ ] Numbered task.\n5. Ordinary numbered item.\n6. [x] Done.\n\n* [ ] Star.\n\n+ [X] Plus.', checked: [false, true, false, true] },
  { name: 'bold, italic, terms, links, code, math, and hard breaks', body: '- [ ] **[[Working memory]]**. Another *sentence* with [link](https://example.com), `code`, ==highlight== and $x^2$.\\\n  Next line.\n- [x] ~~Finished~~.', checked: [false, true] },
  { name: 'quotes and callouts', body: '> - [ ] Quoted task. Another sentence.\n>   - [x] Child.\n\n> [!note]\n> - [ ] Callout task. Another sentence.', checked: [false, true, false] },
  { name: 'empty tasks and literal markers', body: '- [ ]\n- [x]\n\n\\[ \\] Literal.\n\n```md\n- [ ] Not a checkbox.\n```', checked: [false, true] },
  { name: 'blocks below a task', body: '- [ ] Parent task.\n\n  > A quote. Another sentence.\n\n  ```js\n  const done = false;\n  ```\n\n  | Name | Value |\n  |---|---|\n  | First | Second |\n\n- [x] Next task.', checked: [false, true] },
];

let editor: Editor | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => { editor?.destroy(); editor = undefined; host?.remove(); host = undefined; cleanup(); });

describe('Markdown task-list rendering in editor and node', () => {
  it('shares a dedicated checkbox gutter without removing ordinary list markers or numbering', () => {
    for (const selector of itemSelectors) expect(declarations(selector)).toMatchObject({
      display: 'list-item', position: 'relative', 'list-style': 'none',
      'padding-inline-start': 'calc(1em + 8px)', 'min-height': '1lh',
    });
    for (const selector of inputSelectors) expect(declarations(selector)).toMatchObject({
      position: 'absolute', 'inset-inline-start': '0', top: 'calc((1lh - 1em) / 2)',
      width: '1em', height: '1em', margin: '0', font: 'inherit',
    });
    expect(declarations('.chat-markdown ul')['list-style']).toBe('disc');
    expect(declarations('.chat-markdown ol')['list-style']).toBe('decimal');
    expect(declarations('.answer-editor-article ul')['list-style']).toBe('disc');
    expect(declarations('.answer-editor-article ol')['list-style']).toBe('decimal');
  });

  describe.each([false, true])('information chunking = %s', chunked => {
    it.each(cases)('keeps $name through editing, saving, rendering, and chunking toggles', ({ body, checked }) => {
      editor = new Editor({ extensions: buildAnswerExtensions(), content: answerBodyToDoc(body) });
      host = document.createElement('div');
      host.className = 'answer-editor-article';
      host.append(editor.view.dom);
      document.body.append(host);
      const before = editor.getJSON();
      editor.storage.answerEditing.chunked = chunked;
      editor.view.dispatch(editor.state.tr.setMeta('answerChunking', chunked));
      const editorInputs = [...host.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
      expect(editorInputs.map(input => input.checked)).toEqual(checked);
      expect(editorInputs.every(input => input.matches(inputSelectors.join(',')))).toBe(true);
      expect(editor.getJSON()).toEqual(before);
      const saved = answerDocToBody(before);
      expect(editor.schema.nodeFromJSON(answerBodyToDoc(saved)).textContent).toBe(editor.state.doc.textContent);
      // Alternate bullet markers canonicalize to '-', which can merge adjacent
      // lists. Their parsed content and nesting must remain stable thereafter.
      expect(answerBodyToDoc(answerDocToBody(answerBodyToDoc(saved)))).toEqual(answerBodyToDoc(saved));

      const { container, rerender } = render(<ChatMarkdown nodeId="tasks" version={version(saved, chunked)} />);
      const checkNode = () => {
        const inputs = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
        expect(inputs.map(input => input.checked)).toEqual(checked);
        expect(inputs.every(input => input.matches(inputSelectors.join(',')))).toBe(true);
        expect(container.querySelectorAll('li.task-list-item')).toHaveLength(checked.length);
        expect(inputs.every(input => input.closest('li')?.matches(itemSelectors[0]!))).toBe(true);
        expect(container.querySelector('pre input, .sc-ab-sentence input, .ref-chip input')).toBeNull();
        expect(container.querySelectorAll('[data-task-offset]')).toHaveLength(checked.length);
      };
      checkNode();
      const text = container.textContent;
      rerender(<ChatMarkdown nodeId="tasks" version={version(saved, !chunked)} />);
      checkNode();
      expect(container.textContent).toBe(text);
      editor.storage.answerEditing.chunked = !chunked;
      editor.view.dispatch(editor.state.tr.setMeta('answerChunking', !chunked));
      expect(editor.getJSON()).toEqual(before);
      expect(editor.can().undo()).toBe(false);
      host.remove();
    });

    it.each(cases)('toggles only the intended checkbox in $name and supports undo without focusing the node', ({ body, checked }) => {
      const v = version(body, chunked);
      const project = createBlankProject('Tasks', 'tasks');
      project.nodes.tasks = { id: 'tasks', type: 'manual-empty', frozen: false, position: { x: 0, y: 0 }, currentVersionIndex: 0, versions: [v] };
      project.selection = [];
      useGraphStore.setState({ project, activeProjectId: project.id });
      useGraphStore.temporal.getState().clear();
      const { container, rerender } = render(<ChatMarkdown nodeId="tasks" version={v} />);
      checked.forEach((value, index) => {
        const before = useGraphStore.getState().project!.nodes.tasks!.versions[0]!;
        const input = container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]!;
        expect(input).not.toBeDisabled();
        fireEvent.click(input);
        const after = useGraphStore.getState().project!.nodes.tasks!.versions[0]!;
        expect(after.body.length).toBe(before.body.length);
        expect([...after.body].filter((character, offset) => character !== before.body[offset])).toHaveLength(1);
        expect(useGraphStore.getState().project!.selection).toEqual([]);
        rerender(<ChatMarkdown nodeId="tasks" version={after} />);
        expect(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[index]!.checked).toBe(!value);
        useGraphStore.temporal.getState().undo();
        expect(useGraphStore.getState().project!.nodes.tasks!.versions[0]!.body).toBe(body);
        rerender(<ChatMarkdown nodeId="tasks" version={v} />);
      });
    });
  });
});
