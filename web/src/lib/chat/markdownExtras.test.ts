import { describe, expect, it } from 'vitest';
import { annotateChatSourceFields, parseChatMarkdown } from './markdownFields';
import { normalizeEditorUrl } from './markdownExtras';

describe('Markdown extensions', () => {
  it('keeps exact selection offsets inside highlights and callouts while excluding comments', () => {
    const source = 'Before ==a **useful** idea== after. %%not visible%%\n\n> [!note]\n> Select this sentence.';
    const fields = annotateChatSourceFields(parseChatMarkdown(source), source);
    const segments = [...fields.values()].flat();
    expect(segments.map(segment => segment.text).join('')).toBe('Before a useful idea after. Select this sentence.');
    for (const segment of segments) {
      const actual = segment.rawOffsets?.map((at, i) => source.slice(at, segment.rawEnds![i])).join('');
      expect(actual).toBe(segment.text);
    }
  });
  it('accepts common addresses and embedded raster images but rejects executable URLs', () => {
    expect(normalizeEditorUrl('www.example.com/a')).toBe('https://www.example.com/a');
    expect(normalizeEditorUrl('http://example.com/a', true)).toBe('http://example.com/a');
    expect(normalizeEditorUrl('mailto:name@example.com')).toBe('mailto:name@example.com');
    expect(normalizeEditorUrl('data:image/gif;base64,R0lGODlh', true)).toBe('data:image/gif;base64,R0lGODlh');
    expect(normalizeEditorUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeEditorUrl('data:image/svg+xml;base64,PHN2Zz4=', true)).toBeNull();
  });
});
