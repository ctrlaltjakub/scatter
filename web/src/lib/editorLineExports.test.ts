import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { modelToDocxBlob } from './editorDocx';
import { modelFromBody } from './editorSerialize';
import { chatMarkdownToDocx } from './chat/export';

async function documentXml(blob: Blob) {
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  return new DOMParser().parseFromString(await zip.file('word/document.xml')!.async('text'), 'application/xml');
}

describe('authored line boundaries in document exports', () => {
  it.each(['structured', 'markdown'] as const)('preserves paragraphs and line breaks in %s DOCX without splitting punctuation', async kind => {
    const body = 'Meet Capt. J. B. Vance. Same line.\n**Second line.**\n\nNext paragraph.';
    const blob = kind === 'structured' ? await modelToDocxBlob(modelFromBody(body, '', false, false))
      : await chatMarkdownToDocx(body);
    const xml = await documentXml(blob);
    const paragraphs = [...xml.getElementsByTagName('w:p')];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.textContent).toBe('Meet Capt. J. B. Vance. Same line.Second line.');
    expect(paragraphs[0]!.getElementsByTagName('w:br')).toHaveLength(1);
    expect([...paragraphs[0]!.getElementsByTagName('w:b')].filter(mark => mark.getAttribute('w:val') !== 'false')).toHaveLength(1);
    expect(paragraphs[1]!.textContent).toBe('Next paragraph.');
  });
});
