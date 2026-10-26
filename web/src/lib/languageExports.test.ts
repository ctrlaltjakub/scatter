import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { chatMarkdownToDocx } from './chat/export';
import { modelToDocxBlob } from './editorDocx';
import { answerBodyToDoc, answerDocToBody } from './answerEditorSerialize';
import { withExportBibliography } from './exportSources';

describe('language-aware Word exports', () => {
  it('keeps formatted terms and tables without leaking markers, and includes linked bibliography entries', async () => {
    const source = '- **[[Passionate info-dumping]]:** Deep enthusiasm. ⟦5⟧\n\nLinked to **higher [[subjective well-being]]**.\n\n| Mechanism | Outcome |\n|---|---|\n| **Attention** | Clear<br>Readable |\n\nLiteral \\*star\\* and `**code**`.';
    const markdown = withExportBibliography(answerDocToBody(answerBodyToDoc(source), { stripTerms: true }), {
      sources: [{ n: 5, url: 'https://www.example.org/article', title: 'An article' }],
    });
    const zip = await JSZip.loadAsync(await (await chatMarkdownToDocx(markdown)).arrayBuffer());
    const xml = new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('text'), 'application/xml');
    const text = [...xml.getElementsByTagName('w:t')].map(node => node.textContent).join('');
    expect(text).toContain('Passionate info-dumping:');
    expect(text).toContain('higher subjective well-being');
    expect(text).not.toContain('**:**');
    expect(text).not.toContain('**higher');
    expect(text).toContain('Literal *star* and **code**.');
    expect(text).toContain('Bibliography⟦5⟧ example.org');
    expect(xml.getElementsByTagName('w:tbl')).toHaveLength(1);
    expect(xml.getElementsByTagName('w:br')).toHaveLength(1);
    expect(await zip.file('word/_rels/document.xml.rels')!.async('text')).toContain('https://www.example.org/article');
  });

  it('includes the same bibliography for structured encyclopedic and explain exports', async () => {
    const blob = await modelToDocxBlob({ title: 'A topic', freeText: [[{ text: 'A fact ⟦3⟧.' }]], bullets: [] }, 'en', {
      sources: [{ n: 3, url: 'https://example.net/reference', domain: 'example.net' }],
    });
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file('word/document.xml')!.async('text');
    expect(xml).toContain('Bibliography');
    expect(xml).toContain('⟦3⟧ ');
    expect(xml).toContain('example.net');
  });
  it('keeps the direction and language of each answer in a mixed-language chat', async () => {
    const blob = await chatMarkdownToDocx([
      { markdown: 'English answer.', language: 'en' },
      { markdown: 'إجابة عربية.\n\n```js\nconst value = 1;\n```', language: 'ar' },
      { markdown: '日本語の回答。', language: 'ja' },
    ]);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const xml = await zip.file('word/document.xml')!.async('text');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const paragraphs = [...doc.getElementsByTagName('w:p')];
    const paragraph = (text: string) => paragraphs.find(element => element.textContent?.includes(text))!;
    expect(paragraph('English answer.').innerHTML).toContain('w:val="en-US"');
    expect(paragraph('إجابة عربية.').innerHTML).toContain('<w:bidi');
    expect(paragraph('إجابة عربية.').innerHTML).toContain('w:val="ar"');
    expect(paragraph('日本語の回答。').innerHTML).toContain('w:val="ja-JP"');
    expect(paragraph('const value = 1;').getElementsByTagName('w:bidi')).toHaveLength(0);
  });

  it('stores Arabic direction and language in structured node exports', async () => {
    const blob = await modelToDocxBlob({ title: 'عنوان', freeText: [[{ text: 'نص واضح.' }]], bullets: [] }, 'ar');
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(await zip.file('word/document.xml')!.async('text')).toContain('<w:bidi');
    expect(await zip.file('word/styles.xml')!.async('text')).toContain('w:val="ar"');
  });
});
