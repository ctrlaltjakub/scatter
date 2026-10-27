import { describe, it, expect } from 'vitest';
import { modelToMarkdown } from './editorMarkdown';
import { bodyToDoc, docToModel } from './editorSerialize';

const md = (body: string, type = 'root', header = 'Title') =>
  modelToMarkdown(docToModel(bodyToDoc(body, type as never, header)));

describe('modelToMarkdown', () => {
  it('emits a title heading, keeps bold, flattens terms to plain text', () => {
    const out = md('Intro **bold** and a [[term]].\n\n- A\n  - n: d');
    expect(out).toContain('# Title');
    expect(out).toContain('Intro **bold** and a term.');
    expect(out).toContain('- A');
    expect(out).toContain('  - n: d');
    expect(out).not.toContain('[[');
  });

  it('omits an empty description', () => {
    expect(md('- A\n  - solo')).toContain('  - solo');
  });

  it('coalesces a bold term inside a bold phrase (no stray **)', () => {
    const out = md('The **[[Krebs]] cycle** matters.', 'explain');
    expect(out).toContain('**Krebs cycle**');
    expect(out).not.toContain('****');
  });

  it('exports source line breaks without turning them into new paragraphs', () => {
    expect(md('First sentence. Same line.\nSecond line.\n\nAnother paragraph.', 'explain'))
      .toBe('# Title\n\nFirst sentence. Same line.\nSecond line.\n\nAnother paragraph.\n');
  });
});
