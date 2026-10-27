import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { buildAnswerExtensions } from '@/components/editor/answerExtensions';
import { answerBodyToDoc, answerDocToBody } from './answerEditorSerialize';
import { parseChatMarkdown } from './chat/markdownFields';

const rich = `A **[[God-image (*imago Dei*)]]** is discussed. ⟦2⟧ (1)

## A heading

Line one,\\
line two.

- **Bold point.** More detail.
  - Nested point with _italics_.
- Another point.

> A quoted **passage**.

| Name | Value |
| :--- | ---: |
| **Memory** | 19 |
| A \\| B | \\*literal\\* |

---

\`\`\`js
const x = 2;
\`\`\`

An [external link](https://example.com) and \`a *literal* code\`.
`;

describe('rich answer editor round trips', () => {
  it('keeps soft source lines separate from hard breaks and paragraphs across edits', () => {
    const source = 'One sentence. Another on the same line.\n**Second source line.**\\\nExplicit hard break.\n\nA new paragraph.';
    const editor = new Editor({ extensions: buildAnswerExtensions(), content: answerBodyToDoc(source) });
    expect(editor.view.dom.querySelectorAll('.editor-soft-break')).toHaveLength(1);
    expect(editor.view.dom.querySelectorAll('p')).toHaveLength(2);
    expect(answerDocToBody(editor.getJSON())).toBe(source);
    expect(answerDocToBody(answerBodyToDoc(source))).toBe(source);
    editor.destroy();
  });

  it('keeps emphasis continuous across source newlines', () => {
    const source = '**One bold line.\nAnother bold line.**';
    expect(answerDocToBody(answerBodyToDoc(source))).toBe(source);
  });
  it('exports continuous bold text across term boundaries without literal Markdown markers', () => {
    const source = '- **[[Passionate info-dumping]]:** Deep enthusiasm.\n\nLinked to **higher [[subjective well-being]]**, and **[[quality of life]]**.';
    const doc = answerBodyToDoc(source);
    const exported = answerDocToBody(doc, { stripTerms: true });
    expect(exported).toContain('**Passionate info-dumping:**');
    expect(exported).toContain('**higher subjective well-being**');
    const saved = answerDocToBody(doc);
    expect(saved).not.toContain('**higher **');
    const flatten = (node: import('@tiptap/core').JSONContent): string => (node.text ?? '') + (node.content ?? []).map(flatten).join('');
    expect(flatten(answerBodyToDoc(saved))).not.toContain('*');
    expect(flatten(answerBodyToDoc(exported))).not.toContain('*');
    expect(exported).toBe(answerDocToBody(answerBodyToDoc(exported), { stripTerms: true }));
  });
  it.each([
    'important concept', '重要概念', 'concepto importante', 'notion importante', 'wichtiges Konzept',
    'conceito importante', 'concetto importante', '日本語の用語', 'важное понятие', '중요한 개념',
    'belangrijk begrip', 'ważne pojęcie', 'konsep penting', 'viktigt begrepp', 'مفهوم مهم',
    'महत्वपूर्ण अवधारणा', 'önemli kavram', 'khái niệm quan trọng', 'důležitý pojem', 'важливе поняття',
  ])('preserves emphasized terms in every supported language: %s', term => {
    const doc = answerBodyToDoc(`**[[${term}]]:** **text [[${term}]]**.`);
    const saved = answerDocToBody(doc, { stripTerms: true });
    expect(saved).toBe(`**${term}:** **text ${term}**.`);
    expect(answerDocToBody(answerBodyToDoc(saved), { stripTerms: true })).toBe(saved);
  });
  it('keeps escaped extension delimiters literal', () => {
    const body = '\\==literal== and \\%%visible%%';
    const doc = answerBodyToDoc(body);
    expect(JSON.stringify(doc)).not.toMatch(/"type":"(?:highlight|comment)"/);
    const saved = answerDocToBody(doc);
    expect(JSON.stringify(answerBodyToDoc(saved))).not.toMatch(/"type":"(?:highlight|comment)"/);
    expect(answerDocToBody(answerBodyToDoc(saved))).toBe(saved);
  });
  it('keeps nested task children as lists rather than code blocks', () => {
    const source = '- [ ] Parent\n  - Child\n    - [x] Grandchild\n- [x] Other';
    const doc = answerBodyToDoc(source);
    const result = answerDocToBody(doc);
    expect(result).toContain('  - Child');
    expect(result).toContain('    - [x] Grandchild');
    expect(answerBodyToDoc(result)).toEqual(doc);
    expect(answerDocToBody(answerBodyToDoc(result))).toBe(result);
  });
  it('round trips highlights, comments, callouts, math and footnotes', () => {
    const source = '==Important **idea**== and %%private note%% with $x^2$. A note[^1].\n\n> [!note]\n> Useful information.\n\n$$\nx^2 + y^2 = z^2\n$$\n\n[^1]: Footnote text.';
    const result = answerDocToBody(answerBodyToDoc(source));
    expect(result).toContain('==Important **idea**==');
    expect(result).toContain('%%private note%%');
    expect(result).toContain('$x^2$');
    expect(result).toContain('> [!note]\n> Useful information.');
    expect(result).toContain('$$\nx^2 + y^2 = z^2\n$$');
    expect(result).toContain('[^1]: Footnote text.');
    expect(answerDocToBody(answerBodyToDoc(result))).toBe(result);
  });
  it('preserves task state, table breaks and link titles across repeated edits', () => {
    const source = '- [ ] To do\n- [x] Done\n\n| A | B |\n|---|---|\n| **Bold**<br>*Italic*< br >Next | [site](https://example.com "Title") |';
    const editor = new Editor({ extensions: buildAnswerExtensions(), content: answerBodyToDoc(source) });
    const result = answerDocToBody(editor.getJSON());
    expect(result).toContain('- [ ] To do');
    expect(result).toContain('- [x] Done');
    expect(result).toContain('**Bold**<br>_Italic_<br>Next');
    expect(result).toContain('[site](https://example.com "Title")');
    expect(answerDocToBody(answerBodyToDoc(result))).toBe(result);
    editor.destroy();
  });
  it('keeps inline code delimiters, images, references and footnotes without executing raw HTML', () => {
    const text = 'Use `` `code` ``. ![A diagram](https://example.com/a.png) [link][ref] [^note]\n\n[ref]: https://example.com\n\n[^note]: A footnote.\n\n<script>alert(1)</script>';
    const editor = new Editor({ extensions: buildAnswerExtensions(), content: answerBodyToDoc(text) });
    const result = answerDocToBody(editor.getJSON());
    expect(result).toContain('`` `code` ``');
    expect(result).toContain('![A diagram](https://example.com/a.png)');
    expect(result).toContain('[link][ref]');
    expect(result).toContain('[^note]: A footnote.');
    expect(result).toContain('<script>alert(1)</script>');
    expect(editor.view.dom.querySelector('script')).toBeNull();
    editor.destroy();
  });
  it('keeps rich blocks, nested terms, citation keys and explicit line breaks through the actual editor schema', () => {
    const doc = answerBodyToDoc(rich);
    const editor = new Editor({ extensions: buildAnswerExtensions(), content: doc });
    const result = answerDocToBody(editor.getJSON());
    expect(result).toContain('[[**God-image (');
    expect(result).toContain('imago Dei');
    expect(result).toContain('⟦2⟧ (1)');
    expect(result).toContain('Line one,\\\nline two.');
    expect(result).toContain('## A heading');
    expect(result).toContain('  - Nested point');
    expect(result).toContain('> A quoted **passage**.');
    expect(result).toContain('| **Memory** | 19 |');
    expect(result).toContain('| A \\| B | \\*literal\\* |');
    expect(result).toContain('```js\nconst x = 2;\n```');
    expect(result).toContain('[external link](https://example.com)');
    expect(result).toContain('`a *literal* code`');
    expect(parseChatMarkdown(result).children?.filter((n) => n.type === 'table')).toHaveLength(1);
    const second = answerDocToBody(answerBodyToDoc(result));
    expect(second).toBe(result);
    editor.destroy();
  });
  it('supports local undo and redo without losing table content', () => {
    const editor = new Editor({ extensions: buildAnswerExtensions(), content: answerBodyToDoc(rich) });
    const before = answerDocToBody(editor.getJSON());
    editor.commands.insertContentAt(1, 'Added text. ');
    expect(answerDocToBody(editor.getJSON())).toContain('Added text.');
    editor.commands.undo();
    expect(answerDocToBody(editor.getJSON())).toBe(before);
    editor.commands.redo();
    expect(answerDocToBody(editor.getJSON())).toContain('Added text.');
    editor.destroy();
  });
});
