import { describe, it, expect } from 'vitest';
import { bodyToDoc, docToBody, docToModel } from './editorSerialize';
import { LANGUAGES } from './languages';
import { modelToMarkdown } from './editorMarkdown';

/** Round-trip helper: body -> TipTap doc -> body. */
const rt = (body: string, type = 'root', header = 'T') =>
  docToBody(bodyToDoc(body, type as never, header));

describe('editorSerialize round-trip', () => {
  it('keeps pasted lines separated by a space in single-line headers', () => {
    const doc = bodyToDoc('Opening.\n\n- First', 'root', 'Title');
    const title = doc.content![2]!.content![0]!.content![0]!;
    title.content = [{ type: 'text', text: 'First' }, { type: 'softBreak' }, { type: 'text', text: 'second' }];
    expect(docToModel(doc).bullets[0]!.title).toBe('First second');
  });
  it('keeps a pasted multiline outline description inside its item on reopen', () => {
    const doc = bodyToDoc('- Section\n  - Name: First.', 'root', 'Title');
    const child = doc.content![2]!.content![0]!.content![1]!.content![0]!;
    child.content!.push({ type: 'softBreak' }, { type: 'text', text: 'Second.' });
    const body = docToBody(doc);
    expect(body).toBe('- Section\n  - Name: First. Second.');
    expect(rt(body)).toBe(body);
    expect(modelToMarkdown(docToModel(doc))).toBe('# Title\n\n- Section\n  - Name: First. Second.\n');
  });
  it('free-text-only (explain) preserves bold + term, drops the bullet section', () => {
    const body = 'Intro with **bold** and a [[term]] here.';
    const doc = bodyToDoc(body, 'explain', 'My Title');
    expect(docToModel(doc).title).toBe('My Title');
    // explain doc = title + freeTextSection only
    expect((doc.content ?? []).map((n) => n.type)).toEqual(['title', 'freeTextSection']);
    expect(docToBody(doc)).toBe(body);
  });

  it('free text with a combined bold+term [[**X**]]', () => {
    const body = 'See [[**Krebs cycle**]] now.';
    expect(rt(body, 'explain')).toBe(body);
  });

  it('multiple sentences round-trip as one free-text block', () => {
    const body = 'First sentence with **bold**. Second sentence with a [[term]].';
    expect(rt(body, 'explain')).toBe(body);
  });

  it('regular node: free text + two L1 bullets each with two L2 children', () => {
    const body =
      'Intro.\n\n' +
      '- First\n  - alpha: the first\n  - beta: the second\n\n' +
      '- Second\n  - gamma: third\n  - delta: fourth';
    expect(rt(body)).toBe(body);
  });

  it('L2 child with empty description → bare "  - name"', () => {
    const body = '- T\n  - solo';
    expect(rt(body)).toBe(body);
  });

  it('colon inside an L2 name (with description) round-trips via [[ ]] wrap', () => {
    const body = '- Films\n  - [[2001: A Space Odyssey]]: a 1968 film';
    expect(rt(body)).toBe(body);
  });

  it('colon inside an L2 name (no description)', () => {
    const body = '- Films\n  - [[2001: A Space Odyssey]]';
    expect(rt(body)).toBe(body);
  });

  it('term mid-description with a colon inside the term', () => {
    const body = '- Microbes\n  - Bacteria: includes [[E. coli: a microbe]] and more';
    expect(rt(body)).toBe(body);
  });

  it('legacy bold inside an L2 description is dropped on save', () => {
    const body = '- T\n  - n: some **bold** word';
    expect(rt(body)).toBe('- T\n  - n: some bold word');
  });

  it('regular node with no bullets emits no bullet lines (starter bullet dropped)', () => {
    const body = 'Just intro, no bullets.';
    expect(rt(body, 'root')).toBe(body);
  });

  it('L1 title with zero children', () => {
    const body = '- Lonely';
    expect(rt(body)).toBe(body);
  });

  it('is idempotent after the first normalization', () => {
    const body =
      'Intro.\n\n- First\n  - alpha: one\n  - beta: two\n\n- Second\n  - gamma: three';
    const once = rt(body);
    expect(rt(once)).toBe(once);
  });

  it('adjacent L1 bullets normalize to blank-line separated, then stay stable', () => {
    const body = '- First\n  - a: 1\n- Second\n  - b: 2';
    const once = rt(body);
    expect(once).toBe('- First\n  - a: 1\n\n- Second\n  - b: 2');
    expect(rt(once)).toBe(once);
  });

  it('normalizes CRLF and trailing whitespace', () => {
    const body = '  Intro  \r\n\r\n- A\r\n  - n: d  ';
    expect(rt(body)).toBe('Intro\n\n- A\n  - n: d');
  });
});

describe('editorSerialize — chunkIntro (information chunking)', () => {
  const body = 'First sentence here. Second sentence follows. Third ends it.';
  const freeParaCount = (doc: ReturnType<typeof bodyToDoc>) => {
    const fs = (doc.content ?? []).find((n) => n.type === 'freeTextSection');
    return (fs?.content ?? []).filter((p) => p.type === 'paragraph').length;
  };

  it('does not infer line breaks from punctuation when chunking is on', () => {
    expect(freeParaCount(bodyToDoc(body, 'explain', 'T', true))).toBe(1);
  });

  it('chunkIntro off → a single flowing paragraph', () => {
    expect(freeParaCount(bodyToDoc(body, 'explain', 'T', false))).toBe(1);
  });

  it('uses the same authored document regardless of the presentation flag', () => {
    expect(bodyToDoc(body, 'explain', 'T')).toEqual(bodyToDoc(body, 'explain', 'T', false));
  });

  it('is lossless either way (same stored body)', () => {
    expect(docToBody(bodyToDoc(body, 'explain', 'T', true))).toBe(body);
    expect(docToBody(bodyToDoc(body, 'explain', 'T', false))).toBe(body);
  });

  it.each(LANGUAGES)('preserves authored lines, paragraphs, terms and emphasis in $name', ({ sample }) => {
    const source = `**${sample}** Another sentence stays here.\n[[${sample}]]\n\n${sample}\nLast line.`;
    for (const chunked of [true, false]) {
      const doc = bodyToDoc(source, 'explain', 'T', chunked);
      expect(freeParaCount(doc)).toBe(2);
      expect(JSON.stringify(doc).match(/"type":"softBreak"/g)).toHaveLength(2);
      expect(docToBody(doc)).toBe(source);
      expect(bodyToDoc(docToBody(doc), 'explain', 'T', !chunked)).toEqual(doc);
    }
  });

  it('preserves emphasis and clickable terms spanning an authored newline', () => {
    const source = '**An opening line\nwith bold continuation** and [[a long\nterm]].';
    expect(rt(source, 'explain')).toBe(source);
    expect(rt(rt(source, 'explain'), 'explain')).toBe(source);
  });
});
