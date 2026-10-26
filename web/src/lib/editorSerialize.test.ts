import { describe, it, expect } from 'vitest';
import { bodyToDoc, docToBody, docToModel } from './editorSerialize';

/** Round-trip helper: body -> TipTap doc -> body. */
const rt = (body: string, type = 'root', header = 'T') =>
  docToBody(bodyToDoc(body, type as never, header));

describe('editorSerialize round-trip', () => {
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

  it('chunkIntro on → one paragraph per sentence', () => {
    expect(freeParaCount(bodyToDoc(body, 'explain', 'T', true))).toBe(3);
  });

  it('chunkIntro off → a single flowing paragraph', () => {
    expect(freeParaCount(bodyToDoc(body, 'explain', 'T', false))).toBe(1);
  });

  it('defaults to chunked (on) when the flag is omitted', () => {
    expect(freeParaCount(bodyToDoc(body, 'explain', 'T'))).toBe(3);
  });

  it('is lossless either way (same stored body)', () => {
    expect(docToBody(bodyToDoc(body, 'explain', 'T', true))).toBe(body);
    expect(docToBody(bodyToDoc(body, 'explain', 'T', false))).toBe(body);
  });
});
