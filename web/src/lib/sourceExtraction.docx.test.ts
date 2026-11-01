import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { extractSourceBlob } from './sourceExtraction';

// Exercise the same Mammoth browser adapter as the compiled app, not its Node file adapter.
vi.mock('mammoth', () => vi.importActual<typeof import('mammoth')>('mammoth/mammoth.browser'));

async function documentBlob(attributes = '', text = 'Résumé العربية 日本語 हिंदी', suffix = '') {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  zip.file('word/document.xml', `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ${attributes}><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>${suffix}`);
  const buffer = await zip.generateAsync({ type: 'arraybuffer' });
  return { arrayBuffer: async () => buffer } as Blob;
}

describe('Word source extraction through the browser parser', () => {
  it.each([0, 1000])('preserves text in a document with %s extra attributes', async count => {
    const blob = await documentBlob(Array.from({ length: count }, (_, i) => `a${i}="v"`).join(' '));
    const result = await extractSourceBlob(blob, 'docx');
    expect(result.blocks.map(block => block.text).join('\n')).toBe('Résumé العربية 日本語 हिंदी');
    expect(result.retainOriginal).toBe(true);
  });
  it('recovers text from a bounded stray closing tag without hanging', async () => {
    const result = await extractSourceBlob(await documentBlob('', 'Text', '</unexpected>'), 'docx');
    expect(result.blocks.map(block => block.text).join('\n')).toBe('Text');
  });
  it('rejects an unreadable document with an error instead of empty success', async () => {
    const blob = { arrayBuffer: async () => new ArrayBuffer(10) } as Blob;
    await expect(extractSourceBlob(blob, 'docx')).rejects.toThrow();
  });
});
